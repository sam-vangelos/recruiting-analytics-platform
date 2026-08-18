import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import {
  compareOccupiedStages,
  dedupeOccupiedStages,
  isTrueOriginStagePass,
  type OccupiedStage,
} from "../delivery-source/candidate-stage-events"
import {
  ADVANCE_FROM_STAGE,
  ELT_SECTIONS,
  ELT_STAGES,
  EXEC_FUNNEL_STAGES,
  FINALIST_FROM_STAGE,
  OFFERS_TRAILING_DAYS,
  TIER_ACTIVITY_WINDOW_DAYS,
  UNCLASSIFIED_STAGE_LABEL,
  activityWindows,
  attentionOf,
  classifyReq,
  eltReportingFriday,
  fridayWeekLabels,
  fridayWeekStartUtc,
  healthOf,
  momentumOf,
  normalizeStageLabel,
  reportingQuarter,
  resolveFunnelStage,
  stageAtOrBeyond,
  tierOf,
  windowHalfOf,
  type AttentionFlag,
  type ExecHealth,
  type ExecTier,
  type FunnelStageResolution,
  type GovernedFunnelEntry,
  type MomentumLabel,
  type ReqClass,
} from "../exec-definitions"
import type {
  ExecPullDiagnostic,
  HarvestExecStateSources,
} from "../extractors/greenhouse-exec-read-boundary"
import type { HarvestApplicationStageRecord } from "../extractors/greenhouse-harvest-read-adapter"
import { customFieldValue } from "../extractors/greenhouse-harvest-read-adapter"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { CommandCenterMode, SourceEvidenceRef } from "../substrate"
import { finalizeModuleResult, type RecruitingOpsModuleDefinition, type RecruitingOpsModuleResult } from "./types"

const GH_PERSON_URL = "https://app.greenhouse.io/people/"

