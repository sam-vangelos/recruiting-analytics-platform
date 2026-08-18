import type { RenderedAllHireRow } from "./all-hires-renderer"
import type {
  FinalOfferQuarterFilter,
  FinalOfferSheetProjection,
} from "./final-offer-sheet-renderer"
import {
  FINAL_OFFER_HEADERS,
  getStagingSheetContract,
  type StagingSheetContractId,
} from "./staging-sheet-contracts"
import type { SheetCellValue } from "./staging-value-plan"

const GOOGLE_DATE_EPOCH_MS = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000

export interface BoundedStagingValueRangeInput {
  rangeId: StagingSheetContractId
  a1Range: string
  currentValues: readonly (readonly SheetCellValue[])[]
  desiredValues: readonly (readonly SheetCellValue[])[]
}

export interface FinalOfferBoundedValueInput {
  range: BoundedStagingValueRangeInput & { rangeId: "final_offer_master" }
  preservedHistoryRowCount: number
  replacedQuarterRowCount: number
  staleQuarterRowCount: number
  clearedTrailingRowCount: number
}

export interface AllHiresOfferRowBinding {
  offerId: string
  sheetRow: number
  action: "corrected" | "appended"
}

export interface AllHiresBoundedValueInput {
  range: BoundedStagingValueRangeInput & { rangeId: "all_hires_data" }
  preservedExistingRowCount: number
  correctedRowCount: number
  appendedRowCount: number
  offerRowBindings: readonly AllHiresOfferRowBinding[]
}

/**
 * Full-replaces only the requested quarter inside Mastersheet A:AE. Rows whose
 * creation time is outside that quarter are preserved byte-for-byte (apart from
 * rectangular null padding). A shorter post-state is padded with blank rows so
 * stale quarter values are explicitly cleared inside the bounded preimage.
 */
export function buildFinalOfferBoundedValueInput(input: {
  currentValues: readonly (readonly SheetCellValue[])[]
  projection: FinalOfferSheetProjection
  quarter: FinalOfferQuarterFilter
}): FinalOfferBoundedValueInput {
  assertProjectionHeaders(input.projection)
  const contract = getStagingSheetContract("final_offer_master")
  const width = contract.headers.length
  const current = currentDataRows(input.currentValues, contract.headers, width, "Final Offer")
  const quarter = quarterBounds(input.quarter)
  const seenCurrentKeys = new Set<string>()
  const history: SheetCellValue[][] = []
  const currentQuarterKeys: string[] = []

  for (const row of current) {
    if (isBlankRow(row)) continue
    const identity = finalOfferIdentity(row, "current Final Offer row")
    if (seenCurrentKeys.has(identity.key)) {
      throw new Error("Final Offer current data contains a duplicate application/created-at key.")
    }
    seenCurrentKeys.add(identity.key)
    if (identity.createdAtMs >= quarter.startMs && identity.createdAtMs < quarter.endMs) {
      currentQuarterKeys.push(identity.key)
    } else {
      history.push(row)
    }
  }

  const seenOfferIds = new Set<string>()
  const seenProjectionKeys = new Set<string>()
  const projectedRows = [...input.projection.rows]
    .sort((left, right) => compareIds(left.offerId, right.offerId))
    .map((projected) => {
      if (seenOfferIds.has(projected.offerId)) {
        throw new Error("Final Offer projection contains a duplicate offer id.")
      }
      seenOfferIds.add(projected.offerId)
      const row = normalizeRow(projected.values, width, "Final Offer projected row")
      const identity = finalOfferIdentity(row, "projected Final Offer row")
      if (identity.createdAtMs < quarter.startMs || identity.createdAtMs >= quarter.endMs) {
        throw new Error("Final Offer projection contains a row outside the replacement quarter.")
      }
      if (projected.upsertKey !== `${identity.applicationId}\u0000${String(row[13])}`) {
        throw new Error("Final Offer projection upsert key does not match its A:AE values.")
      }
      if (seenProjectionKeys.has(identity.key)) {
        throw new Error("Final Offer projection contains a duplicate application/created-at key.")
      }
      seenProjectionKeys.add(identity.key)
      return row
    })

  const desired = [...history, ...projectedRows]
  const bounded = boundedRange({
    rangeId: "final_offer_master",
    sheetTitle: contract.sheetTitle,
    endColumn: "AE",
    width,
    current,
    desired,
  })
  return {
    range: bounded.range,
    preservedHistoryRowCount: history.length,
    replacedQuarterRowCount: currentQuarterKeys.length,
    staleQuarterRowCount: currentQuarterKeys.filter((key) => !seenProjectionKeys.has(key)).length,
    clearedTrailingRowCount: bounded.clearedTrailingRowCount,
  }
}

