/**
 * Daily identity reconcile cron — PASS 2 of the identity layer (frozen-spec:282,
 * build-program W2 :102). The cheap PASS-1 resolve happens at write time inside the
 * sweeps / YTD extract; THIS route is the expensive upgrade pass. It drives the
 * below-bar queue up the proxy ladder (the rungs that pull scorecard / notes /
 * stage-exit-actor evidence), raises confidence MONOTONICALLY, writes back to the
 * resolution tables, appends an application_ownership_snapshots row ONLY when value
 * or confidence actually changed, and re-queues true defects with exponential
 * backoff. It creates ZERO alert_ledger rows (frozen-spec:282).
 *
 * It RE-RUNS the canonical resolvers — it does not re-implement the ladder:
 *   lib/identity-resolver.ts  — resolveOwnershipWithFetchers (the PASS-2 async
 *                              entrypoint: short-circuits the cheap owner rungs R1-R3,
 *                              pulls R4 scorecards / R5-R6 activity+stage-exit on demand
 *                              via the injected fetchers) + reconcileConfidenceFloor.
 *   lib/agency-resolver.ts    — resolveAgencySource + isAgencySource + AGENCY_SOURCE_TYPE_ID
 *                              + AgencyRegistryResolver (the Prospectly-safe type.id gate).
 * Evidence transport is the Stage-1 contract lib/greenhouse-evidence.ts
 * (listScorecardsForApplications / getStageChangeActors / listJobOwners / listUsers),
 * wired 1:1 into the resolver's OwnershipFetchers. Result + enum shapes come from the
 * Stage-1 contract lib/resolution-types.ts and are consumed verbatim (no re-declaration).
 *
 * Locked defaults (open decisions, build-program): ownership snapshots = append-on-change;
 * reconcileConfidenceFloor = 'high' (only inferred/unresolved incur the proxy upgrade);
 * reconcile is forward-only — the heavy backfill over all jobs touched by existing facts
 * is gated behind ?backfill=1.
 *
 * Guard + shape mirror app/api/cron/ytd-incremental/route.ts:4-26.
 */

import {
  resolveOwnershipWithFetchers,
  reconcileConfidenceFloor,
  type OwnerRow,
  type OwnershipFetchers,
} from "@/lib/identity-resolver"
import {
  resolveAgencySource,
  type AgencyRegistryEntry,
  type AgencyRegistryResolver,
} from "@/lib/agency-resolver"
import {
  listJobOwners,
  listUsers,
  listScorecardsForApplications,
  getStageChangeActors,
  type GHJobOwnerWithResponsible,
} from "@/lib/greenhouse-evidence"
import { greenhouseGetAll } from "@/lib/greenhouse-client"
import { getSupabase } from "@/lib/supabase"
import type { YtdGHJobInterviewStage } from "@/lib/ytd-types"
import type { GHSource } from "@/lib/sweep-types"
import {
  RESOLUTION_CONFIDENCE_VALUES,
  type AgencyResolutionStatus,
  type OwnershipEvidenceType,
  type OwnershipResolution,
  type ResolutionAttempt,
  type ResolutionAttemptStatus,
  type ResolutionChannel,
  type ResolutionConfidence,
  type ResolutionEntityType,
  type ResolutionStatus,
} from "@/lib/resolution-types"
import {
  INTERNAL_SERVER_ERROR_MESSAGE,
  logServerError,
  noStoreJson,
  noStoreServerErrorJson,
  parseBoolean,
  requireCronSecret,
} from "../../ytd/route-utils"
import { readEnv } from "@/lib/env"
import {
  refreshRecruiterSlackDirectory,
  type DirectoryRefreshResult,
} from "@/lib/recruiter-slack-directory"

export const maxDuration = 300

// ---------------------------------------------------------------------------
// Confidence rank (frozen-spec:441): confirmed > high > inferred > unresolved.
// Upgrades are monotonic on this order — reconcile NEVER downgrades a durable row.
// Shared with the resolver via reconcileConfidenceFloor (imported, locked to 'high').
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<ResolutionConfidence, number> = {
  unresolved: 0,
  inferred: 1,
  high: 2,
  confirmed: 3,
}

/** Below the reconcile floor = strictly lower rank than reconcileConfidenceFloor.
 *  At 'high' (the locked default) only inferred/unresolved are below-bar and earn the
 *  expensive proxy upgrade; high/confirmed are already done and are left alone. */
function belowFloor(confidence: ResolutionConfidence): boolean {
  return CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[reconcileConfidenceFloor]
}

const BELOW_FLOOR_CONFIDENCE: ResolutionConfidence[] = RESOLUTION_CONFIDENCE_VALUES.filter(
  (c) => belowFloor(c)
)

// Backoff: exponential on attempt_number, base 6h, capped at 7d, +/-10% jitter so a
// large due-batch doesn't synchronize its next wake. Mirrors greenhouse-client's
// bounded-wait posture (a cap + a sane default), at day granularity.
const BACKOFF_BASE_MS = 6 * 60 * 60 * 1000
const BACKOFF_CAP_MS = 7 * 24 * 60 * 60 * 1000

