import { greenhouseGetAll } from "./greenhouse-client"
import { listJobOwners } from "./greenhouse-evidence"
import { readEnv } from "./env"
import { postSlackDm } from "./notification-delivery"
import { supabase } from "./supabase"
import { SWEEP_CONFIG } from "./sweep-config"
import type { GHCandidate } from "./sweep-types"
import { applyDualAgencyConflicts, applyFeeRiskStates, applyPriorHistoryConflicts } from "./ytd-conflicts"
import {
  buildApplicationFact,
  buildJobOwnerSnapshots,
  buildStageDefinitions,
  buildStageEvents,
  dedupeByKey,
  toCandidateSummary,
  toJobSummary,
  uniqSortedNumbers,
  type YtdApplicationFactWithOwnership,
} from "./ytd-normalize"
import type {
  DuplicateConfidence,
  DuplicateEvidenceType,
  FeeRiskState,
  YtdApplicationFact,
  YtdBuildContext,
  YtdChannel,
  YtdChannelInput,
  YtdConflictType,
  YtdDataQualityFlag,
  YtdGHCandidate,
  YtdGHDepartment,
  YtdGHJob,
  YtdGHApplication,
  YtdGHApplicationStage,
  YtdGHJobInterviewStage,
  YtdGHReferrer,
  YtdGHUser,
  YtdJobOwnerSnapshot,
  YtdJobSummary,
  YtdRunOptions,
  YtdRunResult,
  YtdStageDefinition,
  YtdStageEvent,
} from "./ytd-types"

const BATCH_SIZE = 50
const SOURCE_ID_BATCH_SIZE = 20

// C2 watermark safety overlap. The next incremental's `since` is rolled back this far from
// the prior run's covered_through (= max updated_at it actually fetched) so clock skew and
// writes in flight at the moment of the prior run are re-scanned, not skipped (frozen-spec:598).
// Re-fetching a few already-covered apps is idempotent (the upsert is keyed on application_id).
const WATERMARK_OVERLAP_MS = 6 * 60 * 60 * 1000

/** The single mutation clock the incremental watermark keys on, server- AND client-side.
 *  Greenhouse treats updated_at (per-application mutation time) and last_activity_at (a coarse
 *  per-candidate activity clock) as independent filter params; the old code filtered the server
 *  query on last_activity_at while re-filtering in memory on updated_at, so apps whose updated_at
 *  moved but last_activity_at did not were silently dropped (frozen-spec:593-613, live-confirmed).
 *  updated_at is authoritative here — it is the clock a late stage/owner/status mutation bumps. */
function updatedAt(app: YtdGHApplication): string | null {
  return app.updated_at ?? app.last_activity_at ?? null
}

/** Latest valid ISO timestamp in a list (ignores null/unparseable), or null if none. Used to
 *  derive the run's coverage watermark from the apps it actually fetched (C2). */
function maxIso(values: Array<string | null | undefined>): string | null {
  let bestMs = -Infinity
  let best: string | null = null
  for (const v of values) {
    if (!v) continue
    const ms = new Date(v).getTime()
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms
      best = v
    }
  }
  return best
}

function currentYear(): number {
  return new Date().getUTCFullYear()
}

function yearStart(year: number): string {
  return `${year}-01-01T00:00:00Z`
}

function channelsFor(input: YtdChannelInput | undefined): YtdChannel[] {
  if (input === "referral" || input === "agency") return [input]
  return ["referral", "agency"]
}

