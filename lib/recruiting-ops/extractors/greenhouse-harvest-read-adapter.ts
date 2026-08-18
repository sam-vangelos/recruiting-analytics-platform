import type { GreenhousePipelineStageFact } from "../modules/t02-pipeline"
import type { GreenhouseRpsFact } from "../modules/t05-rps"
import type { GreenhouseFinalOfferFact } from "../modules/t07-final-offer"
import type { GreenhouseOwnershipFact } from "../modules/t09-ownership"
import type { SourceGap } from "../runs"
import type {
  ExecPullDiagnostic,
  ExecReadWindows,
  GreenhouseExecReadBoundary,
  GreenhouseExecSourcesResult,
} from "./greenhouse-exec-read-boundary"
import type { GreenhouseReadBoundary, GreenhouseReadContext } from "./greenhouse-read-boundary"

/**
 * Harvest v3 read adapter. v3 serves FLAT records — related collections live on
 * their own endpoints, never inlined (probe-verified 2026-07-02):
 *   - /applications carry no requisition id and no stage history; history is
 *     /application_stages (entered_at is null on most rows at this org).
 *   - /interviews carry no stage name and no scorecards; slot names come from
 *     /job_interviews, scorecards join via /interview_kits (kit -> job_interview).
 *   - /jobs carry no hiring team and no openings; owners are /job_owners rows
 *     (typed recruiter/sourcer/coordinator), names resolve via /users, and
 *     headcount comes from /openings.
 * The boundary composes these pulls per module; id-array filters (job_ids,
 * application_ids, ids) accept at most 50 ids per request and are chunked.
 */

export type GreenhouseHarvestEndpoint =
  | "/offers"
  | "/interviews"
  | "/applications"
  | "/jobs"
  | "/application_stages"
  | "/job_interview_stages"
  | "/job_interviews"
  | "/interview_kits"
  | "/scorecards"
  | "/job_owners"
  | "/openings"
  | "/users"
  | "/candidates"
  | "/departments"
  | "/sources"
  | "/referrers"
  | "/rejection_details"
  | "/rejection_reasons"

export type GreenhouseHarvestListParams = Record<string, string | number | boolean | undefined>

export interface GreenhouseHarvestReadClient {
  list<T>(endpoint: GreenhouseHarvestEndpoint, params?: GreenhouseHarvestListParams): Promise<readonly T[]>
}

export interface GreenhouseReadAdapterPlan {
  workflowId: "T07" | "T05" | "T02" | "T09"
  endpoint: GreenhouseHarvestEndpoint
  joinEndpoints: readonly GreenhouseHarvestEndpoint[]
  factTarget: "final_offer" | "rps_scorecard" | "pipeline_stage" | "ownership"
  requiredFields: readonly string[]
  notes: string
}

export interface GreenhouseHarvestReadAdapterOptions {
  readonly params?: Partial<Record<GreenhouseReadAdapterPlan["workflowId"], GreenhouseHarvestListParams>>
}

export interface GreenhouseHarvestMappingResult<TFact> {
  facts: TFact[]
  sourceGaps: SourceGap[]
}

export interface HarvestPersonRef {
  id?: string | number
  name?: string
  first_name?: string
  last_name?: string
}

export interface HarvestCustomField {
  name?: string
  value?: unknown
}

export interface HarvestJobRef {
  id?: string | number
  requisition_id?: string | number
  name?: string
}

export interface HarvestApplicationRef {
  id?: string | number
  job_id?: string | number
  job?: HarvestJobRef
  recruiter?: HarvestPersonRef
  sourcer?: HarvestPersonRef
}

export interface HarvestOfferRecord {
  id?: string | number
  application_id?: string | number
  application?: HarvestApplicationRef
  job_id?: string | number
  job?: HarvestJobRef
  candidate_id?: string | number
  recruiter_id?: string | number | null
  starts_on?: string | null
  status?: string
  offer_status?: string
  state?: string
  created_at?: string
  sent_at?: string
  resolved_at?: string
  recruiter?: HarvestPersonRef
  sourcer?: HarvestPersonRef
  team?: { name?: string }
  department?: { name?: string }
  hod?: HarvestPersonRef
  custom_fields?: readonly HarvestCustomField[] | Readonly<Record<string, unknown>>
}

export interface HarvestScorecardRef {
  id?: string | number
  status?: string
  created_at?: string | null
  updated_at?: string | null
  submitted_at?: string
  interviewer?: HarvestPersonRef
}

export interface HarvestScheduledInterviewRecord {
  id?: string | number
  application_id?: string | number
  application?: HarvestApplicationRef
  job_id?: string | number
  job?: HarvestJobRef
  job_interview_id?: string | number
  stage_name?: string
  interview_stage?: string
  interview_name?: string
  scheduled_at?: string | null
  starts_at?: string | null
  /** v3 scheduled-interview end clock; retained for scorecard-submission delivery facts. */
  ends_at?: string | null
  /** Backward-compatible alias used by some fixtures/projections. */
  scheduled_end_at?: string | null
  status?: string
  scorecard_status?: string
  scorecards?: readonly HarvestScorecardRef[]
  interviewers?: readonly HarvestPersonRef[]
}

export interface HarvestStageMovement {
  stage_name?: string
  name?: string
  changed_at?: string
  entered_at?: string
}

export interface HarvestApplicationRecord {
  id?: string | number
  job_id?: string | number
  job?: HarvestJobRef
  candidate_id?: string | number
  recruiter_id?: string | number | null
  /** Flat v3 referrer row id; resolve through `/referrers`, not `/users`. */
  referrer_id?: string | number | null
  req_id?: string | number
  requisition_id?: string | number
  status?: string
  prospect?: boolean
  stage_id?: string | number
  stage_name?: string
  current_stage?: { name?: string }
  current_stage_at?: string
  stage_changed_at?: string
  last_activity_at?: string
  updated_at?: string
  stage_history?: readonly HarvestStageMovement[]
}