function nextRetryAt(attemptNumber: number, nowMs: number): string {
  const growth = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attemptNumber - 1))
  const capped = Math.min(growth, BACKOFF_CAP_MS)
  const jittered = capped * (0.9 + Math.random() * 0.2)
  return new Date(nowMs + jittered).toISOString()
}

// Bound on how many durable rows the proxy ladder touches per run. Each proxy rung is a
// Greenhouse list call (batched <=50 ids), so the forward pass is capped to stay inside
// maxDuration=300 and the rate budget; ?backfill=1 raises the cap for the one-shot pass.
const FORWARD_MAX_JOBS = 250
const BACKFILL_MAX_JOBS = 5000
const FORWARD_MAX_SOURCES = 250
const BACKFILL_MAX_SOURCES = 5000

// Cap on applications resolved per below-bar job. The proxy rungs fetch per application;
// a few representative applications are enough to upgrade the JOB's ownership confidence
// without fanning out to every historical application on a high-volume req.
const MAX_APPS_PER_JOB = 25

// ---------------------------------------------------------------------------
// GET handler — guarded, forward-only by default, ?backfill=1 for the heavy one-shot.
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  // P3: recruiter -> slack directory refresh. Independently gated by NOTIFY_SLACK_RESOLVER_ENABLED
  // (default OFF, must NOT ride IDENTITY_RECONCILE_ENABLED — else GH+Slack IO would start on the
  // first deploy tick). Runs regardless of the reconcile gate below (it only needs migration 009 +
  // the users:read.email scope), and is try/catch-isolated so a Slack/GH blip can't fail the route.
  let slackDirectory:
    | DirectoryRefreshResult
    | { skipped: true }
    | { error: string } = { skipped: true }
  if (readEnv("NOTIFY_SLACK_RESOLVER_ENABLED")?.toLowerCase() === "true") {
    try {
      slackDirectory = await refreshRecruiterSlackDirectory()
    } catch (err) {
      logServerError("cron/reconcile-identity slack directory refresh", err)
      slackDirectory = { error: INTERNAL_SERVER_ERROR_MESSAGE }
    }
  }

  // Activation gate (default OFF). The 005 identity tables this route writes
  // (greenhouse_job_ownership, application_ownership_snapshots, identity_resolution_attempts,
  // agency_source_resolution) ship behind an unapplied migration; until it is applied and the
  // flag is flipped, skip BEFORE any DB access so a scheduled hit is a safe no-op. Mirrors the
  // readEnv idiom in lib/sweep-writeback.ts:30 / lib/ytd-extract.ts:814.
  if (readEnv("IDENTITY_RECONCILE_ENABLED")?.toLowerCase() !== "true") {
    return noStoreJson({
      skipped: true,
      reason: "identity migrations not activated",
      slack_directory: slackDirectory,
    })
  }

  try {
    const url = new URL(request.url)
    const backfill = parseBoolean(url.searchParams.get("backfill")) === true
    const dryRun = parseBoolean(url.searchParams.get("dry_run")) === true

    const result = await runReconcile({ backfill, dryRun })
    return noStoreJson({ ...result, slack_directory: slackDirectory })
  } catch (err) {
    return noStoreServerErrorJson("cron/reconcile-identity", err)
  }
}

interface ReconcileResult {
  mode: "forward" | "backfill"
  dry_run: boolean
  jobs_examined: number
  jobs_upgraded: number
  sources_examined: number
  sources_upgraded: number
  snapshots_appended: number
  attempts_recorded: number
  still_unresolved: number
  by_status: Record<string, number>
}

// ---------------------------------------------------------------------------
// Orchestration. Idempotent: due-work is selected by current state (durable confidence
// below the floor / a due attempt row), upgrades are monotonic, and every write is a
// deterministic upsert keyed on job_id / source_id / (entity_type, entity_id). Re-running
// the same due set converges — the second pass finds the rows now at/above the floor and
// the attempts not yet due, so it is a no-op. ZERO alert_ledger writes.
// ---------------------------------------------------------------------------