function chunks<T>(values: T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

async function fetchBatched<T>(
  path: string,
  idsParam: string,
  ids: number[],
  extra?: Record<string, string | number | boolean | undefined>
): Promise<T[]> {
  const out: T[] = []
  for (const batch of chunks(uniqSortedNumbers(ids))) {
    if (batch.length === 0) continue
    out.push(
      ...(await greenhouseGetAll<T>(path, {
        ...extra,
        [idsParam]: batch.join(","),
        per_page: 500,
      }))
    )
  }
  return out
}

async function fetchAgencySources(): Promise<Map<number, string>> {
  const { data, error } = await supabase
    .from("agency_source_registry")
    .select("source_id, source_name")
  if (error) throw new Error(`Failed to read agency source registry: ${error.message}`)
  const sources = new Map(
    (data ?? []).map((row: { source_id: number; source_name: string }) => [
      row.source_id,
      row.source_name,
    ])
  )
  if (sources.size === 0) {
    throw new Error("No agency sources in registry. Run /api/sweeps/resolve-agencies first.")
  }
  return sources
}

// ---------------------------------------------------------------------------
// C3 — persisted conflict/fee state. One read of ytd_application_facts serves two needs:
//   1. the dual-agency reconcile SUPERSET (so a one-sided incremental re-touch still pairs
//      against its persisted partner instead of being rebuilt as a clean, conflict-free row),
//   2. merge-PRESERVE on upsert (so the blind onConflict=application_id write never overwrites
//      a known conflict/fee verdict with the rebuilt defaults when the conflict isn't re-detected
//      this run). Both read the same columns; loading once keeps them consistent.
// ---------------------------------------------------------------------------

/** The conflict + fee + identity columns persisted on a fact, plus what the dual-agency
 *  reconcile needs to pair it. Mirrors the migration-003/004 column names exactly. */
interface PersistedConflictRow {
  application_id: number
  candidate_id: number
  job_id: number
  candidate_email: string | null
  candidate_name: string | null
  submitted_at: string | null
  agency_source_id: number | null
  agency_source_name: string | null
  conflict_detected: boolean | null
  conflict_types: YtdConflictType[] | null
  dual_agency_group_key: string | null
  prior_internal_application_ids: number[] | null
  duplicate_confidence: DuplicateConfidence | null
  duplicate_evidence_types: DuplicateEvidenceType[] | null
  duplicate_candidate_ids: number[] | null
  fee_risk_state: FeeRiskState | null
  fee_risk_reason: string | null
  conflict_detail: Record<string, unknown> | null
}

const PERSISTED_CONFLICT_COLUMNS =
  "application_id, candidate_id, job_id, candidate_email, candidate_name, submitted_at, " +
  "agency_source_id, agency_source_name, conflict_detected, conflict_types, dual_agency_group_key, " +
  "prior_internal_application_ids, duplicate_confidence, duplicate_evidence_types, " +
  "duplicate_candidate_ids, fee_risk_state, fee_risk_reason, conflict_detail"

/** Load ALL persisted agency facts for the batch's job_ids (including the in-batch applications).
 *  Serves two consumers with opposite filters, so it stays unfiltered and each consumer handles
 *  its own view: the dual-agency reconcile de-dupes by application_id with the in-batch copy
 *  winning (ytd-conflicts.ts:276-278), so an in-batch row passed here is harmlessly superseded;
 *  merge-preserve looks up an application's OWN prior row by application_id. Read-only. */
async function loadExistingAgencyFacts(jobIds: number[]): Promise<PersistedConflictRow[]> {
  if (jobIds.length === 0) return []
  const out: PersistedConflictRow[] = []
  for (const batch of chunks(jobIds, 200)) {
    if (batch.length === 0) continue
    const { data, error } = await supabase
      .from("ytd_application_facts")
      .select(PERSISTED_CONFLICT_COLUMNS)
      .eq("channel", "agency")
      .in("job_id", batch)
    if (error) throw new Error(`Failed to load existing agency facts: ${error.message}`)
    out.push(...((data ?? []) as unknown as PersistedConflictRow[]))
  }
  return out
}

/** C3 merge-preserve. For each in-batch fact rebuilt CONFLICT-FREE whose persisted row carried a
 *  conflict, copy the persisted conflict + fee + duplicate columns back onto the fact so the
 *  upsert preserves the prior verdict instead of overwriting it with the rebuild defaults. A
 *  fact the passes DID re-flag this run is left untouched (the fresh verdict wins). Idempotent. */
function mergePreserveConflicts(
  facts: YtdApplicationFactWithOwnership[],
  existingRows: PersistedConflictRow[]
): void {
  const priorByAppId = new Map<number, PersistedConflictRow>()
  for (const row of existingRows) priorByAppId.set(row.application_id, row)

  for (const fact of facts) {
    if (fact.conflict_detected) continue // re-flagged this run — keep the fresh verdict
    const prior = priorByAppId.get(fact.application_id)
    if (!prior || !prior.conflict_detected) continue // nothing to preserve

    fact.conflict_detected = true
    fact.conflict_types = prior.conflict_types ?? []
    fact.dual_agency_group_key = prior.dual_agency_group_key
    fact.prior_internal_application_ids = prior.prior_internal_application_ids ?? []
    fact.conflict_detail = prior.conflict_detail
    if (prior.duplicate_confidence) fact.duplicate_confidence = prior.duplicate_confidence
    fact.duplicate_evidence_types = prior.duplicate_evidence_types ?? []
    fact.duplicate_candidate_ids = prior.duplicate_candidate_ids ?? []
    if (prior.fee_risk_state) fact.fee_risk_state = prior.fee_risk_state
    fact.fee_risk_reason = prior.fee_risk_reason
  }
}

/** Reconstruct the minimal YtdApplicationFact the dual-agency reconcile reads off `existingFacts`
 *  (identity + source + submitted_at; everything else is stubbed at the build-time defaults the
 *  pure pass never consults). Channel is 'agency' by construction — loadExistingAgencyFacts filters
 *  to it — so this only ever supplies agency partners. */
function existingFactForReconcile(row: PersistedConflictRow): YtdApplicationFact {
  return {
    application_id: row.application_id,
    scan_year: 0,
    channel: "agency",
    candidate_id: row.candidate_id,
    candidate_name: row.candidate_name,
    candidate_email: row.candidate_email,
    job_id: row.job_id,
    job_title: null,
    source_id: row.agency_source_id,
    source_name: row.agency_source_name,
    department_id: null,
    department_name: null,
    application_status: null,
    applied_at: row.submitted_at,
    submitted_at: row.submitted_at,
    last_activity_at: null,
    referrer_id: null,
    referrer_name: null,
    agency_source_id: row.agency_source_id,
    agency_source_name: row.agency_source_name,
    primary_recruiter_id: null,
    primary_recruiter_name: null,
    recruiter_ids: [],
    recruiter_names: [],
    current_stage_id: null,
    current_stage_name: null,
    current_stage_entered_at: null,
    application_review_entered_at: null,
    application_review_exited_at: null,
    actioned_at: null,
    first_action_at: null,
    action_time_hours: null,
    first_action_time_hours: null,
    never_actioned: false,
    action_time_quality: "unknown",
    action_bucket: "unknown",
    max_stage_id: null,
    max_stage_name: null,
    max_stage_rank: null,
    terminal_outcome: "unknown",
    conflict_detected: false,
    conflict_types: [],
    dual_agency_group_key: null,
    prior_internal_application_ids: [],
    duplicate_confidence: "insufficient_data",
    duplicate_evidence_types: [],
    duplicate_candidate_ids: [],
    fee_risk_state: "insufficient_data",
    fee_risk_reason: null,
    conflict_detail: null,
    data_quality_flags: [],
    last_synced_at: "",
    sync_run_id: null,
  }
}

async function fetchApplications(
  channel: YtdChannel,
  scanYear: number,
  sinceIso?: string | null
): Promise<YtdGHApplication[]> {
  // C2: the incremental cutoff keys the server query on updated_at — the per-application
  // mutation clock — NOT last_activity_at. created_at scopes the calendar year regardless.
  const sharedParams = {
    created_at: `gte|${yearStart(scanYear)}`,
    updated_at: sinceIso ? `gte|${sinceIso}` : undefined,
    per_page: 500,
  }

  if (channel === "referral") {
    // C8: capture EVERY configured referral source, not just the first. Greenhouse joins
    // a comma-separated source_ids list; one query covers the (currently 2-tolerant) set.
    return greenhouseGetAll<YtdGHApplication>("/applications", {
      source_ids: SWEEP_CONFIG.referral.sourceIds.join(","),
      ...sharedParams,
    })
  }

  const agencySourceIds = new Set((await fetchAgencySources()).keys())
  return (
    await Promise.all(
      chunks([...agencySourceIds], SOURCE_ID_BATCH_SIZE).map((batch) =>
        greenhouseGetAll<YtdGHApplication>("/applications", {
          source_ids: batch.join(","),
          ...sharedParams,
        })
      )
    )
  ).flat()
}

async function fetchIncrementalApplications(
  channel: YtdChannel,
  scanYear: number,
  sinceIso: string | null
): Promise<YtdGHApplication[]> {
  // C2: the server query now filters on the SAME field the watermark advances on
  // (updated_at, via fetchApplications), so the old in-memory re-filter — which keyed
  // updated_at while the server keyed last_activity_at and could only ever SHRINK the
  // server result, never recover a dropped app — is deleted. One field, one source of
  // truth; nothing to reconcile client-side (frozen-spec:598 fix #3).
  return fetchApplications(channel, scanYear, sinceIso)
}

/**
 * C2 watermark read: the `since` for the next incremental is the prior run's coverage
 * watermark (covered_through = max updated_at it actually fetched), NOT its wall-clock
 * started_at. started_at advanced past data the run never covered; covered_through does not.
 * A safety overlap (WATERMARK_OVERLAP_MS) is subtracted so writes in flight during the prior
 * run are re-scanned. Returns null (=> full-year scan) when no prior run recorded a watermark.
 */
async function incrementalSinceIso(
  scanYear: number,
  channel: YtdChannelInput
): Promise<string | null> {
  const { data } = await supabase
    .from("ytd_sync_runs")
    .select("metadata")
    .eq("scan_year", scanYear)
    .eq("status", "completed")
    .in("channel", [channel, "all"])
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(50)

  for (const row of (data ?? []) as Array<{ metadata: Record<string, unknown> | null }>) {
    const coveredThrough = row.metadata?.covered_through
    if (typeof coveredThrough === "string") {
      const ms = new Date(coveredThrough).getTime()
      if (Number.isFinite(ms)) {
        return new Date(ms - WATERMARK_OVERLAP_MS).toISOString()
      }
    }
  }
  return null
}

async function createRun(options: Required<Pick<YtdRunOptions, "runType">> & {
  scanYear: number
  channel: YtdChannelInput
}): Promise<string> {
  const { data, error } = await supabase
    .from("ytd_sync_runs")
    .insert({
      scan_year: options.scanYear,
      run_type: options.runType,
      channel: options.channel,
      status: "running",
    })
    .select("id")
    .single()
  if (error || !data) throw new Error(`Failed to create YTD sync run: ${error?.message}`)
  return data.id as string
}

async function completeRun(
  runId: string,
  // Exactly the three counters this writes to ytd_sync_runs. (Pick, not Omit, so adding a
  // non-persisted field to YtdRunResult — e.g. applications_skipped_no_job — doesn't force a
  // value here that has no column.)
  result: Pick<
    YtdRunResult,
    "applications_scanned" | "facts_upserted" | "stage_events_upserted"
  >,
  metadata: Record<string, unknown>
) {
  await supabase
    .from("ytd_sync_runs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      applications_scanned: result.applications_scanned,
      facts_upserted: result.facts_upserted,
      stage_events_upserted: result.stage_events_upserted,
      metadata,
    })
    .eq("id", runId)
}

