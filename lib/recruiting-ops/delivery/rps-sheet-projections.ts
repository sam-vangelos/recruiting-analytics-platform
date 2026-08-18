import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import { resolveTeam } from "../dimensions/recruiter-team-hod"
import { legacyDeliveryRpsParityV1 } from "../dimensions/config/legacy-artifact-display.v1"
import type { ResolutionStatus } from "../../resolution-types"
import type { ScorecardSubmissionRow } from "../delivery-source/scorecard-submission"
import {
  getStagingSheetContract,
  type StagingSheetContractId,
} from "./staging-sheet-contracts"

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
const GOOGLE_SHEETS_UNIX_EPOCH_DAYS = 25_569
const CLEANED_SHEET_UTC_OFFSET_MS = legacyDeliveryRpsParityV1.cleanedSheetUtcOffsetMinutes * 60_000
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

export type StagingCell = string | number

export interface RenderedScorecardSheetRow {
  scorecardId: string
  upsertKey: string
  values: readonly StagingCell[]
  submitterTeamId: string | null
  submitterTeamName: string | null
  submitterHodName: string | null
  submitterTeamResolutionStatus: ResolutionStatus
}

export interface ExactSheetProjection {
  contractId: StagingSheetContractId
  headers: readonly string[]
  rows: readonly RenderedScorecardSheetRow[]
}

export type SubmittedScorecardExclusionReason =
  | "missing_or_invalid_submitted_at"
  | "submitted_before_period"
  | "submitted_at_or_after_period_end"

export interface SubmittedScorecardExcludedRow {
  scorecardId: string
  reason: SubmittedScorecardExclusionReason
}

export type RpsTrackingExclusionReason = SubmittedScorecardExclusionReason
export type RpsTrackingExcludedRow = SubmittedScorecardExcludedRow

export interface RpsTrackingProjection extends ExactSheetProjection {
  scope: {
    periodStartMonday: string
    submittedAtStart: string
    submittedAtEndExclusive: string
    sourceRowCount: number
    includedRowCount: number
    excludedRowCount: number
    excludedReasonCounts: Readonly<Record<SubmittedScorecardExclusionReason, number>>
  }
  /** Scorecard IDs and reasons make period exclusions auditable without exposing recruiting PII. */
  excludedRows: readonly RpsTrackingExcludedRow[]
}

export interface ProjectRpsTrackingInput {
  rows: readonly ScorecardSubmissionRow[]
  roster: readonly RecruiterTeamHodEntry[]
  /** Monday that renders as week_order=1 for this period/quarter. */
  periodStartMonday: string
  /** Inclusive submitted-at boundary used by the legacy RPS query. */
  submittedAtStart: string
  /** Exclusive submitted-at boundary for the working period/quarter. */
  submittedAtEndExclusive: string
}

export interface DeliveryRoleJobClassificationInput {
  jobId: string | null
  requisitionId: string | null
  jobName: string | null
}

export type DeliveryRoleJobPredicate = (job: DeliveryRoleJobClassificationInput) => boolean

export interface ProjectDeliveryRoleRpsInput {
  rows: readonly ScorecardSubmissionRow[]
  roster: readonly RecruiterTeamHodEntry[]
  /** Platform-owned classification; the renderer contains no requisition list. */
  isDeliveryRole: DeliveryRoleJobPredicate
  /** First submitted date in the retained daily series; renders as date_order=1. */
  dateOrderStart: string
  /** Inclusive submitted-at boundary for the current copied-report window. */
  submittedAtStart: string
  /** Exclusive submitted-at boundary for the current copied-report window. */
  submittedAtEndExclusive: string
  /** Date the daily report is produced, used for its exact tab/title contract. */
  reportDate: string
}

export interface DeliveryRpsDatedSummaryRow {
  teamName: string
  hodName: string | null
  values: readonly [string, number, number, number, number, number, number, number]
}

