import {
  buildGovernedFunnelMap,
  eltReportingFriday,
  OFFERS_TRAILING_DAYS,
  reportingQuarter,
  type GovernedFunnelEntry,
} from "../exec-definitions"
import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import {
  isGovernedDeliveryRole,
  legacyFinalOfferParityV1,
  legacyRpsTrackingParityV1,
} from "../dimensions/config/legacy-artifact-display.v1"
import {
  createGreenhouseHarvestExecReadBoundary,
  type GreenhouseHarvestReadClient,
  type HarvestApplicationRecord,
  type HarvestApplicationStageRecord,
  type HarvestDepartmentRecord,
  type HarvestInterviewKitRecord,
  type HarvestJobInterviewRecord,
  type HarvestJobInterviewStageRecord,
  type HarvestJobOwnerRecord,
  type HarvestJobRecord,
  type HarvestOpeningRecord,
  type HarvestOfferRecord,
  type HarvestScheduledInterviewRecord,
  type HarvestScorecardRecord,
  type HarvestUserRecord,
} from "../extractors/greenhouse-harvest-read-adapter"
import type {
  ExecPullDiagnostic,
  HarvestExecStateSources,
} from "../extractors/greenhouse-exec-read-boundary"
import type { SourceGap } from "../runs"
import { emitCandidateStageEventRows, type CandidateStageEventRow, type CandidateStageOutcomeSource } from "./candidate-stage-events"
import { mapHarvestApplicationsToCandidateStageOutcomes } from "./harvest-candidate-stage-outcomes"
import {
  mapHarvestToOfferLifecycleExportSources,
  type HarvestCandidateSourceRecord,
  type HarvestOfferLifecycleApplication,
  type HarvestOfferLifecycleCandidate,
  type HarvestOfferLifecycleJob,
  type HarvestOfferLifecycleRecord,
  type HarvestRejectionDetailRecord,
  type HarvestRejectionReasonRecord,
  type HarvestReferrerRecord,
} from "./harvest-offer-lifecycle-source"
import { emitOfferLifecycleExportRows, type OfferLifecycleExportRow } from "./offer-lifecycle-export"
import { buildReqWeekReportRows, type ReqWeekReportRow } from "./req-week-report"
import { requireAvailableWeeklyRecruitmentFriday } from "../delivery/weekly-recruitment-rollover"
import {
  deriveScorecardSubmissionRows,
  type ScorecardSubmissionRow,
} from "./scorecard-submission"

const RECORD_CAP = 200_000
const ID_CHUNK_SIZE = 50
const LEGACY_PIPELINE_REQ_IDS = new Set(["890", "907", "1026", "1027", "1118", "1119"])

export interface StagingHydrationSourceCollections {
  generatedAt: string
  reportingWeekFriday: string
  quarterStart: string
  jobs: readonly HarvestOfferLifecycleJob[]
  openings: readonly HarvestOpeningRecord[]
  jobOwners: readonly HarvestJobOwnerRecord[]
  users: readonly HarvestUserRecord[]
  departments: readonly HarvestDepartmentRecord[]
  applications: readonly HarvestOfferLifecycleApplication[]
  applicationStages: readonly HarvestApplicationStageRecord[]
  jobInterviewStages: readonly HarvestJobInterviewStageRecord[]
  jobInterviews: readonly HarvestJobInterviewRecord[]
  interviewKits: readonly { id?: string | number; job_id?: string | number; job_interview_id?: string | number }[]
  scorecards: readonly HarvestScorecardRecord[]
  scheduledInterviews: readonly HarvestScheduledInterviewRecord[]
  offers: readonly HarvestOfferLifecycleRecord[]
  candidates: readonly HarvestOfferLifecycleCandidate[]
  candidateSources: readonly HarvestCandidateSourceRecord[]
  referrers: readonly HarvestReferrerRecord[]
  rejectionDetails?: readonly HarvestRejectionDetailRecord[]
  rejectionReasons: readonly HarvestRejectionReasonRecord[]
  diagnostics: readonly ExecPullDiagnostic[]
  /** The exact raw base reused by the orchestrated ELT derivation. */
  execSources?: HarvestExecStateSources
  execSourceGaps?: readonly SourceGap[]
}

export interface StagingHydrationFacts {
  generatedAt: string
  reportingWeekFriday: string
  quarterStart: string
  candidateEvents: readonly CandidateStageEventRow[]
  offers: readonly OfferLifecycleExportRow[]
  scorecards: readonly ScorecardSubmissionRow[]
  reqWeeks: readonly ReqWeekReportRow[]
  diagnostics: readonly ExecPullDiagnostic[]
}

