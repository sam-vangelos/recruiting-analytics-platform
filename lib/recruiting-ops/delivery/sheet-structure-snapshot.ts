import { createHash } from "node:crypto"

import { createPayloadFingerprint, stableSerialize } from "../checksums"
import type { GoogleSheet, GoogleSpreadsheet } from "./google-workspace-staging-client"

const SHEET_STRUCTURE_CELL_SELECTOR =
  "rowData(values(userEnteredValue(formulaValue),userEnteredFormat,textFormatRuns,dataValidation,pivotTable))"

export const SHEET_STRUCTURE_METADATA_FIELDS = [
  "spreadsheetId",
  "properties(title,locale,timeZone)",
  "namedRanges(namedRangeId,name,range)",
  "sheets(properties(sheetId,title,index,sheetType,gridProperties))",
  "sheets(merges,conditionalFormats,filterViews,basicFilter,protectedRanges,charts,slicers,bandedRanges,rowGroups,columnGroups)",
].join(",")

export const SHEET_STRUCTURE_COLUMN_METADATA_FIELDS =
  "sheets(properties(sheetId),data(startColumn,columnMetadata))"

export const SHEET_STRUCTURE_CELL_FIELDS =
  `sheets(properties(sheetId),data(startRow,startColumn,rowMetadata,${SHEET_STRUCTURE_CELL_SELECTOR}))`

/**
 * Retained for raw, bounded structural-observer reads. Large value-hydration
 * workbooks must use readStagingSheetStructureSnapshot, which requests this
 * same field set in bounded ranges rather than one response.
 */
export const SHEET_STRUCTURE_FIELDS = [
  SHEET_STRUCTURE_METADATA_FIELDS,
  `sheets(data(startRow,startColumn,rowMetadata,columnMetadata,${SHEET_STRUCTURE_CELL_SELECTOR}))`,
].join(",")

/** Upper bound used for each read-only grid-data response. */
export const SHEET_STRUCTURE_MAX_CELLS_PER_READ = 100_000

/**
 * A bounded, non-reversible representation of a structural collection.
 * `count` makes empty/duplicate membership explicit; `fingerprint` covers each
 * member without retaining formulas, validation literals, editor identities,
 * or per-cell format objects in the returned snapshot.
 */
export interface StructuralCollectionFingerprint {
  count: number
  fingerprint: string
}

export interface SheetStructureSnapshot {
  spreadsheetId: string | null
  properties: StructuralCollectionFingerprint
  namedRanges: StructuralCollectionFingerprint
  sheets: readonly SheetStructureEntry[]
  structureHash: string
}

export interface SheetStructureEntry {
  sheetId: number | null
  index: number | null
  properties: StructuralCollectionFingerprint
  merges: StructuralCollectionFingerprint
  conditionalFormats: StructuralCollectionFingerprint
  filterViews: StructuralCollectionFingerprint
  basicFilter: StructuralCollectionFingerprint
  protectedRanges: StructuralCollectionFingerprint
  charts: StructuralCollectionFingerprint
  slicers: StructuralCollectionFingerprint
  bandedRanges: StructuralCollectionFingerprint
  rowGroups: StructuralCollectionFingerprint
  columnGroups: StructuralCollectionFingerprint
  dimensionMetadata: StructuralCollectionFingerprint
  pivotTables: StructuralCollectionFingerprint
  dataValidations: StructuralCollectionFingerprint
  formulas: StructuralCollectionFingerprint
  cellFormats: StructuralCollectionFingerprint
  textFormatRuns: StructuralCollectionFingerprint
}

export interface SheetStructureSnapshotOptions {
  /**
   * Exact grid coordinates whose full-cell link URI is projected out of the
   * cell-format fingerprint. Every other format field at those coordinates,
   * and every field at every other coordinate, remains structural.
   */
  valueCoupledAutoLinkCoordinates?: ReadonlySet<string>
  /**
   * Sheets may materialize the workbook's default font alongside a newly
   * detected full-cell URL link. When supplied, only this exact family/size
   * pair is projected out at the exact value-coupled coordinates above. All
   * other text-format fields (bold, color, a different font/size, and so on)
   * remain structural and therefore fail the post-write comparison.
   */
  valueCoupledAutoLinkMaterializedDefaultTextFormat?: Readonly<{
    fontFamily: string
    fontSize: number
  }>
  /**
   * Exact report-owned cells whose user-entered format is verified by a
   * dedicated renderer instead of the generic workbook-form hash. Formula,
   * validation, note, pivot, and text-run structure at the same coordinates
   * remains covered by the generic hash.
   */
  valueOwnedFormatRanges?: readonly SheetStructureCellRange[]
}