async function failRun(
  runId: string | null,
  err: unknown,
  ctx: { scanYear: number; channel: YtdChannelInput; runType: YtdRunOptions["runType"] }
) {
  if (!runId) return
  const message = err instanceof Error ? err.message : String(err)
  await supabase
    .from("ytd_sync_runs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: message,
    })
    .eq("id", runId)

  // Dormant-by-default failure alert (mirrors the NOTIFY_*_SEND / YTD_OWNERSHIP_WRITEBACK gates).
  // failRun is the single funnel for EVERY failure path — the daily incremental cron, the
  // /api/ytd/backfill route, and any manual run — so alerting here (not in the cron route) covers
  // a failed backfill too. The Slack call gets its OWN try/catch: failRun runs inside
  // runYtdSync's catch and the original sync error is rethrown right after, so a Slack outage must
  // never mask or replace it. Cadence is intentionally a daily nag — a dead pipeline should stay
  // loud (these failures went unnoticed for 18 days precisely because nothing alerted).
  if (readEnv("YTD_SYNC_ALERT_SEND")?.toLowerCase() === "true") {
    try {
      await postSlackDm(
        SWEEP_CONFIG.slack.headOfTaUserId,
        `:rotating_light: YTD sync failed — ${ctx.runType}/${ctx.channel} ${ctx.scanYear}\nrun ${runId}\n${message}`
      )
    } catch (alertErr) {
      console.error("[ytd] sync-failure alert could not be delivered:", alertErr)
    }
  }
}

