import { classifyReq, fridayWeekLabels, type ReqClass } from "../exec-definitions"
import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import {
  customFieldValue,
  type HarvestDepartmentRecord,
  type HarvestJobOwnerRecord,
  type HarvestJobRecord,
  type HarvestOfferRecord,
  type HarvestOpeningRecord,
  type HarvestUserRecord,
} from "../extractors/greenhouse-harvest-read-adapter"

const DAY_MS = 86_400_000

export type ReqWeekAudienceScope = "team_visible" | "full_internal_only"

/**
 * Artifact-independent, platform-owned row at reporting-week x requisition
 * grain. Human-owned spreadsheet columns are deliberately absent.
 */
export interface ReqWeekReportRow {
  upsertKey: string
  reportingWeekFriday: string
  reportingWeekEnd: string
  reportingWeekLabel: string
  jobId: string
  requisitionId: string
  jobName: string
  jobStatus: string
  closedDate: string | null
  department: string
  location: string | null
  headcountOpen: number
  headcountClosed: number
  offerExtended: number
  signed: number
  declined: number
  /** Legacy sheet column P ("Joined"): accepted offers in the loaded source horizon. */
  acceptedOffers: number
  earliestOpeningDate: string | null
  daysOpen: number | null
  recruiters: readonly string[]
  recruiterTeams: readonly string[]
  sourcers: readonly string[]
  hiringManagers: readonly string[]
  hods: readonly string[]
  jobUrl: string
  reqClass: ReqClass
  audienceScope: ReqWeekAudienceScope
  audienceReason: string
}

export interface BuildReqWeekReportRowsInput {
  reportingWeekFriday: string
  asOf: string
  jobs: readonly HarvestJobRecord[]
  openings: readonly HarvestOpeningRecord[]
  jobOwners: readonly HarvestJobOwnerRecord[]
  users: readonly HarvestUserRecord[]
  departments: readonly HarvestDepartmentRecord[]
  offers: readonly HarvestOfferRecord[]
  roster: readonly RecruiterTeamHodEntry[]
}

/**
 * Produces the queried Weekly Recruitment fields from governed platform
 * sources. Manual fields (Billable, Priority, Health, Progress, Comments and
 * Role Type) are intentionally not representable here, so a renderer cannot
 * accidentally overwrite them.
 */
export function buildReqWeekReportRows(input: BuildReqWeekReportRowsInput): ReqWeekReportRow[] {
  const weekStartMs = parseDateOnly(input.reportingWeekFriday, "reportingWeekFriday")
  const weekEndExclusiveMs = weekStartMs + 7 * DAY_MS
  const asOfMs = parseTimestamp(input.asOf, "asOf")
  const weekEnd = new Date(weekEndExclusiveMs - DAY_MS).toISOString().slice(0, 10)
  const labels = fridayWeekLabels(input.reportingWeekFriday)

  const departmentById = new Map(
    input.departments
      .map((department) => [idOf(department.id), textOf(department.name)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1]))
  )
  const userById = new Map(
    input.users
      .map((user) => [idOf(user.id), personName(user)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1]))
  )
  const rosterByName = new Map(input.roster.map((entry) => [normalizeName(entry.recruiterName), entry]))
  const ownersByJob = groupBy(input.jobOwners, (owner) => idOf(owner.job_id))
  const openingsByJob = groupBy(input.openings, (opening) => idOf(opening.job_id))
  const offersByJob = groupBy(input.offers, (offer) => idOf(offer.job_id ?? offer.job?.id))

  return input.jobs
    .map((job): ReqWeekReportRow | null => {
      const jobId = idOf(job.id)
      const requisitionId = idOf(job.requisition_id)
      const jobName = textOf(job.name)
      if (!jobId || !requisitionId || !jobName) return null

      const openings = openingsByJob.get(jobId) ?? []
      const offers = offersByJob.get(jobId) ?? []
      const owners = ownersByJob.get(jobId) ?? []
      const recruiters = ownerNames(owners, "recruiter", userById)
      const sourcers = ownerNames(owners, "sourcer", userById)
      const hiringManagers = uniqueSorted([
        ...ownerNames(owners, "hiring_manager", userById),
        ...splitNames(customFieldValue(job.custom_fields, "hiring manager")),
        ...splitNames(customFieldValue(job.custom_fields, "supervisor")),
      ])
      const rosterRows = recruiters
        .map((name) => rosterByName.get(normalizeName(name)))
        .filter((entry): entry is RecruiterTeamHodEntry => Boolean(entry))
      const reqClass = classifyReq({ name: jobName, isTemplate: job.is_template }).reqClass
      const department =
        (job.department_id != null ? departmentById.get(String(job.department_id)) : undefined) ??
        textOf(job.departments?.[0]?.name) ??
        "Unassigned"
      const audience = audienceOf({ jobName, department, confidential: job.confidential === true, reqClass })
      const openedDates = openings
        .map((opening) => dateOnlyOf(opening.opened_at))
        .filter((value): value is string => Boolean(value))
        .sort()
      const jobOpenedDate = dateOnlyOf(job.opened_at)
      const earliestOpeningDate = openedDates[0] ?? jobOpenedDate
      const offerCounts = countWeeklyOffers(offers, weekStartMs, weekEndExclusiveMs)
      const closedDate = dateOnlyOf(job.closed_at)
      const daysOpenEndMs = closedDate === null
        ? asOfMs
        : Math.min(asOfMs, parseDateOnly(closedDate, "closed date"))

      return {
        upsertKey: `${input.reportingWeekFriday}|${requisitionId}`,
        reportingWeekFriday: input.reportingWeekFriday,
        reportingWeekEnd: weekEnd,
        reportingWeekLabel: labels.weekShort,
        jobId,
        requisitionId,
        jobName,
        jobStatus: textOf(job.status) ?? "unknown",
        closedDate,
        department,
        location:
          customFieldValue(job.custom_fields, "hiring location(s)") ??
          customFieldValue(job.custom_fields, "hiring location") ??
          customFieldValue(job.custom_fields, "location") ??
          null,
        headcountOpen: openings.filter(isOpenOpening).length || numericCount(job.openings_count),
        headcountClosed: openings.filter((opening) => !isOpenOpening(opening)).length,
        ...offerCounts,
        acceptedOffers: offers.filter(isAcceptedOffer).length,
        earliestOpeningDate,
        daysOpen: earliestOpeningDate === null
          ? null
          : Math.max(
              0,
              Math.floor(
                (daysOpenEndMs - parseDateOnly(earliestOpeningDate, "opening date")) /
                  DAY_MS
              )
            ),
        recruiters,
        recruiterTeams: uniqueSorted(rosterRows.map((entry) => entry.teamName)),
        sourcers,
        hiringManagers,
        hods: uniqueSorted(rosterRows.map((entry) => entry.hodName)),
        // Preserve the legacy workbook's canonical Greenhouse job link. The
        // dashboard route is keyed by the Greenhouse job id, not the req id.
        jobUrl: `https://app4.greenhouse.io/sdash/${jobId}`,
        reqClass,
        audienceScope: audience.scope,
        audienceReason: audience.reason,
      }
    })
    .filter((row): row is ReqWeekReportRow => Boolean(row))
    .sort((a, b) => Number(a.requisitionId) - Number(b.requisitionId) || a.requisitionId.localeCompare(b.requisitionId))
}