/** v3 /application_stages row — one row per stage an application has occupied. */
export interface HarvestApplicationStageRecord {
  id?: string | number
  application_id?: string | number
  job_interview_stage_id?: string | number
  entered_at?: string | null
  exited_at?: string | null
  current?: boolean
}

/** v3 /job_interview_stages row — stage definitions on a job's interview plan. */
export interface HarvestJobInterviewStageRecord {
  id?: string | number
  name?: string
  job_id?: string | number
  active?: boolean
}

/** v3 /job_interviews row — interview slots on a job's interview plan. */
export interface HarvestJobInterviewRecord {
  id?: string | number
  name?: string
  job_interview_stage_id?: string | number
  job_id?: string | number
  active?: boolean
}

/** v3 /interview_kits row — the kit joining scorecards back to a job_interview slot. */
export interface HarvestInterviewKitRecord {
  id?: string | number
  job_id?: string | number
  job_interview_id?: string | number
}

/** v3 /scorecards row — per-interviewer evaluations, joined to interviews via kit. */
export interface HarvestScorecardRecord {
  id?: string | number
  application_id?: string | number
  interview_kit_id?: string | number
  /** Optional direct slot id for projections that already resolved the kit join. */
  job_interview_id?: string | number
  interviewer_id?: string | number
  submitter_id?: string | number
  interviewer?: HarvestPersonRef
  submitted_by?: HarvestPersonRef
  status?: string
  /** Native Harvest v3 scorecard creation clock. Kept distinct from submission. */
  created_at?: string | null
  /** Native Harvest v3 scorecard update clock. Kept for source-contract diagnostics. */
  updated_at?: string | null
  submitted_at?: string | null
  interviewed_at?: string | null
  candidate_rating?: string | null
  overall_recommendation?: string | null
  overall_rating?: string | null
  qa_summary?: string | null
  key_takeaways?: string | null
  questions?: readonly { question?: string | null; answer?: string | null }[]
}

/** v3 /job_owners row — one user in one role (recruiter/sourcer/coordinator) on one job. */
export interface HarvestJobOwnerRecord {
  id?: string | number
  user_id?: string | number
  job_id?: string | number
  type?: string
  responsible?: boolean
}

export interface HarvestOpeningRecord {
  id?: string | number
  status?: string
  job_id?: string | number
  open?: boolean
  opened_at?: string | null
  closed_at?: string | null
}

/** v3 /users row — name resolution for owner/interviewer ids. */
export interface HarvestUserRecord {
  id?: string | number
  name?: string
  first_name?: string
  last_name?: string
  deactivated?: boolean
}

/** v3 /departments row — department-name resolution for jobs. */
export interface HarvestDepartmentRecord {
  id?: string | number
  name?: string
}

/** v3 /candidates row — name resolution, pulled ONLY for finalists and hires. */
export interface HarvestCandidateRecord {
  id?: string | number
  first_name?: string
  last_name?: string
}

export interface HarvestJobRecord {
  id?: string | number
  requisition_id?: string | number
  name?: string
  status?: string
  is_template?: boolean
  confidential?: boolean
  department_id?: string | number | null
  updated_at?: string
  created_at?: string
  opened_at?: string | null
  closed_at?: string | null
  openings_count?: number
  openings?: readonly HarvestOpeningRecord[]
  hiring_team?: {
    recruiters?: readonly HarvestPersonRef[]
    sourcers?: readonly HarvestPersonRef[]
  }
  recruiter?: HarvestPersonRef
  sourcer?: HarvestPersonRef
  departments?: readonly { name?: string }[]
  custom_fields?: readonly HarvestCustomField[] | Readonly<Record<string, unknown>>
}

/** Composite sources for T02 pipeline facts — v3 splits these across four endpoints. */
export interface HarvestPipelineSources {
  applications: readonly HarvestApplicationRecord[]
  applicationStages?: readonly HarvestApplicationStageRecord[]
  jobInterviewStages?: readonly HarvestJobInterviewStageRecord[]
  jobs?: readonly HarvestJobRecord[]
}

/** Composite sources for T05 RPS facts. */
export interface HarvestRpsSources {
  interviews: readonly HarvestScheduledInterviewRecord[]
  jobInterviews?: readonly HarvestJobInterviewRecord[]
  interviewKits?: readonly HarvestInterviewKitRecord[]
  scorecards?: readonly HarvestScorecardRecord[]
}

/** Composite sources for T09 ownership facts. */
export interface HarvestOwnershipSources {
  jobs: readonly HarvestJobRecord[]
  jobOwners?: readonly HarvestJobOwnerRecord[]
  openings?: readonly HarvestOpeningRecord[]
  users?: readonly HarvestUserRecord[]
}

export const GREENHOUSE_READ_ADAPTER_PLANS = [
  {
    workflowId: "T07",
    endpoint: "/offers",
    joinEndpoints: [],
    factTarget: "final_offer",
    requiredFields: ["id", "application_id", "job_id", "status", "created_at"],
    notes: "Offer lifecycle facts for monthly final-offer reporting.",
  },
  {
    workflowId: "T05",
    endpoint: "/interviews",
    joinEndpoints: ["/job_interviews", "/interview_kits", "/scorecards"],
    factTarget: "rps_scorecard",
    requiredFields: ["id", "application_id", "job_id", "stage_name", "scheduled_at", "scorecard_status"],
    notes: "Interview and scorecard accountability facts for RPS tracking.",
  },
  {
    workflowId: "T02",
    endpoint: "/applications",
    joinEndpoints: ["/application_stages", "/job_interview_stages", "/jobs"],
    factTarget: "pipeline_stage",
    requiredFields: ["id", "job_id", "req_id", "stage_name", "stage_changed_at"],
    notes: "Application stage facts for role-specific pipeline and T03 progress.",
  },
  {
    workflowId: "T09",
    endpoint: "/jobs",
    joinEndpoints: ["/job_owners", "/openings", "/users"],
    factTarget: "ownership",
    requiredFields: ["id", "openings", "hiring_team"],
    notes: "Job ownership and workload facts for role assignment by pod.",
  },
] as const satisfies readonly GreenhouseReadAdapterPlan[]