function countQualityFlags(facts: YtdApplicationFact[]): Record<YtdDataQualityFlag, number> {
  const counts: Record<YtdDataQualityFlag, number> = {
    missing_candidate_email: 0,
    missing_referrer: 0,
    missing_recruiter_owner: 0,
    missing_stage_history: 0,
    missing_stage_definition: 0,
    approximate_action_time: 0,
    cannot_check_conflict_missing_email: 0,
  }
  for (const fact of facts) {
    for (const flag of fact.data_quality_flags) counts[flag]++
  }
  return counts
}

async function buildFactsForChannel(input: {
  scanYear: number
  channel: YtdChannel
  runType: YtdRunOptions["runType"]
  syncRunId: string | null
  nowIso: string
  applications: YtdGHApplication[]
  agencySourceIds: Set<number>
  sourceNamesById: Map<number, string>
}): Promise<{
  facts: YtdApplicationFactWithOwnership[]
  stageEvents: YtdStageEvent[]
  stageDefinitions: YtdStageDefinition[]
  ownerSnapshots: YtdJobOwnerSnapshot[]
  jobsById: Map<number, YtdJobSummary>
  /** C2: max updated_at over this channel's fetched apps — the channel's contribution to the
   *  run's coverage watermark. null when nothing was fetched. */
  coveredThrough: string | null
  /** Count of fetched applications dropped because they carry no job_id (not req-attributable). */
  applicationsSkippedNoJob: number
}> {
  // A Greenhouse application with no job_id can't be attributed to a req. ytd_application_facts.job_id
  // is NOT NULL (a fact is req-scoped by definition), so a jobless application — a referral credited to
  // someone but never attached to a req (prospect/pool) — has no home in the facts table and would
  // crash the upsert. The agency channel never produces these (an agency submission is always
  // job-attached); the referral channel does. Drop them from the fact build (counted + logged, never
  // silent), but keep them in the coverage watermark below (computed over input.applications) so the
  // next incremental doesn't re-scan them every run.
  const applications = input.applications.filter((app) => app.job_id != null)
  const applicationsSkippedNoJob = input.applications.length - applications.length
  if (applicationsSkippedNoJob > 0) {
    console.warn(
      `[ytd] ${input.channel}: skipped ${applicationsSkippedNoJob} application(s) with no job_id (not attributable to a req)`
    )
  }

  const jobIds = uniqSortedNumbers(applications.map((app) => app.job_id))
  const candidateIds = uniqSortedNumbers(applications.map((app) => app.candidate_id))
  const appIds = uniqSortedNumbers(applications.map((app) => app.id))
  const referrerIds = uniqSortedNumbers(applications.map((app) => app.referrer_id ?? app.credited_to?.id))
  const appRecruiterIds = uniqSortedNumbers(applications.map((app) => app.recruiter_id))

  // WIRING contract #2: route /job_owners through greenhouse-evidence.listJobOwners so the
  // rows carry `responsible` (GHJobOwnerWithResponsible). The old fetchBatched<YtdGHJobOwner>
  // typed the flag away, so the resolver's R1 (single responsible:true owner) could never fire.
  // Same <=50-id batching + per_page=500 as fetchBatched (greenhouse-evidence.ts:68-87).
  const [jobs, candidates, rawStageDefinitions, rawStageEvents, rawOwners, referrers] =
    await Promise.all([
      fetchBatched<YtdGHJob>("/jobs", "ids", jobIds),
      fetchBatched<YtdGHCandidate>("/candidates", "ids", candidateIds),
      fetchBatched<YtdGHJobInterviewStage>("/job_interview_stages", "job_ids", jobIds),
      fetchBatched<YtdGHApplicationStage>("/application_stages", "application_ids", appIds),
      listJobOwners(jobIds),
      // An application's `referrer_id` is a `/referrers.id`, so this is the ONLY join that names
      // the referrer (the payload has no credited_to, and referrer_id is not a user id). Empty
      // for agency (no referrer_id) — fetchBatched returns [] on an empty id list.
      fetchBatched<YtdGHReferrer>("/referrers", "ids", referrerIds),
    ])

  const departmentIds = new Set(uniqSortedNumbers(jobs.map((job) => job.department_id)))
  const departments =
    departmentIds.size > 0
      ? (await greenhouseGetAll<YtdGHDepartment>("/departments", { per_page: 500 })).filter(
          (department) => departmentIds.has(department.id)
        )
      : []
  const departmentsById = new Map(departments.map((department) => [department.id, department]))
  const ownerUserIds = uniqSortedNumbers(rawOwners.map((owner) => owner.user_id))
  // referrerIds are /referrers ids, NOT user ids, so they are resolved via /referrers above and
  // deliberately excluded from the /users fetch (including them resolved nothing and risked a
  // /referrers.id colliding with an unrelated /users.id).
  const userIds = uniqSortedNumbers([...ownerUserIds, ...appRecruiterIds])
  const users = await fetchBatched<YtdGHUser>("/users", "ids", userIds)

  const usersById = new Map(users.map((user) => [user.id, user]))
  const referrersById = new Map(referrers.map((referrer) => [referrer.id, referrer]))
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, toCandidateSummary(candidate)]))
  const jobsById = new Map(jobs.map((job) => [job.id, toJobSummary(job, departmentsById)]))
  const stageDefinitions = buildStageDefinitions(rawStageDefinitions, input.nowIso)
  const definitionsByStageId = new Map(
    stageDefinitions.map((definition) => [definition.job_interview_stage_id, definition])
  )
  const stageEvents = buildStageEvents(rawStageEvents, definitionsByStageId, input.syncRunId)
  const stageEventsByApplicationId = new Map<number, YtdStageEvent[]>()
  for (const event of stageEvents) {
    const list = stageEventsByApplicationId.get(event.application_id) ?? []
    list.push(event)
    stageEventsByApplicationId.set(event.application_id, list)
  }

  const ownerSnapshots = buildJobOwnerSnapshots(
    rawOwners,
    usersById,
    input.syncRunId,
    input.nowIso
  )
  const ownersByJobId = new Map<number, YtdJobOwnerSnapshot[]>()
  for (const owner of ownerSnapshots) {
    const list = ownersByJobId.get(owner.job_id) ?? []
    list.push(owner)
    ownersByJobId.set(owner.job_id, list)
  }

  const context: Omit<YtdBuildContext, "channel"> = {
    scanYear: input.scanYear,
    syncRunId: input.syncRunId,
    nowIso: input.nowIso,
    applications,
    candidatesById,
    jobsById,
    stageEventsByApplicationId,
    ownersByJobId,
    usersById,
    referrersById,
  }

  const facts = applications.map((app) => {
    const fact = buildApplicationFact(app, { ...context, channel: input.channel })
    if (input.channel === "agency") {
      if (fact.agency_source_id) {
        fact.agency_source_name =
          fact.agency_source_name ?? input.sourceNamesById.get(fact.agency_source_id) ?? null
        fact.source_name = fact.source_name ?? fact.agency_source_name
      }
      // Q4 (005:117): an agency submission ALWAYS has an agency source, so a NULL
      // agency_source_id is a RESOLUTION DEFECT flagged via source_resolution_status —
      // never dropped, never a phantom "different agency". Finalize the verdict here against
      // the resolved agency_source_id: 'resolved' when present, 'unresolved' when NULL.
      fact.source_resolution_status = fact.agency_source_id !== null ? "resolved" : "unresolved"
    }
    if (input.channel === "referral") {
      fact.source_name = fact.source_name ?? "Referral"
    }
    return fact
  })

  if (input.channel === "agency") {
    // C3: dual-agency is a CROSS-application verdict, but an incremental batch holds only the
    // re-touched side. Load the already-persisted agency facts for THIS batch's job_ids and feed
    // them as the reconcile superset so a one-sided re-touch still pairs against its persisted
    // partner — the verdict is recomputed over (in-batch ∪ persisted), not erased. The load is
    // unfiltered (in-batch rows included); the reconcile de-dupes by application_id with the
    // fresher in-batch copy winning, and the same rows back the merge-preserve step below.
    const existingRows = await loadExistingAgencyFacts(jobIds)
    applyDualAgencyConflicts({
      facts,
      candidatesById,
      existingFacts: existingRows.map(existingFactForReconcile),
    })
    await applyPriorHistoryConflicts({
      facts,
      agencySourceIds: input.agencySourceIds,
      jobsById,
      fetchers: {
        findCandidatesByEmail: (email) => greenhouseGetAll<GHCandidate>("/candidates", { email }),
        findApplicationsByCandidateId: (candidateId) =>
          greenhouseGetAll<YtdGHApplication>("/applications", {
            candidate_ids: String(candidateId),
            per_page: 500,
          }),
      },
    })
    applyFeeRiskStates({ facts, nowIso: input.nowIso })

    // C3 merge-preserve (defense in depth, incremental only). The reconcile above re-derives the
    // dual-agency verdict over the persisted superset and the prior-history pass re-queries live,
    // so the documented one-sided erasure can't happen on the common same-job path. This guards
    // the residual case: a fact whose persisted verdict the passes did NOT reproduce this run
    // (e.g. its candidate identity was transiently unfetchable) would otherwise be rebuilt clean
    // and the blind onConflict=application_id upsert would WRITE that clean row over a known
    // conflict. So when an incremental rebuild lands conflict-free but a persisted row for the
    // same application carried a verdict, carry the persisted conflict/fee columns forward rather
    // than overwrite them with defaults. Backfill is authoritative over the whole year in one
    // array and never preserves (it would mask a genuine clear).
    if (input.runType === "incremental") {
      mergePreserveConflicts(facts, existingRows)
    }
  }

  const coveredThrough = maxIso(input.applications.map(updatedAt))

  return {
    facts,
    stageEvents,
    stageDefinitions,
    ownerSnapshots,
    jobsById,
    coveredThrough,
    applicationsSkippedNoJob,
  }
}

