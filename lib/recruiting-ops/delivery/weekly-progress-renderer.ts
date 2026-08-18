import { reportingQuarter } from "../exec-definitions"
import type { CandidateStageEventRow } from "../delivery-source/candidate-stage-events"
import type { OfferLifecycleExportRow } from "../delivery-source/offer-lifecycle-export"
import type { ScorecardSubmissionRow } from "../delivery-source/scorecard-submission"
import type { SheetCellValue } from "./staging-value-plan"

export type WeeklyProgressRoleBucket = "fde_pe" | "code_rl" | "brazil_colombia"

export const WEEKLY_PROGRESS_REQS: Readonly<Record<WeeklyProgressRoleBucket, readonly string[]>> = {
  fde_pe: ["890", "907"],
  code_rl: ["1026", "1027"],
  brazil_colombia: ["1118", "1119"],
}

const ROWS: Readonly<Record<WeeklyProgressRoleBucket, readonly string[]>> = {
  fde_pe: [
    "Offer Accepted",
    "Offer",
    "Onsite Interview",
    "Manager / Tech Screen",
    "Hiring Manager Resume Review",
    "Recruiter Phone Screen Conducted",
  ],
  code_rl: [
    "Offer Accepted",
    "Offer",
    "Onsite Interviews",
    "Skills Assessment",
    "Manager / Tech Screen",
    "Hiring Manager Resume Review",
    "Recruiter Phone Screen Conducted",
  ],
  brazil_colombia: [
    "Offer Accepted",
    "Offer",
    "Onsite Interviews",
    "Skills Assessment",
    "Manager / Tech Screen",
    "Hiring Manager Resume Review",
    "Recruiter Phone Screen Conducted",
  ],
}

const WEEKLY_PROGRESS_BUCKETS = [
  "code_rl",
  "fde_pe",
  "brazil_colombia",
] as const satisfies readonly WeeklyProgressRoleBucket[]

/**
 * Visible weekly-summary values. Stage rows count explicit origin-stage passes,
 * RPS Conducted counts scorecard-grain interviews, and offer rows count offer
 * lifecycle evidence. No sheet formulas or Apps Script semantics are inferred.
 */
export function renderWeeklyProgressValues(input: {
  bucket: WeeklyProgressRoleBucket
  reportingWeekFriday: string
  candidateEvents: readonly CandidateStageEventRow[]
  offers: readonly OfferLifecycleExportRow[]
  scorecards: readonly ScorecardSubmissionRow[]
}): { rowLabels: readonly string[]; values: SheetCellValue[][] } {
  const reqs = new Set(WEEKLY_PROGRESS_REQS[input.bucket])
  const events = input.candidateEvents.filter(
    (row) => row.reporting_week_friday === input.reportingWeekFriday && row.requisition_id && reqs.has(row.requisition_id)
  )
  const offerRows = input.offers.filter(
    (row) => row.requisition_id && reqs.has(row.requisition_id) && withinReportingWeek(row.resolved_at ?? row.created_at, input.reportingWeekFriday)
  )
  const extendedOffers = input.offers.filter(
    (row) => row.requisition_id && reqs.has(row.requisition_id) && withinReportingWeek(row.created_at, input.reportingWeekFriday)
  )
  const conductedRps = input.scorecards.filter(
    (row) =>
      row.requisition_id &&
      reqs.has(row.requisition_id) &&
      /recruiter|phone|rps|preliminary/i.test(row.interview_name ?? "") &&
      withinReportingWeek(row.scheduled_interview_ended_at ?? row.interviewed_at ?? row.submitted_at, input.reportingWeekFriday)
  )

  return renderWeeklyProgressRows({
    bucket: input.bucket,
    events,
    offerRows,
    extendedOffers,
    conductedRps,
  })
}

/**
 * Calendar-quarter counts before the first Fri-Thu column in the quarter.
 * These offsets keep QTD exact when a quarter begins before Friday.
 */
export function renderWeeklyProgressQuarterOpeningOffsets(input: {
  reportingWeekFriday: string
  candidateEvents: readonly CandidateStageEventRow[]
  offers: readonly OfferLifecycleExportRow[]
  scorecards: readonly ScorecardSubmissionRow[]
}): Readonly<Record<WeeklyProgressRoleBucket, readonly number[]>> {
  const quarterStart = reportingQuarter(input.reportingWeekFriday).startIso
  const quarterStartMs = Date.parse(`${quarterStart}T00:00:00.000Z`)
  const firstFridayMs = quarterStartMs +
    ((5 - new Date(quarterStartMs).getUTCDay() + 7) % 7) * 86_400_000

  return renderWeeklyProgressOffsetsForWindow(input, quarterStartMs, firstFridayMs)
}

/**
 * Calendar-quarter counts after quarter end inside the final Fri-Thu column.
 * These offsets are subtracted from QTD when the reporting week straddles quarters.
 */