/** v3 id-array query params accept at most 50 ids per request. */
const ID_FILTER_LIMIT = 50

// The boundary maps through the WithDiagnostics variants ONLY. There are no
// plain facts-only mappers: a mapper that can drop a source record without
// emitting a gap is the fail-open seam that turned 5000 live applications
// into 0 facts + 0 gaps at first light.
export function createGreenhouseHarvestReadBoundary(
  client: GreenhouseHarvestReadClient,
  options: GreenhouseHarvestReadAdapterOptions = {}
): GreenhouseReadBoundary {
  return {
    sourceAdapter: "greenhouse_v3_read",
    async fetchFinalOfferFacts(context) {
      const records = await listWithChunkedJobIds<HarvestOfferRecord>(
        client,
        "/offers",
        paramsFor("T07", context, options)
      )
      return mapHarvestOffersToFinalOfferFactsWithDiagnostics(records)
    },
    async fetchRpsFacts(context) {
      const interviews = await listWithChunkedJobIds<HarvestScheduledInterviewRecord>(
        client,
        "/interviews",
        paramsFor("T05", context, options)
      )
      const jobIds = distinctIds(interviews.map((record) => record.job_id ?? record.job?.id))
      const applicationIds = distinctIds(interviews.map((record) => record.application_id ?? record.application?.id))
      const [jobInterviews, interviewKits, scorecards] = await Promise.all([
        listChunkedByIds<HarvestJobInterviewRecord>(client, "/job_interviews", "job_ids", jobIds),
        listChunkedByIds<HarvestInterviewKitRecord>(client, "/interview_kits", "job_ids", jobIds),
        listChunkedByIds<HarvestScorecardRecord>(client, "/scorecards", "application_ids", applicationIds),
      ])
      return mapHarvestScheduledInterviewsToRpsFactsWithDiagnostics({
        interviews,
        jobInterviews,
        interviewKits,
        scorecards,
      })
    },
    async fetchPipelineStageFacts(context) {
      const applications = await listWithChunkedJobIds<HarvestApplicationRecord>(
        client,
        "/applications",
        paramsFor("T02", context, options)
      )
      const applicationIds = distinctIds(applications.map((record) => record.id))
      const jobIds = distinctIds(applications.map((record) => record.job_id ?? record.job?.id))
      const [applicationStages, jobInterviewStages, jobs] = await Promise.all([
        listChunkedByIds<HarvestApplicationStageRecord>(client, "/application_stages", "application_ids", applicationIds),
        listChunkedByIds<HarvestJobInterviewStageRecord>(client, "/job_interview_stages", "job_ids", jobIds),
        listChunkedByIds<HarvestJobRecord>(client, "/jobs", "ids", jobIds),
      ])
      return mapHarvestApplicationsToPipelineStageFactsWithDiagnostics({
        applications,
        applicationStages,
        jobInterviewStages,
        jobs,
      })
    },
    async fetchOwnershipFacts(context) {
      const jobs = await client.list<HarvestJobRecord>("/jobs", paramsFor("T09", context, options))
      const [jobOwners, openings] = await Promise.all([
        client.list<HarvestJobOwnerRecord>("/job_owners", { per_page: 500 }),
        client.list<HarvestOpeningRecord>("/openings", { per_page: 500, open: true }),
      ])
      const ownerUserIds = distinctIds(jobOwners.map((record) => record.user_id))
      const users = await listChunkedByIds<HarvestUserRecord>(client, "/users", "ids", ownerUserIds)
      return mapHarvestJobsToOwnershipFactsWithDiagnostics({ jobs, jobOwners, openings, users })
    },
  }
}

export function mapHarvestOffersToFinalOfferFactsWithDiagnostics(
  records: readonly HarvestOfferRecord[]
): GreenhouseHarvestMappingResult<GreenhouseFinalOfferFact> {
  const facts: GreenhouseFinalOfferFact[] = []
  const sourceGaps: SourceGap[] = []
  records.forEach((record, index) => {
    const applicationId = requiredIdValue(record.application_id ?? record.application?.id)
    const jobId = requiredIdValue(record.job_id ?? record.job?.id ?? record.application?.job_id ?? record.application?.job?.id)
    const offerId = requiredIdValue(record.id)
    const createdAt = requiredTimestampValue(record.created_at ?? record.sent_at ?? record.resolved_at)
    const status = stringValue(record.status ?? record.offer_status ?? record.state)

    pushRequiredGap(sourceGaps, "T07", "application_id", applicationId, index, "Application ID is required before final-offer rows can be grouped or deduped.")
    pushRequiredGap(sourceGaps, "T07", "job_id", jobId, index, "Job ID is required before final-offer rows can be grouped or deduped.")
    pushRequiredGap(sourceGaps, "T07", "id", offerId, index, "Offer ID is required before final-offer rows can be grouped or deduped.")
    pushRequiredGap(sourceGaps, "T07", "created_at", createdAt, index, "Offer creation timestamp is required before final-offer freshness can be evaluated.")
    pushRequiredGap(sourceGaps, "T07", "status", status === "unknown" ? undefined : status, index, "Offer status is required before final-offer rows can be trusted.")

    if (!applicationId || !jobId || !offerId || !createdAt) return
    facts.push({
      applicationId,
      jobId,
      offerId,
      status,
      createdAt,
      recruiterName: personName(record.recruiter ?? record.application?.recruiter),
      sourcerName: personName(record.sourcer ?? record.application?.sourcer),
      teamName: namedValue(record.team) ?? namedValue(record.department) ?? customFieldValue(record.custom_fields, "team"),
      hodName: personName(record.hod) ?? customFieldValue(record.custom_fields, "hod"),
    })
  })
  return { facts, sourceGaps }
}