/**
 * Incrementally reconciles All Hires A:I. The sheet has no offer-id column, so
 * an offer can correct an existing row only when candidate + accepted date has
 * exactly one match. Unmatched legacy history is never deleted or reordered.
 */
export function buildAllHiresBoundedValueInput(input: {
  currentValues: readonly (readonly SheetCellValue[])[]
  projectedRows: readonly RenderedAllHireRow[]
}): AllHiresBoundedValueInput {
  const contract = getStagingSheetContract("all_hires_data")
  const width = contract.headers.length
  const current = currentDataRows(input.currentValues, contract.headers, width, "All Hires")
  const desired = current.map((row) => [...row])
  const existingByNaturalKey = new Map<string, number[]>()
  const invalidDateCandidates = new Set<string>()

  current.forEach((row, index) => {
    if (isBlankRow(row)) return
    const candidate = normalizedText(row[2])
    if (!candidate) return
    const acceptedDate = acceptedDateSerial(row[3])
    if (acceptedDate === null) {
      invalidDateCandidates.add(candidate)
      return
    }
    const key = `${candidate}\u0000${acceptedDate}`
    const indexes = existingByNaturalKey.get(key) ?? []
    indexes.push(index)
    existingByNaturalKey.set(key, indexes)
  })

  const seenOfferIds = new Set<string>()
  const seenProjectedNaturalKeys = new Set<string>()
  const normalizedProjection = [...input.projectedRows]
    .sort(compareProjectedHires)
    .map((projected) => {
      const offerId = projected.upsertKey.trim()
      if (!offerId) throw new Error("All Hires projection requires an offer id.")
      if (seenOfferIds.has(offerId)) throw new Error("All Hires projection contains a duplicate offer id.")
      seenOfferIds.add(offerId)
      const row = normalizeRow(projected.cells, width, "All Hires projected row")
      const candidate = normalizedText(row[2])
      const acceptedDate = acceptedDateSerial(row[3])
      if (!candidate || acceptedDate === null) {
        throw new Error("All Hires projected row requires candidate and accepted date identity.")
      }
      const naturalKey = `${candidate}\u0000${acceptedDate}`
      if (seenProjectedNaturalKeys.has(naturalKey)) {
        throw new Error("All Hires projection has ambiguous offers for one candidate/accepted date.")
      }
      seenProjectedNaturalKeys.add(naturalKey)
      return { offerId, row, candidate, naturalKey, acceptedDate }
    })

  const bindings: AllHiresOfferRowBinding[] = []
  let correctedRowCount = 0
  for (const projected of normalizedProjection) {
    if (invalidDateCandidates.has(projected.candidate)) {
      throw new Error("All Hires current data has an ambiguous candidate row with an invalid accepted date.")
    }
    const matches = existingByNaturalKey.get(projected.naturalKey) ?? []
    if (matches.length > 1) {
      throw new Error("All Hires current data has ambiguous candidate/accepted-date matches.")
    }
    const existingIndex = matches[0]
    if (existingIndex !== undefined) {
      desired[existingIndex] = projected.row
      correctedRowCount += 1
      bindings.push({ offerId: projected.offerId, sheetRow: existingIndex + 2, action: "corrected" })
    } else {
      desired.push(projected.row)
      bindings.push({ offerId: projected.offerId, sheetRow: desired.length + 1, action: "appended" })
    }
  }

  const bounded = boundedRange({
    rangeId: "all_hires_data",
    sheetTitle: contract.sheetTitle,
    endColumn: "I",
    width,
    current,
    desired,
  })
  return {
    range: bounded.range,
    preservedExistingRowCount: current.length,
    correctedRowCount,
    appendedRowCount: normalizedProjection.length - correctedRowCount,
    offerRowBindings: bindings,
  }
}

function assertProjectionHeaders(projection: FinalOfferSheetProjection): void {
  if (projection.contractId !== "final_offer_master") {
    throw new Error("Final Offer projection has the wrong range contract.")
  }
  if (
    projection.headers.length !== FINAL_OFFER_HEADERS.length ||
    projection.headers.some((header, index) => header !== FINAL_OFFER_HEADERS[index])
  ) {
    throw new Error("Final Offer projection headers do not match the A:AE contract.")
  }
}

function currentDataRows(
  values: readonly (readonly SheetCellValue[])[],
  headers: readonly string[],
  width: number,
  label: string
): SheetCellValue[][] {
  if (values[0] && rowMatchesHeaders(values[0], headers)) {
    throw new Error(`${label} currentValues must exclude the protected header row.`)
  }
  const normalized = values.map((row) => normalizeRow(row, width, `${label} current row`))
  let end = normalized.length
  while (end > 0 && isBlankRow(normalized[end - 1])) end -= 1
  return normalized.slice(0, end)
}