export interface StagingHydrationSourceRequirements {
  /** Continuous 02 Mar 2026-present RPS Tracking ledger across open and closed jobs. */
  includeLegacyRpsHistory?: boolean
  /** Current Fri-Thu Delivery portfolio across open and closed jobs. */
  includeDeliveryRpsCurrentWeek?: boolean
}

/**
 * Read-only source assembly for the staging hydrator. It reuses the proven E01
 * boundary for capped/chunked movement and scorecard pulls, then adds the
 * quarter offer lifecycle and the exact joins required by the copied reports.
 */
export async function loadStagingHydrationSourceCollections(input: {
  client: GreenhouseHarvestReadClient
  nowMs?: number
  recordCap?: number
  requirements?: StagingHydrationSourceRequirements
  reportingWeekFriday?: string
  quarterStart?: string
  calendarValidationNowMs?: number
}): Promise<StagingHydrationSourceCollections> {
  const nowMs = input.nowMs ?? Date.now()
  const calendarValidationNowMs = input.calendarValidationNowMs ?? nowMs
  const generatedAt = new Date(nowMs).toISOString()
  const reportingWeekFriday = input.reportingWeekFriday
    ? requireAvailableWeeklyRecruitmentFriday(input.reportingWeekFriday, calendarValidationNowMs)
    : eltReportingFriday(new Date(nowMs))
  const quarterStart = input.quarterStart
    ? requireQuarterStart(input.quarterStart)
    : reportingQuarter(reportingWeekFriday).startIso
  const quarterStartMs = Date.parse(`${quarterStart}T00:00:00.000Z`)
  const movementSinceIso = new Date(Math.min(
    quarterStartMs,
    nowMs - 31 * 86_400_000
  )).toISOString()
  const offersSinceIso = new Date(Math.min(
    quarterStartMs,
    nowMs - OFFERS_TRAILING_DAYS * 86_400_000
  )).toISOString()
  const reportingWeekSinceIso = `${reportingWeekFriday}T00:00:00.000Z`
  const includeLegacyRpsHistory = input.requirements?.includeLegacyRpsHistory === true
  const includeDeliveryRpsCurrentWeek = input.requirements?.includeDeliveryRpsCurrentWeek === true
  const expandedScorecardSinceIso = includeLegacyRpsHistory
    ? `${legacyRpsTrackingParityV1.submittedAtStart}T00:00:00.000Z`
    : `${reportingWeekFriday}T00:00:00.000Z`
  const sourceRecordCap = input.recordCap ?? RECORD_CAP
  const boundary = createGreenhouseHarvestExecReadBoundary(input.client, {
    recordCap: sourceRecordCap,
  })
  const pulled = await boundary.fetchExecStateSources(
    { asOf: generatedAt },
    { movementSinceIso, offersSinceIso }
  )

  const diagnostics = [...pulled.pullDiagnostics]
  const tracked = async <T>(source: string, pull: () => Promise<readonly T[]>): Promise<readonly T[]> => {
    const rows = await pull()
    diagnostics.push({
      source,
      records: rows.length,
      truncationSuspected: rows.length >= sourceRecordCap,
    })
    return rows
  }
  const trackedChunked = async <T>(
    source: string,
    endpoint: Parameters<GreenhouseHarvestReadClient["list"]>[0],
    idParam: string,
    ids: readonly string[],
    extra: Record<string, string | number | boolean | undefined> = {}
  ): Promise<readonly T[]> => {
    const rows: T[] = []
    let truncationSuspected = false
    for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
      const chunk = ids.slice(start, start + ID_CHUNK_SIZE)
      const page = await input.client.list<T>(endpoint, {
        per_page: 500,
        ...extra,
        [idParam]: chunk.join(","),
      })
      if (page.length >= sourceRecordCap) truncationSuspected = true
      rows.push(...page)
    }
    diagnostics.push({ source, records: rows.length, truncationSuspected })
    return rows
  }

  const [
    allJobs,
    allOpenings,
    quarterOffers,
    weeklyResolvedOffers,
    candidateSources,
    referrers,
    rejectionReasons,
  ] = await Promise.all([
    tracked("/jobs (hydration all-status)", () =>
      input.client.list<HarvestOfferLifecycleJob>("/jobs", { per_page: 500 })
    ),
    tracked("/openings (hydration all-status)", () =>
      input.client.list<HarvestOpeningRecord>("/openings", { per_page: 500 })
    ),
    tracked("/offers?created_at (hydration quarter)", () =>
      input.client.list<HarvestOfferLifecycleRecord>("/offers", {
        per_page: 500,
        current_only: false,
        created_at: `gte|${quarterStart}T00:00:00.000Z`,
      })
    ),
    // A current-week decline or acceptance may belong to an offer created
    // before the quarter. Pull current offer versions by resolution time so
    // weekly N/O counts do not silently miss those events.
    tracked("/offers?resolved_at (hydration week all statuses)", () =>
      input.client.list<HarvestOfferLifecycleRecord>("/offers", {
        per_page: 500,
        current_only: true,
        resolved_at: `gte|${reportingWeekSinceIso}`,
      })
    ),
    tracked("/sources", () =>
      input.client.list<HarvestCandidateSourceRecord>("/sources", { per_page: 500 })
    ),
    tracked("/referrers", () =>
      input.client.list<HarvestReferrerRecord>("/referrers", { per_page: 500 })
    ),
    tracked("/rejection_reasons", () =>
      input.client.list<HarvestRejectionReasonRecord>("/rejection_reasons", { per_page: 500, include_defaults: true })
    ),
  ])
  // Consumers do not share one time clock. Final Offer filters this superset
  // back to offers created in the quarter, while weekly progress, ELT, and All
  // Hires must still see an accepted offer created before the quarter and
  // resolved inside it. Prefer the current-week resolution snapshot when the
  // same offer is present in more than one pull.
  const offers = dedupeById([
    ...weeklyResolvedOffers,
    ...pulled.sources.offers,
    ...quarterOffers.filter((offer) => timestampAtOrAfter(offer.created_at, `${quarterStart}T00:00:00.000Z`)),
  ]) as HarvestOfferLifecycleRecord[]
  const rejectionDetails = await trackedChunked<HarvestRejectionDetailRecord>(
    "/rejection_details?application_ids (hydration offer joins)",
    "/rejection_details",
    "application_ids",
    uniqueIds(offers.map((offer) => offer.application_id))
  )

  // RPS Tracking needs every all-status job from 02 Mar 2026; Delivery RPS
  // needs its governed all-status portfolio for the current Fri-Thu window.
  // Greenhouse's org-wide /scorecards time query times out, so both paths stay
  // bounded by resolving job kits first and querying at most 50 kits per call.
  const scorecardExpansionLabel = includeLegacyRpsHistory
    ? "RPS history all-status"
    : "Delivery current-week all-status"
  const scorecardExpansionJobs = includeLegacyRpsHistory
    ? [...allJobs, ...pulled.sources.jobs, ...pulled.sources.offerJobs]
    : includeDeliveryRpsCurrentWeek
      ? allJobs.filter((job) => isGovernedDeliveryRole({
          requisitionId: idOf(job.requisition_id),
          jobName: job.name,
          departmentName: job.departments?.map((department) => department.name).filter(Boolean).join(" / ") ?? null,
        }))
      : []
  const scorecardExpansionJobIds = uniqueIds(scorecardExpansionJobs.map((job) => job.id))
  const [allStatusJobInterviews, allStatusInterviewKits] = scorecardExpansionJobIds.length > 0
    ? await Promise.all([
        trackedChunked<HarvestJobInterviewRecord>(
          `/job_interviews?job_ids (hydration ${scorecardExpansionLabel})`,
          "/job_interviews",
          "job_ids",
          scorecardExpansionJobIds
        ),
        trackedChunked<HarvestInterviewKitRecord>(
          `/interview_kits?job_ids (hydration ${scorecardExpansionLabel})`,
          "/interview_kits",
          "job_ids",
          scorecardExpansionJobIds
        ),
      ])
    : [[], []]
  const allStatusKitIds = uniqueIds(allStatusInterviewKits.map((kit) => kit.id))
  // Harvest v3 uses bracketed timestamp filters. Pull complete scorecards by
  // both native submission time and the legacy/BIC-compatible creation clock.
  // Each query remains time-windowed and kit-scoped; merging by
  // scorecard id prevents the overlap from changing grain.
  const [historicSubmittedScorecards, compatibilityCreatedScorecards] = allStatusKitIds.length > 0
    ? await Promise.all([
        trackedChunked<HarvestScorecardRecord>(
          `/scorecards?submitted_at[gte] (hydration ${scorecardExpansionLabel} kits)`,
          "/scorecards",
          "interview_kit_ids",
          allStatusKitIds,
          {
            status: "complete",
            "submitted_at[gte]": expandedScorecardSinceIso,
            "submitted_at[lte]": generatedAt,
          }
        ),
        trackedChunked<HarvestScorecardRecord>(
          `/scorecards?created_at[gte] (legacy BIC compatibility ${scorecardExpansionLabel} kits)`,
          "/scorecards",
          "interview_kit_ids",
          allStatusKitIds,
          {
            status: "complete",
            "created_at[gte]": expandedScorecardSinceIso,
            "created_at[lte]": generatedAt,
          }
        ),
      ])
    : [[], []]
  const scorecards = dedupeById([
    ...historicSubmittedScorecards,
    ...compatibilityCreatedScorecards,
    ...pulled.sources.scorecards,
  ]).filter(isCompleteScorecard) as HarvestScorecardRecord[]
  const jobInterviews = dedupeById([
    ...allStatusJobInterviews,
    ...pulled.sources.jobInterviews,
  ]) as HarvestJobInterviewRecord[]
  const interviewKits = dedupeById([
    ...allStatusInterviewKits,
    ...pulled.sources.interviewKits,
  ]) as HarvestInterviewKitRecord[]

  const baseApplications = dedupeById([
    ...pulled.sources.applications,
    ...pulled.sources.movementApplications,
  ]) as HarvestOfferLifecycleApplication[]
  const neededApplicationIds = uniqueIds([
    ...offers.map((offer) => offer.application_id),
    ...scorecards.map((scorecard) => scorecard.application_id),
  ]).filter((id) => !baseApplications.some((application) => idOf(application.id) === id))
  const addedApplications = await tracked("/applications?ids (hydration joins)", () =>
    listChunked<HarvestOfferLifecycleApplication>(input.client, "/applications", "ids", neededApplicationIds)
  )
  const applications = dedupeById([...baseApplications, ...addedApplications]) as HarvestOfferLifecycleApplication[]

  const baseJobs = dedupeById([...allJobs, ...pulled.sources.jobs, ...pulled.sources.offerJobs]) as HarvestOfferLifecycleJob[]
  const neededJobIds = uniqueIds([
    ...offers.map((offer) => offer.job_id),
    ...applications.map((application) => application.job_id ?? application.job?.id),
  ]).filter((id) => !baseJobs.some((job) => idOf(job.id) === id))
  const addedJobs = await tracked("/jobs?ids (hydration joins)", () =>
    listChunked<HarvestOfferLifecycleJob>(input.client, "/jobs", "ids", neededJobIds)
  )
  const jobs = dedupeById([...baseJobs, ...addedJobs]) as HarvestOfferLifecycleJob[]

  // Candidate names are needed only for consumer rows: the six legacy
  // pipelines, quarter offers, and the governed RPS history. Pulling names for every
  // org-wide active application turns this bounded hydration into thousands of
  // unnecessary candidate requests.
  const focusJobIds = new Set(
    jobs
      .filter((job) => LEGACY_PIPELINE_REQ_IDS.has(idOf(job.requisition_id) ?? ""))
      .map((job) => idOf(job.id))
      .filter((id): id is string => Boolean(id))
  )
  const consumerApplicationIds = new Set([
    ...offers.map((offer) => idOf(offer.application_id)),
    ...scorecards.map((scorecard) => idOf(scorecard.application_id)),
    ...applications
      .filter((application) => focusJobIds.has(idOf(application.job_id ?? application.job?.id) ?? ""))
      .map((application) => idOf(application.id)),
  ].filter((id): id is string => Boolean(id)))
  const candidateIds = uniqueIds([
    ...applications
      .filter((application) => consumerApplicationIds.has(idOf(application.id) ?? ""))
      .map((application) => application.candidate_id),
    ...offers.map((offer) => offer.candidate_id),
  ])
  const candidates = await tracked("/candidates?ids (hydration joins)", () =>
    listChunked<HarvestOfferLifecycleCandidate>(input.client, "/candidates", "ids", candidateIds)
  )

  const scorecardApplicationIds = uniqueIds(scorecards.map((scorecard) => scorecard.application_id))
  const scheduledInterviews = await tracked("/interviews?application_ids (hydration scorecards)", () =>
    listChunked<HarvestScheduledInterviewRecord>(
      input.client,
      "/interviews",
      "application_ids",
      scorecardApplicationIds,
      includeLegacyRpsHistory || includeDeliveryRpsCurrentWeek
        ? {}
        : { starts_at: `gte|${movementSinceIso}` }
    )
  )

  const actorUserIds = uniqueIds(
    scorecards.flatMap((scorecard) => [
      scorecard.interviewer_id,
      scorecard.submitter_id,
      scorecard.interviewer?.id,
      scorecard.submitted_by?.id,
    ])
  )
  const existingUserIds = new Set(pulled.sources.users.map((user) => idOf(user.id)).filter(Boolean))
  const missingActorIds = actorUserIds.filter((id) => !existingUserIds.has(id))
  const actorUsers = await tracked("/users?ids (hydration actors)", () =>
    listChunked<HarvestUserRecord>(input.client, "/users", "ids", missingActorIds)
  )

  return {
    generatedAt,
    reportingWeekFriday,
    quarterStart,
    jobs,
    openings: dedupeById([...allOpenings, ...pulled.sources.openings]),
    jobOwners: pulled.sources.jobOwners,
    users: dedupeById([...pulled.sources.users, ...actorUsers]),
    departments: pulled.sources.departments,
    applications,
    applicationStages: pulled.sources.applicationStages,
    jobInterviewStages: pulled.sources.jobInterviewStages,
    jobInterviews,
    interviewKits,
    scorecards,
    scheduledInterviews,
    offers,
    candidates,
    candidateSources,
    referrers,
    rejectionDetails,
    rejectionReasons,
    diagnostics,
    execSources: pulled.sources,
    execSourceGaps: pulled.sourceGaps,
  }
}