async function runReconcile(opts: {
  backfill: boolean
  dryRun: boolean
}): Promise<ReconcileResult> {
  const supabase = getSupabase()
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const mode = opts.backfill ? "backfill" : "forward"

  const byStatus: Record<string, number> = {}
  const bump = (s: string) => {
    byStatus[s] = (byStatus[s] ?? 0) + 1
  }

  const jobOwnershipRows: JobOwnershipRow[] = []
  const agencyRows: AgencyResolutionRow[] = []
  const snapshotRows: SnapshotRow[] = []
  const attemptRows: AttemptRow[] = []

  let jobsUpgraded = 0
  let sourcesUpgraded = 0
  let stillUnresolved = 0

  // === 1. Recruiter ownership ==============================================
  const dueJobIds = await collectDueJobIds(supabase, opts.backfill)

  for (const batch of chunk(dueJobIds, 50)) {
    if (batch.length === 0) continue

    // R1-R3 owner evidence. listJobOwners can throw a 401/403 scope wall; we classify
    // that as permission_blocked and pass the flag into the resolver (terminal-but-
    // visible, frozen-spec:294) rather than failing the whole batch.
    let owners: GHJobOwnerWithResponsible[] = []
    let ownersBlocked = false
    try {
      owners = await listJobOwners(batch)
    } catch (err) {
      if (isPermissionError(err)) ownersBlocked = true
      else throw err
    }
    const ownersByJob = groupBy(owners, (o) => o.job_id)

    // The applications the proxy rungs score against — read-only from the YTD fact store.
    const appsByJob = await loadApplicationsForJobs(supabase, batch)

    // Stage-exit-actor evidence (R6) needs job_interview_stage_id -> name so the fetcher
    // can find the Application Review exit. Load the stage definitions for this batch once
    // and close over the map in the injected fetcher.
    const stageNameById = await loadStageNames(batch)

    // Users for the owners across the batch (resolved names come off one lookup). The
    // resolver also surfaces proxy-actor names, but those ids only matter when an actor
    // IS an owner, so the owner-id user set already covers every name a resolution emits.
    const ownerUserIds = uniqAsc(owners.map((o) => o.user_id))
    const ownerUsers = ownerUserIds.length ? await listUsers(ownerUserIds) : []
    const usersById = new Map(ownerUsers.map((u) => [u.id, u]))

    // Inject the Stage-1 evidence fetchers into the resolver's PASS-2 entrypoint, 1:1.
    const fetchers: OwnershipFetchers = {
      fetchScorecards: (applicationIds) =>
        listScorecardsForApplications(applicationIds),
      fetchStageChangeActors: (apps) => getStageChangeActors(apps, stageNameById),
    }

    for (const jobId of batch) {
      const jobOwners: OwnerRow[] = (ownersByJob.get(jobId) ?? []).map((o) => ({
        user_id: o.user_id,
        type: o.type,
        responsible: o.responsible,
        active: o.active,
      }))
      const apps = (appsByJob.get(jobId) ?? []).slice(0, MAX_APPS_PER_JOB)

      // Resolve each application up the ladder (the resolver pulls proxy evidence only
      // when the cheap owner rungs don't already resolve). Each application gets its own
      // snapshot; the JOB row adopts the strongest resolution across them.
      const perApp = new Map<number, OwnershipResolution>()
      if (apps.length === 0) {
        // No applications to anchor the proxy rungs — resolve owner-evidence-only by
        // running the entrypoint with a synthetic application id of -1 (the proxy
        // fetchers receive [-1] and return nothing; the cheap rungs still fire).
        const res = await resolveOwnershipWithFetchers(
          {
            applicationId: -1,
            candidateId: -1,
            jobOwners,
            usersById,
            jobOwnersPermissionBlocked: ownersBlocked,
          },
          fetchers
        )
        perApp.set(-1, res)
      } else {
        for (const app of apps) {
          const res = await resolveOwnershipWithFetchers(
            {
              applicationId: app.application_id,
              candidateId: app.candidate_id,
              jobOwners,
              usersById,
              applicationRecruiterId: app.application_recruiter_id,
              jobOwnersPermissionBlocked: ownersBlocked,
            },
            fetchers
          )
          perApp.set(app.application_id, res)
        }
      }

      const jobResolution = strongestResolution([...perApp.values()])
      const attemptStatus = jobResolution.status as ResolutionAttemptStatus
      bump(attemptStatus)
      if (jobResolution.status !== "resolved") stillUnresolved++

      jobOwnershipRows.push({
        job_id: jobId,
        job_title: apps[0]?.job_title ?? null,
        department_id: apps[0]?.department_id ?? null,
        department_name: apps[0]?.department_name ?? null,
        confidence: jobResolution.confidence,
        resolution_status: jobResolution.status,
      })
      jobsUpgraded++

      // Snapshot append-on-change, one per real application from its OWN resolution.
      for (const app of apps) {
        const res = perApp.get(app.application_id)
        if (!res) continue
        snapshotRows.push({
          application_id: app.application_id,
          candidate_id: app.candidate_id,
          job_id: jobId,
          channel: app.channel,
          primary_recruiter_id: res.primary_recruiter_id,
          ownership_confidence: res.confidence,
          ownership_resolution_status: res.status,
          ownership_evidence_types: res.evidence_types,
        })
      }

      attemptRows.push({
        entity_type: "job_ownership",
        entity_id: String(jobId),
        channel: null,
        status: attemptStatus,
        confidence: jobResolution.confidence,
      })
    }
  }

  // === 2. Agency-source identity ===========================================
  const dueSourceIds = await collectDueSourceIds(supabase, opts.backfill)
  if (dueSourceIds.length > 0) {
    const registry = await loadRegistryResolver(supabase)
    const sourcesById = await loadSourcesById(dueSourceIds)

    for (const sourceId of dueSourceIds) {
      const src = sourcesById.get(sourceId)
      // Mirror resolveAllAgencySources' evidence construction. The resolver's A2 rung is
      // itself the Prospectly-safe gate — it fires only when sourceTypeId === AGENCY_SOURCE_TYPE_ID
      // — so passing the live source's own type.id straight through is correct: Prospectly (own
      // id collides with the type id, but its type is Prospecting) never clears A2, and a
      // source no longer present in /sources resolves to the unresolved defect (NULL
      // agency_name, never a sentinel) via the resolver's 'none' rung.
      const registryHit =
        registry.byId(sourceId) ?? (src?.name ? registry.byName(src.name) : null)

      const resolution = resolveAgencySource({
        sourceId,
        sourceName: src?.name ?? null,
        sourceTypeId: src?.type?.id ?? null,
        sourceTypeName: src?.type?.name ?? null,
        registryHit: registryHit !== null,
        registryAgencyName: registryHit?.agency_name ?? null,
      })

      const attemptStatus = resolution.status as ResolutionAttemptStatus
      bump(attemptStatus)
      if (resolution.status !== "resolved") stillUnresolved++

      agencyRows.push({
        source_id: sourceId,
        source_name: resolution.source_name,
        source_type_id: resolution.source_type_id,
        source_type_name: resolution.source_type_name,
        agency_name: resolution.agency_name,
        confidence: resolution.confidence,
        resolution_status: resolution.status,
      })
      sourcesUpgraded++

      attemptRows.push({
        entity_type: "agency_source",
        entity_id: String(sourceId),
        channel: "agency",
        status: attemptStatus,
        confidence: resolution.confidence,
      })
    }
  }

  if (opts.dryRun) {
    return {
      mode,
      dry_run: true,
      jobs_examined: dueJobIds.length,
      jobs_upgraded: 0,
      sources_examined: dueSourceIds.length,
      sources_upgraded: 0,
      snapshots_appended: 0,
      attempts_recorded: 0,
      still_unresolved: stillUnresolved,
      by_status: byStatus,
    }
  }

  // === 3. Writeback. Monotonic upserts + append-on-change snapshots + attempts. =====
  const snapshotsAppended = await writeBack(supabase, {
    jobOwnershipRows,
    agencyRows,
    snapshotRows,
    attemptRows,
    nowIso,
    nowMs,
  })

  return {
    mode,
    dry_run: false,
    jobs_examined: dueJobIds.length,
    jobs_upgraded: jobsUpgraded,
    sources_examined: dueSourceIds.length,
    sources_upgraded: sourcesUpgraded,
    snapshots_appended: snapshotsAppended,
    attempts_recorded: attemptRows.length,
    still_unresolved: stillUnresolved,
    by_status: byStatus,
  }
}