function normalizeRow(
  row: readonly SheetCellValue[],
  width: number,
  label: string
): SheetCellValue[] {
  if (row.length > width) throw new Error(`${label} exceeds its designated data width.`)
  return Array.from({ length: width }, (_, index) => row[index] ?? null)
}

function finalOfferIdentity(
  row: readonly SheetCellValue[],
  label: string
): { key: string; applicationId: string; createdAtMs: number } {
  const applicationId = idText(row[3])
  if (!applicationId) throw new Error(`${label} is missing application_id.`)
  const createdAtMs = sheetTimestampMs(row[13])
  if (createdAtMs === null) throw new Error(`${label} has an invalid created_at.`)
  return { key: `${applicationId}\u0000${createdAtMs}`, applicationId, createdAtMs }
}

function quarterBounds(quarter: FinalOfferQuarterFilter): { startMs: number; endMs: number } {
  const startMs = isoDateMs(quarter.startDate, "Final Offer quarter start")
  const endMs = isoDateMs(quarter.endDateExclusive, "Final Offer quarter end")
  const start = new Date(startMs)
  const end = new Date(endMs)
  const monthSpan =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    start.getUTCMonth()
  if (start.getUTCDate() !== 1 || end.getUTCDate() !== 1 || monthSpan !== 3) {
    throw new Error("Final Offer replacement quarter must span three whole calendar months.")
  }
  return { startMs, endMs }
}

function boundedRange<TRangeId extends "final_offer_master" | "all_hires_data">(input: {
  rangeId: TRangeId
  sheetTitle: string
  endColumn: "AE" | "I"
  width: number
  current: readonly (readonly SheetCellValue[])[]
  desired: readonly (readonly SheetCellValue[])[]
}): {
  range: BoundedStagingValueRangeInput & {
    rangeId: TRangeId
  }
  clearedTrailingRowCount: number
} {
  const rowCount = Math.max(1, input.current.length, input.desired.length)
  const blank = (): SheetCellValue[] => Array<SheetCellValue>(input.width).fill(null)
  const currentValues = Array.from({ length: rowCount }, (_, index) =>
    input.current[index] ? [...input.current[index]] : blank()
  )
  const desiredValues = Array.from({ length: rowCount }, (_, index) =>
    input.desired[index] ? [...input.desired[index]] : blank()
  )
  return {
    range: {
      rangeId: input.rangeId,
      a1Range: `'${input.sheetTitle.replaceAll("'", "''")}'!A2:${input.endColumn}${rowCount + 1}`,
      currentValues,
      desiredValues,
    },
    clearedTrailingRowCount: Math.max(0, input.current.length - input.desired.length),
  }
}

function acceptedDateSerial(value: SheetCellValue): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null
    return String(value)
  }
  if (typeof value !== "string") return null
  const text = value.trim()
  if (/^\d+$/.test(text)) return String(Number(text))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const timestamp = isoDateMs(text, "All Hires accepted date")
  return String((timestamp - GOOGLE_DATE_EPOCH_MS) / DAY_MS)
}

function sheetTimestampMs(value: SheetCellValue): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null
    return GOOGLE_DATE_EPOCH_MS + value * DAY_MS
  }
  if (typeof value !== "string" || !value.trim()) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function isoDateMs(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be an ISO date.`)
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be an ISO date.`)
  }
  return timestamp
}

function compareProjectedHires(left: RenderedAllHireRow, right: RenderedAllHireRow): number {
  const leftDate = acceptedDateSerial(left.cells[3])
  const rightDate = acceptedDateSerial(right.cells[3])
  if (leftDate === null || rightDate === null) return left.upsertKey.localeCompare(right.upsertKey)
  return Number(leftDate) - Number(rightDate) || compareIds(left.upsertKey, right.upsertKey)
}

function compareIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left)
    const rightNumber = BigInt(right)
    if (leftNumber < rightNumber) return -1
    if (leftNumber > rightNumber) return 1
  }
  return left.localeCompare(right)
}

function normalizedText(value: SheetCellValue): string | null {
  if (typeof value !== "string") return value === null ? null : String(value)
  const text = value.trim().replace(/\s+/g, " ").toLowerCase()
  return text || null
}

function idText(value: SheetCellValue): string | null {
  if (value === null) return null
  const text = String(value).trim()
  return text || null
}

function isBlankRow(row: readonly SheetCellValue[]): boolean {
  return row.every((value) => value === null || (typeof value === "string" && value.trim() === ""))
}

function rowMatchesHeaders(row: readonly SheetCellValue[], headers: readonly string[]): boolean {
  return (
    row.length >= headers.length &&
    headers.every((header, index) => String(row[index] ?? "").trim() === header)
  )
}
