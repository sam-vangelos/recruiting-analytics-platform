import { resolveOwnership } from "./identity-resolver"
import type { OwnerRow } from "./identity-resolver"
import type {
  AgencyResolutionStatus,
  ResolutionConfidence,
  ResolutionStatus,
} from "./resolution-types"
import { ghStageEnteredAt, ghStageName } from "./sweep-types"
import type {
  AgencyActionBucket,
  ActionTimeQuality,
  TerminalOutcome,
  YtdApplicationFact,
  YtdBuildContext,
  YtdCandidateSummary,
  YtdDataQualityFlag,
  YtdGHApplication,
  YtdGHApplicationStage,
  YtdGHCandidate,
  YtdGHDepartment,
  YtdGHJob,
  YtdGHJobInterviewStage,
  YtdGHJobOwner,
  YtdGHReferrer,
  YtdGHUser,
  YtdJobOwnerSnapshot,
  YtdJobSummary,
  YtdStageDefinition,
  YtdStageEvent,
} from "./ytd-types"

const APPLICATION_REVIEW = "Application Review"

// ---------------------------------------------------------------------------
// W2 contract #2 — owner snapshots must carry `responsible` so the identity
// resolver's R1 (single responsible:true recruiter owner -> confirmed) can fire.
// The live /job_owners projection + greenhouse-evidence.GHJobOwnerWithResponsible
// carry the flag; YtdJobOwnerSnapshot / YtdGHJobOwner do not model it YET (those
// types live in ytd-types.ts, outside this file's edit boundary — the Verify stage
// reconciles the canonical type). Until then this module is the seam that preserves
// the flag end-to-end: buildJobOwnerSnapshots reads it off the raw owner and emits
// it; buildApplicationFact reads it back off the snapshot. The intersection types
// keep that flow self-consistent under tsc while staying assignable to the base
// types every external consumer (ytd-extract, ytd-conflicts) still expects.
// ---------------------------------------------------------------------------

/** A raw /job_owners row that may carry the `responsible` disambiguator. The live
 *  fetch (greenhouse-evidence.listJobOwners -> GHJobOwnerWithResponsible) returns it;
 *  the legacy YtdGHJobOwner type does not declare it, so accept it as optional and
 *  default-false rather than depend on a cross-file type change. */
type RawJobOwnerWithResponsible = YtdGHJobOwner & { responsible?: boolean | null }

/** Owner snapshot extended with the `responsible` flag (contract #2). Assignable to
 *  YtdJobOwnerSnapshot, so it flows through YtdBuildContext.ownersByJobId unchanged. */
export type YtdJobOwnerSnapshotWithResponsible = YtdJobOwnerSnapshot & {
  responsible: boolean
}

/** Application fact extended with the ownership- and source-resolution writebacks
 *  (contract #1 + Q4). Assignable to YtdApplicationFact, so ytd-extract's persist/conflict
 *  path and the ytd-dashboard read path keep type-checking against the base shape; the
 *  extra fields ride along to the 005 writeback columns (005:113-117). source_resolution_status
 *  uses the narrower AgencyResolutionStatus domain (no 'permission_blocked' — agency source
 *  identity never depends on a permission-gated fetch) and is null for the referral channel. */
export type YtdApplicationFactWithOwnership = YtdApplicationFact & {
  ownership_confidence: ResolutionConfidence
  ownership_resolution_status: ResolutionStatus
  source_resolution_status: AgencyResolutionStatus | null
}

export function uniqSortedNumbers(values: Array<number | null | undefined>): number[] {
  return [...new Set(values.filter((v): v is number => typeof v === "number"))].sort(
    (a, b) => a - b
  )
}

// Last-write-wins dedupe by a derived key. Survivors are tracked in an insertion-ordered Map
// (a later occurrence replaces an earlier one), so the result preserves first-seen order while
// keeping the final value for any repeated key. Used at the persist boundary in ytd-extract,
// AFTER all in-place fact mutation, where duplicate rows are structurally identical and so
// last-write-wins is content-preserving. Do NOT move the call earlier than that boundary — see
// the note in ytd-extract.persist(). Keyed on a string so composite keys are just a joined
// template literal at the call site. No sorting (the DB keys on the conflict target; order in
// the upsert batch is irrelevant).
export function dedupeByKey<T>(rows: T[], keyFn: (row: T) => string): T[] {
  const byKey = new Map<string, T>()
  for (const row of rows) byKey.set(keyFn(row), row)
  return [...byKey.values()]
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized ? normalized : null
}

export function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ").toLowerCase()
  return normalized ? normalized : null
}