/** The job-level ownership = the strongest per-application resolution (highest confidence;
 *  among equals prefer 'resolved' over a defect, then the first by application order). The
 *  job's owners are identical across its applications, so the only thing that varies is
 *  which proxy evidence (per application) cleared a rung — the strongest wins. */
function strongestResolution(resolutions: OwnershipResolution[]): OwnershipResolution {
  let best = resolutions[0]
  for (const r of resolutions.slice(1)) {
    const better =
      CONFIDENCE_RANK[r.confidence] > CONFIDENCE_RANK[best.confidence] ||
      (CONFIDENCE_RANK[r.confidence] === CONFIDENCE_RANK[best.confidence] &&
        r.status === "resolved" &&
        best.status !== "resolved")
    if (better) best = r
  }
  return best
}

// ---------------------------------------------------------------------------
// Due-work selection.
//   Forward (default): jobs with a below-floor greenhouse_job_ownership row, plus jobs
//   named by a due/retriable identity_resolution_attempts row, plus jobs whose latest
//   application_ownership_snapshot is below the floor and still mutable (resolved_at null).
//   Backfill (?backfill=1): every job touched by an existing ytd_application_fact.
// permission_blocked rows are excluded — terminal-but-visible, not retried (frozen-spec:294).
// ---------------------------------------------------------------------------

async function collectDueJobIds(
  supabase: SupabaseLike,
  backfill: boolean
): Promise<number[]> {
  const ids = new Set<number>()
  const nowIso = new Date().toISOString()

  if (backfill) {
    const rows = await selectAll<{ job_id: number }>(
      supabase,
      "ytd_application_facts",
      "job_id"
    )
    for (const r of rows) if (Number.isFinite(r.job_id)) ids.add(r.job_id)
    return [...ids].sort((a, b) => a - b).slice(0, BACKFILL_MAX_JOBS)
  }

  const ownershipDue = await query<{ job_id: number }>(supabase, (c) =>
    c
      .from("greenhouse_job_ownership")
      .select("job_id")
      .in("confidence", BELOW_FLOOR_CONFIDENCE)
      .neq("resolution_status", "permission_blocked")
      .limit(FORWARD_MAX_JOBS)
  )
  for (const r of ownershipDue) if (Number.isFinite(r.job_id)) ids.add(r.job_id)

  const attemptsDue = await query<{ entity_id: string }>(supabase, (c) =>
    c
      .from("identity_resolution_attempts")
      .select("entity_id")
      .eq("entity_type", "job_ownership")
      .in("status", ["unresolved", "ambiguous", "failed"])
      .lte("next_retry_at", nowIso)
      .limit(FORWARD_MAX_JOBS)
  )
  for (const r of attemptsDue) {
    const id = Number(r.entity_id)
    if (Number.isFinite(id)) ids.add(id)
  }

  const snapDue = await query<{ job_id: number }>(supabase, (c) =>
    c
      .from("application_ownership_snapshots")
      .select("job_id")
      .in("ownership_confidence", BELOW_FLOOR_CONFIDENCE)
      .neq("ownership_resolution_status", "permission_blocked")
      .is("ownership_resolved_at", null)
      .limit(FORWARD_MAX_JOBS)
  )
  for (const r of snapDue) if (Number.isFinite(r.job_id)) ids.add(r.job_id)

  return [...ids].sort((a, b) => a - b).slice(0, FORWARD_MAX_JOBS)
}