export interface SheetStructureCellRange {
  sheetId: number
  startRowIndex: number
  endRowIndex: number
  startColumnIndex: number
  endColumnIndex: number
}

export function sheetStructureCellCoordinateKey(
  sheetId: number,
  rowIndex: number,
  columnIndex: number
): string {
  return `${sheetId}:${rowIndex}:${columnIndex}`
}

/**
 * Captures form, never literal cell values. A value-only hydration therefore
 * leaves this hash unchanged; tabs, formulas, pivots, filters, validation,
 * protections, charts, merges, ranges, order, or grid size do not.
 *
 * Cell-scale collections are folded incrementally into fixed row buckets and
 * then count + SHA-256 summaries. This makes the result independent of API
 * response chunking, bounds memory/string size, and lets live callers stream a
 * workbook whose complete grid-data JSON exceeds V8's string limit.
 */
export function buildSheetStructureSnapshot(
  spreadsheet: GoogleSpreadsheet,
  options: SheetStructureSnapshotOptions = {}
): SheetStructureSnapshot {
  const accumulator = new SheetStructureSnapshotAccumulator(spreadsheet, options)
  for (const sheet of spreadsheet.sheets ?? []) {
    const sheetId = requiredSheetId(sheet)
    accumulator.addSheetGridData(sheetId, sheet.data ?? [])
  }
  return accumulator.finish()
}

/** Incremental counterpart used by bounded Google Sheets range reads. */
export class SheetStructureSnapshotAccumulator {
  private readonly spreadsheetId: string | null
  private readonly properties: StructuralCollectionFingerprint
  private readonly namedRanges: StructuralCollectionFingerprint
  private readonly sheetsById = new Map<number, MutableSheetStructureEntry>()
  private finished = false

  constructor(
    metadata: GoogleSpreadsheet,
    options: SheetStructureSnapshotOptions = {}
  ) {
    this.spreadsheetId = metadata.spreadsheetId ?? null
    this.properties = fingerprintUnordered(metadata.properties ? [metadata.properties] : [])
    this.namedRanges = fingerprintUnordered(metadata.namedRanges ?? [])
    const valueCoupledAutoLinkCoordinates = new Set(
      options.valueCoupledAutoLinkCoordinates ?? []
    )
    const valueOwnedFormatRanges = (options.valueOwnedFormatRanges ?? []).map(
      validateSheetStructureCellRange
    )
    for (const sheet of metadata.sheets ?? []) {
      const sheetId = requiredSheetId(sheet)
      if (this.sheetsById.has(sheetId)) throw new Error(`Duplicate Google Sheet id in structure metadata: ${sheetId}`)
      this.sheetsById.set(
        sheetId,
        new MutableSheetStructureEntry(
          sheet,
          valueCoupledAutoLinkCoordinates,
          valueOwnedFormatRanges.filter((range) => range.sheetId === sheetId),
          options.valueCoupledAutoLinkMaterializedDefaultTextFormat
        )
      )
    }
  }

  addSheetGridData(sheetId: number, grids: readonly NonNullable<GoogleSheet["data"]>[number][]): void {
    if (this.finished) throw new Error("Cannot add grid data after the structure snapshot is finished.")
    const sheet = this.sheetsById.get(sheetId)
    if (!sheet) throw new Error(`Grid data referenced unknown Google Sheet id: ${sheetId}`)
    sheet.addGridData(grids)
  }

  finish(): SheetStructureSnapshot {
    if (this.finished) throw new Error("Sheet structure snapshot accumulator can only be finished once.")
    this.finished = true
    const body = {
      spreadsheetId: this.spreadsheetId,
      properties: this.properties,
      namedRanges: this.namedRanges,
      sheets: [...this.sheetsById.values()].map((sheet) => sheet.finish()).sort(compareSheetEntries),
    }
    return { ...body, structureHash: createPayloadFingerprint(body) }
  }
}

