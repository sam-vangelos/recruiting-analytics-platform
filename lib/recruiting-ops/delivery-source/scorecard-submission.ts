import type {
  HarvestApplicationRecord,
  HarvestCandidateRecord,
  HarvestInterviewKitRecord,
  HarvestJobInterviewRecord,
  HarvestJobOwnerRecord,
  HarvestJobRecord,
  HarvestPersonRef,
  HarvestScheduledInterviewRecord,
  HarvestScorecardRecord,
  HarvestUserRecord,
} from "../extractors/greenhouse-harvest-read-adapter"

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MONDAY_EPOCH_MS = Date.UTC(1970, 0, 5)

export type ScorecardSubmitterMatch = "match" | "mismatch" | "unknown"

/**
 * Artifact-agnostic, scorecard-grain source used by RPS-style renderers.
 *
 * Names and written feedback are intentionally present because the downstream
 * staging workbooks require them. Callers must keep this server-side and apply
 * the recipient/output controls for the artifact they render.
 */
export interface ScorecardSubmissionRow {
  /** Stable platform grain; copied legacy ledgers use timestamps only as a one-time parity bridge. */
  scorecard_id: string
  application_id: string | null
  candidate_id: string | null
  candidate_name: string | null
  application_status: string | null
  job_id: string | null
  requisition_id: string | null
  job_name: string | null
  job_status: string | null
  recruiter_names: readonly string[]
  sourcer_names: readonly string[]
  interview_kit_id: string | null
  job_interview_id: string | null
  interview_name: string | null
  interviewer_id: string | null
  interviewer_name: string | null
  scheduled_interview_ended_at: string | null
  interviewed_at: string | null
  created_at: string | null
  updated_at: string | null
  submitted_at: string | null
  /** Explicit clock used only by legacy RPS/Delivery copy-staging projections. */
  legacy_bic_reporting_at: string | null
  submitter_id: string | null
  submitter_name: string | null
  scorecard_status: string | null
  candidate_rating: string | null
  overall_recommendation: string | null
  match_mismatch: ScorecardSubmitterMatch
  month_bucket: string | null
  month_ordinal: number | null
  week_bucket: string | null
  week_ordinal: number | null
  qa_summary: string | null
  key_takeaways: string | null
}

export interface ScorecardSubmissionSources {
  scorecards: readonly HarvestScorecardRecord[]
  applications?: readonly HarvestApplicationRecord[]
  candidates?: readonly HarvestCandidateRecord[]
  jobs?: readonly HarvestJobRecord[]
  jobOwners?: readonly HarvestJobOwnerRecord[]
  interviewKits?: readonly HarvestInterviewKitRecord[]
  jobInterviews?: readonly HarvestJobInterviewRecord[]
  scheduledInterviews?: readonly HarvestScheduledInterviewRecord[]
  users?: readonly HarvestUserRecord[]
}

/**
 * Reproduce the timestamp contract observed in the canonical legacy BIC
 * scorecard ledger without mutating the native Harvest submission clock.
 *
 * Full-ledger parity analysis found v3 `created_at` to be the closest observed
 * match for the canonical legacy clock. Missing or invalid creation clocks
 * safely fall back to the native submission clock. This empirical compatibility
 * rule does not redefine `submitted_at` for any other consumer.
 */
export function legacyBicCompatibleReportingTimestamp(
  scorecard: Pick<HarvestScorecardRecord, "created_at" | "submitted_at">
): string | null {
  const createdAt = isoTimestamp(scorecard.created_at)
  const submittedAt = isoTimestamp(scorecard.submitted_at)
  return createdAt ?? submittedAt
}

/**
 * Derive one deterministic row per scorecard ID. Missing enrichment remains
 * null/empty; missing or duplicate grain IDs fail closed instead of silently
 * dropping or coalescing scorecards.
 */