export interface DeliveryRpsDatedProjection {
  contractId: "delivery_rps_dated"
  sheetTitle: string
  titleCell: "A1"
  titleValue: string
  mergeRanges: readonly ["A1:N1"]
  sectionLabelCell: "A3"
  sectionLabel: "Summary by Team"
  headerRow: 4
  headers: readonly string[]
  dataStartRow: 5
  rows: readonly DeliveryRpsDatedSummaryRow[]
}

export interface DeliveryRoleRpsProjection {
  raw: ExactSheetProjection
  clean: ExactSheetProjection
  dated: DeliveryRpsDatedProjection
  scope: {
    dateOrderStart: string
    reportDate: string
    submittedAtStart: string
    submittedAtEndExclusive: string
    sourceRowCount: number
    classifiedRowCount: number
    unclassifiedRowCount: number
    includedRowCount: number
    datedIncludedRowCount: number
    excludedRowCount: number
    excludedReasonCounts: Readonly<Record<SubmittedScorecardExclusionReason, number>>
  }
  /** Only classified Delivery rows can appear here; IDs/reasons keep window exclusions auditable. */
  excludedRows: readonly SubmittedScorecardExcludedRow[]
}

interface ScopedSubmittedScorecardRows {
  submittedAtStartMs: number
  submittedAtEndExclusiveMs: number
  included: readonly { row: ScorecardSubmissionRow; reportingAt: string; reportingAtMs: number }[]
  excludedRows: readonly SubmittedScorecardExcludedRow[]
  summary: {
    submittedAtStart: string
    submittedAtEndExclusive: string
    sourceRowCount: number
    includedRowCount: number
    excludedRowCount: number
    excludedReasonCounts: Readonly<Record<SubmittedScorecardExclusionReason, number>>
  }
}

export function projectRpsTrackingSheet(input: ProjectRpsTrackingInput): RpsTrackingProjection {
  const periodStartMs = dateOnlyMs(input.periodStartMonday, "periodStartMonday")
  if (new Date(periodStartMs).getUTCDay() !== 1) {
    throw new Error("periodStartMonday must be a Monday date.")
  }
  const scoped = scopeSubmittedScorecardRows(input.rows, input.submittedAtStart, input.submittedAtEndExclusive)
  if (scoped.submittedAtStartMs < periodStartMs || scoped.submittedAtStartMs >= periodStartMs + WEEK_MS) {
    throw new Error("submittedAtStart must fall within the week anchored by periodStartMonday.")
  }

  const projection = exactProjection(
    "rps_data_dump",
    scoped.included.map(({ row, reportingAt, reportingAtMs }) =>
      renderRpsTrackingRow(row, input.roster, periodStartMs, reportingAt, reportingAtMs)
    )
  )
  return {
    ...projection,
    scope: {
      periodStartMonday: input.periodStartMonday,
      ...scoped.summary,
    },
    excludedRows: scoped.excludedRows,
  }
}

export function projectDeliveryRoleRps(input: ProjectDeliveryRoleRpsInput): DeliveryRoleRpsProjection {
  const dateOrderStartMs = dateOnlyMs(input.dateOrderStart, "dateOrderStart")
  const reportDateMs = dateOnlyMs(input.reportDate, "reportDate")
  const classified = input.rows.filter((row) => input.isDeliveryRole({
    jobId: row.job_id,
    requisitionId: row.requisition_id,
    jobName: row.job_name,
  }))
  const scoped = scopeSubmittedScorecardRows(classified, input.submittedAtStart, input.submittedAtEndExclusive)
  if (dateOrderStartMs > scoped.submittedAtStartMs) {
    throw new Error("dateOrderStart must be on or before submittedAtStart.")
  }
  if (reportDateMs < scoped.submittedAtStartMs || reportDateMs >= scoped.submittedAtEndExclusiveMs) {
    throw new Error("reportDate must fall within the submitted-at reporting window.")
  }
  const rawRendered = scoped.included.map(({ row, reportingAt, reportingAtMs }) =>
    renderDeliveryRawRpsRow(row, input.roster, dateOrderStartMs, reportingAt, reportingAtMs)
  )
  const cleanRendered = scoped.included.map(({ row, reportingAt, reportingAtMs }) =>
    renderDeliveryCleanRpsRow(row, input.roster, dateOrderStartMs, reportingAt, reportingAtMs)
  )
  const datedRendered: RenderedScorecardSheetRow[] = []
  const datedSourceRows: ScorecardSubmissionRow[] = []
  scoped.included.forEach(({ row, reportingAtMs }, index) => {
    if (dayStartMs(reportingAtMs) !== reportDateMs) return
    datedRendered.push(rawRendered[index])
    datedSourceRows.push(row)
  })
  return {
    raw: exactProjection("delivery_rps_raw", rawRendered),
    clean: exactProjection("delivery_rps_clean", cleanRendered),
    dated: renderDeliveryDatedSummary(datedRendered, datedSourceRows, reportDateMs),
    scope: {
      dateOrderStart: input.dateOrderStart,
      reportDate: input.reportDate,
      ...scoped.summary,
      sourceRowCount: input.rows.length,
      classifiedRowCount: classified.length,
      unclassifiedRowCount: input.rows.length - classified.length,
      datedIncludedRowCount: datedSourceRows.length,
    },
    excludedRows: scoped.excludedRows,
  }
}