export function sheetStructureRowsPerRead(columnCount: number): number {
  if (!Number.isInteger(columnCount) || columnCount <= 0) {
    throw new Error("Google Sheet structure requires a positive integer column count.")
  }
  return Math.max(1, Math.floor(SHEET_STRUCTURE_MAX_CELLS_PER_READ / columnCount))
}

type GridFeatureName =
  | "dimensionMetadata"
  | "pivotTables"
  | "dataValidations"
  | "formulas"
  | "cellFormats"
  | "textFormatRuns"

const GRID_FEATURE_NAMES: readonly GridFeatureName[] = [
  "dimensionMetadata",
  "pivotTables",
  "dataValidations",
  "formulas",
  "cellFormats",
  "textFormatRuns",
]

class MutableSheetStructureEntry {
  private readonly sheetId: number
  private readonly index: number | null
  private readonly columnCount: number
  private readonly staticCollections: Omit<
    SheetStructureEntry,
    "sheetId" | "index" | GridFeatureName
  >
  private readonly featureBuckets = new Map<
    GridFeatureName,
    Map<number, StructuralCollectionAccumulator>
  >()
  private readonly valueCoupledAutoLinkCoordinates: ReadonlySet<string>
  private readonly valueOwnedFormatRanges: readonly SheetStructureCellRange[]
  private readonly valueCoupledAutoLinkMaterializedDefaultTextFormat?: Readonly<{
    fontFamily: string
    fontSize: number
  }>
  private finished = false

  constructor(
    sheet: GoogleSheet,
    valueCoupledAutoLinkCoordinates: ReadonlySet<string>,
    valueOwnedFormatRanges: readonly SheetStructureCellRange[],
    valueCoupledAutoLinkMaterializedDefaultTextFormat?: Readonly<{
      fontFamily: string
      fontSize: number
    }>
  ) {
    this.sheetId = requiredSheetId(sheet)
    this.index = sheet.properties?.index ?? null
    this.columnCount = requiredColumnCount(sheet)
    this.valueCoupledAutoLinkCoordinates = valueCoupledAutoLinkCoordinates
    this.valueOwnedFormatRanges = valueOwnedFormatRanges
    this.valueCoupledAutoLinkMaterializedDefaultTextFormat =
      valueCoupledAutoLinkMaterializedDefaultTextFormat
    this.staticCollections = {
      properties: fingerprintUnordered(sheet.properties ? [sheet.properties] : []),
      merges: fingerprintUnordered(sheet.merges ?? []),
      conditionalFormats: fingerprintUnordered(sheet.conditionalFormats ?? []),
      filterViews: fingerprintUnordered(sheet.filterViews ?? []),
      basicFilter: fingerprintUnordered(sheet.basicFilter ? [sheet.basicFilter] : []),
      protectedRanges: fingerprintUnordered(sheet.protectedRanges ?? []),
      charts: fingerprintUnordered(sheet.charts ?? []),
      slicers: fingerprintUnordered(sheet.slicers ?? []),
      bandedRanges: fingerprintUnordered(sheet.bandedRanges ?? []),
      rowGroups: fingerprintUnordered(sheet.rowGroups ?? []),
      columnGroups: fingerprintUnordered(sheet.columnGroups ?? []),
    }
    for (const feature of GRID_FEATURE_NAMES) this.featureBuckets.set(feature, new Map())
  }

  addGridData(grids: readonly NonNullable<GoogleSheet["data"]>[number][]): void {
    if (this.finished) throw new Error("Cannot add grid data after the sheet structure entry is finished.")
    for (const grid of [...grids].sort(compareGridData)) this.addGridBlock(grid)
  }

