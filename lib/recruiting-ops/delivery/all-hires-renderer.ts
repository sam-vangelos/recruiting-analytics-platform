import type { OfferLifecycleExportRow } from "../delivery-source/offer-lifecycle-export"
import type { SheetCellValue } from "./staging-value-plan"

const GOOGLE_DATE_EPOCH_MS = Date.UTC(1899, 11, 30)
const MONTH_ORDER_EPOCH_YEAR = 2025
const MONTH_ORDER_EPOCH_MONTH = 8 // September, zero-based

export interface HireDisplayDimension {
  requisitionId: string
  jobCategory: string
  jobName: string
}

export interface RenderedAllHireRow {
  upsertKey: string
  cells: readonly SheetCellValue[]
}

export interface UnmappedAllHire {
  requisitionId: string | null
  jobName: string | null
  departmentName: string | null
  acceptedDate: string | null
}

export interface AllHiresProjection {
  rows: RenderedAllHireRow[]
  /**
   * Accepted hires the display vocabulary has no entry for. They are NOT written
   * - the category and job name this sheet shows are editorial labels that no
   * Greenhouse field produces, so inventing them would be fabrication - but they
   * are reported, because a hire dropped in silence is what let this artifact
   * report a clean no-change while going stale for weeks.
   */
  unmapped: UnmappedAllHire[]
}

/** Exact `Data sheet!A:I` accepted-hire projection. */
export function projectAllHires(input: {
  offers: readonly OfferLifecycleExportRow[]
  displayDimensions: readonly HireDisplayDimension[]
}): AllHiresProjection {
  const dimensions = new Map(input.displayDimensions.map((entry) => [entry.requisitionId, entry]))
  if (dimensions.size !== input.displayDimensions.length) {
    throw new Error("All Hires display dimensions contain a duplicate requisition id.")
  }
  const accepted = input.offers.filter((offer) => isAccepted(offer))
  const unmapped = accepted
    .filter((offer) => offer.requisition_id === null || !dimensions.has(offer.requisition_id))
    .map((offer): UnmappedAllHire => ({
      requisitionId: offer.requisition_id,
      jobName: offer.job_name,
      departmentName: offer.department_name,
      acceptedDate: dateOnly(offer.resolved_at, `offer ${offer.offer_id} resolved_at`),
    }))
  return { rows: renderAllHiresRows(input), unmapped }
}

/** Exact `Data sheet!A:I` accepted-hire projection. */
export function renderAllHiresRows(input: {
  offers: readonly OfferLifecycleExportRow[]
  displayDimensions: readonly HireDisplayDimension[]
}): RenderedAllHireRow[] {
  const dimensions = new Map(input.displayDimensions.map((entry) => [entry.requisitionId, entry]))
  if (dimensions.size !== input.displayDimensions.length) {
    throw new Error("All Hires display dimensions contain a duplicate requisition id.")
  }
  return input.offers
    .filter((offer) => isAccepted(offer) && offer.requisition_id !== null && dimensions.has(offer.requisition_id))
    .map((offer): RenderedAllHireRow => {
      const dimension = dimensions.get(offer.requisition_id!)!
      const acceptedDate = dateOnly(offer.resolved_at, `offer ${offer.offer_id} resolved_at`)
      if (!acceptedDate) throw new Error(`Accepted offer ${offer.offer_id} is missing resolved_at.`)
      if (!offer.candidate_name) throw new Error(`Accepted offer ${offer.offer_id} is missing candidate_name.`)
      const startDate = dateOnly(offer.start_date, `offer ${offer.offer_id} start_date`)
      return {
        upsertKey: offer.offer_id,
        cells: [
          dimension.jobCategory,
          dimension.jobName,
          offer.candidate_name,
          googleDateSerial(acceptedDate),
          monthLabel(acceptedDate),
          monthOrder(acceptedDate),
          startDate ? googleDateSerial(startDate) : null,
          startDate ? monthLabel(startDate) : null,
          startDate ? monthOrder(startDate) : null,
        ],
      }
    })
    .sort((left, right) => {
      const leftDate = Number(left.cells[3])
      const rightDate = Number(right.cells[3])
      return leftDate - rightDate || left.upsertKey.localeCompare(right.upsertKey)
    })
}

function isAccepted(offer: OfferLifecycleExportRow): boolean {
  return /accepted|signed|hired/i.test(offer.offer_status)
}

function dateOnly(value: string | null, field: string): string | null {
  if (!value) return null
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(timestamp)) throw new Error(`${field} must be a valid date.`)
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function googleDateSerial(isoDate: string): number {
  const timestamp = Date.parse(`${isoDate}T00:00:00.000Z`)
  if (Number.isNaN(timestamp)) throw new Error("Google date serial requires an ISO date.")
  return (timestamp - GOOGLE_DATE_EPOCH_MS) / 86_400_000
}

export function monthLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(date)
}

export function monthOrder(isoDate: string): number {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  return (
    (date.getUTCFullYear() - MONTH_ORDER_EPOCH_YEAR) * 12 +
    (date.getUTCMonth() - MONTH_ORDER_EPOCH_MONTH) +
    1
  )
}