function scopeSubmittedScorecardRows(
  rows: readonly ScorecardSubmissionRow[],
  submittedAtStart: string,
  submittedAtEndExclusive: string
): ScopedSubmittedScorecardRows {
  const submittedAtStartMs = dateOnlyMs(submittedAtStart, "submittedAtStart")
  const submittedAtEndExclusiveMs = dateOnlyMs(submittedAtEndExclusive, "submittedAtEndExclusive")
  if (submittedAtEndExclusiveMs <= submittedAtStartMs) {
    throw new Error("submittedAtEndExclusive must be after submittedAtStart.")
  }
  const included: { row: ScorecardSubmissionRow; reportingAt: string; reportingAtMs: number }[] = []
  const excludedRows: SubmittedScorecardExcludedRow[] = []
  const excludedReasonCounts: Record<SubmittedScorecardExclusionReason, number> = {
    missing_or_invalid_submitted_at: 0,
    submitted_before_period: 0,
    submitted_at_or_after_period_end: 0,
  }
  for (const row of rows) {
    // These two legacy copy-staging projections intentionally use the explicit
    // BIC compatibility clock. Other ScorecardSubmissionRow consumers continue
    // to use native submitted/interview clocks.
    const reportingAt = row.legacy_bic_reporting_at ?? row.submitted_at
    const reportingAtMs = timestampMs(reportingAt)
    if (reportingAt === null || reportingAtMs === null) {
      excludeSubmittedScorecardRow(row.scorecard_id, "missing_or_invalid_submitted_at", excludedRows, excludedReasonCounts)
      continue
    }
    if (reportingAtMs < submittedAtStartMs) {
      excludeSubmittedScorecardRow(row.scorecard_id, "submitted_before_period", excludedRows, excludedReasonCounts)
      continue
    }
    if (reportingAtMs >= submittedAtEndExclusiveMs) {
      excludeSubmittedScorecardRow(row.scorecard_id, "submitted_at_or_after_period_end", excludedRows, excludedReasonCounts)
      continue
    }
    included.push({ row, reportingAt, reportingAtMs })
  }
  return {
    submittedAtStartMs,
    submittedAtEndExclusiveMs,
    included,
    excludedRows: excludedRows.sort((left, right) => compareIds(left.scorecardId, right.scorecardId)),
    summary: {
      submittedAtStart,
      submittedAtEndExclusive,
      sourceRowCount: rows.length,
      includedRowCount: included.length,
      excludedRowCount: excludedRows.length,
      excludedReasonCounts,
    },
  }
}

function excludeSubmittedScorecardRow(
  scorecardId: string,
  reason: SubmittedScorecardExclusionReason,
  excludedRows: SubmittedScorecardExcludedRow[],
  excludedReasonCounts: Record<SubmittedScorecardExclusionReason, number>
): void {
  excludedRows.push({ scorecardId, reason })
  excludedReasonCounts[reason] += 1
}