  finish(): SheetStructureEntry {
    if (this.finished) throw new Error("Sheet structure entry can only be finished once.")
    this.finished = true
    return {
      sheetId: this.sheetId,
      index: this.index,
      ...this.staticCollections,
      dimensionMetadata: this.finishFeature("dimensionMetadata"),
      pivotTables: this.finishFeature("pivotTables"),
      dataValidations: this.finishFeature("dataValidations"),
      formulas: this.finishFeature("formulas"),
      cellFormats: this.finishFeature("cellFormats"),
      textFormatRuns: this.finishFeature("textFormatRuns"),
    }
  }

  private addGridBlock(grid: NonNullable<GoogleSheet["data"]>[number]): void {
    const startRow = grid.startRow ?? 0
    const startColumn = grid.startColumn ?? 0
    for (const [rowOffset, metadata] of (grid.rowMetadata ?? []).entries()) {
      if (hasStructuralContent(metadata)) {
        const rowIndex = startRow + rowOffset
        this.addFeature("dimensionMetadata", rowIndex, {
          axis: "row",
          index: rowIndex,
          metadata,
        })
      }
    }
    for (const [columnOffset, metadata] of (grid.columnMetadata ?? []).entries()) {
      if (hasStructuralContent(metadata)) {
        // Column metadata is independent of row chunks and occupies a reserved
        // bucket so it is requested exactly once per sheet.
        this.addFeature("dimensionMetadata", -1, {
          axis: "column",
          index: startColumn + columnOffset,
          metadata,
        })
      }
    }
    for (const [rowOffset, row] of (grid.rowData ?? []).entries()) {
      const rowIndex = startRow + rowOffset
      for (const [columnOffset, cell] of (row.values ?? []).entries()) {
        const coordinate = {
          rowIndex,
          columnIndex: startColumn + columnOffset,
        }
        if (hasStructuralContent(cell.pivotTable)) {
          this.addFeature("pivotTables", rowIndex, { ...coordinate, pivotTable: cell.pivotTable })
        }
        if (hasStructuralContent(cell.dataValidation)) {
          this.addFeature("dataValidations", rowIndex, { ...coordinate, rule: cell.dataValidation })
        }
        const formula = cell.userEnteredValue?.formulaValue
        if (typeof formula === "string") {
          this.addFeature("formulas", rowIndex, { ...coordinate, formula })
        }
        const format = this.valueOwnedFormatRanges.some((range) =>
          coordinateInStructureRange(rowIndex, coordinate.columnIndex, range)
        )
          ? undefined
          : this.valueCoupledAutoLinkCoordinates.has(
              sheetStructureCellCoordinateKey(this.sheetId, rowIndex, coordinate.columnIndex)
            )
            ? withoutValueCoupledAutoLinkMaterialization(
                cell.userEnteredFormat,
                this.valueCoupledAutoLinkMaterializedDefaultTextFormat
              )
            : cell.userEnteredFormat
        if (hasStructuralContent(format)) {
          this.addFeature("cellFormats", rowIndex, { ...coordinate, format })
        }
        if ((cell.textFormatRuns?.length ?? 0) > 0) {
          this.addFeature("textFormatRuns", rowIndex, { ...coordinate, runs: cell.textFormatRuns })
        }
      }
    }
  }

  private addFeature(feature: GridFeatureName, rowIndex: number, value: unknown): void {
    const bucketIndex = rowIndex < 0 ? -1 : Math.floor(rowIndex / sheetStructureRowsPerRead(this.columnCount))
    const buckets = this.featureBuckets.get(feature)
    if (!buckets) throw new Error(`Unknown structure feature: ${feature}`)
    let bucket = buckets.get(bucketIndex)
    if (!bucket) {
      bucket = new StructuralCollectionAccumulator()
      buckets.set(bucketIndex, bucket)
    }
    bucket.add(value)
  }

  private finishFeature(feature: GridFeatureName): StructuralCollectionFingerprint {
    const buckets = this.featureBuckets.get(feature)
    if (!buckets) throw new Error(`Unknown structure feature: ${feature}`)
    const combined = new StructuralCollectionAccumulator()
    let count = 0
    for (const [bucketIndex, bucket] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const summary = bucket.finish()
      count += summary.count
      combined.add({ bucketIndex, ...summary })
    }
    return { count, fingerprint: combined.finish().fingerprint }
  }
}

class StructuralCollectionAccumulator {
  private readonly hash = createHash("sha256")
  private itemCount = 0