export function renderWeeklyProgressQuarterClosingOffsets(input: {
  reportingWeekFriday: string
  candidateEvents: readonly CandidateStageEventRow[]
  offers: readonly OfferLifecycleExportRow[]
  scorecards: readonly ScorecardSubmissionRow[]
}): Readonly<Record<WeeklyProgressRoleBucket, readonly number[]>> {
  const reportingFridayMs = Date.parse(`${input.reportingWeekFriday}T00:00:00.000Z`)
  const reportingFriday = new Date(reportingFridayMs)
  const quarterEndMs = Date.UTC(
    reportingFriday.getUTCFullYear(),
    Math.floor(reportingFriday.getUTCMonth() / 3) * 3 + 3,
    1
  )
  if (reportingFridayMs + 7 * 86_400_000 <= quarterEndMs) {
    return renderWeeklyProgressOffsetsForWindow(input, quarterEndMs, quarterEndMs)
  }

  const inQuarter = renderWeeklyProgressOffsetsForWindow(input, reportingFridayMs, quarterEndMs)
  const closing = {} as Record<WeeklyProgressRoleBucket, readonly number[]>
  for (const bucket of WEEKLY_PROGRESS_BUCKETS) {
    const fullWeek = renderWeeklyProgressValues({ ...input, bucket }).values.map(([value]) => Number(value))
    closing[bucket] = fullWeek.map((value, index) => {
      const adjustment = value - inQuarter[bucket][index]
      if (!Number.isInteger(adjustment) || adjustment < 0) {
        throw new Error("Weekly Progress quarter-closing adjustment is invalid.")
      }
      return adjustment
    })
  }
  return closing
}

function renderWeeklyProgressOffsetsForWindow(
  input: {
    candidateEvents: readonly CandidateStageEventRow[]
    offers: readonly OfferLifecycleExportRow[]
    scorecards: readonly ScorecardSubmissionRow[]
  },
  startMs: number,
  endMs: number
): Readonly<Record<WeeklyProgressRoleBucket, readonly number[]>> {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error("Weekly Progress quarter-boundary window is invalid.")
  }

  const offsets = {} as Record<WeeklyProgressRoleBucket, readonly number[]>
  for (const bucket of WEEKLY_PROGRESS_BUCKETS) {
    if (endMs <= startMs) {
      offsets[bucket] = ROWS[bucket].map(() => 0)
      continue
    }
    const reqs = new Set(WEEKLY_PROGRESS_REQS[bucket])
    const inBoundaryWindow = (value: string | null): boolean =>
      withinWindow(value, startMs, endMs)
    const rendered = renderWeeklyProgressRows({
      bucket,
      events: input.candidateEvents.filter(
        (row) => row.requisition_id && reqs.has(row.requisition_id) && inBoundaryWindow(row.event_ts)
      ),
      offerRows: input.offers.filter(
        (row) => row.requisition_id && reqs.has(row.requisition_id) && inBoundaryWindow(row.resolved_at ?? row.created_at)
      ),
      extendedOffers: input.offers.filter(
        (row) => row.requisition_id && reqs.has(row.requisition_id) && inBoundaryWindow(row.created_at)
      ),
      conductedRps: input.scorecards.filter(
        (row) =>
          row.requisition_id &&
          reqs.has(row.requisition_id) &&
          /recruiter|phone|rps|preliminary/i.test(row.interview_name ?? "") &&
          inBoundaryWindow(row.scheduled_interview_ended_at ?? row.interviewed_at ?? row.submitted_at)
      ),
    })
    offsets[bucket] = rendered.values.map(([value]) => Number(value))
  }
  return offsets
}

function renderWeeklyProgressRows(input: {
  bucket: WeeklyProgressRoleBucket
  events: readonly CandidateStageEventRow[]
  offerRows: readonly OfferLifecycleExportRow[]
  extendedOffers: readonly OfferLifecycleExportRow[]
  conductedRps: readonly ScorecardSubmissionRow[]
}): { rowLabels: readonly string[]; values: SheetCellValue[][] } {
  const countPassed = (canonical: string): number =>
    uniqueApplications(input.events.filter((row) => row.event_type === "passed" && row.core_stage === canonical))
  const valuesByLabel = new Map<string, number>([
    ["Offer Accepted", new Set(input.offerRows.filter(isAccepted).map((row) => row.offer_id)).size],
    ["Offer", new Set(input.extendedOffers.map((row) => row.offer_id)).size],
    ["Onsite Interview", countPassed("Onsite Interview")],
    ["Onsite Interviews", countPassed("Onsite Interview")],
    ["Skills Assessment", countPassed("Skills Assessment")],
    ["Manager / Tech Screen", countPassed("Manager / Tech Screen")],
    ["Hiring Manager Resume Review", countPassed("Hiring Manager Review")],
    ["Recruiter Phone Screen Conducted", new Set(input.conductedRps.map((row) => row.scorecard_id)).size],
  ])
  const rowLabels = ROWS[input.bucket]
  return { rowLabels, values: rowLabels.map((label) => [valuesByLabel.get(label) ?? 0]) }
}

function uniqueApplications(rows: readonly CandidateStageEventRow[]): number {
  return new Set(rows.map((row) => row.application_id)).size
}

function isAccepted(row: OfferLifecycleExportRow): boolean {
  return /accepted|signed|hired/i.test(row.offer_status)
}

function withinReportingWeek(value: string | null, friday: string): boolean {
  const start = Date.parse(`${friday}T00:00:00.000Z`)
  return withinWindow(value, start, start + 7 * 86_400_000)
}

function withinWindow(value: string | null, start: number, end: number): boolean {
  if (!value) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && Number.isFinite(start) && Number.isFinite(end) && timestamp >= start && timestamp < end
}
