/**
 * Stateful agency duplicate detection sweep.
 *
 * Stores ALL agency submissions in agency_submissions table for cross-reference.
 * When a new agency submission arrives, checks local state first (instant
 * cross-agency duplicate detection), then checks Greenhouse for non-agency
 * prior history only for candidates not already in the local ledger.
 *
 * W2 wiring (change-spec:27, frozen-spec:280, :300, :302):
 *   - Agency identity flows through the PURE agency-resolver (resolveAgencySource +
 *     the agency_source_registry DI), NOT the legacy `app.source?.name ?? "Unknown
 *     Agency"` / `agency_source_id ?? 0` sentinels. An unresolved source is a
 *     data-quality DEFECT: agency_source_id/name go NULL and source_resolution_status
 *     records why (migration 005:126-129). The literal "Unknown Agency" / id 0 are banned.
 *   - Recruiter ownership flows through the PURE identity-resolver (resolveOwnership over
 *     the job's /job_owners, the same owner-level R1-R3 ladder ytd-normalize runs). The
 *     winner + ownership_resolution_status persist to agency_submissions
 *     (recruiter_id/recruiter_name/ownership_resolution_status, 005:130-132) and to
 *     sweep_items (recruiter_id/ownership_confidence/ownership_resolution_status, 005:120-123).
 *     Unresolved ownership keeps recruiter_id/name NULL and carries the status — never
 *     "Unknown"/"UNASSIGNED".
 *   - C6: the whole run is wrapped in a Postgres advisory lock keyed on the sweep type, so
 *     an overlapping cron tick or a retried run can't double-insert. A held lock exits
 *     cleanly (no orphaned `running` sweep_run row, since the lock is taken BEFORE the run
 *     row is created).
 *
 * The conflict taxonomy (prior_history / dual_agency), the alert_ledger dedupe, and the
 * legacy AgencyConflict objects are otherwise UNCHANGED.
 */

import { supabase } from "./supabase"
import { greenhouseGetAll } from "./greenhouse-client"
import { listJobOwners, listUsers } from "./greenhouse-evidence"
import {
  isAgencySource,
  resolveAgencySource,
  type AgencyEvidence,
  type AgencyRegistryEntry,
  type AgencyRegistryResolver,
} from "./agency-resolver"
import { resolveOwnership, type OwnerRow } from "./identity-resolver"
import type {
  AgencySourceResolution,
  OwnershipResolution,
} from "./resolution-types"
import { SWEEP_CONFIG } from "./sweep-config"
import {
  ghStageName,
  type GHApplication,
  type GHJob,
  type GHCandidate,
  type AgencyConflict,
  type PriorApplication,
  type SweepRunSummary,
} from "./sweep-types"
import type { YtdGHUser } from "./ytd-types"
import {
  gateSweepRow,
  isSweepOwnershipWritebackEnabled,
  AGENCY_SUBMISSIONS_005_COLUMNS,
  SWEEP_ITEMS_005_COLUMNS,
} from "./sweep-writeback"

/**
 * AgencyConflict carrying the resolved recruiter ownership for the sweep_items writeback.
 * AgencyConflict itself lives in sweep-types.ts (outside this file's W2 edit boundary), so the
 * ownership fields ride along as a local intersection — assignable to the base type, so the
 * conflict objects still flow through AgencySweepResult.conflicts (AgencyConflict[]) unchanged.
 * Identity fields are NULL on a non-'resolved' owner (the canon defect — never "Unknown"). The
 * Verify stage folds these onto the canonical AgencyConflict type if it wants them first-class.
 */
type AgencyConflictWithOwnership = AgencyConflict & {
  recruiter_id: number | null
  recruiter_name: string | null
  ownership_confidence: OwnershipResolution["confidence"]
  ownership_resolution_status: OwnershipResolution["status"]
}

interface AgencySweepResult {
  run: SweepRunSummary | null
  conflicts: AgencyConflict[]
  newAlerts: number
  totalProcessed: number
  /** True when a concurrent run held the advisory lock and this invocation exited without
   *  doing any work (C6). The cron surfaces it; nothing was created or mutated. */
  skipped?: boolean
}

const SOURCE_ID_BATCH_SIZE = 20