export function mapHarvestScheduledInterviewsToRpsFactsWithDiagnostics(
  sources: HarvestRpsSources
): GreenhouseHarvestMappingResult<GreenhouseRpsFact> {
  const facts: GreenhouseRpsFact[] = []
  const sourceGaps: SourceGap[] = []
  const slotNameById = buildIdMap(sources.jobInterviews, (slot) => slot.name?.trim() || undefined)
  const slotIdByKitId = buildIdMap(sources.interviewKits, (kit) => requiredIdValue(kit.job_interview_id))
  const scorecardsByAppAndSlot = groupBy(sources.scorecards ?? [], (scorecard) => {
    const applicationId = requiredIdValue(scorecard.application_id)
    const kitId = requiredIdValue(scorecard.interview_kit_id)
    const slotId = kitId ? slotIdByKitId.get(kitId) : undefined
    return applicationId && slotId ? `${applicationId}|${slotId}` : undefined
  })

  sources.interviews.forEach((record, index) => {
    const firstScorecard = record.scorecards?.[0]
    const applicationId = requiredIdValue(record.application_id ?? record.application?.id)
    const jobId = requiredIdValue(record.job_id ?? record.job?.id ?? record.application?.job_id ?? record.application?.job?.id)
    const interviewId = requiredIdValue(record.id)
    const slotId = requiredIdValue(record.job_interview_id)
    const matchedScorecards =
      applicationId && slotId ? (scorecardsByAppAndSlot.get(`${applicationId}|${slotId}`) ?? []) : []

    const slotName = slotId ? slotNameById.get(slotId) : undefined
    const stageName = stringValue(record.stage_name ?? record.interview_stage ?? record.interview_name ?? slotName)
    const scheduledAt = requiredTimestampValue(
      record.scheduled_at ?? record.starts_at ?? earliestInterviewedAt(matchedScorecards)
    )
    const scorecardStatusValue = stringValue(
      record.scorecard_status ??
        scorecardStatusFromMatches(matchedScorecards) ??
        (sources.scorecards ? "missing" : scorecardStatus(firstScorecard))
    )

    pushRequiredGap(sourceGaps, "T05", "application_id", applicationId, index, "Application ID is required before RPS rows can be grouped or deduped.")
    pushRequiredGap(sourceGaps, "T05", "job_id", jobId, index, "Job ID is required before RPS rows can be grouped or deduped.")
    pushRequiredGap(sourceGaps, "T05", "id", interviewId, index, "Interview ID is required before RPS rows can be grouped or deduped.")
    pushRequiredGap(sourceGaps, "T05", "scheduled_at", scheduledAt, index, "No interview timestamp: v3 starts_at/scheduled_at are null and no matched scorecard carries interviewed_at.")
    pushRequiredGap(sourceGaps, "T05", "stage_name", stageName === "unknown" ? undefined : stageName, index, "No interview name: the v3 record has no stage fields and its job_interview_id resolved to no named slot in the /job_interviews join.")
    pushRequiredGap(sourceGaps, "T05", "scorecard_status", scorecardStatusValue === "unknown" ? undefined : scorecardStatusValue, index, "Scorecard status is required before RPS rows can be trusted.")

    if (!applicationId || !jobId || !interviewId || !scheduledAt) return
    facts.push({
      applicationId,
      jobId,
      interviewId,
      stageName,
      scheduledAt,
      scorecardStatus: scorecardStatusValue,
      interviewerName: personName(firstScorecard?.interviewer ?? record.interviewers?.[0]),
    })
  })
  return { facts, sourceGaps }
}