function countWeeklyOffers(
  offers: readonly HarvestOfferRecord[],
  weekStartMs: number,
  weekEndExclusiveMs: number
): Pick<ReqWeekReportRow, "offerExtended" | "signed" | "declined"> {
  let offerExtended = 0
  let signed = 0
  let declined = 0
  for (const offer of offers) {
    const createdMs = timestampMs(offer.created_at)
    const resolvedMs = timestampMs(offer.resolved_at)
    if (createdMs !== null && createdMs >= weekStartMs && createdMs < weekEndExclusiveMs) offerExtended += 1
    if (resolvedMs === null || resolvedMs < weekStartMs || resolvedMs >= weekEndExclusiveMs) continue
    if (isAcceptedOffer(offer)) signed += 1
    else if (isDeclinedOffer(offer)) declined += 1
  }
  return { offerExtended, signed, declined }
}

function audienceOf(input: {
  jobName: string
  department: string
  confidential: boolean
  reqClass: ReqClass
}): { scope: ReqWeekAudienceScope; reason: string } {
  if (input.confidential || /confidential/i.test(input.department)) {
    return { scope: "full_internal_only", reason: "confidential job or department" }
  }
  if (/delivery|fulfillment/i.test(`${input.jobName} ${input.department}`)) {
    return { scope: "full_internal_only", reason: "delivery or fulfillment req" }
  }
  if (/central hiring platform/i.test(input.jobName)) {
    return { scope: "full_internal_only", reason: "central-hiring platform holding req" }
  }
  if (input.reqClass !== "role") {
    return { scope: "full_internal_only", reason: `${input.reqClass} requisition` }
  }
  return { scope: "team_visible", reason: "team-visible role" }
}

function ownerNames(
  owners: readonly HarvestJobOwnerRecord[],
  type: string,
  userById: ReadonlyMap<string, string>
): string[] {
  return uniqueSorted(
    owners
      .filter((owner) => normalizeOwnerType(owner.type) === type)
      .map((owner) => (owner.user_id == null ? undefined : userById.get(String(owner.user_id))))
      .filter((name): name is string => Boolean(name))
  )
}

function normalizeOwnerType(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
}

function isOpenOpening(opening: HarvestOpeningRecord): boolean {
  return opening.open !== false && (opening.status ?? "").toLowerCase() !== "closed"
}

function isAcceptedOffer(offer: HarvestOfferRecord): boolean {
  return /accepted|signed|hired/i.test(textOf(offer.status ?? offer.offer_status ?? offer.state) ?? "")
}

function isDeclinedOffer(offer: HarvestOfferRecord): boolean {
  return /declined|rejected|withdrawn/i.test(textOf(offer.status ?? offer.offer_status ?? offer.state) ?? "")
}

function numericCount(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : 0
}

function parseDateOnly(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be an ISO date`)
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be an ISO date`)
  return timestamp
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be a valid timestamp`)
  return timestamp
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function dateOnlyOf(value: string | null | undefined): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString().slice(0, 10)
}

function personName(person: { name?: string; first_name?: string; last_name?: string }): string | undefined {
  return textOf(person.name) ?? textOf([person.first_name, person.last_name].filter(Boolean).join(" "))
}

function splitNames(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;|]/)
    .map((name) => name.trim())
    .filter(Boolean)
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

function textOf(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text || undefined
}

function idOf(value: unknown): string | undefined {
  return textOf(value)
}

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string | undefined): ReadonlyMap<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    const group = grouped.get(key)
    if (group) group.push(row)
    else grouped.set(key, [row])
  }
  return grouped
}