async function collectDueSourceIds(
  supabase: SupabaseLike,
  backfill: boolean
): Promise<number[]> {
  const ids = new Set<number>()
  const nowIso = new Date().toISOString()

  if (backfill) {
    const rows = await selectAll<{ agency_source_id: number | null }>(
      supabase,
      "ytd_application_facts",
      "agency_source_id"
    )
    for (const r of rows) {
      if (r.agency_source_id != null && Number.isFinite(r.agency_source_id)) {
        ids.add(r.agency_source_id)
      }
    }
    return [...ids].sort((a, b) => a - b).slice(0, BACKFILL_MAX_SOURCES)
  }

  // agency_source_resolution has the narrower domain (no permission_blocked); below-floor
  // = confidence in {inferred, unresolved}.
  const resDue = await query<{ source_id: number }>(supabase, (c) =>
    c
      .from("agency_source_resolution")
      .select("source_id")
      .in("confidence", BELOW_FLOOR_CONFIDENCE)
      .limit(FORWARD_MAX_SOURCES)
  )
  for (const r of resDue) if (Number.isFinite(r.source_id)) ids.add(r.source_id)

  const attemptsDue = await query<{ entity_id: string }>(supabase, (c) =>
    c
      .from("identity_resolution_attempts")
      .select("entity_id")
      .in("entity_type", ["agency_source", "agency_submitter"])
      .in("status", ["unresolved", "ambiguous", "failed"])
      .lte("next_retry_at", nowIso)
      .limit(FORWARD_MAX_SOURCES)
  )
  for (const r of attemptsDue) {
    const id = Number(r.entity_id)
    if (Number.isFinite(id)) ids.add(id)
  }

  return [...ids].sort((a, b) => a - b).slice(0, FORWARD_MAX_SOURCES)
}

// ---------------------------------------------------------------------------
// Evidence + reference loaders.
// ---------------------------------------------------------------------------

interface ReconcileApp {
  application_id: number
  candidate_id: number
  job_id: number
  channel: ResolutionChannel
  job_title: string | null
  department_id: number | null
  department_name: string | null
  application_recruiter_id: number | null
}

/** Applications (from the YTD fact store) on the given jobs — the population the proxy
 *  rungs score against. Read-only; ytd_application_facts is never written here. */
async function loadApplicationsForJobs(
  supabase: SupabaseLike,
  jobIds: number[]
): Promise<Map<number, ReconcileApp[]>> {
  const out = new Map<number, ReconcileApp[]>()
  if (jobIds.length === 0) return out

  for (const batch of chunk(jobIds, 200)) {
    const rows = await query<{
      application_id: number
      candidate_id: number
      job_id: number
      channel: ResolutionChannel
      job_title: string | null
      department_id: number | null
      department_name: string | null
    }>(supabase, (c) =>
      c
        .from("ytd_application_facts")
        .select(
          "application_id, candidate_id, job_id, channel, job_title, department_id, department_name"
        )
        .in("job_id", batch)
    )
    for (const r of rows) {
      const app: ReconcileApp = {
        application_id: r.application_id,
        candidate_id: r.candidate_id,
        job_id: r.job_id,
        channel: r.channel,
        job_title: r.job_title,
        department_id: r.department_id,
        department_name: r.department_name,
        // applicationRecruiterId is the LIVE application recruiter from Greenhouse (the R2
        // owner_match rung input, identity-resolver.ts). ytd_application_facts does NOT store it —
        // primary_recruiter_id is the RESOLVED owner, and feeding that back would make R2 fire on
        // stale resolution output. No live value exists on the fact, so it is null; reconcile
        // relies on R1/R3 + the proxy rungs R4-R6.
        application_recruiter_id: null,
      }
      const list = out.get(r.job_id)
      if (list) list.push(app)
      else out.set(r.job_id, [app])
    }
  }
  return out
}

/** job_interview_stage_id -> stage name, for the stage-exit-actor rung. getStageChangeActors
 *  is a single-responsibility evidence shaper and does NOT load stage definitions itself, so
 *  the caller supplies the map (greenhouse-evidence.ts:292). */
async function loadStageNames(jobIds: number[]): Promise<Map<number, string | null>> {
  const map = new Map<number, string | null>()
  if (jobIds.length === 0) return map
  const defs = await fetchByIdsLocal<YtdGHJobInterviewStage>(
    "/job_interview_stages",
    "job_ids",
    jobIds
  )
  for (const def of defs) map.set(def.id, def.name ?? def.stage_name ?? null)
  return map
}

/** Build the injected AgencyRegistryResolver from agency_source_registry (migration 001 —
 *  the thin id->name cache: source_id, source_name, source_type, last_verified_at; NO
 *  agency_name column). The registry's canonical agency display IS its source_name, so the
 *  resolver's AgencyRegistryEntry.agency_name is derived from it. byId is the A1 path; byName
 *  covers id-less rows. */