export function mapHarvestApplicationsToPipelineStageFactsWithDiagnostics(
  sources: HarvestPipelineSources
): GreenhouseHarvestMappingResult<GreenhousePipelineStageFact> {
  const facts: GreenhousePipelineStageFact[] = []
  const sourceGaps: SourceGap[] = []
  const requisitionIdByJobId = buildIdMap(sources.jobs, (job) => requiredIdValue(job.requisition_id))
  const stageNameById = buildIdMap(sources.jobInterviewStages, (stage) => stage.name?.trim() || undefined)
  const stageRowsByApplicationId = groupBy(sources.applicationStages ?? [], (row) =>
    requiredIdValue(row.application_id)
  )

  sources.applications.forEach((record, index) => {
    const applicationId = requiredIdValue(record.id)
    const jobId = requiredIdValue(record.job_id ?? record.job?.id)
    const reqId =
      requiredIdValue(record.req_id ?? record.requisition_id ?? record.job?.requisition_id) ??
      (jobId ? requisitionIdByJobId.get(jobId) : undefined)
    pushRequiredGap(sourceGaps, "T02", "id", applicationId, index, "Application ID is required before pipeline rows can be grouped or deduped.")
    pushRequiredGap(sourceGaps, "T02", "job_id", jobId, index, "Job ID is required before pipeline rows can be grouped or deduped.")
    pushRequiredGap(sourceGaps, "T02", "req_id", reqId, index, "No requisition id: v3 applications do not carry one and the application's job resolved to no requisition_id in the /jobs join.")

    // v3 creates an application_stages row for EVERY stage on the job's plan up
    // front; a row with no entered_at, no exited_at, and current=false is a stage
    // the candidate never reached — plan scaffolding, not a movement and not a
    // gap (probe-verified 2026-07-02: 360/415 sampled rows are scaffolding, and
    // every occupied row carried entered_at).
    const historyRows = (applicationId ? stageRowsByApplicationId.get(applicationId) : undefined)?.filter(
      (row) => Boolean(row.entered_at) || Boolean(row.exited_at) || row.current === true
    )
    const movements: { stageName: string; stageChangedAt: string | undefined; timestampGapReason: string }[] =
      historyRows?.length
        ? historyRows.map((row) => {
            const stageId = requiredIdValue(row.job_interview_stage_id)
            return {
              stageName: stringValue(stageId ? stageNameById.get(stageId) : undefined),
              stageChangedAt: requiredTimestampValue(row.entered_at),
              timestampGapReason:
                "v3 application_stages.entered_at is null on an occupied stage row — Greenhouse did not stamp when this stage was entered.",
            }
          })
        : record.stage_history?.length
          ? record.stage_history.map((movement) => ({
              stageName: stringValue(movement.stage_name ?? movement.name),
              stageChangedAt: requiredTimestampValue(movement.changed_at ?? movement.entered_at),
              timestampGapReason: "Stage movement timestamp is required before pipeline freshness can be evaluated.",
            }))
          : [
              {
                stageName: stringValue(record.stage_name ?? record.current_stage?.name),
                stageChangedAt: requiredTimestampValue(record.stage_changed_at ?? record.current_stage_at),
                timestampGapReason:
                  "No stage-entry timestamp: the v3 application record has no stage-change time and its /application_stages history is empty. last_activity_at is not a stage-change time and is never substituted.",
              },
            ]

    movements.forEach((movement, movementIndex) => {
      pushRequiredGap(sourceGaps, "T02", "stage_name", movement.stageName === "unknown" ? undefined : movement.stageName, index, "No stage name: the stage row's job_interview_stage_id resolved to no named stage in the /job_interview_stages join.", movementIndex)
      pushRequiredGap(sourceGaps, "T02", "stage_changed_at", movement.stageChangedAt, index, movement.timestampGapReason, movementIndex)
      if (!applicationId || !jobId || !reqId || !movement.stageChangedAt) return
      facts.push({
        applicationId,
        jobId,
        reqId,
        stageName: movement.stageName,
        stageChangedAt: movement.stageChangedAt,
      })
    })
  })
  return { facts, sourceGaps }
}

export function mapHarvestJobsToOwnershipFactsWithDiagnostics(
  sources: HarvestOwnershipSources
): GreenhouseHarvestMappingResult<GreenhouseOwnershipFact> {
  const facts: GreenhouseOwnershipFact[] = []
  const sourceGaps: SourceGap[] = []
  const ownersByJobId = groupBy(sources.jobOwners ?? [], (owner) => requiredIdValue(owner.job_id))
  const userNameById = buildIdMap(sources.users, (user) => userName(user))
  const openOpeningCountByJobId = countOpenOpeningsByJobId(sources.openings)

  sources.jobs.forEach((record, index) => {
    const jobId = requiredIdValue(record.id)
    pushRequiredGap(sourceGaps, "T09", "id", jobId, index, "Job ID is required before ownership rows can be grouped or deduped.")

    const owners = jobId ? (ownersByJobId.get(jobId) ?? []) : []
    const ownerName = (type: string): string | undefined => {
      const typed = owners.filter((owner) => owner.type === type)
      const pick = typed.find((owner) => owner.responsible === true) ?? typed[0]
      const userId = pick ? requiredIdValue(pick.user_id) : undefined
      return userId ? userNameById.get(userId) : undefined
    }
    const recruiterName = personName(record.recruiter ?? record.hiring_team?.recruiters?.[0]) ?? ownerName("recruiter")
    const sourcerName = personName(record.sourcer ?? record.hiring_team?.sourcers?.[0]) ?? ownerName("sourcer")

    const embeddedOpeningsCount =
      typeof record.openings_count === "number"
        ? record.openings_count
        : record.openings
          ? record.openings.filter((opening) => opening.status !== "closed" && opening.open !== false).length
          : undefined
    const joinedOpeningsCount = sources.openings && jobId ? (openOpeningCountByJobId.get(jobId) ?? 0) : undefined
    const openingsCount = embeddedOpeningsCount ?? joinedOpeningsCount

    if (openingsCount === undefined) {
      pushRequiredGap(sourceGaps, "T09", "openings", undefined, index, "No headcount source: v3 jobs carry no openings and no /openings join was supplied.")
    }
    if (!record.hiring_team && !record.recruiter && !record.sourcer && owners.length === 0) {
      pushRequiredGap(sourceGaps, "T09", "hiring_team", undefined, index, "No ownership source: the job has no /job_owners rows (recruiter/sourcer/coordinator unassigned in Greenhouse).")
    } else if (!recruiterName && !sourcerName && owners.length > 0) {
      const hasTypedOwner = owners.some((owner) => owner.type === "recruiter" || owner.type === "sourcer")
      pushRequiredGap(
        sourceGaps,
        "T09",
        "hiring_team",
        undefined,
        index,
        hasTypedOwner
          ? "Typed recruiter/sourcer owners exist but their user_ids did not resolve to names in the /users join."
          : "Owners exist but none are typed recruiter or sourcer (coordinator-only hiring team in Greenhouse)."
      )
    }
    if (!jobId) return
    const observedAt = optionalTimestampValue(record.updated_at ?? record.created_at)
    facts.push({
      jobId,
      recruiterName,
      sourcerName,
      podName: customFieldValue(record.custom_fields, "pod") ?? namedValue(record.departments?.[0]),
      openingsCount: openingsCount ?? 0,
      ...(observedAt ? { observedAt } : {}),
    })
  })
  return { facts, sourceGaps }
}