export const execStateOfPlayModuleDefinition = {
  moduleId: "exec-state-of-play",
  workflowId: "E01",
  capabilityId: "structured_hiring_status",
  title: "E01 exec state-of-play",
  sourceIds: ["greenhouse"],
  queryIds: [],
  legacyArtifactIds: [],
  outputContractIds: ["exec_state_of_play_snapshot"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find(
  (contract) => contract.sourceContractId === "exec_state_of_play_snapshot"
)!
if (!outputContract) throw new Error("Missing exec state-of-play concrete output contract")

export interface ExecFinalistRef {
  name: string
  url: string
  stage: string
  /** Days sitting in the current stage (from the engaged stage-history pull); null when unresolvable. */
  in_stage_days: number | null
}

export interface ExecFunnelCell {
  stage: string
  count: number
  /** Longest current-stage wait among these candidates, days; null for pre-screen and unclassified buckets. */
  oldest_days: number | null
  median_days: number | null
}

export interface ExecStageMovement {
  stage: string
  /** Interviews conducted at this stage in the trailing 14 days (submitted scorecards). */
  conducted: number
  /** Candidates who advanced INTO this stage in the trailing 14 days. */
  advanced_in: number
}

/** One row per open requisition — the contract the page, snapshot, and ELT facts consume. */
export interface ExecReqRow {
  req_id: number | null
  job_id: string
  role: string
  department: string
  confidential: boolean
  req_class: ReqClass
  owner: string | null
  owner_kind: "recruiter" | "sourcer" | null
  owner_on_roster: boolean | null
  seats: number
  opened_on: string | null
  days_open: number | null
  /** Stage names as VALUES (a "Recruiter Phone Screen" KEY trips the PII key-pattern certifier). */
  funnel: ExecFunnelCell[]
  engaged_depth: number
  application_pile: number
  unclassified_count: number
  furthest_stage: string | null
  finalists: ExecFinalistRef[]
  conducted_last7: number
  conducted_prior7: number
  pending_writeups: number
  advanced_last7: number
  advanced_prior7: number
  added_last7: number
  conducted_last30: number
  advanced_last30: number
  added_last30: number
  /** Most recent stage entry across the req's engaged applications (unbounded); null when none. */
  last_advance_at: string | null
  /** Most recent accepted offer on this req inside the offers pull window; null when none. */
  last_hire_accepted_on: string | null
  /** Trailing-14-day per-stage movement (stage names as VALUES). */
  movement_14d: ExecStageMovement[]
  tier: ExecTier
  tier_rule: string
  tier_reason: string
  /** Fired attention rules, most severe first (content contract §1.3); populated for in-play rows. */
  attention: { rule: string; reason: string }[]
  momentum: MomentumLabel
  health: ExecHealth
  health_rule: string
  health_reason: string
  offers_accepted_12wk: number
  /** Reporting-week per-stage activity for the ELT funnels (stage name as a VALUE — a key would trip the PII key-pattern certifier). */
  week_stage_activity: { stage: string; conducted: number; passed: number }[]
}

export interface ExecHireRow {
  candidate: string
  url: string
  role: string
  req_id: number | null
  department: string
  priority: string | null
  location: string | null
  accepted_on: string
  starts_on: string | null
  week_friday: string
}

export interface ExecOrgRollup {
  as_of: string
  reporting_week_friday: string
  open_roles: number
  pools_campaigns_templates: number
  red: number
  amber: number
  green: number
  seats: number
  unowned_roles: number
  offers_accepted_12wk: number
  momentum: Record<string, number>
  /** Role counts per liveness tier (content contract §1.2). */
  tiers: { in_play: number; gone_quiet: number; filled_not_closed: number; no_search: number }
  /** In-play roles with at least one fired attention rule — the "Needs a push" group. */
  attention_count: number
  positions_in_play: number
  /** Offer-stage candidates across role reqs, and how many have waited 14+ days. */
  offers_out: { count: number; waiting_14d_plus: number }
  off_scope_scorecards: number
  conducted_unattributed_stage: number
  truncation_suspected_pulls: number
}

/** The shape scripts/build-elt-update.py consumes (argv[1]) — legacy ELT doc facts. */
export interface ExecEltFacts {
  generatedAt: string
  weekLabel: string
  weekShort: string
  hires: {
    candidate: string
    role: string
    reqId: number | null
    startsOn: string | null
    department: string | null
    priority: string | null
    location: string | null
  }[]
  hiresNote: string
  sections: {
    title: string
    subs: string[]
    qtdOffers: { total: number; subs: { label: string; count: number }[]; names: string[] }
    stages: {
      label: string
      conducted: number
      passed: number
      subs: { label: string; conducted: number; passed: number }[]
    }[]
    weekOffers: { total: number; subs: { label: string; count: number }[]; names: string[] }
  }[]
}

export interface ExecStateBundle {
  rows: ExecReqRow[]
  hires: ExecHireRow[]
  rollup: ExecOrgRollup
  eltFacts: ExecEltFacts
}

export interface ExecDerivationInput {
  sources: HarvestExecStateSources
  roster: readonly RecruiterTeamHodEntry[]
  governedFunnel: ReadonlyMap<string, GovernedFunnelEntry>
  candidateNameById: ReadonlyMap<string, string>
  /** Full stage histories for the engaged application ids (collectEngagedApplicationIds → boundary). */
  engagedStageHistories: readonly HarvestApplicationStageRecord[]
  nowMs: number
  pullDiagnostics: readonly ExecPullDiagnostic[]
  /**
   * Declares a past Fri–Thu week for the ELT block instead of deriving it from
   * nowMs. The clock itself never moves: generatedAt stays live, so the write
   * path's freshness fence holds honestly, and only the ELT week's event
   * windows rewind. Must be a UTC Friday strictly older than the derived
   * current ELT week — strictly older is what makes the declared week a
   * complete one, since the derived week is the last complete week.
   */
  eltBackfillWeekFriday?: string
}

function idOf(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text ? text : undefined
}

function personNameOf(record: { name?: string; first_name?: string; last_name?: string } | undefined): string {
  if (!record) return ""
  const direct = record.name?.trim()
  if (direct) return direct
  return [record.first_name, record.last_name].filter(Boolean).join(" ").trim()
}

/**
 * Light pre-pass: the candidate ids the derivation will need names for
 * (finalists on open reqs + accepted-offer candidates). The entrypoint fetches
 * exactly these before the full run, so name resolution stays scoped.
 */
export function collectExecCandidateIds(
  sources: HarvestExecStateSources,
  governedFunnel: ReadonlyMap<string, GovernedFunnelEntry>
): string[] {
  const ids = new Set<string>()
  const openJobIds = new Set(sources.jobs.map((job) => idOf(job.id)).filter(Boolean) as string[])
  for (const application of sources.applications) {
    const jobId = idOf(application.job_id)
    if (!jobId || !openJobIds.has(jobId)) continue
    const resolution = resolveFunnelStage(String(application.stage_name ?? ""), governedFunnel)
    if (!stageAtOrBeyond(resolution, FINALIST_FROM_STAGE)) continue
    const candidateId = idOf(application.candidate_id)
    if (candidateId) ids.add(candidateId)
  }
  for (const offer of sources.offers) {
    const candidateId = idOf(offer.candidate_id)
    if (candidateId) ids.add(candidateId)
  }
  return [...ids]
}

/**
 * The application ids whose stage histories the derivation needs: every
 * active application on an open req at a classified engaged stage (at or
 * beyond the advance stage). Feeds the boundary's scoped
 * /application_stages?application_ids pull — true last-advance dates and
 * time-in-current-stage, unbounded by the movement window.
 */
export function collectEngagedApplicationIds(
  sources: HarvestExecStateSources,
  governedFunnel: ReadonlyMap<string, GovernedFunnelEntry>
): string[] {
  const ids: string[] = []
  const openJobIds = new Set(sources.jobs.map((job) => idOf(job.id)).filter(Boolean) as string[])
  for (const application of sources.applications) {
    const jobId = idOf(application.job_id)
    if (!jobId || !openJobIds.has(jobId)) continue
    const resolution = resolveFunnelStage(String(application.stage_name ?? ""), governedFunnel)
    if (!stageAtOrBeyond(resolution, ADVANCE_FROM_STAGE)) continue
    const applicationId = idOf(application.id)
    if (applicationId) ids.push(applicationId)
  }
  return ids
}

interface StageResolutionAudit {
  cache: Map<string, FunnelStageResolution>
  /** Keyed by NORMALIZED label (gap-id grain: "Reached Out" and "reached out" are one gap), value keeps a representative raw label. */
  heuristicCounts: Map<string, { rawLabel: string; count: number }>
  unclassifiedCounts: Map<string, { rawLabel: string; count: number }>
}

function bumpAudit(counts: Map<string, { rawLabel: string; count: number }>, rawLabel: string): void {
  const key = normalizeStageLabel(rawLabel)
  const cell = counts.get(key) ?? { rawLabel, count: 0 }
  cell.count += 1
  counts.set(key, cell)
}

function auditedResolve(label: string, governed: ReadonlyMap<string, GovernedFunnelEntry>, audit: StageResolutionAudit) {
  const key = label ?? ""
  const cached = audit.cache.get(key)
  const resolution = cached ?? resolveFunnelStage(key, governed)
  if (!cached) audit.cache.set(key, resolution)
  if (resolution.source === "heuristic") bumpAudit(audit.heuristicCounts, key)
  if (resolution.source === "unclassified" && key.trim()) bumpAudit(audit.unclassifiedCounts, key)
  return resolution
}

/**
 * The ELT week: derived from the clock, or declared for a backfill. A declared
 * week must be a real UTC Friday strictly older than the derived week — never
 * the current or a future one, because those are what the honest clock already
 * produces and a "backfill" of them would be a way to write a week early.
 */
function resolveEltReportingFriday(nowMs: number, declared: string | undefined): string {
  const derived = eltReportingFriday(new Date(nowMs))
  if (declared === undefined) return derived
  const declaredMs = Date.parse(`${declared}T00:00:00.000Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(declared) ||
    !Number.isFinite(declaredMs) ||
    new Date(declaredMs).getUTCDay() !== 5
  ) {
    throw new Error("Declared ELT backfill week is not a valid UTC Friday.")
  }
  if (declaredMs >= Date.parse(`${derived}T00:00:00.000Z`)) {
    throw new Error("Declared ELT backfill week is not older than the governed current reporting week.")
  }
  return declared
}

export function deriveExecState(input: ExecDerivationInput): {
  bundle: ExecStateBundle
  sourceGaps: SourceGap[]
} {
  const { sources } = input
  const windows = activityWindows(input.nowMs)
  const reportingFriday = fridayWeekStartUtc(new Date(input.nowMs))
  const reportingFridayMs = Date.parse(`${reportingFriday}T00:00:00.000Z`)
  // The ELT doc's week is distinct from the page's current week: written on its
  // Thursday deadline it covers the week ending that day; otherwise the last
  // complete Fri–Thu week. A declared backfill week replaces the derivation but
  // never the clock.
  const eltFriday = resolveEltReportingFriday(input.nowMs, input.eltBackfillWeekFriday)
  const eltFridayMs = Date.parse(`${eltFriday}T00:00:00.000Z`)
  const eltWeekEndMs = eltFridayMs + 7 * 86_400_000
  const audit: StageResolutionAudit = { cache: new Map(), heuristicCounts: new Map(), unclassifiedCounts: new Map() }
  const sourceGaps: SourceGap[] = []
  const tierWindowStartMs = input.nowMs - TIER_ACTIVITY_WINDOW_DAYS * 86_400_000
  const daysAgoOf = (timestampMs: number) => Math.max(0, Math.floor((input.nowMs - timestampMs) / 86_400_000))

  // Engaged stage histories, indexed per application: the current-stage row
  // (current flag, else the un-exited row) and the most recent stage entry.
  const historyFactsByApp = new Map<string, { currentEnteredMs: number | null; lastEntryMs: number | null }>()
  {
    const rowsByApp = new Map<string, HarvestApplicationStageRecord[]>()
    for (const row of input.engagedStageHistories) {
      const applicationId = idOf(row.application_id)
      if (!applicationId) continue
      const bucket = rowsByApp.get(applicationId) ?? []
      bucket.push(row)
      rowsByApp.set(applicationId, bucket)
    }
    for (const [applicationId, rows] of rowsByApp) {
      let currentEnteredMs: number | null = null
      let lastEntryMs: number | null = null
      for (const row of rows) {
        const enteredMs = Date.parse(String(row.entered_at ?? ""))
        if (Number.isNaN(enteredMs) || enteredMs > input.nowMs) continue
        if (lastEntryMs === null || enteredMs > lastEntryMs) lastEntryMs = enteredMs
        const isCurrent = row.current === true || (row.current === undefined && !row.exited_at)
        if (isCurrent && (currentEnteredMs === null || enteredMs > currentEnteredMs)) currentEnteredMs = enteredMs
      }
      historyFactsByApp.set(applicationId, { currentEnteredMs, lastEntryMs })
    }
  }

  const departmentNameById = new Map<string, string>()
  for (const department of sources.departments) {
    const id = idOf(department.id)
    if (id) departmentNameById.set(id, department.name?.trim() || "Unassigned")
  }

  const openJobs = sources.jobs
  const openJobIds = new Set(openJobs.map((job) => idOf(job.id)).filter(Boolean) as string[])
  const jobById = new Map<string, (typeof openJobs)[number]>()
  for (const job of [...openJobs, ...sources.offerJobs]) {
    const id = idOf(job.id)
    if (id && !jobById.has(id)) jobById.set(id, job)
  }

  const seatsByJob = new Map<string, number>()
  for (const opening of sources.openings) {
    if (opening.open === false) continue
    const jobId = idOf(opening.job_id)
    if (!jobId || !openJobIds.has(jobId)) continue
    seatsByJob.set(jobId, (seatsByJob.get(jobId) ?? 0) + 1)
  }

  const userNameById = new Map<string, string>()
  for (const user of sources.users) {
    const id = idOf(user.id)
    if (id) userNameById.set(id, personNameOf(user))
  }
  const rosterNames = new Set(input.roster.map((entry) => entry.recruiterName.trim().toLowerCase()))
  const ownerByJob = new Map<string, { userId: string; kind: "recruiter" | "sourcer" }>()
  for (const ownerRecord of sources.jobOwners) {
    const jobId = idOf(ownerRecord.job_id)
    const userId = idOf(ownerRecord.user_id)
    if (!jobId || !userId || !openJobIds.has(jobId)) continue
    const kind = ownerRecord.type === "recruiter" ? "recruiter" : ownerRecord.type === "sourcer" ? "sourcer" : null
    if (!kind) continue
    const existing = ownerByJob.get(jobId)
    const wins =
      !existing ||
      (kind === "recruiter" && existing.kind === "sourcer") ||
      (kind === existing.kind && ownerRecord.responsible === true)
    if (wins) ownerByJob.set(jobId, { userId, kind })
  }

  const applicationsByJob = new Map<string, typeof sources.applications extends readonly (infer T)[] ? T[] : never>()
  const jobByApplicationId = new Map<string, string>()
  for (const application of sources.applications) {
    const jobId = idOf(application.job_id)
    const applicationId = idOf(application.id)
    if (applicationId && jobId) jobByApplicationId.set(applicationId, jobId)
    if (!jobId || !openJobIds.has(jobId)) continue
    const bucket = applicationsByJob.get(jobId) ?? []
    bucket.push(application)
    applicationsByJob.set(jobId, bucket)
  }
  for (const application of sources.movementApplications) {
    const jobId = idOf(application.job_id)
    const applicationId = idOf(application.id)
    if (applicationId && jobId && !jobByApplicationId.has(applicationId)) {
      jobByApplicationId.set(applicationId, jobId)
    }
  }

  const stageNameByStageId = new Map<string, string>()
  for (const stage of sources.jobInterviewStages) {
    const id = idOf(stage.id)
    if (id) stageNameByStageId.set(id, String(stage.name ?? ""))
  }
  const jobInterviewById = new Map<string, string>() // job_interview id → job_interview_stage_id
  for (const slot of sources.jobInterviews) {
    const id = idOf(slot.id)
    const stageId = idOf(slot.job_interview_stage_id)
    if (id && stageId) jobInterviewById.set(id, stageId)
  }
  const jobInterviewIdByKitId = new Map<string, string>()
  for (const kit of sources.interviewKits) {
    const id = idOf(kit.id)
    const jobInterviewId = idOf(kit.job_interview_id)
    if (id && jobInterviewId) jobInterviewIdByKitId.set(id, jobInterviewId)
  }

  interface JobActivity {
    conductedLast7: number
    conductedPrior7: number
    advancedLast7: number
    advancedPrior7: number
    addedLast7: number
    conducted30: number
    advanced30: number
    added30: number
    pendingWriteups: number
    weekStage: Map<string, { conducted: number; passed: number }>
    eltWeekStage: Map<string, { conducted: number; passed: number }>
    /** Trailing-14-day per-stage movement for the page's disclosure layer. */
    move14: Map<string, { conducted: number; advanced_in: number }>
  }
  const activityByJob = new Map<string, JobActivity>()
  const activityFor = (jobId: string): JobActivity => {
    const existing = activityByJob.get(jobId)
    if (existing) return existing
    const fresh: JobActivity = {
      conductedLast7: 0,
      conductedPrior7: 0,
      advancedLast7: 0,
      advancedPrior7: 0,
      addedLast7: 0,
      conducted30: 0,
      advanced30: 0,
      added30: 0,
      pendingWriteups: 0,
      weekStage: new Map(),
      eltWeekStage: new Map(),
      move14: new Map(),
    }
    activityByJob.set(jobId, fresh)
    return fresh
  }
  const move14Bump = (activity: JobActivity, stageLabel: string, field: "conducted" | "advanced_in") => {
    const cell = activity.move14.get(stageLabel) ?? { conducted: 0, advanced_in: 0 }
    cell[field] += 1
    activity.move14.set(stageLabel, cell)
  }
  const inTierWindow = (timestampMs: number) => timestampMs >= tierWindowStartMs && timestampMs <= input.nowMs
  const stageBump = (
    grid: Map<string, { conducted: number; passed: number }>,
    stageLabel: string,
    field: "conducted" | "passed"
  ) => {
    const cell = grid.get(stageLabel) ?? { conducted: 0, passed: 0 }
    cell[field] += 1
    grid.set(stageLabel, cell)
  }
  const inEltWeek = (timestampMs: number) => timestampMs >= eltFridayMs && timestampMs < eltWeekEndMs
  const stageBumpOnce = (
    seen: Set<string>,
    grid: Map<string, { conducted: number; passed: number }>,
    stageLabel: string,
    field: "conducted" | "passed"
  ) => {
    if (seen.has(stageLabel)) return
    seen.add(stageLabel)
    stageBump(grid, stageLabel, field)
  }
  const stagesByApplicationId = new Map<string, OccupiedStage[]>()
  const collectOccupiedStage = (
    stageRow: HarvestApplicationStageRecord,
    applicationId: string,
    enteredAtMs: number,
    rawStage: string | null,
    resolution: FunnelStageResolution | null
  ) => {
    const exitedAtMs = Date.parse(String(stageRow.exited_at ?? ""))
    const stages = stagesByApplicationId.get(applicationId) ?? []
    stages.push({
      source: stageRow,
      sourceId: idOf(stageRow.id) ?? null,
      applicationId,
      stageId: idOf(stageRow.job_interview_stage_id) ?? null,
      rawStage,
      resolution,
      enteredAt: new Date(enteredAtMs).toISOString(),
      enteredAtMs,
      exitedAt: Number.isFinite(exitedAtMs) ? new Date(exitedAtMs).toISOString() : null,
      exitedAtMs: Number.isFinite(exitedAtMs) ? exitedAtMs : null,
    })
    stagesByApplicationId.set(applicationId, stages)
  }

  // Stage advances + top-of-funnel adds from stage-entry events.
  for (const stageRow of sources.applicationStages) {
    const enteredAtMs = Date.parse(String(stageRow.entered_at ?? ""))
    if (Number.isNaN(enteredAtMs)) continue // plan-scaffolding rows carry no entered_at
    const applicationId = idOf(stageRow.application_id)
    if (!applicationId) continue
    const jobId = jobByApplicationId.get(applicationId)
    if (!jobId || !openJobIds.has(jobId)) continue
    const stageName = stageNameByStageId.get(idOf(stageRow.job_interview_stage_id) ?? "")
    if (stageName === undefined) {
      collectOccupiedStage(stageRow, applicationId, enteredAtMs, null, null)
      continue
    }
    const resolution = auditedResolve(stageName, input.governedFunnel, audit)
    const half = windowHalfOf(enteredAtMs, windows)
    const activity = activityFor(jobId)
    if (stageAtOrBeyond(resolution, ADVANCE_FROM_STAGE)) {
      if (inTierWindow(enteredAtMs)) activity.advanced30 += 1
      if (half) move14Bump(activity, resolution.stage, "advanced_in")
    } else if (resolution.order !== null && resolution.order <= 1 && inTierWindow(enteredAtMs)) {
      activity.added30 += 1
    }
    if (half && stageAtOrBeyond(resolution, ADVANCE_FROM_STAGE)) {
      if (half === "last7") activity.advancedLast7 += 1
      else activity.advancedPrior7 += 1
    } else if (half === "last7" && resolution.order !== null && resolution.order <= 1) {
      activity.addedLast7 += 1
    }
    collectOccupiedStage(stageRow, applicationId, enteredAtMs, stageName.trim() || null, resolution)
  }

  // Reporting-week stage activity: entries belong to the stage entered; true
  // forward passes belong to the stage exited.
  for (const [applicationId, unsortedStages] of stagesByApplicationId) {
    const jobId = jobByApplicationId.get(applicationId)
    if (!jobId) continue
    const stages = dedupeOccupiedStages(unsortedStages).sort(compareOccupiedStages)
    const weekConducted = new Set<string>()
    const eltWeekConducted = new Set<string>()
    const weekPassed = new Set<string>()
    const eltWeekPassed = new Set<string>()
    const activity = activityFor(jobId)
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]
      if (stage.resolution && stage.resolution.order !== null) {
        if (stage.enteredAtMs >= reportingFridayMs) {
          stageBumpOnce(weekConducted, activity.weekStage, stage.resolution.stage, "conducted")
        }
        if (inEltWeek(stage.enteredAtMs)) {
          stageBumpOnce(eltWeekConducted, activity.eltWeekStage, stage.resolution.stage, "conducted")
        }
      }
      if (!isTrueOriginStagePass(stage, stages[index + 1])) continue
      if (stage.exitedAtMs! >= reportingFridayMs) {
        stageBumpOnce(weekPassed, activity.weekStage, stage.resolution!.stage, "passed")
      }
      if (inEltWeek(stage.exitedAtMs!)) {
        stageBumpOnce(eltWeekPassed, activity.eltWeekStage, stage.resolution!.stage, "passed")
      }
    }
  }

  // Interviews conducted, from scorecards (complete only), stage via kit → slot → stage.
  let offScopeScorecards = 0
  let conductedUnattributedStage = 0
  for (const scorecard of sources.scorecards) {
    if (scorecard.status !== "complete") continue
    const applicationId = idOf(scorecard.application_id)
    const jobId = applicationId ? jobByApplicationId.get(applicationId) : undefined
    if (!jobId || !openJobIds.has(jobId)) {
      offScopeScorecards += 1
      continue
    }
    const conductedAtMs = Date.parse(String(scorecard.interviewed_at ?? scorecard.submitted_at ?? ""))
    if (Number.isNaN(conductedAtMs)) continue
    const half = windowHalfOf(conductedAtMs, windows)
    const activity = activityFor(jobId)
    if (half === "last7") activity.conductedLast7 += 1
    else if (half === "prior7") activity.conductedPrior7 += 1
    if (inTierWindow(conductedAtMs)) activity.conducted30 += 1
    const kitId = idOf(scorecard.interview_kit_id)
    const stageId = kitId ? jobInterviewById.get(jobInterviewIdByKitId.get(kitId) ?? "") : undefined
    const stageName = stageId ? stageNameByStageId.get(stageId) : undefined
    if (stageName !== undefined && half) {
      move14Bump(activity, auditedResolve(stageName, input.governedFunnel, audit).stage, "conducted")
    }
    if ((conductedAtMs >= reportingFridayMs || inEltWeek(conductedAtMs)) && stageName === undefined) {
      conductedUnattributedStage += 1
    }
  }

  // Interviews conducted but awaiting a write-up (current-state).
  for (const interview of sources.awaitingFeedbackInterviews) {
    const jobId = idOf(interview.job_id) ?? idOf(interview.job?.id)
    if (!jobId || !openJobIds.has(jobId)) continue
    activityFor(jobId).pendingWriteups += 1
  }

  // Offers accepted. The boundary's pull window may be WIDER than 12 weeks
  // (it extends to the ELT reporting quarter's start for QTD) — the hires
  // strip, rollup, and per-req counts stay true 12-week numbers; only the ELT
  // QTD reads the full set.
  const acceptedMsOf = (hire: ExecHireRow) => Date.parse(`${hire.accepted_on}T00:00:00.000Z`)
  const offersTrailingStartMs = input.nowMs - OFFERS_TRAILING_DAYS * 86_400_000
  const offersByJob = new Map<string, number>()
  const lastHireByJob = new Map<string, string>()
  const allHires: ExecHireRow[] = []
  for (const offer of sources.offers) {
    const jobId = idOf(offer.job_id)
    const job = jobId ? jobById.get(jobId) : undefined
    const candidateId = idOf(offer.candidate_id)
    const acceptedOn = String(offer.resolved_at ?? "").slice(0, 10)
    if (!acceptedOn) continue
    const acceptedMs = Date.parse(`${acceptedOn}T00:00:00.000Z`)
    if (jobId && acceptedMs >= offersTrailingStartMs) offersByJob.set(jobId, (offersByJob.get(jobId) ?? 0) + 1)
    if (jobId && acceptedOn > (lastHireByJob.get(jobId) ?? "")) lastHireByJob.set(jobId, acceptedOn)
    allHires.push({
      candidate: (candidateId && input.candidateNameById.get(candidateId)) || "Candidate",
      url: candidateId ? `${GH_PERSON_URL}${candidateId}` : "",
      role: String(job?.name ?? ""),
      req_id: job?.requisition_id != null ? Number(job.requisition_id) : null,
      department: (job?.department_id != null && departmentNameById.get(String(job.department_id))) || "Unassigned",
      priority: customFieldValue(job?.custom_fields, "priority") ?? null,
      location: customFieldValue(job?.custom_fields, "hiring location(s)") ?? customFieldValue(job?.custom_fields, "location") ?? null,
      accepted_on: acceptedOn,
      starts_on: offer.starts_on ? String(offer.starts_on).slice(0, 10) : null,
      week_friday: fridayWeekStartUtc(new Date(Date.parse(`${acceptedOn}T00:00:00.000Z`))),
    })
  }
  allHires.sort((a, b) => b.accepted_on.localeCompare(a.accepted_on))
  const hires = allHires.filter((hire) => acceptedMsOf(hire) >= offersTrailingStartMs)

  // Per-req rows.
  const rows: ExecReqRow[] = []
  const rowSortAux = new Map<
    string,
    {
      attentionSeverity: number
      attentionWait: number
      deepestOrder: number
      act14: number
      lastAdvanceDays: number | null
      lastHireOn: string
    }
  >()
  for (const job of openJobs) {
    const jobId = idOf(job.id)
    if (!jobId) continue
    const applications = applicationsByJob.get(jobId) ?? []
    const funnelCounts = new Map<string, number>()
    const stageAges = new Map<string, number[]>()
    let engagedDepth = 0
    let applicationPile = 0
    let unclassifiedCount = 0
    let furthestOrder = -1
    let lastAdvanceMs: number | null = null
    const finalists: ExecFinalistRef[] = []
    for (const application of applications) {
      const resolution = auditedResolve(String(application.stage_name ?? ""), input.governedFunnel, audit)
      funnelCounts.set(resolution.stage, (funnelCounts.get(resolution.stage) ?? 0) + 1)
      let inStageDays: number | null = null
      if (resolution.order === null) {
        unclassifiedCount += 1
      } else if (resolution.order <= 1) {
        applicationPile += 1
      } else {
        engagedDepth += 1
        const applicationId = idOf(application.id)
        const history = applicationId ? historyFactsByApp.get(applicationId) : undefined
        if (history?.lastEntryMs != null && (lastAdvanceMs === null || history.lastEntryMs > lastAdvanceMs)) {
          lastAdvanceMs = history.lastEntryMs
        }
        if (history?.currentEnteredMs != null) {
          inStageDays = daysAgoOf(history.currentEnteredMs)
          const ages = stageAges.get(resolution.stage) ?? []
          ages.push(inStageDays)
          stageAges.set(resolution.stage, ages)
        }
      }
      if (resolution.order !== null && resolution.order > furthestOrder) furthestOrder = resolution.order
      if (stageAtOrBeyond(resolution, FINALIST_FROM_STAGE)) {
        const candidateId = idOf(application.candidate_id)
        finalists.push({
          name: (candidateId && input.candidateNameById.get(candidateId)) || "Candidate",
          url: candidateId ? `${GH_PERSON_URL}${candidateId}` : "",
          stage: resolution.stage,
          in_stage_days: inStageDays,
        })
      }
    }
    finalists.sort(
      (a, b) =>
        EXEC_FUNNEL_STAGES.indexOf(b.stage as never) - EXEC_FUNNEL_STAGES.indexOf(a.stage as never) ||
        (b.in_stage_days ?? -1) - (a.in_stage_days ?? -1)
    )
    const agesOf = (stage: string) => {
      const ages = stageAges.get(stage)
      if (!ages?.length) return { oldest: null as number | null, median: null as number | null }
      const sorted = [...ages].sort((a, b) => a - b)
      return { oldest: sorted[sorted.length - 1], median: sorted[Math.floor(sorted.length / 2)] }
    }

    const owner = ownerByJob.get(jobId)
    const ownerName = owner ? userNameById.get(owner.userId) || null : null
    const classification = classifyReq({ name: String(job.name ?? ""), isTemplate: job.is_template })
    const openedOn = job.opened_at ? String(job.opened_at).slice(0, 10) : null
    const daysOpen = openedOn ? Math.floor((input.nowMs - Date.parse(`${openedOn}T00:00:00.000Z`)) / 86_400_000) : null
    const activity = activityByJob.get(jobId)
    const facts = {
      seats: seatsByJob.get(jobId) ?? 0,
      engagedDepth,
      applicationPile,
      unclassifiedCount,
      daysOpen,
      conductedLast7: activity?.conductedLast7 ?? 0,
      conductedPrior7: activity?.conductedPrior7 ?? 0,
      advancedLast7: activity?.advancedLast7 ?? 0,
      advancedPrior7: activity?.advancedPrior7 ?? 0,
      addedLast7: activity?.addedLast7 ?? 0,
    }
    const verdict = healthOf(facts)
    const lastAdvanceDays = lastAdvanceMs !== null ? daysAgoOf(lastAdvanceMs) : null
    const tierVerdict = tierOf({
      conducted30: activity?.conducted30 ?? 0,
      advanced30: activity?.advanced30 ?? 0,
      addedLast7: facts.addedLast7,
      lastAdvanceDays,
      daysOpen,
      engagedDepth,
      offersAccepted12wk: offersByJob.get(jobId) ?? 0,
    })
    const offerAges = agesOf("Offer")
    const onsiteAges = agesOf("Onsite Interview")
    const attentionFlags: AttentionFlag[] = attentionOf({
      offerCount: funnelCounts.get("Offer") ?? 0,
      offerOldestDays: offerAges.oldest,
      onsiteCount: funnelCounts.get("Onsite Interview") ?? 0,
      onsiteOldestDays: onsiteAges.oldest,
      conductedLast7: facts.conductedLast7,
      conductedPrior7: facts.conductedPrior7,
      advancedLast7: facts.advancedLast7,
      advancedPrior7: facts.advancedPrior7,
      addedLast7: facts.addedLast7,
      engagedDepth,
      pendingWriteups: activity?.pendingWriteups ?? 0,
      owned: ownerName !== null,
      lastAdvanceDays,
    })
    rows.push({
      req_id: job.requisition_id != null ? Number(job.requisition_id) : null,
      job_id: jobId,
      role: String(job.name ?? ""),
      department:
        (job.department_id != null && departmentNameById.get(String(job.department_id))) || "Unassigned",
      confidential: job.confidential === true,
      req_class: classification.reqClass,
      owner: ownerName,
      owner_kind: owner?.kind ?? null,
      owner_on_roster: ownerName ? rosterNames.has(ownerName.trim().toLowerCase()) : null,
      seats: facts.seats,
      opened_on: openedOn,
      days_open: daysOpen,
      funnel: [...funnelCounts.entries()].map(([stage, count]) => {
        const ages = agesOf(stage)
        return { stage, count, oldest_days: ages.oldest, median_days: ages.median }
      }),
      engaged_depth: engagedDepth,
      application_pile: applicationPile,
      unclassified_count: unclassifiedCount,
      furthest_stage: furthestOrder >= 0 ? EXEC_FUNNEL_STAGES[furthestOrder] : unclassifiedCount > 0 ? UNCLASSIFIED_STAGE_LABEL : null,
      finalists,
      conducted_last7: facts.conductedLast7,
      conducted_prior7: facts.conductedPrior7,
      pending_writeups: activity?.pendingWriteups ?? 0,
      advanced_last7: facts.advancedLast7,
      advanced_prior7: facts.advancedPrior7,
      added_last7: facts.addedLast7,
      conducted_last30: activity?.conducted30 ?? 0,
      advanced_last30: activity?.advanced30 ?? 0,
      added_last30: activity?.added30 ?? 0,
      last_advance_at: lastAdvanceMs !== null ? new Date(lastAdvanceMs).toISOString() : null,
      last_hire_accepted_on: lastHireByJob.get(jobId) ?? null,
      movement_14d: [...(activity?.move14 ?? new Map()).entries()].map(([stage, cell]) => ({
        stage,
        conducted: cell.conducted,
        advanced_in: cell.advanced_in,
      })),
      tier: tierVerdict.tier,
      tier_rule: tierVerdict.ruleId,
      tier_reason: tierVerdict.reason,
      attention: attentionFlags.map((flag) => ({ rule: flag.ruleId, reason: flag.reason })),
      momentum: momentumOf(facts),
      health: verdict.health,
      health_rule: verdict.ruleId,
      health_reason: verdict.reason,
      offers_accepted_12wk: offersByJob.get(jobId) ?? 0,
      week_stage_activity: [...(activityByJob.get(jobId)?.weekStage ?? new Map()).entries()].map(
        ([stage, cell]) => ({ stage, conducted: cell.conducted, passed: cell.passed })
      ),
    })
    rowSortAux.set(jobId, {
      attentionSeverity: attentionFlags[0]?.severity ?? Number.POSITIVE_INFINITY,
      attentionWait: attentionFlags[0]?.waitDays ?? -1,
      deepestOrder: furthestOrder,
      act14: facts.conductedLast7 + facts.conductedPrior7 + facts.advancedLast7 + facts.advancedPrior7,
      lastAdvanceDays,
      lastHireOn: lastHireByJob.get(jobId) ?? "",
    })

    if (classification.reqClass !== "role") {
      sourceGaps.push({
        id: sanitizeGapId(`gap_e01_req_class_${jobId}`),
        workflowId: "E01",
        sourceId: "greenhouse",
        field: "req_class",
        reason: `Req "${String(job.name ?? "")}" classified as ${classification.reqClass} (signal: ${classification.signal ?? "none"}) — segregated from open roles; promote or correct the classification if wrong.`,
        blocksCutover: false,
      })
    } else if (!ownerName) {
      sourceGaps.push({
        id: sanitizeGapId(`gap_e01_unowned_${jobId}`),
        workflowId: "E01",
        sourceId: "greenhouse",
        field: "owner",
        reason: `Open role "${String(job.name ?? "")}" has no recruiter or sourcer owner.`,
        blocksCutover: false,
      })
    }
  }

  // Emit order IS the page's reading order (the page renders, never re-sorts):
  // roles before pools; tiers in contract order; within In-play the attention
  // rows lead (most severe, longest-waiting first) and the rest run closest-
  // to-hire first; Gone-quiet most-recent-stall first (most salvageable);
  // Filled-not-closed most-recent-hire first; No-search oldest first.
  const tierRank: Record<ExecTier, number> = { in_play: 0, gone_quiet: 1, filled_not_closed: 2, no_search: 3 }
  const aux = (row: ExecReqRow) =>
    rowSortAux.get(row.job_id) ?? {
      attentionSeverity: Number.POSITIVE_INFINITY,
      attentionWait: -1,
      deepestOrder: -1,
      act14: 0,
      lastAdvanceDays: null,
      lastHireOn: "",
    }
  rows.sort((a, b) => {
    const classRank = (row: ExecReqRow) => (row.req_class === "role" ? 0 : 1)
    if (classRank(a) !== classRank(b)) return classRank(a) - classRank(b)
    if (classRank(a) === 1) return b.engaged_depth - a.engaged_depth || (b.days_open ?? 0) - (a.days_open ?? 0)
    if (tierRank[a.tier] !== tierRank[b.tier]) return tierRank[a.tier] - tierRank[b.tier]
    const auxA = aux(a)
    const auxB = aux(b)
    switch (a.tier) {
      case "in_play": {
        const flaggedA = a.attention.length > 0 ? 0 : 1
        const flaggedB = b.attention.length > 0 ? 0 : 1
        if (flaggedA !== flaggedB) return flaggedA - flaggedB
        if (flaggedA === 0) {
          return (
            auxA.attentionSeverity - auxB.attentionSeverity ||
            auxB.attentionWait - auxA.attentionWait ||
            auxB.deepestOrder - auxA.deepestOrder
          )
        }
        return auxB.deepestOrder - auxA.deepestOrder || auxB.act14 - auxA.act14
      }
      case "gone_quiet":
        return (auxA.lastAdvanceDays ?? Number.POSITIVE_INFINITY) - (auxB.lastAdvanceDays ?? Number.POSITIVE_INFINITY)
      case "filled_not_closed":
        return auxB.lastHireOn.localeCompare(auxA.lastHireOn)
      default:
        return (b.days_open ?? 0) - (a.days_open ?? 0)
    }
  })

  // Stage-resolution gaps: one per DISTINCT normalized label, counted, never per row.
  for (const [normalized, cell] of audit.heuristicCounts) {
    sourceGaps.push({
      id: sanitizeGapId(`gap_e01_stage_heuristic_${normalized}`),
      workflowId: "E01",
      sourceId: "greenhouse",
      field: "stage_label",
      reason: `Stage label "${cell.rawLabel}" resolved by keyword heuristic (${cell.count} occurrence(s)) — promote it into recruiting_ops_interview_stage_taxonomy funnel columns.`,
      blocksCutover: false,
    })
  }
  for (const [normalized, cell] of audit.unclassifiedCounts) {
    sourceGaps.push({
      id: sanitizeGapId(`gap_e01_stage_unclassified_${normalized}`),
      workflowId: "E01",
      sourceId: "greenhouse",
      field: "stage_label",
      reason: `Stage label "${cell.rawLabel}" could not be classified (${cell.count} occurrence(s)) — candidates counted as "${UNCLASSIFIED_STAGE_LABEL}", excluded from finalists and advances.`,
      blocksCutover: false,
    })
  }
  for (const ownerName of new Set(
    rows.filter((row) => row.owner && row.owner_on_roster === false).map((row) => row.owner as string)
  )) {
    sourceGaps.push({
      id: sanitizeGapId(`gap_e01_owner_roster_${ownerName}`),
      workflowId: "E01",
      sourceId: "greenhouse",
      field: "owner",
      reason: `Req owner "${ownerName}" is not on the active governed roster — possibly departed or unmapped.`,
      blocksCutover: false,
    })
  }
  for (const pull of input.pullDiagnostics.filter((diagnostic) => diagnostic.truncationSuspected)) {
    sourceGaps.push({
      id: sanitizeGapId(`gap_e01_truncation_${pull.source}`),
      workflowId: "E01",
      sourceId: "greenhouse",
      field: "pull_completeness",
      reason: `Pull ${pull.source} returned ${pull.records} records at the configured cap — pages were likely dropped; raise the cap and rerun.`,
      blocksCutover: true,
    })
  }

  // --- ELT facts (legacy weekly-doc contract: scripts/build-elt-update.py) ---
  const eltLabels = fridayWeekLabels(eltFriday)
  const eltQuarter = reportingQuarter(eltFriday)
  const eltQuarterStartMs = Date.parse(`${eltQuarter.startIso}T00:00:00.000Z`)
  const jobIdByReqId = new Map<number, string>()
  for (const job of [...openJobs, ...sources.offerJobs]) {
    const id = idOf(job.id)
    if (id && job.requisition_id != null) jobIdByReqId.set(Number(job.requisition_id), id)
  }
  const hiresInEltWeek = allHires.filter((hire) => inEltWeek(acceptedMsOf(hire)))
  const eltFacts: ExecEltFacts = {
    generatedAt: new Date(input.nowMs).toISOString(),
    weekLabel: eltLabels.weekLabel,
    weekShort: eltLabels.weekShort,
    hires: hiresInEltWeek.map((hire) => ({
      candidate: hire.candidate,
      role: hire.role,
      reqId: hire.req_id,
      startsOn: hire.starts_on,
      department: hire.department || null,
      priority: hire.priority,
      location: hire.location,
    })),
    hiresNote: `For ${eltLabels.weekShort}, accepted offers are org-wide; candidates are counted when they enter each stage, and passes are credited to the stage they exit.`,
    sections: ELT_SECTIONS.map((section) => {
      const sectionHireOf = (hire: ExecHireRow) => section.subs.find((sub) => sub.reqId === hire.req_id)
      const qtd = allHires.filter((hire) => {
        const acceptedMs = acceptedMsOf(hire)
        return sectionHireOf(hire) && acceptedMs >= eltQuarterStartMs && acceptedMs < eltWeekEndMs
      })
      const weekOffers = hiresInEltWeek.filter((hire) => sectionHireOf(hire))
      const subCount = (list: ExecHireRow[], reqId: number) => list.filter((hire) => hire.req_id === reqId).length
      return {
        title: section.title,
        subs: section.subs.map((sub) => sub.label),
        qtdOffers: {
          total: qtd.length,
          subs: section.subs.map((sub) => ({ label: sub.label, count: subCount(qtd, sub.reqId) })),
          names: qtd.map((hire) => hire.candidate),
        },
        stages: ELT_STAGES.map((stage) => {
          const per = section.subs.map((sub) => {
            const jobId = jobIdByReqId.get(sub.reqId)
            const cell = jobId ? activityByJob.get(jobId)?.eltWeekStage.get(stage.funnelStage) : undefined
            return { label: sub.label, conducted: cell?.conducted ?? 0, passed: cell?.passed ?? 0 }
          })
          return {
            label: stage.label,
            conducted: per.reduce((sum, cell) => sum + cell.conducted, 0),
            passed: per.reduce((sum, cell) => sum + cell.passed, 0),
            subs: per,
          }
        }),
        weekOffers: {
          total: weekOffers.length,
          subs: section.subs.map((sub) => ({ label: sub.label, count: subCount(weekOffers, sub.reqId) })),
          names: weekOffers.map((hire) => hire.candidate),
        },
      }
    }),
  }

  const roleRows = rows.filter((row) => row.req_class === "role")
  const offerFinalists = roleRows.flatMap((row) => row.finalists.filter((finalist) => finalist.stage === "Offer"))
  const rollup: ExecOrgRollup = {
    as_of: new Date(input.nowMs).toISOString(),
    reporting_week_friday: reportingFriday,
    open_roles: roleRows.length,
    pools_campaigns_templates: rows.length - roleRows.length,
    red: roleRows.filter((row) => row.health === "red").length,
    amber: roleRows.filter((row) => row.health === "amber").length,
    green: roleRows.filter((row) => row.health === "green").length,
    seats: roleRows.reduce((sum, row) => sum + row.seats, 0),
    unowned_roles: roleRows.filter((row) => !row.owner).length,
    offers_accepted_12wk: hires.length,
    momentum: rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.momentum] = (acc[row.momentum] ?? 0) + 1
      return acc
    }, {}),
    tiers: {
      in_play: roleRows.filter((row) => row.tier === "in_play").length,
      gone_quiet: roleRows.filter((row) => row.tier === "gone_quiet").length,
      filled_not_closed: roleRows.filter((row) => row.tier === "filled_not_closed").length,
      no_search: roleRows.filter((row) => row.tier === "no_search").length,
    },
    attention_count: roleRows.filter((row) => row.tier === "in_play" && row.attention.length > 0).length,
    positions_in_play: roleRows.filter((row) => row.tier === "in_play").reduce((sum, row) => sum + row.seats, 0),
    offers_out: {
      count: offerFinalists.length,
      waiting_14d_plus: offerFinalists.filter((finalist) => (finalist.in_stage_days ?? 0) >= 14).length,
    },
    off_scope_scorecards: offScopeScorecards,
    conducted_unattributed_stage: conductedUnattributedStage,
    truncation_suspected_pulls: input.pullDiagnostics.filter((diagnostic) => diagnostic.truncationSuspected).length,
  }

  return { bundle: { rows, hires, rollup, eltFacts }, sourceGaps }
}

function sanitizeGapId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_./-]/g, "_")
}

export interface RunExecStateOfPlayModuleInput extends ExecDerivationInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  mode?: CommandCenterMode
}

export type ExecStateOfPlayModuleResult = RecruitingOpsModuleResult<ExecReqRow> & {
  execState: ExecStateBundle
}

export async function runExecStateOfPlayModule(
  input: RunExecStateOfPlayModuleInput
): Promise<ExecStateOfPlayModuleResult> {
  const runId = buildRunId(execStateOfPlayModuleDefinition.workflowId, input.startedAt)
  const { bundle, sourceGaps } = deriveExecState(input)

  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "e01_exec_state_sources",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label:
        "Org-wide open jobs, prospect-excluded active applications, windowed stage entries and scorecards, awaiting-feedback interviews, org-wide accepted offers.",
    },
  ]
  const publicSummary = {
    workflowId: execStateOfPlayModuleDefinition.workflowId,
    moduleId: execStateOfPlayModuleDefinition.moduleId,
    normalizedRowCount: bundle.rows.length,
    openRoles: bundle.rollup.open_roles,
    poolsCampaignsTemplates: bundle.rollup.pools_campaigns_templates,
    needsAttention: bundle.rollup.red + bundle.rollup.amber,
    tiersInPlay: bundle.rollup.tiers.in_play,
    tiersGoneQuiet: bundle.rollup.tiers.gone_quiet,
    tiersFilledNotClosed: bundle.rollup.tiers.filled_not_closed,
    tiersNoSearch: bundle.rollup.tiers.no_search,
    attentionCount: bundle.rollup.attention_count,
    offersOut: bundle.rollup.offers_out.count,
    seats: bundle.rollup.seats,
    unownedRoles: bundle.rollup.unowned_roles,
    offersAccepted12wk: bundle.rollup.offers_accepted_12wk,
    truncationSuspectedPulls: bundle.rollup.truncation_suspected_pulls,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: 0,
  }

  // deliverableId resolves the governed PII posture (internal_review_identifiers):
  // finalist names survive in the run artifacts instead of fail-closed redaction.
  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: execStateOfPlayModuleDefinition.workflowId,
    runId,
    deliverableId: outputContract.sourceContractId,
    schemaVersion: outputContract.schemaVersion,
    rows: bundle.rows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: execStateOfPlayModuleDefinition.workflowId,
    runId,
    deliverableId: outputContract.sourceContractId,
    schemaVersion: outputContract.schemaVersion,
    rows: bundle.rows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })

  const run = buildCommandCenterRun({
    workflowId: execStateOfPlayModuleDefinition.workflowId,
    capabilityId: execStateOfPlayModuleDefinition.capabilityId,
    moduleId: execStateOfPlayModuleDefinition.moduleId,
    mode: input.mode ?? "fixture",
    status: sourceGaps.some((gap) => gap.blocksCutover) ? "blocked" : "succeeded",
    startedAt: input.startedAt,
    completedAt: input.generatedAt,
    sourceRefs,
    legacyArtifactRefs: [],
    normalizedRows: bundle.rows,
    artifactRefs: [jsonArtifact, csvArtifact],
    sourceGaps,
    discrepancies: [],
    publicSummary,
  })

  const moduleResult = finalizeModuleResult({
    definition: execStateOfPlayModuleDefinition,
    normalizedRows: bundle.rows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies: [],
    sourceGaps,
    run,
  })
  return { ...moduleResult, execState: bundle }
}