// ---------------------------------------------------------------------------
// C6 — advisory lock keyed on the sweep type. Overlapping cron ticks / retried runs must
// not both walk the same window and double-insert into agency_submissions + sweep_items.
//
// pg_advisory_xact_lock (the literal the change-spec names) is TRANSACTION-scoped, and
// PostgREST runs every supabase call (.from / .rpc) in its OWN implicit transaction — so an
// xact lock acquired in one round-trip releases the instant that round-trip's transaction
// commits and protects NOTHING across the sweep's many statements. To actually hold the lock
// for the duration of a run that spans dozens of round-trips (and many Greenhouse calls), the
// lock must be SESSION-scoped: pg_try_advisory_lock to acquire non-blockingly (so a held lock
// returns false and we exit cleanly rather than queue), pg_advisory_unlock to release in
// `finally`. Both are exposed as RPCs the Verify-stage cron+migration cluster defines (the same
// pattern migration 006 uses for claim_notification_outbox / reap_stale_notification_leases —
// the SQL function is the shared contract; this caller only invokes it).
//
// The lock key is derived from the sweep type so 'agency' and 'referral' take DISTINCT locks
// (they touch disjoint rows) and two 'agency' runs contend on the same one.
//
// POOLING CAVEAT (the Verify-stage cron+migration cluster owns the resolution): a session-level
// advisory lock lives on ONE backend connection. Under a transaction-mode pooler (PgBouncer)
// the acquire RPC, the work, and the release RPC can land on different pooled backends, so the
// lock can be invisible/auto-released mid-run. The cron must run the sweep over a session-pinned
// connection (direct connection or session-mode pooler), and the C6 stale-`running` reaper
// (change-spec:31) is the backstop: any run abandoned without completing is reclaimed regardless
// of whether the lock survived pooling. This caller is correct given a session-pinned connection;
// the connection mode + the try_advisory_lock/advisory_unlock SQL functions are wired downstream.
// ---------------------------------------------------------------------------

const SWEEP_LOCK_NAMESPACE = 0x5357 // 'SW' — a stable namespace so the keyspace can't collide
// with an unrelated advisory lock taken elsewhere.

/** Stable 32-bit lock key for a sweep type. djb2 over the type string, masked to a positive
 *  int so it fits pg_*_advisory_lock(int4, int4) and never changes between runs. */
function sweepLockKey(sweepType: "agency" | "referral"): number {
  let hash = 5381
  for (let i = 0; i < sweepType.length; i++) {
    hash = ((hash << 5) + hash + sweepType.charCodeAt(i)) | 0
  }
  // Mask to 31 bits (always non-negative); the int4 pair (namespace, key) names the lock.
  return hash & 0x7fffffff
}

/** True when an rpc error means the SQL function itself is undefined — i.e. migration 007 (which
 *  defines try_advisory_lock/advisory_unlock) is not yet applied. Postgres raises SQLSTATE 42883
 *  (undefined_function); PostgREST surfaces a missing RPC as PGRST202 ("Could not find the
 *  function ... in the schema cache"). Match on the code OR the message text so either surfacing
 *  is caught, while a generic DB error (e.g. 42501 permission, 40P01 deadlock) returns false and
 *  still throws. Pure (no I/O) so it can be unit-tested in isolation. */
export function isMissingFunctionError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false
  const code = (error as { code?: unknown }).code
  if (code === "42883" || code === "PGRST202") return true
  const message = (error as { message?: unknown }).message
  if (typeof message !== "string") return false
  const lower = message.toLowerCase()
  return (
    (lower.includes("function") && lower.includes("does not exist")) ||
    lower.includes("could not find the function")
  )
}

/** The conflicts to actually persist this run: drop any whose application was SKIPPED at the
 *  agency_submissions write (a sourceless agency app pre-005). sweep_items + alert_ledger are
 *  written from conflicts[] unconditionally, so without this a skipped conflict orphans — a live
 *  tracker/alert row with no agency_submissions backing, invisible to the next sweep's dup-check.
 *  Pure; unit-tested in test/sweep-agency-orphan.test.ts. */
export function conflictsToPersist<T extends { agency_application_id: number }>(
  conflicts: T[],
  skippedAppIds: Set<number>
): T[] {
  return conflicts.filter((c) => !skippedAppIds.has(c.agency_application_id))
}

/** Acquire the session-scoped advisory lock for `sweepType` without blocking. Returns true if
 *  this session now holds it, false if another run holds it (caller exits cleanly). */