function paramsFor(
  workflowId: GreenhouseReadAdapterPlan["workflowId"],
  _context: GreenhouseReadContext,
  options: GreenhouseHarvestReadAdapterOptions
): GreenhouseHarvestListParams {
  return {
    per_page: 500,
    ...options.params?.[workflowId],
  }
}

/**
 * Top-level list pull that honors the 50-id limit on job_ids filters: a comma
 * list over the limit is split into chunked pulls (results concatenated).
 */
async function listWithChunkedJobIds<T>(
  client: GreenhouseHarvestReadClient,
  endpoint: GreenhouseHarvestEndpoint,
  params: GreenhouseHarvestListParams
): Promise<readonly T[]> {
  const jobIdsParam = params.job_ids
  if (typeof jobIdsParam !== "string") return client.list<T>(endpoint, params)
  const ids = jobIdsParam.split(",").map((value) => value.trim()).filter(Boolean)
  if (ids.length <= ID_FILTER_LIMIT) return client.list<T>(endpoint, params)
  const records: T[] = []
  for (const chunk of chunkIds(ids)) {
    records.push(...(await client.list<T>(endpoint, { ...params, job_ids: chunk.join(",") })))
  }
  return records
}

/**
 * Join pull chunked by an id-array filter. An EMPTY id list returns [] without
 * calling the endpoint — an id filter that silently drops when empty would turn
 * a scoped join into an org-wide pull.
 */
async function listChunkedByIds<T>(
  client: GreenhouseHarvestReadClient,
  endpoint: GreenhouseHarvestEndpoint,
  idParamName: string,
  ids: readonly string[]
): Promise<readonly T[]> {
  if (ids.length === 0) return []
  const records: T[] = []
  for (const chunk of chunkIds(ids)) {
    records.push(...(await client.list<T>(endpoint, { per_page: 500, [idParamName]: chunk.join(",") })))
  }
  return records
}

function chunkIds(ids: readonly string[]): string[][] {
  const chunks: string[][] = []
  for (let start = 0; start < ids.length; start += ID_FILTER_LIMIT) {
    chunks.push([...ids.slice(start, start + ID_FILTER_LIMIT)])
  }
  return chunks
}

function distinctIds(values: readonly (string | number | undefined)[]): string[] {
  const ids = new Set<string>()
  for (const value of values) {
    const id = requiredIdValue(value)
    if (id) ids.add(id)
  }
  return [...ids]
}

function buildIdMap<TRecord extends { id?: string | number }, TValue>(
  records: readonly TRecord[] | undefined,
  valueOf: (record: TRecord) => TValue | undefined
): ReadonlyMap<string, TValue> {
  const map = new Map<string, TValue>()
  for (const record of records ?? []) {
    const id = requiredIdValue(record.id)
    if (!id) continue
    const value = valueOf(record)
    if (value !== undefined && !map.has(id)) map.set(id, value)
  }
  return map
}

function groupBy<TRecord>(
  records: readonly TRecord[],
  keyOf: (record: TRecord) => string | undefined
): ReadonlyMap<string, TRecord[]> {
  const map = new Map<string, TRecord[]>()
  for (const record of records) {
    const key = keyOf(record)
    if (!key) continue
    const group = map.get(key)
    if (group) group.push(record)
    else map.set(key, [record])
  }
  return map
}

function countOpenOpeningsByJobId(
  openings: readonly HarvestOpeningRecord[] | undefined
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const opening of openings ?? []) {
    if (opening.open === false || opening.status === "closed") continue
    const jobId = requiredIdValue(opening.job_id)
    if (!jobId) continue
    counts.set(jobId, (counts.get(jobId) ?? 0) + 1)
  }
  return counts
}

function earliestInterviewedAt(scorecards: readonly HarvestScorecardRecord[]): string | undefined {
  const timestamps = scorecards
    .map((scorecard) => requiredTimestampValue(scorecard.interviewed_at))
    .filter((value): value is string => Boolean(value))
    .sort()
  return timestamps[0]
}

/** v3 scorecard statuses are draft|complete; map to the module's accountability vocab. */
function scorecardStatusFromMatches(scorecards: readonly HarvestScorecardRecord[]): string | undefined {
  if (scorecards.length === 0) return undefined
  if (scorecards.some((scorecard) => scorecard.status === "complete" || scorecard.submitted_at)) return "submitted"
  if (scorecards.some((scorecard) => scorecard.status === "draft")) return "pending"
  return "missing"
}

function userName(user: HarvestUserRecord): string | undefined {
  if (user.name?.trim()) return user.name.trim()
  const joined = [user.first_name, user.last_name].filter(Boolean).join(" ").trim()
  return joined || undefined
}

function requiredIdValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text ? text : undefined
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown"
}

function timestampValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "unknown"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString()
}

function requiredTimestampValue(value: unknown): string | undefined {
  const timestamp = timestampValue(value)
  return timestamp === "unknown" ? undefined : timestamp
}

function optionalTimestampValue(value: unknown): string | undefined {
  const timestamp = timestampValue(value)
  return timestamp === "unknown" ? undefined : timestamp
}

function personName(person: HarvestPersonRef | undefined): string | undefined {
  if (!person) return undefined
  if (person.name?.trim()) return person.name.trim()
  const joined = [person.first_name, person.last_name].filter(Boolean).join(" ").trim()
  return joined || undefined
}