async function upsertRows(table: string, rows: Record<string, unknown>[], conflict: string): Promise<number> {
  let count = 0
  for (const batch of chunks(rows, 500)) {
    if (batch.length === 0) continue
    const { error } = await supabase.from(table).upsert(batch, { onConflict: conflict })
    if (error) throw new Error(`Failed to upsert ${table}: ${error.message}`)
    count += batch.length
  }
  return count
}

async function insertRows(table: string, rows: Record<string, unknown>[]): Promise<number> {
  let count = 0
  for (const batch of chunks(rows, 500)) {
    if (batch.length === 0) continue
    const { error } = await supabase.from(table).insert(batch)
    if (error) throw new Error(`Failed to insert ${table}: ${error.message}`)
    count += batch.length
  }
  return count
}

// Owner active-flag staleness grace. An owner row on a scanned job is deactivated only if it
// was last seen strictly before (now - GRACE) — never merely "by a different run id". This is
// the flap fix: two overlapping/retried runs both stamp last_seen_at ≈ now, so neither marks
// the other's freshly re-seen owners inactive (the old `last_seen_run_id != mine` predicate had
// them toggle each other, and an empty ownerSnapshots[0] fell back to a zero-UUID that nuked
// every owner on the scanned jobs). A genuinely departed owner ages out after the grace. The
// grace comfortably exceeds maxDuration (300s) so an in-flight run is never treated as stale.
const OWNER_STALE_GRACE_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// WIRING: application_ownership_snapshots — the append-only accountability trail (005:41-67).
// The write-time PASS-1 row from the YTD extract carries ownership_source='ytd_extract'. APPEND
// ON CHANGE (the locked default, reconcile-identity.ts:23): one row per application+channel only
// when its (confidence, status, primary_recruiter_id) triple differs from the latest snapshot —
// so the incremental cadence (every few hours) doesn't write an unchanged row each run. The fact
// carries the resolution outputs the resolver landed (ownership_confidence/status +
// primary_recruiter_* + recruiter_ids/names); evidence_types/detail are not on the fact shape, so
// the column takes its NOT-NULL default ('{}') and detail stays null here — the reconcile path
// records the proxy-rung evidence trail. ownership_resolved_at is the monotonic lock point: the
// earliest prior resolved_at is carried forward, else stamped now when this row first reaches
// high+ resolved (mirrors reconcile-identity.ts:864-870 so the two writers agree).
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<string, number> = {
  unresolved: 0,
  inferred: 1,
  high: 2,
  confirmed: 3,
}

