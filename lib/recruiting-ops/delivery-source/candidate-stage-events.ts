import {
  fridayWeekLabels,
  fridayWeekStartUtc,
  resolveFunnelStage,
  type GovernedFunnelEntry,
  type FunnelStageResolution,
} from "../exec-definitions"
import type {
  HarvestApplicationRecord,
  HarvestApplicationStageRecord,
  HarvestCandidateRecord,
  HarvestJobInterviewStageRecord,
  HarvestJobOwnerRecord,
  HarvestJobRecord,
  HarvestUserRecord,
} from "../extractors/greenhouse-harvest-read-adapter"

const MS_PER_WEEK = 7 * 86_400_000

/**
 * Legacy pipeline copies use a sequential week ordinal whose live values align
 * to Nov 28, 2025 = week 1. The display label still comes from the governed
 * Fri–Thu calendar; this constant exists only to preserve the sortable legacy
 * ordinal.
 */
export const CANDIDATE_STAGE_EVENT_WEEK_ORDER_EPOCH = "2025-11-28"

export type CandidateStageEventType = "entered" | "passed" | "rejected" | "withdrawn"
export type CandidateStageOutcomeDirection = "company_rejected" | "candidate_withdrew"
export type CandidateStageSourceKind = "application_stage" | "application_outcome"

/**
 * Explicit terminal evidence. Application status alone is intentionally not
 * enough to synthesize a terminal event: it carries no trustworthy event time
 * or rejection/withdrawal direction in the current Harvest application shape.
 */
export interface CandidateStageOutcomeSource {
  id?: string | number
  application_id: string | number
  event_type: "rejected" | "withdrawn"
  event_at: string
  stage_id?: string | number | null
  stage_name?: string | null
  rejection_reason_id?: string | number | null
  rejection_reason?: string | null
  /** Raw legacy withdrawal narrative, e.g. "Withdrew from Onsite Interviews". */
  withdrew?: string | null
  /** Raw rejecting actor name from the source; this is not a direction category. */
  rejected_by?: string | null
}

export interface CandidateStageRecruiterIdentity {
  recruiter_id: string | null
  recruiter_name: string | null
}

export interface EmitCandidateStageEventRowsInput {
  applications: readonly HarvestApplicationRecord[]
  applicationStages: readonly HarvestApplicationStageRecord[]
  jobInterviewStages: readonly HarvestJobInterviewStageRecord[]
  jobs: readonly HarvestJobRecord[]
  governedFunnel: ReadonlyMap<string, GovernedFunnelEntry>
  outcomes?: readonly CandidateStageOutcomeSource[]
  candidates?: readonly HarvestCandidateRecord[]
  candidateNameById?: ReadonlyMap<string, string>
  jobOwners?: readonly HarvestJobOwnerRecord[]
  users?: readonly HarvestUserRecord[]
  /**
   * Optional governed ownership result. It wins over the conservative fallback
   * derived from jobOwners/users and is the preferred production seam.
   */
  recruiterByJobId?: ReadonlyMap<string, CandidateStageRecruiterIdentity>
}

/**
 * Shared, artifact-neutral application × stage-event fact. The common legacy
 * candidate-tab columns retain their names (`week_order`, `week`,
 * `requisition_id`, …); the additional ids and canonical fields prevent the
 * Google delivery layer from having to reconstruct joins or business logic.
 */
export interface CandidateStageEventRow {
  event_key: string
  source_kind: CandidateStageSourceKind
  source_stage_event_id: string | null
  source_outcome_id: string | null

  week_order: number
  week: string
  week_label: string
  reporting_week_friday: string
  reporting_week_thursday: string

  job_id: string | null
  requisition_id: string | null
  job_name: string | null
  application_id: string
  candidate_id: string | null
  candidate_name: string | null
  recruiter_id: string | null
  recruiter_name: string | null

  raw_stage_id: string | null
  stage_name: string | null
  core_stage: FunnelStageResolution["stage"] | null
  core_stage_order: number | null
  stage_resolution_source: FunnelStageResolution["source"] | null
  event_type: CandidateStageEventType
  event_ts: string

  application_status: string | null
  current_stage_id: string | null
  current_stage_name: string | null
  current_core_stage: FunnelStageResolution["stage"] | null
  current_core_stage_order: number | null