function namedValue(value: { name?: string } | undefined): string | undefined {
  return value?.name?.trim() || undefined
}

export function customFieldValue(
  fields: readonly HarvestCustomField[] | Readonly<Record<string, unknown>> | undefined,
  name: string
): string | undefined {
  if (!fields) return undefined
  // Harvest v3 serves custom_fields as a MAP keyed by field key, each value
  // {name, type, value}; multi_select values are ARRAYS (probe-verified: a
  // "Priority" multi_select carries ["P0"]). The v3 map matches on the human
  // field NAME, not the machine key ("hiring_location_s__job_17598..."). The
  // array-of-{name,value} shape is tolerated for fixtures and older payloads.
  if (Array.isArray(fields)) {
    const field = (fields as readonly HarvestCustomField[]).find(
      (item) => item.name?.trim().toLowerCase() === name
    )
    return scalarOrJoined(field?.value)
  }
  const entries = Object.entries(fields as Readonly<Record<string, unknown>>)
  const entry =
    entries.find(([key]) => key.trim().toLowerCase() === name) ??
    entries.find(([, value]) => {
      const fieldName = (value as { name?: unknown } | null)?.name
      return typeof fieldName === "string" && fieldName.trim().toLowerCase() === name
    })
  const value = entry?.[1]
  if (typeof value === "string" && value.trim()) return value.trim()
  if (value && typeof value === "object" && "value" in value) {
    return scalarOrJoined((value as { value?: unknown }).value)
  }
  return undefined
}

function scalarOrJoined(inner: unknown): string | undefined {
  if (typeof inner === "string" && inner.trim()) return inner.trim()
  if (Array.isArray(inner)) {
    const parts = inner.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    if (parts.length) return parts.map((part) => part.trim()).join(", ")
  }
  return undefined
}

function scorecardStatus(scorecard: HarvestScorecardRef | undefined): string | undefined {
  if (!scorecard) return "missing"
  if (scorecard.status?.trim()) return scorecard.status.trim()
  return scorecard.submitted_at ? "submitted" : "missing"
}

function pushRequiredGap(
  gaps: SourceGap[],
  workflowId: GreenhouseReadAdapterPlan["workflowId"],
  field: string,
  value: string | undefined,
  recordIndex: number,
  reason: string,
  movementIndex?: number
): void {
  if (value) return
  const entity = movementIndex === undefined ? `record_${recordIndex}` : `record_${recordIndex}_movement_${movementIndex}`
  gaps.push({
    id: `gap_harvest_${workflowId.toLowerCase()}_required_${field}_${entity}`.replace(/[^A-Za-z0-9_./-]/g, "_"),
    workflowId,
    sourceId: "greenhouse",
    field,
    reason,
    blocksCutover: true,
  })
}

// ===================================================================== exec

export interface GreenhouseHarvestExecReadOptions {
  /**
   * The maxRecordsPerEndpoint the caller configured on the live client. Used
   * ONLY as the truncation sentinel: the client silently slices at its cap, so
   * any single list call returning >= cap records means pages were likely
   * dropped. The module turns a flagged pull into a blocking source gap.
   */
  readonly recordCap?: number
}

/**
 * Org-wide exec state-of-play boundary. Returns typed RAW source collections —
 * no mapping happens here, so nothing can be silently dropped at this layer;
 * every narrowing is a documented v3 query param (status=open, prospect=false,
 * status=Accepted + resolved_at window, updated_at window, awaiting_feedback).
 */