interface LatestSnapshot {
  confidence: string
  status: string
  recruiterId: number | null
  referrerId: number | null
  resolvedAt: string | null
}

/** Append a snapshot for each persisted fact whose ownership triple changed vs its latest prior
 *  snapshot (or which has none). Returns the count inserted. Read-then-insert; append-only (the
 *  surrogate id is the uniqueness key, 005:40), never an upsert. */
async function appendOwnershipSnapshots(
  facts: YtdApplicationFactWithOwnership[],
  syncRunId: string | null,
  nowIso: string
): Promise<number> {
  if (facts.length === 0) return 0

  const appIds = uniqSortedNumbers(facts.map((f) => f.application_id))
  const latestByKey = new Map<string, LatestSnapshot>()
  const everResolvedAt = new Map<string, string>()

  for (const batch of chunks(appIds, 200)) {
    if (batch.length === 0) continue
    const { data, error } = await supabase
      .from("application_ownership_snapshots")
      .select(
        "application_id, channel, ownership_confidence, ownership_resolution_status, primary_recruiter_id, referrer_id, ownership_resolved_at, created_at"
      )
      .in("application_id", batch)
      .order("created_at", { ascending: false })
    if (error) throw new Error(`Failed to read ownership snapshots: ${error.message}`)
    for (const row of (data ?? []) as Array<{
      application_id: number
      channel: string
      ownership_confidence: string
      ownership_resolution_status: string
      primary_recruiter_id: number | null
      referrer_id: number | null
      ownership_resolved_at: string | null
    }>) {
      const key = `${row.application_id}:${row.channel}`
      // First row per (app, channel) is the latest (created_at desc).
      if (!latestByKey.has(key)) {
        latestByKey.set(key, {
          confidence: row.ownership_confidence,
          status: row.ownership_resolution_status,
          recruiterId: row.primary_recruiter_id,
          referrerId: row.referrer_id,
          resolvedAt: row.ownership_resolved_at,
        })
      }
      if (row.ownership_resolved_at && !everResolvedAt.has(key)) {
        everResolvedAt.set(key, row.ownership_resolved_at)
      }
    }
  }

  const inserts: Record<string, unknown>[] = []
  for (const fact of facts) {
    const key = `${fact.application_id}:${fact.channel}`
    const prior = latestByKey.get(key)
    const changed =
      !prior ||
      prior.confidence !== fact.ownership_confidence ||
      prior.status !== fact.ownership_resolution_status ||
      prior.recruiterId !== fact.primary_recruiter_id ||
      // A referral whose credited referrer flips is an ownership change too — without this the
      // detector would skip the new snapshot and the accountability trail would lose the flip.
      prior.referrerId !== fact.referrer_id
    if (!changed) continue

    const reachedHighNow =
      CONFIDENCE_RANK[fact.ownership_confidence] >= CONFIDENCE_RANK["high"] &&
      fact.ownership_resolution_status === "resolved"
    const resolvedAt = everResolvedAt.get(key) ?? (reachedHighNow ? nowIso : null)

    inserts.push({
      application_id: fact.application_id,
      candidate_id: fact.candidate_id,
      job_id: fact.job_id,
      channel: fact.channel,
      primary_recruiter_id: fact.primary_recruiter_id,
      primary_recruiter_name: fact.primary_recruiter_name,
      recruiter_ids: fact.recruiter_ids,
      recruiter_names: fact.recruiter_names,
      referrer_id: fact.referrer_id,
      referrer_name: fact.referrer_name,
      ownership_source: "ytd_extract",
      ownership_confidence: fact.ownership_confidence,
      ownership_resolution_status: fact.ownership_resolution_status,
      ownership_resolved_at: resolvedAt,
      sync_run_id: syncRunId,
    })
  }

  return insertRows("application_ownership_snapshots", inserts)
}