function renderRpsTrackingRow(
  row: ScorecardSubmissionRow,
  roster: readonly RecruiterTeamHodEntry[],
  periodStartMs: number,
  reportingAt: string,
  reportingAtMs: number
): RenderedScorecardSheetRow {
  const team = resolveTeam({ recruiterName: row.submitter_name }, roster)
  const weekMondayMs = mondayMs(reportingAtMs)
  const weekOrder = oneBasedOrdinal(weekMondayMs, periodStartMs, WEEK_MS, "RPS week")
  const values: StagingCell[] = [
    blank(row.candidate_name),
    blank(row.job_name),
    blank(row.requisition_id),
    blank(row.application_status),
    row.recruiter_names.join(", "),
    row.sourcer_names.join(", "),
    blank(row.interview_name),
    blank(row.interviewer_name),
    sqlTimestamp(row.scheduled_interview_ended_at),
    sqlTimestamp(reportingAt),
    blank(row.submitter_name),
    matchDisplay(row.match_mismatch),
    MONTHS_LONG[new Date(reportingAtMs).getUTCMonth()],
    blank(team.team_name),
    weekLabel(weekMondayMs),
    weekOrder,
    blank(row.qa_summary),
    blank(row.key_takeaways),
  ]
  return renderedRow(row, values, team, reportingAt)
}

function renderDeliveryRawRpsRow(
  row: ScorecardSubmissionRow,
  roster: readonly RecruiterTeamHodEntry[],
  dateOrderStartMs: number,
  reportingAt: string,
  reportingAtMs: number
): RenderedScorecardSheetRow {
  const team = resolveTeam({ recruiterName: row.submitter_name }, roster)
  const weekMondayMs = mondayMs(reportingAtMs)
  const values: StagingCell[] = [
    blank(row.candidate_name),
    blank(row.job_name),
    blank(row.requisition_id),
    blank(row.application_status),
    row.recruiter_names.join(", "),
    row.sourcer_names.join(", "),
    blank(row.interview_name),
    blank(row.interviewer_name),
    row.scheduled_interview_ended_at ? offsetTimestamp(row.scheduled_interview_ended_at) : "∅",
    offsetTimestamp(reportingAt),
    googleDateSerial(reportingAtMs),
    oneBasedOrdinal(dayStartMs(reportingAtMs), dateOrderStartMs, DAY_MS, "Delivery RPS date"),
    blank(row.submitter_name),
    recommendationDisplay(row.overall_recommendation ?? row.candidate_rating),
    matchDisplay(row.match_mismatch),
    MONTHS_LONG[new Date(reportingAtMs).getUTCMonth()],
    blank(team.team_name),
    weekLabel(weekMondayMs),
    isoWeekNumber(weekMondayMs),
    blank(row.key_takeaways),
  ]
  return renderedRow(row, values, team, reportingAt)
}

function renderDeliveryCleanRpsRow(
  row: ScorecardSubmissionRow,
  roster: readonly RecruiterTeamHodEntry[],
  dateOrderStartMs: number,
  reportingAt: string,
  reportingAtMs: number
): RenderedScorecardSheetRow {
  const team = resolveTeam({ recruiterName: row.submitter_name }, roster)
  const weekMondayMs = mondayMs(reportingAtMs)
  const values: StagingCell[] = [
    blank(row.candidate_name),
    blank(row.job_name),
    blank(row.requisition_id),
    blank(row.application_status),
    row.recruiter_names.join(", "),
    row.sourcer_names.join(", "),
    blank(row.interview_name),
    blank(row.interviewer_name),
    legacyCleanedTimestamp(row.scheduled_interview_ended_at),
    legacyCleanedTimestamp(reportingAt),
    legacyCleanedDateString(reportingAtMs),
    oneBasedOrdinal(dayStartMs(reportingAtMs), dateOrderStartMs, DAY_MS, "Delivery RPS date"),
    blank(row.submitter_name),
    recommendationDisplay(row.overall_recommendation ?? row.candidate_rating),
    matchDisplay(row.match_mismatch),
    MONTHS_LONG[new Date(reportingAtMs).getUTCMonth()],
    blank(team.team_name),
    weekLabel(weekMondayMs),
    isoWeekNumber(weekMondayMs),
    blank(row.key_takeaways),
  ]
  return renderedRow(row, values, team, reportingAt)
}