export function deriveScorecardSubmissionRows(
  sources: ScorecardSubmissionSources
): ScorecardSubmissionRow[] {
  const applicationsById = indexUnique(sources.applications ?? [], (row) => idOf(row.id))
  const candidatesById = indexUnique(sources.candidates ?? [], (row) => idOf(row.id))
  const jobsById = indexUnique(sources.jobs ?? [], (row) => idOf(row.id))
  const kitsById = indexUnique(sources.interviewKits ?? [], (row) => idOf(row.id))
  const slotsById = indexUnique(sources.jobInterviews ?? [], (row) => idOf(row.id))
  const usersById = indexUnique(sources.users ?? [], (row) => idOf(row.id))
  const ownerNamesByJobAndRole = groupJobOwnerNames(sources.jobOwners ?? [], usersById)
  const scheduledByApplicationAndSlot = groupScheduledInterviews(sources.scheduledInterviews ?? [])

  const seenScorecardIds = new Set<string>()
  const rows = sources.scorecards.map((scorecard, index) => {
    const scorecardId = idOf(scorecard.id)
    if (!scorecardId) {
      throw new Error(`Scorecard submission source row ${index} is missing scorecard id.`)
    }
    if (seenScorecardIds.has(scorecardId)) {
      throw new Error(`Scorecard submission source contains duplicate scorecard id ${scorecardId}.`)
    }
    seenScorecardIds.add(scorecardId)

    const applicationId = idOf(scorecard.application_id)
    const application = applicationId ? applicationsById.get(applicationId) : undefined
    const candidateId = idOf(application?.candidate_id)
    const candidate = candidateId ? candidatesById.get(candidateId) : undefined
    const kitId = idOf(scorecard.interview_kit_id)
    const kit = kitId ? kitsById.get(kitId) : undefined
    const jobId = idOf(application?.job_id ?? application?.job?.id ?? kit?.job_id)
    const job = jobId ? jobsById.get(jobId) : undefined
    const slotId = idOf(scorecard.job_interview_id ?? kit?.job_interview_id)
    const slot = slotId ? slotsById.get(slotId) : undefined
    const scheduledInterview = selectScheduledInterview(
      applicationId && slotId
        ? scheduledByApplicationAndSlot.get(compoundKey(applicationId, slotId)) ?? []
        : [],
      scorecard
    )

    const interviewerId = idOf(scorecard.interviewer_id ?? scorecard.interviewer?.id)
    const submitterId = idOf(scorecard.submitter_id ?? scorecard.submitted_by?.id)
    const interviewerName = resolveActorName({
      actor: scorecard.interviewer,
      actorId: interviewerId,
      usersById,
      scheduledPeople: scheduledInterview?.interviewers,
    })
    const submitterName = resolveActorName({
      actor: scorecard.submitted_by,
      actorId: submitterId,
      usersById,
    })

    const scheduledEndAt = isoTimestamp(
      scheduledInterview?.ends_at ?? scheduledInterview?.scheduled_end_at
    )
    const interviewedAt = isoTimestamp(scorecard.interviewed_at)
    const createdAt = isoTimestamp(scorecard.created_at)
    const updatedAt = isoTimestamp(scorecard.updated_at)
    const submittedAt = isoTimestamp(scorecard.submitted_at)
    const reportingClock = scheduledEndAt ?? interviewedAt ?? submittedAt
    const calendar = calendarBuckets(reportingClock)
    const candidateRating = textOf(
      scorecard.candidate_rating ?? scorecard.overall_rating ?? scorecard.overall_recommendation
    )
    const overallRecommendation = textOf(
      scorecard.overall_recommendation ?? scorecard.overall_rating ?? scorecard.candidate_rating
    )

    return {
      scorecard_id: scorecardId,
      application_id: applicationId,
      candidate_id: candidateId,
      candidate_name: personName(candidate),
      application_status: textOf(application?.status),
      job_id: jobId,
      requisition_id: idOf(
        job?.requisition_id ?? application?.requisition_id ?? application?.req_id ?? application?.job?.requisition_id
      ),
      job_name: textOf(job?.name ?? application?.job?.name),
      job_status: textOf(job?.status),
      recruiter_names: namesFromOwnersOrEmbedded(
        jobId ? ownerNamesByJobAndRole.get(jobOwnerKey(jobId, "recruiter")) : undefined,
        job?.recruiter,
        job?.hiring_team?.recruiters
      ),
      sourcer_names: namesFromOwnersOrEmbedded(
        jobId ? ownerNamesByJobAndRole.get(jobOwnerKey(jobId, "sourcer")) : undefined,
        job?.sourcer,
        job?.hiring_team?.sourcers
      ),
      interview_kit_id: kitId,
      job_interview_id: slotId,
      interview_name: textOf(slot?.name ?? scheduledInterview?.interview_name),
      interviewer_id: interviewerId,
      interviewer_name: interviewerName,
      scheduled_interview_ended_at: scheduledEndAt,
      interviewed_at: interviewedAt,
      created_at: createdAt,
      updated_at: updatedAt,
      submitted_at: submittedAt,
      legacy_bic_reporting_at: legacyBicCompatibleReportingTimestamp(scorecard),
      submitter_id: submitterId,
      submitter_name: submitterName,
      scorecard_status: textOf(scorecard.status),
      candidate_rating: candidateRating,
      overall_recommendation: overallRecommendation,
      match_mismatch: actorMatch(interviewerId, interviewerName, submitterId, submitterName),
      ...calendar,
      qa_summary: feedbackOf(scorecard, ["qa summary", "quality assurance summary"], "qa_summary"),
      key_takeaways: feedbackOf(
        scorecard,
        ["key takeaways", "key take-away", "key take-aways"],
        "key_takeaways"
      ),
    }
  })

  return rows.sort((left, right) => compareIds(left.scorecard_id, right.scorecard_id))
}