// 005 WRITEBACK GATE — pure projection so the gate is unit-testable
// (test/ytd-ownership-writeback-gate.test.ts). input.facts are YtdApplicationFactWithOwnership: they
// carry the three 005-only columns (ownership_confidence / ownership_resolution_status /
// source_resolution_status: ytd-normalize.ts:64-67, migration 005:113-118). Against a PRE-005 DB an
// upsert that references those columns is rejected by PostgREST and ZERO facts persist (silently
// staling /ytd/agency). With the writeback OFF (default) we strip them to the base 003/004 column set;
// with it ON (post-005) they pass through unchanged. Same reasoning as the owner-snapshot pre-005
// projection (this file :750-765). Returns a fresh row per fact — never mutates the input.
export function projectFactsForWriteback(
  facts: YtdApplicationFactWithOwnership[],
  ownershipWriteback: boolean
): Record<string, unknown>[] {
  if (ownershipWriteback) return facts as unknown as Record<string, unknown>[]
  return facts.map((fact) => {
    const row = { ...(fact as unknown as Record<string, unknown>) }
    delete row.ownership_confidence
    delete row.ownership_resolution_status
    delete row.source_resolution_status
    return row
  })
}

// Exported so the per-table dedupe can be asserted directly against the recorded upsert
// payloads (test/ytd-persist-dedupe.test.ts), the same reason projectFactsForWriteback is
// exported to make its gate unit-testable.
//
// DEDUPE BOUNDARY: every batch is deduped on its conflict key HERE, immediately before the
// upsert, and nowhere earlier. runYtdSync runs buildFactsForChannel once PER channel, and the
// job-scoped rows (stage definitions/events, owner snapshots) are derived from each channel's
// jobIds — so a job that has both a referral and an agency application in-year emits identical
// rows from both passes, and the concatenated batch carries a duplicated conflict target. A
// blind upsert then dies on Postgres "ON CONFLICT DO UPDATE command cannot affect row a second
// time". Last-write-wins is safe ONLY here because by this point every fact has been fully
// mutated (applyDualAgencyConflicts/applyPriorHistoryConflicts/applyFeeRiskStates/
// mergePreserveConflicts all ran inside buildFactsForChannel); the duplicate rows are therefore
// structurally identical and collapsing them is content-preserving. Moving any dedupe before
// those conflict passes would break that guarantee.
export async function persist(input: {
  facts: YtdApplicationFactWithOwnership[]
  stageEvents: YtdStageEvent[]
  stageDefinitions: YtdStageDefinition[]
  ownerSnapshots: YtdJobOwnerSnapshot[]
  scanJobIds: number[]
  syncRunId: string | null
  nowIso: string
}): Promise<{ facts: number; stageEvents: number; ownershipSnapshots: number }> {
  await upsertRows(
    "ytd_job_stage_definitions",
    dedupeByKey(
      input.stageDefinitions,
      (definition) => String(definition.job_interview_stage_id)
    ) as unknown as Record<string, unknown>[],
    "job_interview_stage_id"
  )
  // Strip to the EXACT migration-003 column set before the upsert. The snapshots flowing in
  // are YtdJobOwnerSnapshotWithResponsible — they carry an extra `responsible` flag the resolver
  // consumes in-process (via YtdBuildContext.ownersByJobId -> buildApplicationFact). That column
  // does NOT exist on ytd_job_owner_snapshots (003:87-97), and the blind cast that sent the whole
  // object would have the upsert reject the unknown column. Project to 003's columns only; the
  // in-process flag delivery is unaffected (it never touched the DB row).
  const ownerRows: Record<string, unknown>[] = input.ownerSnapshots.map((owner) => ({
    job_id: owner.job_id,
    user_id: owner.user_id,
    owner_type: owner.owner_type,
    user_name: owner.user_name,
    user_email: owner.user_email,
    active: owner.active,
    last_seen_run_id: owner.last_seen_run_id,
    last_seen_at: owner.last_seen_at,
  }))
  // Composite conflict key (job_id,user_id,owner_type) — the same cross-channel double-emit as
  // the stage tables, so dedupe on the joined triple before the upsert.
  await upsertRows(
    "ytd_job_owner_snapshots",
    dedupeByKey(ownerRows, (row) => `${row.job_id}|${row.user_id}|${row.owner_type}`),
    "job_id,user_id,owner_type"
  )

  // Guard the owner active-flag flap (see OWNER_STALE_GRACE_MS). Time-based staleness, scoped to
  // the jobs we re-queried this run, replaces the run-id-difference predicate that flapped under
  // overlapping runs.
  if (input.scanJobIds.length > 0) {
    const staleBefore = new Date(new Date(input.nowIso).getTime() - OWNER_STALE_GRACE_MS).toISOString()
    const { error } = await supabase
      .from("ytd_job_owner_snapshots")
      .update({ active: false })
      .in("job_id", input.scanJobIds)
      .lt("last_seen_at", staleBefore)
    if (error) throw new Error(`Failed to mark missing job owners inactive: ${error.message}`)
  }

  const stageEvents = await upsertRows(
    "ytd_application_stage_events",
    dedupeByKey(input.stageEvents, (event) => String(event.id)) as unknown as Record<
      string,
      unknown
    >[],
    "id"
  )
  // 005 WRITEBACK GATE (see projectFactsForWriteback). Default OFF: strip the three 005-only
  // ownership columns from the facts AND skip appendOwnershipSnapshots (which reads+writes the 005
  // table application_ownership_snapshots, this file :662,:733), so the whole resolution writeback is
  // dormant and this code is safe to deploy BEFORE migration 005. Flip YTD_OWNERSHIP_WRITEBACK=true
  // only AFTER 005 is applied. Mirrors the NOTIFY_*_SEND dormant-by-default gate.
  const ownershipWriteback = readEnv("YTD_OWNERSHIP_WRITEBACK")?.toLowerCase() === "true"
  // Dedupe AFTER the writeback projection so we dedupe the exact rows being sent. An
  // application_id is single-channel by construction, so this is insurance against a same-channel
  // duplicate rather than the live cross-channel trigger — but it keeps the facts upsert from
  // ever hitting the same ON CONFLICT wall the job-scoped tables do.
  const factRows = dedupeByKey(
    projectFactsForWriteback(input.facts, ownershipWriteback),
    (row) => String(row.application_id)
  )
  const facts = await upsertRows("ytd_application_facts", factRows, "application_id")
  const ownershipSnapshots = ownershipWriteback
    ? await appendOwnershipSnapshots(input.facts, input.syncRunId, input.nowIso)
    : 0
  return { facts, stageEvents, ownershipSnapshots }
}