  rejected_at: string | null
  withdrew: string | null
  rejected_by: string | null
  rejection_reason_id: string | null
  rejection_reason: string | null
  outcome_direction: CandidateStageOutcomeDirection | null
}

interface NormalizedOutcome {
  source: CandidateStageOutcomeSource
  sourceId: string | null
  applicationId: string
  eventAt: string
  eventAtMs: number
}

export interface OccupiedStage {
  source: HarvestApplicationStageRecord
  sourceId: string | null
  applicationId: string
  stageId: string | null
  rawStage: string | null
  resolution: FunnelStageResolution | null
  enteredAt: string
  enteredAtMs: number
  exitedAt: string | null
  exitedAtMs: number | null
}

interface EventStage {
  stageId: string | null
  rawStage: string | null
  resolution: FunnelStageResolution | null
}

interface EventIdentity {
  application: HarvestApplicationRecord
  applicationId: string
  jobId: string | null
  requisitionId: string | null
  jobName: string | null
  candidateId: string | null
  candidateName: string | null
  recruiter: CandidateStageRecruiterIdentity
  currentStage: EventStage
}

/** Pure, deterministic platform emit. Performs no reads, writes, or logging. */
export function emitCandidateStageEventRows(input: EmitCandidateStageEventRowsInput): CandidateStageEventRow[] {
  const applicationById = indexApplications(input.applications)
  const jobById = indexById(input.jobs)
  const stageNameById = new Map<string, string>()
  for (const stage of input.jobInterviewStages) {
    const stageId = idOf(stage.id)
    const stageName = textOf(stage.name)
    if (stageId && stageName) stageNameById.set(stageId, stageName)
  }

  const candidateNameById = buildCandidateNameIndex(input.candidates ?? [], input.candidateNameById)
  const recruiterByJobId = buildRecruiterIndex(input)
  const normalizedOutcomes = normalizeOutcomes(input.outcomes ?? [], applicationById)
  const latestOutcomeByApplicationId = latestOutcomeIndex(normalizedOutcomes)

  const identityByApplicationId = new Map<string, EventIdentity>()
  const identityFor = (applicationId: string): EventIdentity | null => {
    const cached = identityByApplicationId.get(applicationId)
    if (cached) return cached
    const application = applicationById.get(applicationId)
    if (!application) return null
    const jobId = idOf(application.job_id) ?? idOf(application.job?.id) ?? null
    const job = jobId ? jobById.get(jobId) : undefined
    const candidateId = idOf(application.candidate_id) ?? null
    const currentStageId = idOf(application.stage_id) ?? null
    const currentRawStage =
      textOf(application.stage_name) ?? textOf(application.current_stage?.name) ??
      (currentStageId ? stageNameById.get(currentStageId) ?? null : null)
    const identity: EventIdentity = {
      application,
      applicationId,
      jobId,
      requisitionId:
        idOf(job?.requisition_id) ??
        idOf(application.req_id) ??
        idOf(application.requisition_id) ??
        idOf(application.job?.requisition_id) ??
        null,
      jobName: textOf(job?.name) ?? textOf(application.job?.name),
      candidateId,
      candidateName: candidateId ? textOf(candidateNameById.get(candidateId)) : null,
      recruiter: jobId ? recruiterByJobId.get(jobId) ?? EMPTY_RECRUITER : EMPTY_RECRUITER,
      currentStage: eventStage(currentStageId, currentRawStage, input.governedFunnel),
    }
    identityByApplicationId.set(applicationId, identity)
    return identity
  }

  const stagesByApplicationId = new Map<string, OccupiedStage[]>()
  for (const row of input.applicationStages) {
    const applicationId = idOf(row.application_id)
    if (!applicationId || !applicationById.has(applicationId)) continue
    const entered = timestampOf(row.entered_at)
    // Harvest pre-creates never-occupied plan rows. They are definitions, not events.
    if (!entered) continue
    const stageId = idOf(row.job_interview_stage_id) ?? null
    const rawStage = stageId ? stageNameById.get(stageId) ?? null : null
    const exited = timestampOf(row.exited_at)
    const bucket = stagesByApplicationId.get(applicationId) ?? []
    bucket.push({
      source: row,
      sourceId: idOf(row.id) ?? null,
      applicationId,
      stageId,
      rawStage,
      resolution: rawStage ? resolveFunnelStage(rawStage, input.governedFunnel) : null,
      enteredAt: entered.iso,
      enteredAtMs: entered.ms,
      exitedAt: exited?.iso ?? null,
      exitedAtMs: exited?.ms ?? null,
    })
    stagesByApplicationId.set(applicationId, bucket)
  }

  const rows: CandidateStageEventRow[] = []
  for (const [applicationId, unsortedStages] of stagesByApplicationId) {
    const identity = identityFor(applicationId)
    if (!identity) continue
    const stages = dedupeOccupiedStages(unsortedStages).sort(compareOccupiedStages)
    const terminal = latestOutcomeByApplicationId.get(applicationId) ?? null
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]
      rows.push(buildStageRow(identity, stage, "entered", stage.enteredAt, terminal))

      const next = stages[index + 1]
      if (!isTrueOriginStagePass(stage, next)) continue
      rows.push(buildStageRow(identity, stage, "passed", stage.exitedAt!, terminal))
    }
  }

  for (const outcome of normalizedOutcomes) {
    const identity = identityFor(outcome.applicationId)
    if (!identity) continue
    const stageId = idOf(outcome.source.stage_id) ?? identity.currentStage.stageId
    const rawStage = textOf(outcome.source.stage_name) ?? identity.currentStage.rawStage
    rows.push(buildOutcomeRow(identity, outcome, eventStage(stageId, rawStage, input.governedFunnel)))
  }

  const unique = new Map<string, CandidateStageEventRow>()
  for (const row of rows) {
    // Identical source evidence re-read on an overlapping pull must not duplicate output.
    if (!unique.has(row.event_key)) unique.set(row.event_key, row)
  }
  return [...unique.values()].sort(compareCandidateStageEventRows)
}