async function loadRegistryResolver(supabase: SupabaseLike): Promise<AgencyRegistryResolver> {
  const rows = await query<{
    source_id: number
    source_name: string | null
  }>(supabase, (c) =>
    c.from("agency_source_registry").select("source_id, source_name")
  )
  const byId = new Map<number, AgencyRegistryEntry>()
  const byName = new Map<string, AgencyRegistryEntry>()
  for (const r of rows) {
    if (!Number.isFinite(r.source_id)) continue
    const entry: AgencyRegistryEntry = {
      source_id: r.source_id,
      source_name: r.source_name ?? "",
      agency_name: r.source_name ?? null,
    }
    byId.set(r.source_id, entry)
    if (entry.source_name) byName.set(entry.source_name, entry)
  }
  return {
    byId: (id) => byId.get(id) ?? null,
    byName: (name) => byName.get(name) ?? null,
  }
}

/** Live /sources, filtered to the ids in scope. The live source set is small (dozens), so
 *  one paginated pull + a filter is cheaper than per-id calls. */
async function loadSourcesById(sourceIds: number[]): Promise<Map<number, GHSource>> {
  if (sourceIds.length === 0) return new Map()
  const want = new Set(sourceIds)
  const all = await greenhouseGetAll<GHSource>("/sources", { per_page: 500 })
  const out = new Map<number, GHSource>()
  for (const s of all) if (want.has(s.id)) out.set(s.id, s)
  return out
}

// ---------------------------------------------------------------------------
// Durable-row shapes (the columns of migration 005 this cron writes back).
// ---------------------------------------------------------------------------

interface JobOwnershipRow {
  job_id: number
  job_title: string | null
  department_id: number | null
  department_name: string | null
  confidence: ResolutionConfidence
  resolution_status: ResolutionStatus
}

interface AgencyResolutionRow {
  source_id: number
  source_name: string | null
  source_type_id: number | null
  source_type_name: string | null
  agency_name: string | null
  confidence: ResolutionConfidence
  resolution_status: AgencyResolutionStatus
}

interface SnapshotRow {
  application_id: number
  candidate_id: number
  job_id: number
  channel: ResolutionChannel
  primary_recruiter_id: number | null
  ownership_confidence: ResolutionConfidence
  ownership_resolution_status: ResolutionStatus
  ownership_evidence_types: OwnershipEvidenceType[]
}

interface AttemptRow {
  entity_type: ResolutionEntityType
  entity_id: string
  channel: ResolutionChannel | null
  status: ResolutionAttemptStatus
  confidence: ResolutionConfidence | null
}

// ---------------------------------------------------------------------------
// Writeback. greenhouse_job_ownership + agency_source_resolution are upserted ONLY when
// the new confidence is >= the stored one (monotonic, frozen-spec:441 — reconcile never
// downgrades). Snapshots append ONLY on a value/confidence change vs the latest snapshot.
// identity_resolution_attempts is updated in place per (entity_type, entity_id) with the
// next backoff target. No alert_ledger writes anywhere.
// ---------------------------------------------------------------------------

async function writeBack(
  supabase: SupabaseLike,
  args: {
    jobOwnershipRows: JobOwnershipRow[]
    agencyRows: AgencyResolutionRow[]
    snapshotRows: SnapshotRow[]
    attemptRows: AttemptRow[]
    nowIso: string
    nowMs: number
  }
): Promise<number> {
  const { jobOwnershipRows, agencyRows, snapshotRows, attemptRows, nowIso, nowMs } = args

  // --- greenhouse_job_ownership: monotonic upsert ---
  if (jobOwnershipRows.length > 0) {
    const jobIds = jobOwnershipRows.map((r) => r.job_id)
    const priors = await query<{ job_id: number; confidence: ResolutionConfidence }>(
      supabase,
      (c) =>
        c.from("greenhouse_job_ownership").select("job_id, confidence").in("job_id", jobIds)
    )
    const priorById = new Map(priors.map((p) => [p.job_id, p.confidence]))

    const upserts = jobOwnershipRows
      .filter((r) => {
        const prior = priorById.get(r.job_id)
        return prior == null || CONFIDENCE_RANK[r.confidence] >= CONFIDENCE_RANK[prior]
      })
      .map((r) => ({
        job_id: r.job_id,
        job_title: r.job_title,
        department_id: r.department_id,
        department_name: r.department_name,
        confidence: r.confidence,
        resolution_status: r.resolution_status,
        last_seen_at: nowIso,
        last_verified_at: nowIso,
      }))

    if (upserts.length > 0) {
      const { error } = await supabase
        .from("greenhouse_job_ownership")
        .upsert(upserts, { onConflict: "job_id" })
      if (error) throw new Error(`job_ownership upsert failed: ${error.message}`)
    }
  }

  // --- agency_source_resolution: monotonic upsert ---
  if (agencyRows.length > 0) {
    const sourceIds = agencyRows.map((r) => r.source_id)
    const priors = await query<{ source_id: number; confidence: ResolutionConfidence }>(
      supabase,
      (c) =>
        c
          .from("agency_source_resolution")
          .select("source_id, confidence")
          .in("source_id", sourceIds)
    )
    const priorById = new Map(priors.map((p) => [p.source_id, p.confidence]))

    const upserts = agencyRows
      .filter((r) => {
        const prior = priorById.get(r.source_id)
        return prior == null || CONFIDENCE_RANK[r.confidence] >= CONFIDENCE_RANK[prior]
      })
      .map((r) => ({
        source_id: r.source_id,
        source_name: r.source_name,
        source_type_id: r.source_type_id,
        source_type_name: r.source_type_name,
        agency_name: r.agency_name,
        confidence: r.confidence,
        resolution_status: r.resolution_status,
        last_verified_at: nowIso,
      }))

    if (upserts.length > 0) {
      const { error } = await supabase
        .from("agency_source_resolution")
        .upsert(upserts, { onConflict: "source_id" })
      if (error) throw new Error(`agency_source_resolution upsert failed: ${error.message}`)
    }
  }

  // --- application_ownership_snapshots: append ON CHANGE only ---
  const snapshotsAppended = await appendChangedSnapshots(supabase, snapshotRows, nowIso)

  // --- identity_resolution_attempts: update-in-place with backoff ---
  await recordAttempts(supabase, attemptRows, nowMs)

  return snapshotsAppended
}