export function createGreenhouseHarvestExecReadBoundary(
  client: GreenhouseHarvestReadClient,
  options: GreenhouseHarvestExecReadOptions = {}
): GreenhouseExecReadBoundary {
  const cap = options.recordCap
  const suspect = (count: number) => cap !== undefined && count >= cap

  async function tracked<T>(
    diagnostics: ExecPullDiagnostic[],
    source: string,
    pull: () => Promise<readonly T[]>
  ): Promise<readonly T[]> {
    const records = await pull()
    diagnostics.push({ source, records: records.length, truncationSuspected: suspect(records.length) })
    return records
  }

  async function trackedChunked<T>(
    diagnostics: ExecPullDiagnostic[],
    source: string,
    endpoint: GreenhouseHarvestEndpoint,
    idParamName: string,
    ids: readonly string[],
    extraParams: GreenhouseHarvestListParams = {}
  ): Promise<readonly T[]> {
    if (ids.length === 0) {
      diagnostics.push({ source, records: 0, truncationSuspected: false })
      return []
    }
    const records: T[] = []
    let truncationSuspected = false
    for (const chunk of chunkIds(ids)) {
      const page = await client.list<T>(endpoint, { per_page: 500, ...extraParams, [idParamName]: chunk.join(",") })
      if (suspect(page.length)) truncationSuspected = true
      records.push(...page)
    }
    diagnostics.push({ source, records: records.length, truncationSuspected })
    return records
  }

  return {
    sourceAdapter: "greenhouse_v3_read",
    async fetchExecStateSources(_context, windows: ExecReadWindows): Promise<GreenhouseExecSourcesResult> {
      const diagnostics: ExecPullDiagnostic[] = []

      const jobs = await tracked<HarvestJobRecord>(diagnostics, "/jobs?status=open", () =>
        client.list<HarvestJobRecord>("/jobs", { per_page: 500, status: "open" })
      )
      const openJobIds = distinctIds(jobs.map((job) => job.id))

      const [
        openings,
        jobOwners,
        departments,
        applications,
        jobInterviewStages,
        jobInterviews,
        interviewKits,
        awaitingFeedbackInterviews,
        offers,
        applicationStages,
      ] = await Promise.all([
        tracked<HarvestOpeningRecord>(diagnostics, "/openings?open=true", () =>
          client.list<HarvestOpeningRecord>("/openings", { per_page: 500, open: true })
        ),
        tracked<HarvestJobOwnerRecord>(diagnostics, "/job_owners", () =>
          client.list<HarvestJobOwnerRecord>("/job_owners", { per_page: 500 })
        ),
        tracked<HarvestDepartmentRecord>(diagnostics, "/departments", () =>
          client.list<HarvestDepartmentRecord>("/departments", { per_page: 500 })
        ),
        trackedChunked<HarvestApplicationRecord>(
          diagnostics,
          "/applications?status=active&prospect=false",
          "/applications",
          "job_ids",
          openJobIds,
          { status: "active", prospect: false }
        ),
        trackedChunked<HarvestJobInterviewStageRecord>(
          diagnostics,
          "/job_interview_stages",
          "/job_interview_stages",
          "job_ids",
          openJobIds
        ),
        trackedChunked<HarvestJobInterviewRecord>(diagnostics, "/job_interviews", "/job_interviews", "job_ids", openJobIds),
        trackedChunked<HarvestInterviewKitRecord>(diagnostics, "/interview_kits", "/interview_kits", "job_ids", openJobIds),
        trackedChunked<HarvestScheduledInterviewRecord>(
          diagnostics,
          "/interviews?status=awaiting_feedback",
          "/interviews",
          "job_ids",
          openJobIds,
          { status: "awaiting_feedback" }
        ),
        tracked<HarvestOfferRecord>(diagnostics, "/offers?status=Accepted&resolved_at", () =>
          client.list<HarvestOfferRecord>("/offers", {
            per_page: 500,
            status: "Accepted",
            current_only: true,
            resolved_at: `gte|${windows.offersSinceIso}`,
          })
        ),
        tracked<HarvestApplicationStageRecord>(diagnostics, "/application_stages?updated_at", () =>
          client.list<HarvestApplicationStageRecord>("/application_stages", {
            per_page: 500,
            updated_at: `gte|${windows.movementSinceIso}`,
          })
        ),
      ])

      // Scorecards scoped by the open jobs' interview kits, windowed. An UNSCOPED
      // time-window pull times out inside Greenhouse (PG statement timeout on
      // /scorecards?interviewed_at org-wide — observed live 2026-07-06); the kit
      // filter keeps every query small and indexed, and kit-scoping loses only
      // closed-job scorecards the module never attributes anyway. Two windows
      // (interviewed_at + submitted_at) because interviewed_at may be null.
      const kitIds = distinctIds(interviewKits.map((kit) => kit.id))
      const [scorecardsByInterviewedAt, scorecardsBySubmittedAt] = await Promise.all([
        trackedChunked<HarvestScorecardRecord>(
          diagnostics,
          "/scorecards?interviewed_at[gte] (kit-scoped)",
          "/scorecards",
          "interview_kit_ids",
          kitIds,
          { "interviewed_at[gte]": windows.movementSinceIso }
        ),
        trackedChunked<HarvestScorecardRecord>(
          diagnostics,
          "/scorecards?submitted_at[gte] (kit-scoped)",
          "/scorecards",
          "interview_kit_ids",
          kitIds,
          { "submitted_at[gte]": windows.movementSinceIso }
        ),
      ])

      // Two windowed scorecard pulls (interviewed_at may be null on drafts) merged by id.
      const scorecardById = new Map<string, HarvestScorecardRecord>()
      for (const record of [...scorecardsByInterviewedAt, ...scorecardsBySubmittedAt]) {
        const id = record.id === undefined || record.id === null ? undefined : String(record.id)
        if (id === undefined) continue
        if (!scorecardById.has(id)) scorecardById.set(id, record)
      }
      const scorecards = [...scorecardById.values()]

      const ownerUserIds = distinctIds(jobOwners.map((record) => record.user_id))
      const users = await trackedChunked<HarvestUserRecord>(diagnostics, "/users?ids", "/users", "ids", ownerUserIds)

      const knownApplicationIds = new Set(applications.map((record) => String(record.id)))
      const movementApplicationIds = distinctIds(applicationStages.map((record) => record.application_id)).filter(
        (id) => !knownApplicationIds.has(id)
      )
      const movementApplications = await trackedChunked<HarvestApplicationRecord>(
        diagnostics,
        "/applications?ids (movement delta)",
        "/applications",
        "ids",
        movementApplicationIds
      )

      // Hires on reqs that closed after filling still need name/department/priority.
      const openJobIdSet = new Set(openJobIds)
      const offerJobIds = distinctIds(offers.map((record) => record.job_id)).filter((id) => !openJobIdSet.has(id))
      const offerJobs = await trackedChunked<HarvestJobRecord>(
        diagnostics,
        "/jobs?ids (offer delta)",
        "/jobs",
        "ids",
        offerJobIds
      )

      return {
        sources: {
          jobs,
          openings,
          jobOwners,
          users,
          departments,
          applications,
          movementApplications,
          applicationStages,
          jobInterviewStages,
          jobInterviews,
          interviewKits,
          scorecards,
          awaitingFeedbackInterviews,
          offers,
          offerJobs,
        },
        sourceGaps: [],
        pullDiagnostics: diagnostics,
      }
    },
    async fetchExecCandidateNames(candidateIds) {
      return listChunkedByIds<HarvestCandidateRecord>(client, "/candidates", "ids", distinctIds(candidateIds))
    },
    async fetchEngagedStageHistories(applicationIds) {
      return listChunkedByIds<HarvestApplicationStageRecord>(
        client,
        "/application_stages",
        "application_ids",
        distinctIds(applicationIds)
      )
    },
  }
}