function idOf(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null) return null
  const id = String(value).trim()
  return id || null
}

function textOf(value: string | undefined | null): string | null {
  const text = value?.trim()
  return text || null
}

function personName(person: { name?: string; first_name?: string; last_name?: string } | undefined): string | null {
  if (!person) return null
  return textOf(person.name) ?? textOf([person.first_name, person.last_name].filter(Boolean).join(" "))
}

function peopleNames(primary: HarvestPersonRef | undefined, people: readonly HarvestPersonRef[] | undefined): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const person of [primary, ...(people ?? [])]) {
    const name = personName(person)
    if (!name) continue
    const key = name.toLocaleLowerCase("en-US")
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

function namesFromOwnersOrEmbedded(
  ownerNames: readonly string[] | undefined,
  primary: HarvestPersonRef | undefined,
  embeddedPeople: readonly HarvestPersonRef[] | undefined
): string[] {
  return ownerNames?.length ? [...ownerNames] : peopleNames(primary, embeddedPeople)
}

function groupJobOwnerNames(
  jobOwners: readonly HarvestJobOwnerRecord[],
  usersById: ReadonlyMap<string, HarvestUserRecord>
): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const ordered = [...jobOwners].sort((left, right) => {
    if (Boolean(left.responsible) !== Boolean(right.responsible)) return left.responsible ? -1 : 1
    return compareIds(idOf(left.user_id) ?? "", idOf(right.user_id) ?? "")
  })
  for (const owner of ordered) {
    const jobId = idOf(owner.job_id)
    const role = normalizeJobOwnerRole(owner.type)
    const userId = idOf(owner.user_id)
    const name = userId ? personName(usersById.get(userId)) : null
    if (!jobId || !role || !name) continue
    const key = jobOwnerKey(jobId, role)
    const existing = result.get(key) ?? []
    if (!existing.some((value) => normalizedName(value) === normalizedName(name))) {
      result.set(key, [...existing, name])
    }
  }
  return result
}

function normalizeJobOwnerRole(value: string | undefined): "recruiter" | "sourcer" | null {
  const role = value?.trim().toLocaleLowerCase("en-US")
  if (role === "recruiter" || role === "sourcer") return role
  return null
}

function jobOwnerKey(jobId: string, role: "recruiter" | "sourcer"): string {
  return `${jobId}\u0000${role}`
}

function indexUnique<T>(rows: readonly T[], keyOf: (row: T) => string | null): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    const key = keyOf(row)
    if (key && !result.has(key)) result.set(key, row)
  }
  return result
}

function compoundKey(applicationId: string, slotId: string): string {
  return `${applicationId}\u0000${slotId}`
}

function groupScheduledInterviews(
  interviews: readonly HarvestScheduledInterviewRecord[]
): Map<string, HarvestScheduledInterviewRecord[]> {
  const grouped = new Map<string, HarvestScheduledInterviewRecord[]>()
  for (const interview of interviews) {
    const applicationId = idOf(interview.application_id ?? interview.application?.id)
    const slotId = idOf(interview.job_interview_id)
    if (!applicationId || !slotId) continue
    const key = compoundKey(applicationId, slotId)
    grouped.set(key, [...(grouped.get(key) ?? []), interview])
  }
  return grouped
}