/** Append a snapshot only when the (confidence, resolution_status, primary_recruiter_id)
 *  triple differs from the most recent snapshot for that application+channel. Append-on-
 *  change keeps the audit history without a row per reconcile run (the locked default).
 *  ownership_resolved_at is set the first time a row reaches 'high'+ (the lock point,
 *  frozen-spec:352) — once set on a prior snapshot it is carried forward, never cleared. */
async function appendChangedSnapshots(
  supabase: SupabaseLike,
  rows: SnapshotRow[],
  nowIso: string
): Promise<number> {
  if (rows.length === 0) return 0

  const appIds = uniqAsc(rows.map((r) => r.application_id))
  const latestByApp = new Map<
    string,
    {
      confidence: ResolutionConfidence
      status: string
      recruiterId: number | null
      resolvedAt: string | null
    }
  >()
  const everResolvedAt = new Map<string, string>()

  for (const batch of chunk(appIds, 200)) {
    const priors = await query<{
      application_id: number
      channel: ResolutionChannel
      ownership_confidence: ResolutionConfidence
      ownership_resolution_status: string
      primary_recruiter_id: number | null
      ownership_resolved_at: string | null
      created_at: string
    }>(supabase, (c) =>
      c
        .from("application_ownership_snapshots")
        .select(
          "application_id, channel, ownership_confidence, ownership_resolution_status, primary_recruiter_id, ownership_resolved_at, created_at"
        )
        .in("application_id", batch)
        .order("created_at", { ascending: false })
    )
    for (const p of priors) {
      const key = `${p.application_id}:${p.channel}`
      // First row per (app, channel) is the latest (desc order).
      if (!latestByApp.has(key)) {
        latestByApp.set(key, {
          confidence: p.ownership_confidence,
          status: p.ownership_resolution_status,
          recruiterId: p.primary_recruiter_id,
          resolvedAt: p.ownership_resolved_at,
        })
      }
      // Earliest lock point across all snapshots for the app+channel (carry it forward).
      if (p.ownership_resolved_at && !everResolvedAt.has(key)) {
        everResolvedAt.set(key, p.ownership_resolved_at)
      }
    }
  }

  const inserts = rows
    .filter((r) => {
      const prior = latestByApp.get(`${r.application_id}:${r.channel}`)
      if (!prior) return true
      return (
        prior.confidence !== r.ownership_confidence ||
        prior.status !== r.ownership_resolution_status ||
        prior.recruiterId !== r.primary_recruiter_id
      )
    })
    .map((r) => {
      const key = `${r.application_id}:${r.channel}`
      const reachedHighNow =
        CONFIDENCE_RANK[r.ownership_confidence] >= CONFIDENCE_RANK["high"] &&
        r.ownership_resolution_status === "resolved"
      // The lock point is monotonic: keep the earliest prior resolved_at if one exists,
      // else stamp now if this snapshot is the first to reach high+.
      const resolvedAt =
        everResolvedAt.get(key) ?? (reachedHighNow ? nowIso : null)
      return {
        application_id: r.application_id,
        candidate_id: r.candidate_id,
        job_id: r.job_id,
        channel: r.channel,
        primary_recruiter_id: r.primary_recruiter_id,
        ownership_source: "reconcile",
        ownership_confidence: r.ownership_confidence,
        ownership_resolution_status: r.ownership_resolution_status,
        ownership_evidence_types: r.ownership_evidence_types,
        ownership_resolved_at: resolvedAt,
      }
    })

  if (inserts.length === 0) return 0
  // Append-only: insert (never upsert) — the surrogate id is the uniqueness key (005:40).
  for (const batch of chunk(inserts, 500)) {
    const { error } = await supabase.from("application_ownership_snapshots").insert(batch)
    if (error) throw new Error(`snapshot insert failed: ${error.message}`)
  }
  return inserts.length
}