function buildStageRow(
  identity: EventIdentity,
  stage: OccupiedStage,
  eventType: "entered" | "passed",
  eventAt: string,
  terminal: NormalizedOutcome | null
): CandidateStageEventRow {
  const sourceIdentity =
    stage.sourceId ??
    [stage.stageId ?? "stage-missing", stage.enteredAt, stage.exitedAt ?? "open"].map(encodeURIComponent).join("|")
  return buildRow({
    identity,
    sourceKind: "application_stage",
    sourceStageEventId: stage.sourceId,
    sourceOutcomeId: null,
    sourceIdentity,
    eventType,
    eventAt,
    stage: { stageId: stage.stageId, rawStage: stage.rawStage, resolution: stage.resolution },
    terminal,
  })
}

function buildOutcomeRow(
  identity: EventIdentity,
  outcome: NormalizedOutcome,
  stage: EventStage
): CandidateStageEventRow {
  const sourceIdentity =
    outcome.sourceId ??
    [outcome.source.event_type, outcome.eventAt, stage.stageId ?? stage.rawStage ?? "stage-missing"]
      .map(encodeURIComponent)
      .join("|")
  return buildRow({
    identity,
    sourceKind: "application_outcome",
    sourceStageEventId: null,
    sourceOutcomeId: outcome.sourceId,
    sourceIdentity,
    eventType: outcome.source.event_type,
    eventAt: outcome.eventAt,
    stage,
    terminal: outcome,
  })
}

function buildRow(input: {
  identity: EventIdentity
  sourceKind: CandidateStageSourceKind
  sourceStageEventId: string | null
  sourceOutcomeId: string | null
  sourceIdentity: string
  eventType: CandidateStageEventType
  eventAt: string
  stage: EventStage
  terminal: NormalizedOutcome | null
}): CandidateStageEventRow {
  const week = reportingWeek(input.eventAt)
  const terminalSource = input.terminal?.source
  return {
    event_key: stableEventKey(input.identity.applicationId, input.sourceKind, input.sourceIdentity, input.eventType),
    source_kind: input.sourceKind,
    source_stage_event_id: input.sourceStageEventId,
    source_outcome_id: input.sourceOutcomeId,
    ...week,
    job_id: input.identity.jobId,
    requisition_id: input.identity.requisitionId,
    job_name: input.identity.jobName,
    application_id: input.identity.applicationId,
    candidate_id: input.identity.candidateId,
    candidate_name: input.identity.candidateName,
    recruiter_id: input.identity.recruiter.recruiter_id,
    recruiter_name: input.identity.recruiter.recruiter_name,
    raw_stage_id: input.stage.stageId,
    stage_name: input.stage.rawStage,
    core_stage: input.stage.resolution?.stage ?? null,
    core_stage_order: input.stage.resolution?.order ?? null,
    stage_resolution_source: input.stage.resolution?.source ?? null,
    event_type: input.eventType,
    event_ts: input.eventAt,
    application_status: textOf(input.identity.application.status),
    current_stage_id: input.identity.currentStage.stageId,
    current_stage_name: input.identity.currentStage.rawStage,
    current_core_stage: input.identity.currentStage.resolution?.stage ?? null,
    current_core_stage_order: input.identity.currentStage.resolution?.order ?? null,
    rejected_at: input.terminal?.eventAt ?? null,
    withdrew: textOf(terminalSource?.withdrew),
    rejected_by: textOf(terminalSource?.rejected_by),
    rejection_reason_id: idOf(terminalSource?.rejection_reason_id) ?? null,
    rejection_reason: textOf(terminalSource?.rejection_reason),
    outcome_direction: terminalSource
      ? terminalSource.event_type === "withdrawn"
        ? "candidate_withdrew"
        : "company_rejected"
      : null,
  }
}