export async function runYtdSync(options: YtdRunOptions): Promise<YtdRunResult> {
  const scanYear = options.year ?? currentYear()
  const channel = options.channel ?? "all"
  const dryRun = Boolean(options.dryRun)
  const nowIso = new Date().toISOString()
  const agencySources = await fetchAgencySources().catch((err) => {
    if (channel === "referral") return new Map<number, string>()
    throw err
  })
  const agencySourceIds = new Set(agencySources.keys())
  let runId: string | null = null

  try {
    if (!dryRun) {
      runId = await createRun({ scanYear, channel, runType: options.runType })
    }

    const since =
      options.runType === "incremental"
        ? await incrementalSinceIso(scanYear, channel)
        : null
    const allFacts: YtdApplicationFactWithOwnership[] = []
    const allStageEvents: YtdStageEvent[] = []
    const allStageDefinitions: YtdStageDefinition[] = []
    const allOwnerSnapshots: YtdJobOwnerSnapshot[] = []
    const scanJobIds: number[] = []
    const coveredThroughCandidates: Array<string | null> = []
    let skippedNoJob = 0

    for (const nextChannel of channelsFor(channel)) {
      const applications =
        options.runType === "incremental"
          ? await fetchIncrementalApplications(nextChannel, scanYear, since)
          : await fetchApplications(nextChannel, scanYear)
      const built = await buildFactsForChannel({
        scanYear,
        channel: nextChannel,
        runType: options.runType,
        syncRunId: runId,
        nowIso,
        applications,
        agencySourceIds,
        sourceNamesById: agencySources,
      })

      allFacts.push(...built.facts)
      allStageEvents.push(...built.stageEvents)
      allStageDefinitions.push(...built.stageDefinitions)
      allOwnerSnapshots.push(...built.ownerSnapshots)
      scanJobIds.push(...built.jobsById.keys())
      coveredThroughCandidates.push(built.coveredThrough)
      skippedNoJob += built.applicationsSkippedNoJob
    }

    // C2: the run's coverage watermark = the max updated_at it actually fetched across channels.
    // Persisted into ytd_sync_runs.metadata and read as the next incremental's `since` (minus the
    // safety overlap). Falls back to the cutoff this run used when it fetched nothing (an empty
    // incremental shouldn't roll the watermark backward to null and trigger a full rescan next time).
    const coveredThrough = maxIso(coveredThroughCandidates) ?? since

    let factsUpserted = 0
    let stageEventsUpserted = 0
    if (!dryRun) {
      const persisted = await persist({
        facts: allFacts,
        stageEvents: allStageEvents,
        stageDefinitions: allStageDefinitions,
        ownerSnapshots: allOwnerSnapshots,
        scanJobIds: uniqSortedNumbers(scanJobIds),
        syncRunId: runId,
        nowIso,
      })
      factsUpserted = persisted.facts
      stageEventsUpserted = persisted.stageEvents
      if (runId) {
        await completeRun(
          runId,
          {
            applications_scanned: allFacts.length,
            facts_upserted: factsUpserted,
            stage_events_upserted: stageEventsUpserted,
          },
          { since, covered_through: coveredThrough, dry_run: dryRun }
        )
      }
    }

    return {
      run_id: runId,
      dry_run: dryRun,
      scan_year: scanYear,
      channel,
      applications_scanned: allFacts.length,
      facts_upserted: dryRun ? 0 : factsUpserted,
      stage_events_upserted: dryRun ? 0 : stageEventsUpserted,
      applications_skipped_no_job: skippedNoJob,
      data_quality: countQualityFlags(allFacts),
    }
  } catch (err) {
    await failRun(runId, err, { scanYear, channel, runType: options.runType })
    throw err
  }
}