function selectScheduledInterview(
  interviews: readonly HarvestScheduledInterviewRecord[],
  scorecard: HarvestScorecardRecord
): HarvestScheduledInterviewRecord | undefined {
  if (interviews.length <= 1) return interviews[0]
  const scorecardClock = timestampMs(scorecard.interviewed_at ?? scorecard.submitted_at)
  return [...interviews].sort((left, right) => {
    const distance = (row: HarvestScheduledInterviewRecord): number => {
      if (scorecardClock === null) return Number.POSITIVE_INFINITY
      const rowClock = timestampMs(
        row.ends_at ?? row.scheduled_end_at ?? row.starts_at ?? row.scheduled_at
      )
      return rowClock === null ? Number.POSITIVE_INFINITY : Math.abs(rowClock - scorecardClock)
    }
    const leftDistance = distance(left)
    const rightDistance = distance(right)
    if (leftDistance !== rightDistance) return leftDistance < rightDistance ? -1 : 1
    return compareIds(idOf(left.id) ?? "", idOf(right.id) ?? "")
  })[0]
}

function resolveActorName(input: {
  actor?: HarvestPersonRef
  actorId: string | null
  usersById: ReadonlyMap<string, HarvestUserRecord>
  scheduledPeople?: readonly HarvestPersonRef[]
}): string | null {
  const direct = personName(input.actor)
  if (direct) return direct
  if (input.actorId) {
    const user = input.usersById.get(input.actorId)
    const userName = personName(user)
    if (userName) return userName
    const scheduled = input.scheduledPeople?.find((person) => idOf(person.id) === input.actorId)
    const scheduledName = personName(scheduled)
    if (scheduledName) return scheduledName
  }
  if (input.scheduledPeople?.length === 1) return personName(input.scheduledPeople[0])
  return null
}

function actorMatch(
  interviewerId: string | null,
  interviewerName: string | null,
  submitterId: string | null,
  submitterName: string | null
): ScorecardSubmitterMatch {
  if (interviewerId && submitterId) return interviewerId === submitterId ? "match" : "mismatch"
  const interviewer = normalizedName(interviewerName)
  const submitter = normalizedName(submitterName)
  if (!interviewer || !submitter) return "unknown"
  return interviewer === submitter ? "match" : "mismatch"
}

function normalizedName(value: string | null): string {
  return value?.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ") ?? ""
}

function timestampMs(value: string | undefined | null): number | null {
  const text = textOf(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : parsed
}

function isoTimestamp(value: string | undefined | null): string | null {
  const timestamp = timestampMs(value)
  return timestamp === null ? null : new Date(timestamp).toISOString()
}

function calendarBuckets(value: string | null): Pick<
  ScorecardSubmissionRow,
  "month_bucket" | "month_ordinal" | "week_bucket" | "week_ordinal"
> {
  const timestamp = timestampMs(value)
  if (timestamp === null) {
    return { month_bucket: null, month_ordinal: null, week_bucket: null, week_ordinal: null }
  }
  const date = new Date(timestamp)
  const monthBucket = date.toISOString().slice(0, 7)
  const monthOrdinal = date.getUTCFullYear() * 12 + date.getUTCMonth()
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    - ((date.getUTCDay() + 6) % 7) * 24 * 60 * 60 * 1000
  return {
    month_bucket: monthBucket,
    month_ordinal: monthOrdinal,
    week_bucket: new Date(monday).toISOString().slice(0, 10),
    week_ordinal: Math.floor((monday - MONDAY_EPOCH_MS) / WEEK_MS),
  }
}

function feedbackOf(
  scorecard: HarvestScorecardRecord,
  labels: readonly string[],
  directField: "qa_summary" | "key_takeaways"
): string | null {
  const direct = textOf(scorecard[directField])
  if (direct) return direct
  const wanted = new Set(labels.map(normalizeFeedbackLabel))
  const matching = scorecard.questions?.find((question) => {
    const label = normalizeFeedbackLabel(question.question ?? "")
    return wanted.has(label)
  })
  return textOf(matching?.answer)
}

function normalizeFeedbackLabel(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim()
}

function compareIds(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) {
    const leftValue = BigInt(left)
    const rightValue = BigInt(right)
    if (leftValue < rightValue) return -1
    if (leftValue > rightValue) return 1
    return 0
  }
  return left.localeCompare(right, "en-US")
}
