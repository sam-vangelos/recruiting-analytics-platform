import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import { legacyFinalOfferParityV1 } from "../dimensions/config/legacy-artifact-display.v1"
import { resolveTeam } from "../dimensions/recruiter-team-hod"
import type { OfferLifecycleExportRow } from "../delivery-source/offer-lifecycle-export"
import { FINAL_OFFER_HEADERS } from "./staging-sheet-contracts"
import type { SheetCellValue } from "./staging-value-plan"

const DAY_MS = 86_400_000
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

const EXCLUDED_APPLICATION_RECRUITERS = new Set(
  legacyFinalOfferParityV1.excludedApplicationRecruiterNames.map(normalized)
)
const EXCLUDED_JOB_NAMES = new Set(legacyFinalOfferParityV1.excludedJobNames.map(normalized))
const EXCLUDED_OFFER_STATUSES = new Set(
  legacyFinalOfferParityV1.excludedOfferStatuses.map(normalized)
)
const EXCLUDED_REJECTION_REASONS = new Set(
  legacyFinalOfferParityV1.excludedRejectionReasonNames.map(normalized)
)

export interface FinalOfferQuarterFilter {
  /** Inclusive first day of the quarter, for example 2026-07-01. */
  startDate: string
  /** Exclusive first day after the quarter, for example 2026-10-01. */
  endDateExclusive: string
}

export interface RenderedFinalOfferSheetRow {
  offerId: string
  upsertKey: string
  values: readonly SheetCellValue[]
  recruiterTeamName: string | null
  sourcerTeamName: string | null
}

export interface FinalOfferSheetProjection {
  contractId: "final_offer_master"
  headers: typeof FINAL_OFFER_HEADERS
  rows: readonly RenderedFinalOfferSheetRow[]
}

/**
 * Exact Final Offer `Mastersheet!A:AE` projection. The observed legacy ordinal
 * contract is lifecycle status order 1–5 and quarter-relative month order 1–3.
 * The source quarter and month are based on offer creation time, matching T07.
 */
export function projectFinalOfferSheet(input: {
  rows: readonly OfferLifecycleExportRow[]
  roster: readonly RecruiterTeamHodEntry[]
  quarter: FinalOfferQuarterFilter
}): FinalOfferSheetProjection {
  const quarter = parseQuarter(input.quarter)
  const seenOfferIds = new Set<string>()
  const rendered = input.rows
    .filter((row) => {
      const createdAt = timestampMs(row.created_at, "created_at")
      return createdAt >= quarter.startMs && createdAt < quarter.endMs && isInLegacyFinalOfferScope(row)
    })
    .map((row): RenderedFinalOfferSheetRow => {
      if (seenOfferIds.has(row.offer_id)) {
        throw new Error("Final Offer renderer received a duplicate offer id.")
      }
      seenOfferIds.add(row.offer_id)

      const createdAt = timestampMs(row.created_at, "created_at")
      const createdDate = new Date(createdAt)
      const recruiterTeam = resolveTeam(
        { recruiterName: row.recruiter_of_record_name },
        input.roster
      )
      const sourcerTeam = resolveTeam({ recruiterName: row.sourcer_name }, input.roster)
      const legacyStatus = legacyApplicationStatus(row)
      const values: SheetCellValue[] = [
        row.candidate_name,
        legacyStatus,
        row.application_stage,
        row.application_id,
        row.recruiter_of_record_name,
        row.rejection_reason_id,
        row.rejection_reason_name,
        row.rejection_type,
        recruiterTeam.team_name ?? "Unknown",
        row.sourcer_name,
        sourcerTeam.team_name ?? "Unknown",
        legacyCandidateSource(row),
        row.offer_status,
        row.created_at,
        row.created_by_name,
        row.sent_at,
        row.resolved_at,
        resolutionDays(row.created_at, row.resolved_at),
        row.job_name,
        row.detailed_job_title,
        row.requisition_id,
        row.job_status,
        MONTHS[createdDate.getUTCMonth()],
        offerOrder(legacyStatus),
        quarterMonthOrder(createdDate, quarter.startDate),
        row.job_level,
        row.start_date,
        row.department_name,
        row.hod_name ?? recruiterTeam.hod_name ?? "Unknown",
        row.approver_name,
        row.hiring_location,
      ]
      if (values.length !== FINAL_OFFER_HEADERS.length) {
        throw new Error(
          `Final Offer renderer emitted ${values.length} cells for ${FINAL_OFFER_HEADERS.length} headers.`
        )
      }
      return {
        offerId: row.offer_id,
        upsertKey: `${row.application_id}\u0000${row.created_at}`,
        values,
        recruiterTeamName: recruiterTeam.team_name,
        sourcerTeamName: sourcerTeam.team_name,
      }
    })
    .sort((left, right) => compareOfferIds(left.offerId, right.offerId))

  return { contractId: "final_offer_master", headers: FINAL_OFFER_HEADERS, rows: rendered }
}