function reportingWeek(eventAt: string): Pick<
  CandidateStageEventRow,
  "week_order" | "week" | "week_label" | "reporting_week_friday" | "reporting_week_thursday"
> {
  const friday = fridayWeekStartUtc(new Date(eventAt))
  const labels = fridayWeekLabels(friday)
  const fridayMs = Date.parse(`${friday}T00:00:00.000Z`)
  const epochMs = Date.parse(`${CANDIDATE_STAGE_EVENT_WEEK_ORDER_EPOCH}T00:00:00.000Z`)
  return {
    week_order: Math.floor((fridayMs - epochMs) / MS_PER_WEEK) + 1,
    week: labels.weekShort,
    week_label: labels.weekLabel,
    reporting_week_friday: friday,
    reporting_week_thursday: new Date(fridayMs + 6 * 86_400_000).toISOString().slice(0, 10),
  }
}

export function isTrueOriginStagePass(origin: OccupiedStage, next: OccupiedStage | undefined): boolean {
  if (!next || origin.exitedAtMs === null || origin.exitedAt === null) return false
  if (origin.exitedAtMs < origin.enteredAtMs || next.enteredAtMs < origin.exitedAtMs) return false
  const originOrder = origin.resolution?.order ?? null
  const nextOrder = next.resolution?.order ?? null
  if (originOrder === null || nextOrder === null) return false
  // The source stage that was actually exited gets the pass. We do not credit
  // (destination - 1), and we do not treat same-stage substeps/regressions as passes.
  return nextOrder > originOrder
}

function normalizeOutcomes(
  outcomes: readonly CandidateStageOutcomeSource[],
  applicationById: ReadonlyMap<string, HarvestApplicationRecord>
): NormalizedOutcome[] {
  const normalized: NormalizedOutcome[] = []
  for (const source of outcomes) {
    const applicationId = idOf(source.application_id)
    const eventAt = timestampOf(source.event_at)
    if (!applicationId || !applicationById.has(applicationId) || !eventAt) continue
    normalized.push({
      source,
      sourceId: idOf(source.id) ?? null,
      applicationId,
      eventAt: eventAt.iso,
      eventAtMs: eventAt.ms,
    })
  }
  const deduped = new Map<string, NormalizedOutcome>()
  for (const outcome of normalized) {
    const key = outcome.sourceId
      ? `id:${outcome.sourceId}`
      : `fallback:${outcome.applicationId}|${outcome.source.event_type}|${outcome.eventAt}|${idOf(outcome.source.stage_id) ?? textOf(outcome.source.stage_name) ?? "stage-missing"}`
    const existing = deduped.get(key)
    if (!existing || compareOutcomeEvidence(outcome, existing) > 0) deduped.set(key, outcome)
  }
  return [...deduped.values()].sort(
    (left, right) =>
      left.eventAtMs - right.eventAtMs ||
      left.applicationId.localeCompare(right.applicationId) ||
      (left.sourceId ?? "").localeCompare(right.sourceId ?? "") ||
      left.source.event_type.localeCompare(right.source.event_type)
  )
}