export function normalizePhone(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "")
  if (!digits || digits.length < 7) return null
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits
}

export function normalizeProfileUrl(value: string | null | undefined): string | null {
  const raw = value?.trim().toLowerCase()
  if (!raw) return null
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`)
    const host = url.hostname.replace(/^www\./, "")
    const path = url.pathname.replace(/\/+$/, "")
    return `${host}${path}`
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "")
  }
}

export function primaryCandidateEmail(candidate: Pick<YtdGHCandidate, "email_addresses">): string | null {
  const emails = candidate.email_addresses ?? []
  return normalizeEmail(
    emails.find((e) => e.type === "personal" || e.type === "work")?.value ??
      emails[0]?.value ??
      null
  )
}

export function candidateName(candidate: Pick<YtdGHCandidate, "first_name" | "last_name">): string | null {
  const name = `${candidate.first_name ?? ""} ${candidate.last_name ?? ""}`.trim()
  return name || null
}

export function userName(user: YtdGHUser | null | undefined): string | null {
  if (!user) return null
  const fromName = user.name?.trim()
  if (fromName) return fromName
  const composed = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim()
  return composed || null
}

export function userEmail(user: YtdGHUser | null | undefined): string | null {
  if (!user) return null
  return (
    normalizeEmail(user.primary_email) ??
    normalizeEmail(user.email) ??
    normalizeEmail(user.emails?.[0]?.value)
  )
}

export function appliedAt(app: YtdGHApplication): string | null {
  return app.applied_at ?? app.created_at ?? app.last_activity_at ?? null
}

export function hoursBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null
  const startTime = new Date(start).getTime()
  const endTime = new Date(end).getTime()
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null
  return Math.round(((endTime - startTime) / (1000 * 60 * 60)) * 10) / 10
}

export function deriveActionBucket(input: {
  submittedAt: string | null
  firstActionTimeHours: number | null
  firstActionAt: string | null
  nowIso: string
}): AgencyActionBucket {
  if (typeof input.firstActionTimeHours === "number" && Number.isFinite(input.firstActionTimeHours)) {
    if (input.firstActionTimeHours < 24) return "lt_24h"
    if (input.firstActionTimeHours < 48) return "h24_48"
    if (input.firstActionTimeHours <= 168) return "d2_7"
    return "gt_7d"
  }
  if (!input.submittedAt || input.firstActionAt) return "unknown"
  const ageHours = hoursBetween(input.submittedAt, input.nowIso)
  if (typeof ageHours !== "number") return "unknown"
  return ageHours > 168 ? "unactioned_gt_7d" : "unactioned_lt_7d"
}

export function sourceId(app: YtdGHApplication): number | null {
  return app.source_id ?? app.source?.id ?? null
}

export function currentStageId(app: YtdGHApplication): number | null {
  return app.stage_id ?? app.current_stage?.id ?? null
}

export function referrerId(app: YtdGHApplication): number | null {
  return app.referrer_id ?? app.credited_to?.id ?? null
}

// Resolve a referral's referrer name. The application's `referrer_id` is a GH `/referrers.id`
// (confirmed against raw Harvest: the payload has no `credited_to`, and `referrer_id` resolves
// only via `/referrers?ids=`, never `/users?ids=`), so the registry map is the primary source.
// `credited_to` is kept as a fallback for parity with GH configs / the sweep path that do
// populate it; this org does not. Returns null (a defect carried as missing_referrer) when the
// referrer can't be named — never a sentinel.
export function referrerName(
  app: YtdGHApplication,
  referrersById: Map<number, YtdGHReferrer>
): string | null {
  const rid = referrerId(app)
  if (rid != null) {
    const name = referrersById.get(rid)?.name?.trim()
    if (name) return name
  }
  if (app.credited_to) {
    const name = `${app.credited_to.first_name ?? ""} ${app.credited_to.last_name ?? ""}`.trim()
    if (name) return name
  }
  return null
}

export function terminalOutcome(status: string | null | undefined): TerminalOutcome {
  if (status === "active" || status === "in_process") return "active"
  if (status === "rejected" || status === "hired" || status === "converted") return status
  return "unknown"
}

function uniqueNormalized<T>(values: T[], normalize: (value: T) => string | null): string[] {
  return [...new Set(values.map(normalize).filter((value): value is string => Boolean(value)))].sort()
}

export function toCandidateSummary(candidate: YtdGHCandidate): YtdCandidateSummary {
  return {
    id: candidate.id,
    name: candidateName(candidate),
    email: primaryCandidateEmail(candidate),
    first_name: candidate.first_name ?? null,
    last_name: candidate.last_name ?? null,
    company: normalizeText(candidate.company),
    title: normalizeText(candidate.title),
    phones: uniqueNormalized(
      candidate.phone_numbers?.map((phone) => phone.value ?? null) ?? [],
      normalizePhone
    ),
    profile_urls: uniqueNormalized(
      [
        ...(candidate.website_addresses?.map((url) => url.value ?? null) ?? []),
        ...(candidate.social_media_addresses?.map((url) => url.value ?? null) ?? []),
      ],
      normalizeProfileUrl
    ),
  }
}

export function toJobSummary(
  job: YtdGHJob,
  departmentsById: Map<number, YtdGHDepartment>
): YtdJobSummary {
  const departmentId = job.department_id ?? null
  return {
    id: job.id,
    title: job.name ?? null,
    department_id: departmentId,
    department_name: departmentId ? departmentsById.get(departmentId)?.name ?? null : null,
  }
}

function readStageName(stage: YtdGHJobInterviewStage): string | null {
  return stage.name ?? stage.stage_name ?? null
}

export function buildStageDefinitions(stages: YtdGHJobInterviewStage[], nowIso: string): YtdStageDefinition[] {
  const byJob = new Map<number, YtdGHJobInterviewStage[]>()
  for (const stage of stages) {
    const list = byJob.get(stage.job_id) ?? []
    list.push(stage)
    byJob.set(stage.job_id, list)
  }

  const definitions: YtdStageDefinition[] = []
  for (const [, jobStages] of byJob) {
    const sorted = [...jobStages].sort((a, b) => {
      const aOrder = a.order ?? a.priority ?? a.sort_order
      const bOrder = b.order ?? b.priority ?? b.sort_order
      if (typeof aOrder === "number" && typeof bOrder === "number") return aOrder - bOrder
      return jobStages.indexOf(a) - jobStages.indexOf(b)
    })
    sorted.forEach((stage, index) => {
      definitions.push({
        job_interview_stage_id: stage.id,
        job_id: stage.job_id,
        stage_name: readStageName(stage),
        stage_rank: index + 1,
        active: typeof stage.active === "boolean" ? stage.active : null,
        last_synced_at: nowIso,
      })
    })
  }
  return definitions
}

export function buildStageEvents(
  rawStages: YtdGHApplicationStage[],
  definitionsByStageId: Map<number, YtdStageDefinition>,
  syncRunId: string | null
): YtdStageEvent[] {
  return rawStages.map((stage) => {
    const definition = stage.job_interview_stage_id
      ? definitionsByStageId.get(stage.job_interview_stage_id)
      : undefined
    return {
      id: stage.id,
      application_id: stage.application_id,
      job_interview_stage_id: stage.job_interview_stage_id,
      stage_name: definition?.stage_name ?? null,
      stage_rank: definition?.stage_rank ?? null,
      entered_at: stage.entered_at,
      exited_at: stage.exited_at,
      days_in_stage: stage.days_in_stage,
      current: Boolean(stage.current),
      sync_run_id: syncRunId,
    }
  })
}

export function buildJobOwnerSnapshots(
  owners: RawJobOwnerWithResponsible[],
  usersById: Map<number, YtdGHUser>,
  syncRunId: string | null,
  nowIso: string
): YtdJobOwnerSnapshotWithResponsible[] {
  return owners.map((owner) => {
    const user = usersById.get(owner.user_id)
    return {
      job_id: owner.job_id,
      user_id: owner.user_id,
      owner_type: owner.type,
      user_name: userName(user),
      user_email: userEmail(user),
      // Contract #2: carry the responsible flag through to the resolver. Absent ===
      // not responsible (the resolver's R1 only fires on responsible === true).
      responsible: owner.responsible === true,
      active: true,
      last_seen_run_id: syncRunId,
      last_seen_at: nowIso,
    }
  })
}

export function deriveActionState(input: {
  app: YtdGHApplication
  stageEvents: YtdStageEvent[]
}): {
  application_review_entered_at: string | null
  application_review_exited_at: string | null
  actioned_at: string | null
  action_time_hours: number | null
  never_actioned: boolean
  action_time_quality: ActionTimeQuality
  data_quality_flags: YtdDataQualityFlag[]
} {
  const flags: YtdDataQualityFlag[] = []
  const started = appliedAt(input.app)
  const sortedEvents = [...input.stageEvents].sort((a, b) => {
    const aTime = a.entered_at ? new Date(a.entered_at).getTime() : 0
    const bTime = b.entered_at ? new Date(b.entered_at).getTime() : 0
    return aTime - bTime
  })

  if (sortedEvents.length === 0) flags.push("missing_stage_history")

  const review = sortedEvents.find((event) => event.stage_name === APPLICATION_REVIEW)
  const reviewEntered = review?.entered_at ?? null
  const reviewExited = review?.exited_at ?? null
  const laterStage = sortedEvents.find((event) => {
    if (event.stage_name === APPLICATION_REVIEW || !event.entered_at) return false
    if (typeof review?.stage_rank !== "number") return true
    return typeof event.stage_rank === "number" && event.stage_rank > review.stage_rank
  })

  let actioned: string | null = null
  let quality: ActionTimeQuality = "unknown"

  if (reviewExited) {
    actioned = reviewExited
    quality = "exact"
  } else if (laterStage?.entered_at) {
    actioned = laterStage.entered_at
    quality = "approximate"
    flags.push("approximate_action_time")
  } else if (
    input.app.status !== "active" &&
    input.app.status !== "in_process" &&
    input.app.last_activity_at
  ) {
    actioned = input.app.last_activity_at
    quality = "approximate"
    flags.push("approximate_action_time")
  }

  const actionHours = hoursBetween(started, actioned)
  const neverActioned =
    (input.app.status === "active" || input.app.status === "in_process") &&
    ghStageName(input.app) === APPLICATION_REVIEW &&
    !reviewExited &&
    !laterStage

  return {
    application_review_entered_at: reviewEntered,
    application_review_exited_at: reviewExited,
    actioned_at: actioned,
    action_time_hours: actionHours,
    never_actioned: neverActioned,
    action_time_quality: quality,
    data_quality_flags: flags,
  }
}

export function deepestStage(stageEvents: YtdStageEvent[]): {
  max_stage_id: number | null
  max_stage_name: string | null
  max_stage_rank: number | null
} {
  const ranked = stageEvents
    .filter((event) => typeof event.stage_rank === "number")
    .sort((a, b) => (b.stage_rank ?? 0) - (a.stage_rank ?? 0))
  const top = ranked[0]
  return {
    max_stage_id: top?.job_interview_stage_id ?? null,
    max_stage_name: top?.stage_name ?? null,
    max_stage_rank: top?.stage_rank ?? null,
  }
}

export function buildApplicationFact(
  app: YtdGHApplication,
  context: YtdBuildContext
): YtdApplicationFactWithOwnership {
  const candidate = context.candidatesById.get(app.candidate_id)
  const job = context.jobsById.get(app.job_id)
  const stageEvents = context.stageEventsByApplicationId.get(app.id) ?? []
  const owners = context.ownersByJobId.get(app.job_id) ?? []
  const appRecruiterId = app.recruiter_id ?? null

  // Contract #1: the recruiter pick is no longer `recruiters[0]`. Map the job's
  // owner snapshots into the resolver's OwnerRow shape (carrying `responsible` —
  // read defensively because YtdJobOwnerSnapshot does not model it yet, see the
  // contract #2 note above) and run the synchronous owner-level ladder (R1-R3;
  // R4-R6 are reconcile-only and skipped here). The resolution is the single source
  // of truth for primary_recruiter_*/recruiter_ids/recruiter_names below.
  const jobOwners: OwnerRow[] = owners.map((owner) => ({
    user_id: owner.user_id,
    type: owner.owner_type,
    responsible: (owner as YtdJobOwnerSnapshotWithResponsible).responsible === true,
    active: owner.active,
  }))
  // The resolver derives names from usersById, not from the owner snapshot. Merge the
  // snapshots' names in so an owner whose user record was not separately fetched still
  // resolves (the snapshot already carries user_name from buildJobOwnerSnapshots).
  const ownershipUsersById = new Map<number, YtdGHUser>(context.usersById)
  for (const owner of owners) {
    if (!ownershipUsersById.has(owner.user_id)) {
      ownershipUsersById.set(owner.user_id, { id: owner.user_id, name: owner.user_name })
    }
  }
  const ownership = resolveOwnership({
    jobOwners,
    usersById: ownershipUsersById,
    applicationRecruiterId: appRecruiterId,
  })
  const ownershipResolved = ownership.status === "resolved"
  const action = deriveActionState({ app, stageEvents })
  const maxStage = deepestStage(stageEvents)
  const submittedAt = appliedAt(app)
  const hasCandidateIdentity =
    Boolean(candidate?.email) ||
    Boolean(candidate?.phones.length) ||
    Boolean(candidate?.profile_urls.length) ||
    Boolean(candidate?.first_name && candidate.last_name && candidate.company && candidate.title)
  const actionBucket = deriveActionBucket({
    submittedAt,
    firstActionAt: action.actioned_at,
    firstActionTimeHours: action.action_time_hours,
    nowIso: context.nowIso,
  })
  const qualityFlags = [...action.data_quality_flags]
  const hasCurrentStageDefinition =
    !currentStageId(app) ||
    stageEvents.some((event) => event.job_interview_stage_id === currentStageId(app)) ||
    maxStage.max_stage_rank !== null

  if (context.channel === "referral" && !referrerName(app, context.referrersById)) {
    qualityFlags.push("missing_referrer")
  }
  if (!candidate?.email) qualityFlags.push("missing_candidate_email")
  // Defect-as-flag (canon): unresolved ownership is a data-quality defect carried as
  // status + (below) ownership_resolution_status, NOT a sentinel name. Flag whenever
  // the resolver could not land a recruiter (unresolved / ambiguous / permission_blocked).
  if (!ownershipResolved) qualityFlags.push("missing_recruiter_owner")
  if (!hasCurrentStageDefinition) qualityFlags.push("missing_stage_definition")

  return {
    application_id: app.id,
    scan_year: context.scanYear,
    channel: context.channel,
    candidate_id: app.candidate_id,
    candidate_name: candidate?.name ?? null,
    candidate_email: candidate?.email ?? null,
    job_id: app.job_id,
    job_title: job?.title ?? null,
    source_id: sourceId(app),
    source_name: app.source?.name ?? null,
    department_id: job?.department_id ?? null,
    department_name: job?.department_name ?? null,
    application_status: app.status ?? null,
    applied_at: submittedAt,
    submitted_at: submittedAt,
    last_activity_at: app.last_activity_at,
    referrer_id: context.channel === "referral" ? referrerId(app) : null,
    referrer_name:
      context.channel === "referral" ? referrerName(app, context.referrersById) : null,
    agency_source_id: context.channel === "agency" ? sourceId(app) : null,
    agency_source_name: context.channel === "agency" ? app.source?.name ?? null : null,
    // Q4 (005:117): an agency submission ALWAYS has an agency source, so a NULL
    // agency_source_id is a RESOLUTION DEFECT surfaced via source_resolution_status —
    // never silently dropped, never a phantom "different agency". 'resolved' when the
    // source id is present, 'unresolved' when NULL. The referral channel has no agency
    // source to resolve, so the column stays null there.
    source_resolution_status:
      context.channel === "agency" ? (sourceId(app) !== null ? "resolved" : "unresolved") : null,
    // Contract #1: identity from the resolution. On a non-'resolved' status the
    // resolver guarantees primary_recruiter_id/name are NULL (the defect carries
    // status + recruiter_ids provenance, never a sentinel name).
    primary_recruiter_id: ownership.primary_recruiter_id,
    primary_recruiter_name: ownership.primary_recruiter_name,
    recruiter_ids: ownership.recruiter_ids,
    recruiter_names: ownership.recruiter_names,
    current_stage_id: currentStageId(app),
    current_stage_name: ghStageName(app),
    current_stage_entered_at: ghStageEnteredAt(app),
    application_review_entered_at: action.application_review_entered_at,
    application_review_exited_at: action.application_review_exited_at,
    actioned_at: action.actioned_at,
    first_action_at: action.actioned_at,
    action_time_hours: action.action_time_hours,
    first_action_time_hours: action.action_time_hours,
    never_actioned: action.never_actioned,
    action_time_quality: action.action_time_quality,
    action_bucket: actionBucket,
    max_stage_id: maxStage.max_stage_id,
    max_stage_name: maxStage.max_stage_name,
    max_stage_rank: maxStage.max_stage_rank,
    terminal_outcome: terminalOutcome(app.status),
    conflict_detected: false,
    conflict_types: [],
    dual_agency_group_key: null,
    prior_internal_application_ids: [],
    duplicate_confidence: hasCandidateIdentity ? "none" : "insufficient_data",
    duplicate_evidence_types: [],
    duplicate_candidate_ids: [],
    fee_risk_state: hasCandidateIdentity ? "not_duplicate" : "insufficient_data",
    fee_risk_reason: null,
    conflict_detail: null,
    // Contract #1: the ownership-resolution writeback (005 columns). These travel with
    // the fact to ytd-extract's persist path and the ytd-dashboard read path; an
    // unresolved row carries its status here while identity stays null above.
    ownership_confidence: ownership.confidence,
    ownership_resolution_status: ownership.status,
    data_quality_flags: [...new Set(qualityFlags)],
    last_synced_at: context.nowIso,
    sync_run_id: context.syncRunId,
  }
}