function parseQuarter(filter: FinalOfferQuarterFilter): {
  startMs: number
  endMs: number
  startDate: Date
} {
  const startMs = dateOnlyMs(filter.startDate, "quarter.startDate")
  const endMs = dateOnlyMs(filter.endDateExclusive, "quarter.endDateExclusive")
  const startDate = new Date(startMs)
  const endDate = new Date(endMs)
  if (startDate.getUTCDate() !== 1 || endDate.getUTCDate() !== 1) {
    throw new Error("Final Offer quarter boundaries must be first-of-month dates.")
  }
  const monthSpan =
    (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
    endDate.getUTCMonth() -
    startDate.getUTCMonth()
  if (monthSpan !== 3 || endMs <= startMs) {
    throw new Error("Final Offer quarter must span exactly three calendar months.")
  }
  return { startMs, endMs, startDate }
}

function offerOrder(legacyStatus: string): number {
  if (legacyStatus === "Offer Created") return 1
  if (legacyStatus === "In Progress") return 2
  if (legacyStatus === "Offer Declined") return 3
  if (legacyStatus === "Offer Reneged") return 4
  if (legacyStatus === "Offer Accepted") return 5
  throw new Error("Final Offer renderer cannot assign offer_order to an unmapped application state.")
}

function legacyApplicationStatus(row: OfferLifecycleExportRow): string {
  const status = normalized(row.application_status)
  if (status === "hired") return "Offer Accepted"
  if (status === "active" || status === "in_process") {
    return row.sent_at ? "In Progress" : "Offer Created"
  }
  if (status === "rejected") {
    const direction = normalized(row.rejection_type)
    if (["they rejected us", "candidate", "candidate rejected", "candidate declined"].includes(direction)) {
      return "Offer Declined"
    }
    if (["we rejected them", "company", "company rejected", "employer"].includes(direction)) {
      return "Offer Reneged"
    }
    throw new Error("Final Offer rejected application is missing a governed rejection direction.")
  }
  throw new Error("Final Offer renderer cannot map the application status to the legacy contract.")
}

function legacyCandidateSource(row: OfferLifecycleExportRow): string | null {
  const name = row.candidate_source_name?.trim()
  const type = row.candidate_source_type?.trim()
  if (name && type) return `${name} - ${type}`
  return name || type || null
}

function isInLegacyFinalOfferScope(row: OfferLifecycleExportRow): boolean {
  return !(
    EXCLUDED_APPLICATION_RECRUITERS.has(normalized(row.application_recruiter_name)) ||
    EXCLUDED_JOB_NAMES.has(normalized(row.job_name)) ||
    EXCLUDED_OFFER_STATUSES.has(normalized(row.offer_status)) ||
    EXCLUDED_REJECTION_REASONS.has(normalized(row.rejection_reason_name))
  )
}

function normalized(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? ""
}

function quarterMonthOrder(date: Date, quarterStart: Date): number {
  const order =
    (date.getUTCFullYear() - quarterStart.getUTCFullYear()) * 12 +
    date.getUTCMonth() -
    quarterStart.getUTCMonth() +
    1
  if (order < 1 || order > 3) {
    throw new Error("Final Offer row falls outside the requested quarter.")
  }
  return order
}

function resolutionDays(createdAt: string | null, resolvedAt: string | null): number | null {
  if (!createdAt || !resolvedAt) return null
  const created = new Date(timestampMs(createdAt, "created_at"))
  const resolved = new Date(timestampMs(resolvedAt, "resolved_at"))
  const createdDay = Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate())
  const resolvedDay = Date.UTC(resolved.getUTCFullYear(), resolved.getUTCMonth(), resolved.getUTCDate())
  const days = (resolvedDay - createdDay) / DAY_MS
  if (days < 0) throw new Error("Final Offer resolved_at cannot precede created_at.")
  return days
}

function dateOnlyMs(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must be an ISO date.`)
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be an ISO date.`)
  }
  return timestamp
}

function timestampMs(value: string, field: string): number {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) throw new Error(`Final Offer ${field} must be a valid timestamp.`)
  return timestamp
}

function compareOfferIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left)
    const rightNumber = BigInt(right)
    if (leftNumber < rightNumber) return -1
    if (leftNumber > rightNumber) return 1
  }
  return left.localeCompare(right)
}