function requireQuarterStart(value: string): string {
  if (!/^\d{4}-(?:01|04|07|10)-01$/.test(value)) {
    throw new Error("Staging hydration quarterStart must be an ISO calendar-quarter start.")
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error("Staging hydration quarterStart must be an ISO calendar-quarter start.")
  }
  return value
}

export function deriveStagingHydrationFacts(input: {
  collections: StagingHydrationSourceCollections
  roster: readonly RecruiterTeamHodEntry[]
  stageTaxonomy: readonly { stageLabel: string; funnelStage?: string | null }[]
  outcomes?: readonly CandidateStageOutcomeSource[]
}): StagingHydrationFacts {
  const { collections } = input
  const governedFunnel: ReadonlyMap<string, GovernedFunnelEntry> = buildGovernedFunnelMap(input.stageTaxonomy)
  const offerSources = mapHarvestToOfferLifecycleExportSources({
    offers: collections.offers,
    applications: collections.applications,
    candidates: collections.candidates,
    jobs: collections.jobs,
    users: collections.users,
    departments: collections.departments,
    sources: collections.candidateSources,
    referrers: collections.referrers,
    rejectionDetails: collections.rejectionDetails,
    rejectionReasons: collections.rejectionReasons,
    departmentHods: legacyFinalOfferParityV1.departmentHods.map((entry) => ({
      department_name: entry.departmentName,
      hod_name: entry.hodName,
    })),
    recruiterRoster: input.roster,
  })
  const offers = emitOfferLifecycleExportRows(offerSources)
  const outcomes = input.outcomes ?? mapHarvestApplicationsToCandidateStageOutcomes({
    applications: collections.applications,
    users: collections.users,
  })
  return {
    generatedAt: collections.generatedAt,
    reportingWeekFriday: collections.reportingWeekFriday,
    quarterStart: collections.quarterStart,
    candidateEvents: emitCandidateStageEventRows({
      applications: pipelineApplications(collections.applications, collections.jobs),
      applicationStages: pipelineStageRows(collections.applicationStages, collections.applications, collections.jobs),
      jobInterviewStages: collections.jobInterviewStages,
      jobs: collections.jobs,
      governedFunnel,
      outcomes,
      candidates: collections.candidates,
      jobOwners: collections.jobOwners,
      users: collections.users,
    }),
    offers,
    scorecards: deriveScorecardSubmissionRows({
      scorecards: collections.scorecards,
      applications: collections.applications,
      candidates: collections.candidates,
      jobs: collections.jobs,
      interviewKits: collections.interviewKits,
      jobInterviews: collections.jobInterviews,
      scheduledInterviews: collections.scheduledInterviews,
      users: collections.users,
      jobOwners: collections.jobOwners,
    }),
    reqWeeks: buildReqWeekReportRows({
      reportingWeekFriday: collections.reportingWeekFriday,
      asOf: collections.generatedAt,
      jobs: currentWeeklyJobs(
        collections.jobs,
        collections.offers,
        collections.reportingWeekFriday
      ),
      openings: collections.openings,
      jobOwners: collections.jobOwners,
      users: collections.users,
      departments: collections.departments,
      offers: collections.offers,
      roster: input.roster,
    }),
    diagnostics: collections.diagnostics,
  }
}