export function dedupeOccupiedStages(stages: readonly OccupiedStage[]): OccupiedStage[] {
  const deduped = new Map<string, OccupiedStage>()
  for (const stage of stages) {
    const key = stage.sourceId
      ? `id:${stage.sourceId}`
      : `fallback:${stage.applicationId}|${stage.stageId ?? "stage-missing"}|${stage.enteredAt}`
    const existing = deduped.get(key)
    if (!existing || compareStageEvidence(stage, existing) > 0) deduped.set(key, stage)
  }
  return [...deduped.values()]
}

function compareStageEvidence(left: OccupiedStage, right: OccupiedStage): number {
  const leftExited = left.exitedAtMs === null ? 0 : 1
  const rightExited = right.exitedAtMs === null ? 0 : 1
  return (
    leftExited - rightExited ||
    (left.exitedAtMs ?? Number.MIN_SAFE_INTEGER) - (right.exitedAtMs ?? Number.MIN_SAFE_INTEGER) ||
    Number(left.rawStage !== null) - Number(right.rawStage !== null) ||
    (left.rawStage ?? "").localeCompare(right.rawStage ?? "")
  )
}

function compareOutcomeEvidence(left: NormalizedOutcome, right: NormalizedOutcome): number {
  const score = (outcome: NormalizedOutcome) =>
    [
      outcome.source.stage_id,
      outcome.source.stage_name,
      outcome.source.rejection_reason_id,
      outcome.source.rejection_reason,
      outcome.source.withdrew,
      outcome.source.rejected_by,
    ].filter((value) => idOf(value) !== null).length
  const scoreDifference = score(left) - score(right)
  if (scoreDifference !== 0) return scoreDifference
  const signature = (outcome: NormalizedOutcome) =>
    [
      idOf(outcome.source.stage_id) ?? "",
      textOf(outcome.source.stage_name) ?? "",
      idOf(outcome.source.rejection_reason_id) ?? "",
      textOf(outcome.source.rejection_reason) ?? "",
      textOf(outcome.source.withdrew) ?? "",
      textOf(outcome.source.rejected_by) ?? "",
    ].join("|")
  return signature(left).localeCompare(signature(right))
}

function latestOutcomeIndex(outcomes: readonly NormalizedOutcome[]): Map<string, NormalizedOutcome> {
  const latest = new Map<string, NormalizedOutcome>()
  for (const outcome of outcomes) {
    const existing = latest.get(outcome.applicationId)
    if (
      !existing ||
      outcome.eventAtMs > existing.eventAtMs ||
      (outcome.eventAtMs === existing.eventAtMs && (outcome.sourceId ?? "") > (existing.sourceId ?? ""))
    ) {
      latest.set(outcome.applicationId, outcome)
    }
  }
  return latest
}

function buildCandidateNameIndex(
  candidates: readonly HarvestCandidateRecord[],
  supplied: ReadonlyMap<string, string> | undefined
): Map<string, string> {
  const names = new Map<string, string>()
  for (const candidate of candidates) {
    const candidateId = idOf(candidate.id)
    const name = personName(candidate)
    if (candidateId && name) names.set(candidateId, name)
  }
  for (const [candidateId, name] of supplied ?? []) {
    const id = idOf(candidateId)
    const normalizedName = textOf(name)
    if (id && normalizedName) names.set(id, normalizedName)
  }
  return names
}

const EMPTY_RECRUITER: CandidateStageRecruiterIdentity = { recruiter_id: null, recruiter_name: null }