  add(value: unknown): void {
    const serialized = stableSerialize(value)
    // Length framing prevents concatenation ambiguity while allowing the hash
    // to consume one small structural member at a time.
    this.hash.update(`${Buffer.byteLength(serialized, "utf8")}:`, "utf8")
    this.hash.update(serialized, "utf8")
    this.itemCount += 1
  }

  finish(): StructuralCollectionFingerprint {
    return {
      count: this.itemCount,
      fingerprint: `sha256:${this.hash.digest("hex")}`,
    }
  }
}

function fingerprintUnordered(values: readonly unknown[]): StructuralCollectionFingerprint {
  const memberFingerprints = values.map((value) => createPayloadFingerprint(value)).sort()
  const accumulator = new StructuralCollectionAccumulator()
  for (const fingerprint of memberFingerprints) accumulator.add(fingerprint)
  return accumulator.finish()
}

function compareSheetEntries(a: SheetStructureEntry, b: SheetStructureEntry): number {
  const byIndex = (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER)
  if (byIndex !== 0) return byIndex
  return (a.sheetId ?? Number.MAX_SAFE_INTEGER) - (b.sheetId ?? Number.MAX_SAFE_INTEGER)
}

function compareGridData(
  a: NonNullable<GoogleSheet["data"]>[number],
  b: NonNullable<GoogleSheet["data"]>[number]
): number {
  const byRow = (a.startRow ?? 0) - (b.startRow ?? 0)
  if (byRow !== 0) return byRow
  return (a.startColumn ?? 0) - (b.startColumn ?? 0)
}

function requiredSheetId(sheet: GoogleSheet): number {
  const sheetId = sheet.properties?.sheetId
  if (!Number.isInteger(sheetId)) throw new Error("Google Sheet structure is missing a numeric sheet id.")
  return sheetId as number
}

function requiredColumnCount(sheet: GoogleSheet): number {
  const columnCount = sheet.properties?.gridProperties?.columnCount
  if (!Number.isInteger(columnCount) || (columnCount as number) <= 0) {
    throw new Error(`Google Sheet ${requiredSheetId(sheet)} is missing a positive grid column count.`)
  }
  return columnCount as number
}

function hasStructuralContent(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0
  return true
}

function withoutValueCoupledAutoLinkMaterialization(
  value: unknown,
  materializedDefaultTextFormat?: Readonly<{
    fontFamily: string
    fontSize: number
  }>
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const format = structuredClone(value) as Record<string, unknown>
  const textFormat = recordOrNull(format.textFormat)
  const link = recordOrNull(textFormat?.link)
  if (!textFormat) return value

  if (link && typeof link.uri === "string") {
    delete link.uri
    if (Object.keys(link).length === 0) delete textFormat.link
  }
  if (
    materializedDefaultTextFormat &&
    textFormat.fontFamily === materializedDefaultTextFormat.fontFamily &&
    textFormat.fontSize === materializedDefaultTextFormat.fontSize
  ) {
    delete textFormat.fontFamily
    delete textFormat.fontSize
  }
  if (Object.keys(textFormat).length === 0) delete format.textFormat
  return format
}

function validateSheetStructureCellRange(
  range: SheetStructureCellRange
): SheetStructureCellRange {
  if (
    !Number.isInteger(range.sheetId) || range.sheetId < 0 ||
    !Number.isInteger(range.startRowIndex) || range.startRowIndex < 0 ||
    !Number.isInteger(range.endRowIndex) || range.endRowIndex <= range.startRowIndex ||
    !Number.isInteger(range.startColumnIndex) || range.startColumnIndex < 0 ||
    !Number.isInteger(range.endColumnIndex) || range.endColumnIndex <= range.startColumnIndex
  ) {
    throw new Error("Sheet structure value-owned format range is invalid.")
  }
  return { ...range }
}

function coordinateInStructureRange(
  rowIndex: number,
  columnIndex: number,
  range: SheetStructureCellRange
): boolean {
  return rowIndex >= range.startRowIndex && rowIndex < range.endRowIndex &&
    columnIndex >= range.startColumnIndex && columnIndex < range.endColumnIndex
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