function renderDeliveryDatedSummary(
  rendered: readonly RenderedScorecardSheetRow[],
  sourceRows: readonly ScorecardSubmissionRow[],
  reportDateMs: number
): DeliveryRpsDatedProjection {
  const byTeam = new Map<string, {
    hodName: string | null
    total: number
    match: number
    mismatch: number
    strongYes: number
    yes: number
    no: number
    other: number
  }>()
  rendered.forEach((row, index) => {
    const teamName = row.submitterTeamName ?? ""
    const counts = byTeam.get(teamName) ?? {
      hodName: row.submitterHodName,
      total: 0,
      match: 0,
      mismatch: 0,
      strongYes: 0,
      yes: 0,
      no: 0,
      other: 0,
    }
    counts.total += 1
    if (sourceRows[index].match_mismatch === "match") counts.match += 1
    else if (sourceRows[index].match_mismatch === "mismatch") counts.mismatch += 1
    const recommendation = recommendationBucket(
      sourceRows[index].overall_recommendation ?? sourceRows[index].candidate_rating
    )
    counts[recommendation] += 1
    byTeam.set(teamName, counts)
  })

  const dateToken = shortDate(reportDateMs)
  const contract = getStagingSheetContract("delivery_rps_dated")
  return {
    contractId: "delivery_rps_dated",
    sheetTitle: dateToken,
    titleCell: "A1",
    titleValue: `Recruiter Role Report - ${dateToken}`,
    mergeRanges: ["A1:N1"],
    sectionLabelCell: "A3",
    sectionLabel: "Summary by Team",
    headerRow: 4,
    headers: contract.headers,
    dataStartRow: 5,
    rows: [...byTeam.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([teamName, counts]) => ({
        teamName,
        hodName: counts.hodName,
        values: [teamName, counts.total, counts.match, counts.mismatch, counts.strongYes, counts.yes, counts.no, counts.other],
      })),
  }
}

function exactProjection(
  contractId: "rps_data_dump" | "delivery_rps_raw" | "delivery_rps_clean",
  rows: readonly RenderedScorecardSheetRow[]
): ExactSheetProjection {
  const contract = getStagingSheetContract(contractId)
  for (const row of rows) {
    if (row.values.length !== contract.headers.length) {
      throw new Error(`${contractId} renderer emitted ${row.values.length} cells for ${contract.headers.length} headers.`)
    }
  }
  return {
    contractId,
    headers: contract.headers,
    rows: [...rows].sort(compareRenderedRows),
  }
}

function renderedRow(
  row: ScorecardSubmissionRow,
  values: readonly StagingCell[],
  team: ReturnType<typeof resolveTeam>,
  reportingAt: string
): RenderedScorecardSheetRow {
  const keyParts = [row.requisition_id, reportingAt, row.submitter_name, row.interview_name]
    .map((value) => value ?? "")
  return {
    scorecardId: row.scorecard_id,
    upsertKey: keyParts.join("\u0000"),
    values,
    submitterTeamId: team.team_id,
    submitterTeamName: team.team_name,
    submitterHodName: team.hod_name,
    submitterTeamResolutionStatus: team.status,
  }
}

function compareRenderedRows(left: RenderedScorecardSheetRow, right: RenderedScorecardSheetRow): number {
  const leftSubmitted = String(left.values[9] ?? "")
  const rightSubmitted = String(right.values[9] ?? "")
  return leftSubmitted.localeCompare(rightSubmitted) || compareIds(left.scorecardId, right.scorecardId)
}

function matchDisplay(value: ScorecardSubmissionRow["match_mismatch"]): string {
  if (value === "match") return "Match"
  if (value === "mismatch") return "Mismatch"
  return ""
}