function pipelineApplications(
  applications: readonly HarvestApplicationRecord[],
  jobs: readonly HarvestJobRecord[]
): HarvestApplicationRecord[] {
  const jobIds = new Set(
    jobs
      .filter((job) => LEGACY_PIPELINE_REQ_IDS.has(idOf(job.requisition_id) ?? ""))
      .map((job) => idOf(job.id))
      .filter((id): id is string => Boolean(id))
  )
  return applications.filter((application) => jobIds.has(idOf(application.job_id ?? application.job?.id) ?? ""))
}

function pipelineStageRows(
  rows: readonly HarvestApplicationStageRecord[],
  applications: readonly HarvestApplicationRecord[],
  jobs: readonly HarvestJobRecord[]
): HarvestApplicationStageRecord[] {
  const appIds = new Set(
    pipelineApplications(applications, jobs)
      .map((application) => idOf(application.id))
      .filter((id): id is string => Boolean(id))
  )
  return rows.filter((row) => appIds.has(idOf(row.application_id) ?? ""))
}

function currentWeeklyJobs(
  jobs: readonly HarvestJobRecord[],
  offers: readonly HarvestOfferRecord[],
  reportingWeekFriday: string
): HarvestJobRecord[] {
  const weekStart = Date.parse(`${reportingWeekFriday}T00:00:00Z`)
  const weekEndExclusive = weekStart + 7 * 86_400_000
  const weeklyOfferJobIds = new Set(
    offers
      .filter((offer) =>
        timestampInside(offer.created_at, weekStart, weekEndExclusive) ||
        timestampInside(offer.resolved_at, weekStart, weekEndExclusive)
      )
      .map((offer) => idOf(offer.job_id ?? offer.job?.id))
      .filter((jobId): jobId is string => Boolean(jobId))
  )
  return jobs.filter((job) => {
    if ((job.status ?? "").toLowerCase() === "open") return true
    if (weeklyOfferJobIds.has(idOf(job.id) ?? "")) return true
    const closedAt = Date.parse(job.closed_at ?? "")
    return !Number.isNaN(closedAt) && closedAt >= weekStart
  })
}