async function tryAcquireSweepLock(sweepType: "agency" | "referral"): Promise<boolean> {
  const { data, error } = await supabase.rpc("try_advisory_lock", {
    p_namespace: SWEEP_LOCK_NAMESPACE,
    p_key: sweepLockKey(sweepType),
  })
  if (error) {
    // Pre-007 the SQL function doesn't exist yet. Soft-fail ONLY that case: return false so the
    // caller exits cleanly as skipped (the sweep stays dormant) instead of throwing every cron
    // tick — a thrown lock acquire would silently kill the agency sweep while referral/YTD run.
    if (isMissingFunctionError(error)) {
      console.warn(
        `[agency-sweep] advisory lock RPC unavailable (migration 007 not applied?) — skipping ${sweepType} sweep: ${error.message}`
      )
      return false
    }
    throw new Error(`Failed to acquire sweep advisory lock: ${error.message}`)
  }
  return data === true
}

/** Release the session-scoped advisory lock. Best-effort: a failed unlock is logged, not
 *  thrown, so it never masks the run's own error in a `finally`. The lock is also released
 *  automatically when the DB session ends. */
async function releaseSweepLock(sweepType: "agency" | "referral"): Promise<void> {
  const { error } = await supabase.rpc("advisory_unlock", {
    p_namespace: SWEEP_LOCK_NAMESPACE,
    p_key: sweepLockKey(sweepType),
  })
  if (error) {
    console.error(
      `[agency-sweep] Failed to release advisory lock: ${error.message}`
    )
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let index = 0
  async function worker() {
    while (index < items.length) {
      const i = index++
      results[i] = await fn(items[i])
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  )
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Agency-source resolution wiring. The registry (migration 001 agency_source_registry — the
// thin id->name cache) is loaded once and wrapped in the AgencyRegistryResolver the pure
// resolver consumes by DI. The registry has no `agency_name` column, so byId/byName carry
// agency_name:null and the resolver falls back to the registered source_name (its documented
// nameless-source path) — A1 -> confirmed with agency_name = source_name.
// ---------------------------------------------------------------------------

function buildRegistryResolver(
  rows: Array<{ source_id: number; source_name: string }>
): AgencyRegistryResolver {
  const byId = new Map<number, AgencyRegistryEntry>()
  const byName = new Map<string, AgencyRegistryEntry>()
  for (const row of rows) {
    const entry: AgencyRegistryEntry = {
      source_id: row.source_id,
      source_name: row.source_name,
      // 001's agency_source_registry has no agency_name column; the resolver falls back to
      // source_name when this is null (never a sentinel).
      agency_name: null,
    }
    byId.set(row.source_id, entry)
    if (row.source_name) byName.set(row.source_name, entry)
  }
  return {
    byId: (id) => byId.get(id) ?? null,
    byName: (name) => byName.get(name) ?? null,
  }
}

/** Resolve one application's agency source against the registry. Selection-gate parity with
 *  the bootstrap path: a source that is not the agency TYPE never asserts an identity — it
 *  falls to the unresolved defect (NULL identity + status), so a mis-sourced row can't smuggle
 *  in a fake agency name. registryHit keys on the source's own id, with a name fallback for an
 *  id-less row (mirrors resolveAllAgencySources). */
function resolveApplicationAgency(
  app: GHApplication,
  registry: AgencyRegistryResolver
): AgencySourceResolution {
  const src = app.source
  // The pure resolver only treats a row as an agency on the agency TYPE rung (A2) or a
  // registry hit (A1). The sweep's /applications projection (GHApplication.source) carries
  // only { id, name } — no type — so a non-registered source has no type evidence and resolves
  // unresolved unless the registry recognizes its id/name. That is correct: the registry IS the
  // agency allow-list for this path (the sweep only fetched apps whose source_ids are in it).
  const hit =
    (src?.id != null ? registry.byId(src.id) : null) ??
    (src?.name ? registry.byName(src.name) : null)

  const evidence: AgencyEvidence = {
    sourceId: src?.id ?? null,
    sourceName: src?.name ?? null,
    // No type on the /applications source projection; a registry hit (A1) is what resolves it.
    sourceTypeId: null,
    sourceTypeName: null,
    registryHit: hit !== null,
    registryAgencyName: hit?.agency_name ?? null,
  }
  return resolveAgencySource(evidence)
}

// ---------------------------------------------------------------------------
// Recruiter-ownership resolution wiring. The sweep's /applications projection carries no
// owner data, so ownership is resolved off /job_owners (+ /users for names) — the same
// owner-level ladder (R1-R3; R4-R6 are reconcile-only) ytd-normalize runs. Per-job owner rows
// are loaded once for the batch and the synchronous resolver decides each application's winner.
// A null/absent app.recruiter_id simply skips R2 (frozen-spec:287) — GHApplication has no
// recruiter_id field, so R2 never fires here and resolution leans on responsible/single-owner.
// ---------------------------------------------------------------------------

interface OwnershipContext {
  ownersByJobId: Map<number, OwnerRow[]>
  usersById: Map<number, YtdGHUser>
  permissionBlocked: boolean
}

/** Load /job_owners for every job in the batch (+ resolve owner ids to names via /users), and
 *  shape them for the resolver. A permission wall on /job_owners is recorded so each
 *  resolution folds to permission_blocked rather than throwing the sweep. */
async function loadOwnershipContext(jobIds: number[]): Promise<OwnershipContext> {
  if (jobIds.length === 0) {
    return { ownersByJobId: new Map(), usersById: new Map(), permissionBlocked: false }
  }

  let owners: Awaited<ReturnType<typeof listJobOwners>> = []
  let permissionBlocked = false
  try {
    owners = await listJobOwners(jobIds)
  } catch (err) {
    // The owner-level evidence fetch can be permission-walled (frozen-spec:294). Treat it as a
    // visible defect — every application then resolves permission_blocked — never a thrown
    // sweep. greenhouse-client surfaces a scope wall as "Greenhouse API error: 401|403 ...".
    if (err instanceof Error && /Greenhouse API error:\s*(401|403)\b/.test(err.message)) {
      console.warn(`[agency-sweep] permission_blocked loading /job_owners: ${err.message}`)
      permissionBlocked = true
    } else {
      throw err
    }
  }

  const ownersByJobId = new Map<number, OwnerRow[]>()
  for (const owner of owners) {
    const list = ownersByJobId.get(owner.job_id) ?? []
    list.push({
      user_id: owner.user_id,
      type: owner.type,
      responsible: owner.responsible === true,
      active: owner.active,
    })
    ownersByJobId.set(owner.job_id, list)
  }

  const ownerUserIds = [...new Set(owners.map((o) => o.user_id).filter((id) => Number.isFinite(id)))]
  const users = ownerUserIds.length > 0 ? await listUsers(ownerUserIds) : []
  const usersById = new Map<number, YtdGHUser>(users.map((u) => [u.id, u]))

  return { ownersByJobId, usersById, permissionBlocked }
}

/** Resolve recruiter ownership for one application off the preloaded owner context. */
function resolveApplicationOwnership(
  app: GHApplication,
  ctx: OwnershipContext
): OwnershipResolution {
  return resolveOwnership({
    jobOwners: ctx.ownersByJobId.get(app.job_id) ?? [],
    usersById: ctx.usersById,
    // GHApplication carries no recruiter_id; R2 is skipped, never failed (frozen-spec:287).
    applicationRecruiterId: null,
    jobOwnersPermissionBlocked: ctx.permissionBlocked,
  })
}

export async function runAgencySweep(opts: {
  lookbackHours?: number
  concurrency?: number
  dryRun?: boolean
}): Promise<AgencySweepResult> {
  const lookbackHours =
    opts.lookbackHours ?? SWEEP_CONFIG.agency.lookbackHours
  const concurrency = opts.concurrency ?? SWEEP_CONFIG.agency.concurrency
  const lookbackDate = new Date(
    Date.now() - lookbackHours * 60 * 60 * 1000
  )

  // C6: take the lock BEFORE creating the run row, so a held-lock exit leaves no orphaned
  // `running` sweep_run. A concurrent run owns the window; exit cleanly with nothing created.
  const lockAcquired = await tryAcquireSweepLock("agency")
  if (!lockAcquired) {
    console.log(
      "[agency-sweep] advisory lock held by a concurrent run — skipping cleanly"
    )
    return { run: null, conflicts: [], newAlerts: 0, totalProcessed: 0, skipped: true }
  }

  let runId: string | null = null
  let runStartedAt: string | null = null

  try {
    const { data: runRow, error: runError } = await supabase
      .from("sweep_runs")
      .insert({
        sweep_type: "agency",
        started_at: new Date().toISOString(),
        status: "running",
        lookback_hours: lookbackHours,
      })
      .select("id, started_at")
      .single()

    if (runError || !runRow) {
      throw new Error(`Failed to create sweep run: ${runError?.message}`)
    }

    runId = runRow.id as string
    runStartedAt = runRow.started_at as string

    // Step 1: Read agency source IDs (+ names) from registry. source_name feeds the
    // agency-resolver's A1 rung (the registry has no agency_name column; source_name is the
    // canonical name on a hit).
    const { data: agencySources } = await supabase
      .from("agency_source_registry")
      .select("source_id, source_name")

    if (!agencySources || agencySources.length === 0) {
      throw new Error(
        "No agency sources in registry. Run /api/sweeps/resolve-agencies first."
      )
    }

    const registryRows = agencySources as Array<{
      source_id: number
      source_name: string
    }>
    const agencySourceIds = new Set(registryRows.map((s) => s.source_id))
    const registry = buildRegistryResolver(registryRows)

    // Step 2: Fetch recent agency-sourced applications
    const applications = (
      await Promise.all(
        chunks([...agencySourceIds], SOURCE_ID_BATCH_SIZE).map((batch) =>
          greenhouseGetAll<GHApplication>("/applications", {
            source_ids: batch.join(","),
            created_at: `gte|${lookbackDate.toISOString()}`,
            per_page: 500,
          })
        )
      )
    ).flat()

    if (applications.length === 0) {
      const completedRun = await markRunCompleted(runId, runStartedAt, {
        scanned: 0,
        found: 0,
        alerted: 0,
      })
      return {
        run: completedRun,
        conflicts: [],
        newAlerts: 0,
        totalProcessed: 0,
      }
    }

    // Step 3: Enrich with job titles
    const uniqueJobIds = [
      ...new Set(applications.map((a) => a.job_id).filter((id) => Number.isFinite(id))),
    ]
    const jobs = (
      await Promise.all(
        chunks(uniqueJobIds, SOURCE_ID_BATCH_SIZE).map((batch) =>
          greenhouseGetAll<GHJob>("/jobs", {
            ids: batch.join(","),
            per_page: 500,
          })
        )
      )
    ).flat()
    const jobMap = new Map(jobs.map((j) => [j.id, j]))

    // Step 3b: Load recruiter-ownership evidence for the batch (job_owners + users), resolved
    // per application below. Done once for the whole batch, not per application.
    const ownershipContext = await loadOwnershipContext(uniqueJobIds)

    // Step 4: Enrich candidates. Current Greenhouse OAuth permits list-by-ids,
    // but rejects /candidates/{id} for these records.
    const uniqueCandidateIds = [
      ...new Set(
        applications
          .map((a) => a.candidate_id)
          .filter((id) => Number.isFinite(id))
      ),
    ]
    const candidates = (
      await Promise.all(
        chunks(uniqueCandidateIds, SOURCE_ID_BATCH_SIZE).map((batch) =>
          greenhouseGetAll<GHCandidate>("/candidates", {
            ids: batch.join(","),
            per_page: 500,
          })
        )
      )
    ).flat()
    const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]))

    // Step 5: Check which applications are already in agency_submissions
    const appIds = applications.map((a) => a.id)
    const existingSubmissions = (
      await Promise.all(
        chunks(appIds, 100).map(async (batch) => {
          const { data, error } = await supabase
            .from("agency_submissions")
            .select("application_id")
            .in("application_id", batch)
          if (error) throw new Error(`Failed to read agency submissions: ${error.message}`)
          return data ?? []
        })
      )
    ).flat()

    const alreadyTracked = new Set(
      (existingSubmissions ?? []).map(
        (s: { application_id: number }) => s.application_id
      )
    )
    const newApplications = applications.filter(
      (a) => !alreadyTracked.has(a.id)
    )

    // Step 6: Process new applications (concurrency-limited)
    const conflicts: AgencyConflictWithOwnership[] = []
    const submissionRows: Array<Record<string, unknown>> = []
    // Apps SKIPPED at the agency_submissions write (sourceless, pre-005) — their conflicts must NOT
    // orphan into sweep_items/alert_ledger (filtered out via conflictsToPersist before persistence).
    const skippedAppIds = new Set<number>()
    // 005 writeback gate (lib/sweep-writeback.ts). OFF (default) strips the 005 columns and uses the
    // legacy non-null agency_source fallback below, so this cron's inserts are legal pre-005.
    const ownershipWriteback = isSweepOwnershipWritebackEnabled()

    await mapWithConcurrency(newApplications, concurrency, async (app) => {
      try {
        const candidate = candidateMap.get(app.candidate_id)
        if (!candidate) {
          console.error(
            `[agency-sweep] Candidate ${app.candidate_id} not returned by Greenhouse list-by-ids`
          )
          return
        }

        const primaryEmail =
          candidate.email_addresses?.find(
            (e) => e.type === "personal" || e.type === "work"
          )?.value ?? candidate.email_addresses?.[0]?.value

        const candidateName = `${candidate.first_name} ${candidate.last_name}`
        const jobTitle =
          jobMap.get(app.job_id)?.name ?? `Job #${app.job_id}`

        // Agency identity via the PURE resolver. On a non-'resolved' status the resolution
        // carries NULL agency_name/source_id (the defect contract) — never "Unknown Agency"/0.
        const agencyResolution = resolveApplicationAgency(app, registry)
        // The legacy AgencyConflict / conflict_detail surfaces want a display string. Use the
        // resolved name when present; otherwise the source's raw name as a non-authoritative
        // label, and NULL only if even that is absent. This is a UI label, not the persisted
        // identity — the persisted agency_source_id/name come from agencyResolution (NULL on a
        // defect) and the defect is carried by source_resolution_status.
        const agencyLabel =
          agencyResolution.agency_name ?? app.source?.name ?? null

        // Recruiter ownership via the PURE resolver (owner-level rungs).
        const ownership = resolveApplicationOwnership(app, ownershipContext)

        const submittedAt =
          app.applied_at ?? app.created_at ?? app.last_activity_at

        // Check local state first: does this candidate email already exist
        // in agency_submissions from a DIFFERENT agency?
        let conflictDetected = false
        let conflictType: "prior_history" | "dual_agency" | null = null
        let conflictDetail: Record<string, unknown> | null = null

        if (primaryEmail) {
          // Find prior agency_submissions for this email from a DIFFERENT agency. Only exclude
          // THIS application's own source when it has a real source id — a literal `?? 0` would
          // false-match other defect/fallback rows that also carry agency_source_id 0.
          let priorAgencyQuery = supabase
            .from("agency_submissions")
            .select("*")
            .eq("candidate_email", primaryEmail)
          if (typeof app.source?.id === "number") {
            priorAgencyQuery = priorAgencyQuery.neq("agency_source_id", app.source.id)
          }
          const { data: priorAgencySubs } = await priorAgencyQuery

          if (priorAgencySubs && priorAgencySubs.length > 0) {
            // Cross-agency conflict detected from local state
            const hasOtherAgency = priorAgencySubs.some(
              (s: Record<string, unknown>) =>
                agencySourceIds.has(s.agency_source_id as number)
            )

            conflictDetected = true
            conflictType = hasOtherAgency ? "dual_agency" : "prior_history"
            conflictDetail = {
              prior_submissions: priorAgencySubs.map(
                (s: Record<string, unknown>) => ({
                  application_id: s.application_id,
                  agency: s.agency_source_name,
                  job_title: s.job_title,
                  submitted_at: s.submitted_at,
                })
              ),
            }
          }

          // If no local conflict, check Greenhouse for non-agency prior history
          if (!conflictDetected) {
            const matchingCandidates = await greenhouseGetAll<GHCandidate>(
              "/candidates",
              { email: primaryEmail }
            )

            for (const match of matchingCandidates) {
              if (match.id === app.candidate_id) continue

              const priorApps = await greenhouseGetAll<GHApplication>(
                "/applications",
                { candidate_ids: String(match.id) }
              )

              const nonAgencyPriors = priorApps.filter(
                (pa) => !agencySourceIds.has(pa.source?.id ?? 0)
              )

              if (nonAgencyPriors.length > 0) {
                conflictDetected = true
                conflictType = "prior_history"

                const priorApplications: PriorApplication[] =
                  nonAgencyPriors.map((pa) => ({
                    application_id: pa.id,
                    job_title:
                      jobMap.get(pa.job_id)?.name ?? `Job #${pa.job_id}`,
                    source_name: pa.source?.name ?? "Unknown",
                    status: pa.status,
                    current_stage: ghStageName(pa),
                    applied_at: pa.applied_at ?? pa.created_at ?? null,
                  }))

                conflictDetail = {
                  prior_applications: priorApplications,
                  candidate_email: primaryEmail,
                }

                // Build legacy conflict object for sweep_items
                let riskLevel: "high" | "medium" | "low" = "low"
                for (const pa of nonAgencyPriors) {
                  if (
                    (pa.status === "active" || pa.status === "in_process") &&
                    pa.job_id === app.job_id
                  ) {
                    riskLevel = "high"
                    break
                  }
                  if (
                    pa.status === "active" ||
                    pa.status === "in_process"
                  ) {
                    riskLevel = "medium"
                  }
                }

                conflicts.push({
                  agency_application_id: app.id,
                  agency_source_name: agencyLabel ?? "",
                  candidate_id: app.candidate_id,
                  candidate_name: candidateName,
                  candidate_email: primaryEmail,
                  job_id: app.job_id,
                  job_title: jobTitle,
                  prior_applications: priorApplications,
                  conflict_type: conflictType,
                  risk_level: riskLevel,
                  recruiter_id: ownership.primary_recruiter_id,
                  recruiter_name: ownership.primary_recruiter_name,
                  ownership_confidence: ownership.confidence,
                  ownership_resolution_status: ownership.status,
                })
                break
              }
            }
          } else {
            // Local conflict — also build the AgencyConflict object
            conflicts.push({
              agency_application_id: app.id,
              agency_source_name: agencyLabel ?? "",
              candidate_id: app.candidate_id,
              candidate_name: candidateName,
              candidate_email: primaryEmail,
              job_id: app.job_id,
              job_title: jobTitle,
              prior_applications: [],
              conflict_type: conflictType!,
              risk_level: "high",
              recruiter_id: ownership.primary_recruiter_id,
              recruiter_name: ownership.primary_recruiter_name,
              ownership_confidence: ownership.confidence,
              ownership_resolution_status: ownership.status,
            })
          }
        }

        // Store in agency_submissions regardless of conflict status. Identity columns come
        // from the resolutions: a resolved agency keeps its real id/name; an unresolved one
        // writes NULL + source_resolution_status (005:126-129) — never "Unknown Agency"/0.
        // Likewise recruiter_id/name are NULL on an unresolved owner, with the status carried.
        //
        // Pre-005 (writeback OFF) agency_source_id/name are still NOT NULL, so fall back to the
        // raw GH source — present on a genuine agency application — to keep the insert legal. The
        // banned "Unknown Agency"/0 sentinels are NEVER written: if even the raw source is absent
        // (a defect on an agency-sourced app), SKIP this row's persistence rather than persist a
        // sentinel; the next sweep retries it (once the source resolves or 005 lands and NULL is
        // permitted). When the writeback is ON, persist the resolver's value (NULL on a defect,
        // carried by source_resolution_status).
        const rawSourceId =
          typeof app.source?.id === "number" ? app.source.id : null
        const rawSourceName = app.source?.name ?? null
        const fallbackSourceId = agencyResolution.source_id ?? rawSourceId
        const fallbackSourceName = agencyResolution.agency_name ?? rawSourceName
        if (
          !ownershipWriteback &&
          (fallbackSourceId == null || fallbackSourceName == null)
        ) {
          console.warn(
            `[agency-sweep] application ${app.id}: no agency source to persist pre-005 (writeback OFF) — skipping submission row to avoid the banned 0/"Unknown Agency" sentinel`
          )
          skippedAppIds.add(app.id)
          return
        }
        submissionRows.push({
          application_id: app.id,
          candidate_id: app.candidate_id,
          candidate_email: primaryEmail ?? null,
          agency_source_id: ownershipWriteback
            ? agencyResolution.source_id
            : fallbackSourceId,
          agency_source_name: ownershipWriteback
            ? agencyResolution.agency_name
            : fallbackSourceName,
          source_resolution_status: agencyResolution.status,
          job_id: app.job_id,
          job_title: jobTitle,
          submitted_at: submittedAt,
          checked_at: new Date().toISOString(),
          conflict_detected: conflictDetected,
          conflict_type: conflictType,
          conflict_detail: conflictDetail,
          recruiter_id: ownership.primary_recruiter_id,
          recruiter_name: ownership.primary_recruiter_name,
          ownership_resolution_status: ownership.status,
        })
      } catch (err) {
        console.error(
          `[agency-sweep] Error checking application ${app.id}:`,
          err instanceof Error ? err.message : err
        )
      }
    })

    // Check the alert ledger for already-alerted conflicts. Computed before the persistence
    // guard so newConflicts.length is the single post-ledger-dedupe count for both the live and
    // dryRun summary paths (mirrors sweep-referral's newItems.length).
    const persistedConflicts = conflictsToPersist(conflicts, skippedAppIds)
    const conflictAppIds = persistedConflicts.map((c) => c.agency_application_id)
    const { data: existingAlerts } = await supabase
      .from("alert_ledger")
      .select("application_id")
      .eq("sweep_type", "agency")
      .in("application_id", conflictAppIds.length > 0 ? conflictAppIds : [-1])

    const alreadyAlerted = new Set(
      (existingAlerts ?? []).map(
        (a: { application_id: number }) => a.application_id
      )
    )
    const newConflicts = persistedConflicts.filter(
      (c) => !alreadyAlerted.has(c.agency_application_id)
    )

    // Step 7: Persist all submissions and conflicts
    if (!opts.dryRun) {
      // Insert all new submissions into agency_submissions
      if (submissionRows.length > 0) {
        const { error: upsertSubError } = await supabase
          .from("agency_submissions")
          .upsert(
            submissionRows.map((r) =>
              gateSweepRow(r, AGENCY_SUBMISSIONS_005_COLUMNS, ownershipWriteback)
            ),
            { onConflict: "application_id" }
          )
        if (upsertSubError) {
          throw new Error(`agency_submissions upsert failed: ${upsertSubError.message}`)
        }
      }

      // Insert conflicts into sweep_items. recruiter_id + ownership_* ride along on the 005
      // columns; recruiter_name reuses the existing 002 sweep_items.recruiter_name column.
      if (persistedConflicts.length > 0) {
        const sweepItemRows = persistedConflicts.map((c) => ({
          sweep_run_id: runId,
          sweep_type: "agency" as const,
          application_id: c.agency_application_id,
          candidate_id: c.candidate_id,
          job_id: c.job_id,
          candidate_name: c.candidate_name,
          job_title: c.job_title,
          source_name: c.agency_source_name,
          application_status: "active",
          conflict_detail: {
            conflict_type: c.conflict_type,
            risk_level: c.risk_level,
            prior_applications: c.prior_applications,
            candidate_email: c.candidate_email,
          },
          recruiter_id: c.recruiter_id,
          recruiter_name: c.recruiter_name,
          ownership_confidence: c.ownership_confidence,
          ownership_resolution_status: c.ownership_resolution_status,
        }))
        const { error: insertItemsError } = await supabase
          .from("sweep_items")
          .insert(
            sweepItemRows.map((r) => gateSweepRow(r, SWEEP_ITEMS_005_COLUMNS, ownershipWriteback))
          )
        if (insertItemsError) {
          throw new Error(`sweep_items insert failed: ${insertItemsError.message}`)
        }
      }

      // Alert ledger for new conflicts
      if (newConflicts.length > 0) {
        const now = new Date().toISOString()
        const alertRows = newConflicts.map((c) => ({
          application_id: c.agency_application_id,
          sweep_type: "agency" as const,
          first_alerted_at: now,
          last_alerted_at: now,
          alert_count: 1,
          greenhouse_stage_at_alert: "active",
        }))
        const { error: alertUpsertError } = await supabase.from("alert_ledger").upsert(alertRows, {
          onConflict: "application_id,sweep_type",
        })
        if (alertUpsertError) {
          throw new Error(`alert_ledger upsert failed: ${alertUpsertError.message}`)
        }
      }
    }

    const completedRun = await markRunCompleted(runId, runStartedAt, {
      scanned: applications.length,
      found: persistedConflicts.length,
      alerted: newConflicts.length,
    })

    return {
      run: completedRun,
      conflicts,
      newAlerts: newConflicts.length,
      totalProcessed: submissionRows.length,
    }
  } catch (err) {
    if (runId) {
      const { error: failUpdateError } = await supabase
        .from("sweep_runs")
        .update({
          completed_at: new Date().toISOString(),
          status: "failed",
          error_message: err instanceof Error ? err.message : String(err),
        })
        .eq("id", runId)
      if (failUpdateError) {
        console.error(
          `[agency-sweep] sweep_runs update (failed) could not persist: ${failUpdateError.message}`
        )
      }
    }
    throw err
  } finally {
    // Always release the session-scoped lock so the next tick can run (it also releases on
    // session end). Best-effort: never let an unlock failure mask the run's own error.
    await releaseSweepLock("agency")
  }
}

async function markRunCompleted(
  runId: string,
  startedAt: string,
  counts: { scanned: number; found: number; alerted: number }
): Promise<SweepRunSummary> {
  const completedAt = new Date().toISOString()
  const { error: completeError } = await supabase
    .from("sweep_runs")
    .update({
      completed_at: completedAt,
      status: "completed",
      applications_scanned: counts.scanned,
      items_found: counts.found,
      items_alerted: counts.alerted,
    })
    .eq("id", runId)
  if (completeError) {
    throw new Error(`sweep_runs update (completed) failed: ${completeError.message}`)
  }

  return {
    id: runId,
    sweep_type: "agency",
    started_at: startedAt,
    completed_at: completedAt,
    status: "completed",
    applications_scanned: counts.scanned,
    items_found: counts.found,
    items_alerted: counts.alerted,
  }
}