function recommendationDisplay(value: string | null): string {
  const normalized = normalizeToken(value)
  if (!normalized) return ""
  if (normalized === "strong_yes") return "Strong Yes"
  if (normalized === "yes") return "Yes"
  if (normalized === "no") return "No"
  if (normalized === "strong_no" || normalized === "definitely_not") return "Definitely Not"
  if (normalized === "mixed") return "Mixed"
  if (normalized === "no_decision") return "No Decision"
  return normalized.split("_").map(capitalize).join(" ")
}

function recommendationBucket(value: string | null): "strongYes" | "yes" | "no" | "other" {
  const normalized = normalizeToken(value)
  if (normalized === "strong_yes") return "strongYes"
  if (normalized === "yes") return "yes"
  if (normalized === "no") return "no"
  return "other"
}

function normalizeToken(value: string | null): string {
  return value?.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") ?? ""
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value
}

function blank(value: string | null): string {
  return value ?? ""
}

function sqlTimestamp(value: string | null): string {
  const timestamp = timestampMs(value)
  return timestamp === null ? "" : new Date(timestamp).toISOString().replace("T", " ").replace("Z", "")
}

function offsetTimestamp(value: string | null): string {
  const timestamp = timestampMs(value)
  return timestamp === null ? "" : new Date(timestamp).toISOString().replace("Z", "+00:00")
}

function googleDateSerial(timestamp: number): number {
  return dayStartMs(timestamp) / DAY_MS + GOOGLE_SHEETS_UNIX_EPOCH_DAYS
}

/**
 * Reproduces the manual Cleaned_RPS Date-object write: the UTC instant is
 * shifted into the legacy sheet's India-local wall clock before it is stored
 * as a Google Sheets serial. The source timestamp itself remains UTC.
 */
function legacyCleanedTimestamp(value: string | null): StagingCell {
  if (value === null) return "∅"
  const timestamp = timestampMs(value)
  if (timestamp === null) return ""
  return (timestamp + CLEANED_SHEET_UTC_OFFSET_MS) / DAY_MS + GOOGLE_SHEETS_UNIX_EPOCH_DAYS
}

/** Deterministic equivalent of Date#toString in the observed Asia/Calcutta workbook. */
function legacyCleanedDateString(timestamp: number): string {
  const date = new Date(dayStartMs(timestamp))
  return `${WEEKDAYS_SHORT[date.getUTCDay()]} ${MONTHS_SHORT[date.getUTCMonth()]} ${pad2(date.getUTCDate())} ` +
    `${date.getUTCFullYear()} 00:00:00 GMT+0530 (India Standard Time)`
}

function weekLabel(monday: number): string {
  const sunday = monday + 6 * DAY_MS
  return `${MONTHS_SHORT[new Date(monday).getUTCMonth()]} ${pad2(new Date(monday).getUTCDate())} – ${MONTHS_SHORT[new Date(sunday).getUTCMonth()]} ${pad2(new Date(sunday).getUTCDate())}`
}

function shortDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad2(date.getUTCDate())} ${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

function dateOnlyMs(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be YYYY-MM-DD.`)
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} is not a real date.`)
  }
  return timestamp
}

function timestampMs(value: string | null): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function dayStartMs(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function mondayMs(timestamp: number): number {
  const start = dayStartMs(timestamp)
  return start - ((new Date(start).getUTCDay() + 6) % 7) * DAY_MS
}

function oneBasedOrdinal(timestamp: number, start: number, interval: number, label: string): number {
  const distance = timestamp - start
  if (distance < 0 || distance % interval !== 0) {
    throw new Error(`${label} is outside or misaligned with the configured ordinal start.`)
  }
  return distance / interval + 1
}

function isoWeekNumber(monday: number): number {
  const thursday = monday + 3 * DAY_MS
  const year = new Date(thursday).getUTCFullYear()
  const januaryFourth = Date.UTC(year, 0, 4)
  const weekOneMonday = mondayMs(januaryFourth)
  return Math.floor((monday - weekOneMonday) / WEEK_MS) + 1
}

function compareIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left)
    const rightNumber = BigInt(right)
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
  }
  return left.localeCompare(right, "en-US")
}