function timestampInside(
  value: string | null | undefined,
  startInclusive: number,
  endExclusive: number
): boolean {
  const timestamp = Date.parse(value ?? "")
  return !Number.isNaN(timestamp) && timestamp >= startInclusive && timestamp < endExclusive
}

async function listChunked<T>(
  client: GreenhouseHarvestReadClient,
  endpoint: Parameters<GreenhouseHarvestReadClient["list"]>[0],
  idParam: string,
  ids: readonly string[],
  extra: Record<string, string | number | boolean | undefined> = {}
): Promise<readonly T[]> {
  const rows: T[] = []
  for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + ID_CHUNK_SIZE)
    rows.push(...(await client.list<T>(endpoint, { per_page: 500, ...extra, [idParam]: chunk.join(",") })))
  }
  return rows
}

function timestampAtOrAfter(value: string | undefined, minimum: string): boolean {
  const timestamp = Date.parse(value ?? "")
  return !Number.isNaN(timestamp) && timestamp >= Date.parse(minimum)
}

function isCompleteScorecard(scorecard: HarvestScorecardRecord): boolean {
  const status = scorecard.status?.trim().toLocaleLowerCase("en-US")
  if (status) return status === "complete"
  return !Number.isNaN(Date.parse(scorecard.submitted_at ?? ""))
}

function idOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const id = String(value).trim()
  return id || null
}

function uniqueIds(values: readonly unknown[]): string[] {
  return [...new Set(values.map(idOf).filter((value): value is string => Boolean(value)))]
}

function dedupeById<T extends { id?: string | number | null }>(rows: readonly T[]): T[] {
  const byId = new Map<string, T>()
  for (const row of rows) {
    const id = idOf(row.id)
    if (id && !byId.has(id)) byId.set(id, row)
  }
  return [...byId.values()]
}