/** Update the live attempt row per (entity_type, entity_id): bump attempt_number, stamp
 *  status/confidence, set the next backoff target (NULL once resolved, NULL for
 *  permission_blocked — terminal-but-visible). Idempotent on unique(entity_type, entity_id). */
async function recordAttempts(
  supabase: SupabaseLike,
  rows: AttemptRow[],
  nowMs: number
): Promise<void> {
  if (rows.length === 0) return

  const priorByKey = new Map<string, number>()
  for (const batch of chunk(rows, 200)) {
    const entityIds = batch.map((r) => r.entity_id)
    const priors = await query<{
      entity_type: ResolutionEntityType
      entity_id: string
      attempt_number: number
    }>(supabase, (c) =>
      c
        .from("identity_resolution_attempts")
        .select("entity_type, entity_id, attempt_number")
        .in("entity_id", entityIds)
    )
    for (const p of priors) {
      priorByKey.set(`${p.entity_type}:${p.entity_id}`, p.attempt_number)
    }
  }

  const nowIso = new Date(nowMs).toISOString()
  const upserts: ResolutionAttempt[] = rows.map((r) => {
    const prior = priorByKey.get(`${r.entity_type}:${r.entity_id}`) ?? 0
    const attemptNumber = prior + 1
    const evidenceChecked =
      r.entity_type === "job_ownership"
        ? ["job_owners", "scorecards", "notes", "stage_actors"]
        : ["registry", "sources"]
    return {
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      channel: r.channel,
      status: r.status,
      confidence: r.confidence,
      attempt_number: attemptNumber,
      evidence_sources_checked: evidenceChecked,
      failure_reason: r.status === "resolved" ? null : `reconcile:${r.status}`,
      next_retry_at: retryTargetFor(r.status, attemptNumber, nowMs),
      attempted_at: nowIso,
      metadata: { source: "reconcile-identity" },
    }
  })

  for (const batch of chunk(upserts, 500)) {
    const { error } = await supabase
      .from("identity_resolution_attempts")
      .upsert(batch, { onConflict: "entity_type,entity_id" })
    if (error) throw new Error(`attempts upsert failed: ${error.message}`)
  }
}

/** Backoff target for an attempt row: NULL once resolved (resolution-types.ts:178),
 *  NULL for permission_blocked (terminal-but-visible, NOT re-queued — frozen-spec:294),
 *  exponential backoff otherwise. */
function retryTargetFor(
  status: ResolutionAttemptStatus,
  attemptNumber: number,
  nowMs: number
): string | null {
  if (status === "resolved" || status === "permission_blocked") return null
  return nextRetryAt(attemptNumber, nowMs)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function uniqAsc(values: Array<number | null | undefined>): number[] {
  const seen = new Set<number>()
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) seen.add(v)
  return [...seen].sort((a, b) => a - b)
}

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

// ---------------------------------------------------------------------------
// Supabase query plumbing — thin wrappers so every .from() goes through one error-checked
// path. The client is untyped (no generated Database types in this repo), so the casts are
// localized here. Mirrors the { data, error } read pattern used across lib/sweep-agency.ts.
// ---------------------------------------------------------------------------

type SupabaseLike = ReturnType<typeof getSupabase>

interface PgResult<T> {
  data: T[] | null
  error: { message: string } | null
}

async function query<T>(
  supabase: SupabaseLike,
  build: (c: SupabaseLike) => unknown
): Promise<T[]> {
  const res = (await build(supabase)) as PgResult<T>
  if (res.error) throw new Error(res.error.message)
  return res.data ?? []
}

/** Paginated full-table column scan (backfill only). Reads 1000-row pages via range() so a
 *  large ytd_application_facts doesn't hit the implicit row cap. */
async function selectAll<T>(
  supabase: SupabaseLike,
  table: string,
  columns: string
): Promise<T[]> {
  const out: T[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const res = (await (
      supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            range: (a: number, b: number) => Promise<PgResult<T>>
          }
        }
      }
    )
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1)) as PgResult<T>
    if (res.error) throw new Error(res.error.message)
    const rows = res.data ?? []
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Local copy of greenhouse-evidence's permission classifier + id-batch fetcher. Those
// helpers aren't exported; the route needs the same 401/403 -> permission_blocked semantics
// on its own listJobOwners try/catch and /job_interview_stages fetch, with the same
// <=50-id batch (greenhouse-evidence.ts:47, :97-101).
// ---------------------------------------------------------------------------

const PERMISSION_STATUS_RE = /Greenhouse API error:\s*(401|403)\b/

function isPermissionError(err: unknown): boolean {
  return err instanceof Error && PERMISSION_STATUS_RE.test(err.message)
}

async function fetchByIdsLocal<T>(
  path: string,
  idsParam: string,
  ids: number[]
): Promise<T[]> {
  const clean = uniqAsc(ids)
  if (clean.length === 0) return []
  const out: T[] = []
  for (const batch of chunk(clean, 50)) {
    out.push(
      ...(await greenhouseGetAll<T>(path, {
        [idsParam]: batch.join(","),
        per_page: 500,
      }))
    )
  }
  return out
}