function buildRecruiterIndex(input: EmitCandidateStageEventRowsInput): Map<string, CandidateStageRecruiterIdentity> {
  const userNameById = new Map<string, string>()
  for (const user of input.users ?? []) {
    const userId = idOf(user.id)
    const name = personName(user)
    if (userId && name) userNameById.set(userId, name)
  }

  const ownersByJobId = new Map<string, HarvestJobOwnerRecord[]>()
  for (const owner of input.jobOwners ?? []) {
    if (textOf(owner.type)?.toLowerCase() !== "recruiter") continue
    const jobId = idOf(owner.job_id)
    const userId = idOf(owner.user_id)
    if (!jobId || !userId) continue
    const bucket = ownersByJobId.get(jobId) ?? []
    bucket.push(owner)
    ownersByJobId.set(jobId, bucket)
  }

  const recruiters = new Map<string, CandidateStageRecruiterIdentity>()
  for (const [jobId, owners] of ownersByJobId) {
    const responsibleIds = uniqueIds(owners.filter((owner) => owner.responsible === true).map((owner) => owner.user_id))
    const allIds = uniqueIds(owners.map((owner) => owner.user_id))
    // Fail closed on ambiguous ownership; do not pick an arbitrary array member.
    const recruiterId = responsibleIds.length === 1 ? responsibleIds[0] : responsibleIds.length === 0 && allIds.length === 1 ? allIds[0] : null
    recruiters.set(jobId, {
      recruiter_id: recruiterId,
      recruiter_name: recruiterId ? userNameById.get(recruiterId) ?? null : null,
    })
  }

  for (const [jobIdInput, recruiter] of input.recruiterByJobId ?? []) {
    const jobId = idOf(jobIdInput)
    if (!jobId) continue
    recruiters.set(jobId, {
      recruiter_id: idOf(recruiter.recruiter_id) ?? null,
      recruiter_name: textOf(recruiter.recruiter_name),
    })
  }
  return recruiters
}

function indexApplications(applications: readonly HarvestApplicationRecord[]): Map<string, HarvestApplicationRecord> {
  const indexed = new Map<string, HarvestApplicationRecord>()
  for (const application of applications) {
    const applicationId = idOf(application.id)
    if (applicationId && !indexed.has(applicationId)) indexed.set(applicationId, application)
  }
  return indexed
}

function indexById<T extends { id?: string | number }>(rows: readonly T[]): Map<string, T> {
  const indexed = new Map<string, T>()
  for (const row of rows) {
    const id = idOf(row.id)
    if (id && !indexed.has(id)) indexed.set(id, row)
  }
  return indexed
}

function eventStage(
  stageId: string | null,
  rawStage: string | null,
  governedFunnel: ReadonlyMap<string, GovernedFunnelEntry>
): EventStage {
  return {
    stageId,
    rawStage,
    resolution: rawStage ? resolveFunnelStage(rawStage, governedFunnel) : null,
  }
}

function stableEventKey(
  applicationId: string,
  sourceKind: CandidateStageSourceKind,
  sourceIdentity: string,
  eventType: CandidateStageEventType
): string {
  return ["candidate-stage-event", "v1", sourceKind, applicationId, sourceIdentity, eventType]
    .map(encodeURIComponent)
    .join(":")
}

export function compareOccupiedStages(left: OccupiedStage, right: OccupiedStage): number {
  return (
    left.enteredAtMs - right.enteredAtMs ||
    (left.resolution?.order ?? Number.MAX_SAFE_INTEGER) - (right.resolution?.order ?? Number.MAX_SAFE_INTEGER) ||
    (left.exitedAtMs ?? Number.MAX_SAFE_INTEGER) - (right.exitedAtMs ?? Number.MAX_SAFE_INTEGER) ||
    (left.sourceId ?? "").localeCompare(right.sourceId ?? "")
  )
}

const EVENT_ORDER: Record<CandidateStageEventType, number> = {
  entered: 0,
  passed: 1,
  rejected: 2,
  withdrawn: 3,
}

function compareCandidateStageEventRows(left: CandidateStageEventRow, right: CandidateStageEventRow): number {
  return (
    left.event_ts.localeCompare(right.event_ts) ||
    (left.requisition_id ?? "").localeCompare(right.requisition_id ?? "", undefined, { numeric: true }) ||
    left.application_id.localeCompare(right.application_id, undefined, { numeric: true }) ||
    EVENT_ORDER[left.event_type] - EVENT_ORDER[right.event_type] ||
    (left.core_stage_order ?? Number.MAX_SAFE_INTEGER) - (right.core_stage_order ?? Number.MAX_SAFE_INTEGER) ||
    left.event_key.localeCompare(right.event_key)
  )
}

function timestampOf(value: string | null | undefined): { iso: string; ms: number } | null {
  if (!value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return { iso: new Date(ms).toISOString(), ms }
}

function idOf(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function textOf(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text || null
}

function personName(person: { name?: string; first_name?: string; last_name?: string }): string | null {
  return textOf(person.name) ?? textOf([person.first_name, person.last_name].filter(Boolean).join(" "))
}

function uniqueIds(values: readonly (string | number | null | undefined)[]): string[] {
  return [...new Set(values.map(idOf).filter((value): value is string => value !== null))].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true })
  )
}
