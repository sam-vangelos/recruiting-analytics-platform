import { beforeEach, describe, expect, test, vi } from "vitest"
import type { sheets_v4 } from "googleapis"

import { PII_FINGERPRINT_SALT_ENV } from "../lib/recruiting-ops/checksums"
import {
  StagingSheetValueWriteExecutionError,
  writeStagingSheetValues,
  type GoogleSpreadsheet,
  type GoogleWorkspaceStagingClients,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { buildSheetStructureSnapshot } from "../lib/recruiting-ops/delivery/sheet-structure-snapshot"
import {
  getStagingArtifact,
  STAGING_HYDRATION_ENABLED_AT_ENV,
  STAGING_HYDRATION_EXPIRES_AT_ENV,
  STAGING_HYDRATION_GLOBAL_FLAG,
} from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import type { StagingSheetContractId } from "../lib/recruiting-ops/delivery/staging-sheet-contracts"
import { buildStagingSheetValuePlan } from "../lib/recruiting-ops/delivery/staging-value-plan"
import type { SheetCellValue } from "../lib/recruiting-ops/delivery/staging-value-plan"
import type { StagingWritePermit } from "../lib/recruiting-ops/delivery/staging-write-permit"

function allHiresDateFormatResponse() {
  return {
    spreadsheetId: getStagingArtifact("all_hires").artifactId,
    sheets: [{
      properties: { sheetId: 1_324_142_221, title: "Data sheet" },
      data: [{
        startRow: 0,
        startColumn: 0,
        rowData: Array.from({ length: 400 }, () => ({
          values: Array.from({ length: 9 }, () => ({
            userEnteredFormat: { numberFormat: { type: "DATE", pattern: "mmm d, yyyy" } },
          })),
        })),
      }],
    }],
  }
}

function structure(
  title = "Data sheet",
  cells?: readonly (readonly TypedCell[])[]
): GoogleSpreadsheet {
  const artifact = getStagingArtifact("all_hires")
  return {
    spreadsheetId: artifact.artifactId,
    properties: { title: "Copy of All Hires", locale: "en_US", timeZone: "UTC" },
    sheets: [
      {
        properties: {
          sheetId: 1324142221,
          title,
          index: 0,
          sheetType: "GRID",
          gridProperties: { rowCount: 1009, columnCount: 29 },
        },
        ...(cells
          ? {
              data: [{
                startRow: 1,
                startColumn: 0,
                rowData: cells.map((row) => ({ values: row.map(cloneCell) })),
              }],
            }
          : {}),
      },
    ],
  }
}

type TypedCell = sheets_v4.Schema$CellData

interface FixtureBatchUpdateOutcome {
  apply: boolean
  error?: Error
}

interface FixturePlanRange {
  rangeId: StagingSheetContractId
  a1Range: string
  currentValues: readonly (readonly SheetCellValue[])[]
  desiredValues: readonly (readonly SheetCellValue[])[]
  startRowIndex: number
  startColumnIndex: number
}

function fixture(options: {
  beforeStructure?: GoogleSpreadsheet
  currentValues?: readonly (readonly SheetCellValue[])[]
  desiredValues?: readonly (readonly SheetCellValue[])[]
  typedPreimage?: readonly (readonly TypedCell[])[]
  typedVerificationCells?: readonly (readonly TypedCell[])[]
  postStructures?: readonly GoogleSpreadsheet[]
  driveVersions?: readonly string[]
  batchUpdateOutcomes?: readonly FixtureBatchUpdateOutcome[]
  planRanges?: readonly FixturePlanRange[]
} = {}) {
  const before = options.beforeStructure ?? structure()
  const structureHash = buildSheetStructureSnapshot(before).structureHash
  const current = options.currentValues ?? [["old"]]
  const desired = options.desiredValues ?? [["new"]]
  const width = current[0]?.length ?? 0
  const height = current.length
  if (width === 0 || desired.length !== height || desired.some((row) => row.length !== width)) {
    throw new Error("Writer test fixture requires equal non-empty matrix shapes.")
  }
  const endColumn = String.fromCharCode(64 + width)
  const planRanges: readonly FixturePlanRange[] = options.planRanges ?? [{
    rangeId: "all_hires_data",
    a1Range: `'Data sheet'!A2:${endColumn}${height + 1}`,
    currentValues: current,
    desiredValues: desired,
    startRowIndex: 1,
    startColumnIndex: 0,
  }]
  const plan = buildStagingSheetValuePlan({
    artifactKey: "all_hires",
    runId: "hydration_20260711120000000",
    sourceGeneratedAt: "2026-07-11T12:00:00.000Z",
    structureHash,
    dataProvenance: "live",
    ranges: planRanges.map((range) => ({
      rangeId: range.rangeId,
      a1Range: range.a1Range,
      currentValues: range.currentValues,
      desiredValues: range.desiredValues,
    })),
  })
  const artifact = getStagingArtifact("all_hires")
  const env = {
    [STAGING_HYDRATION_GLOBAL_FLAG]: "true",
    [artifact.hydrationFlag]: "true",
    [STAGING_HYDRATION_ENABLED_AT_ENV]: "2026-07-11T12:00:00.000Z",
    [STAGING_HYDRATION_EXPIRES_AT_ENV]: "2026-07-11T12:10:00.000Z",
  }
  const permit: StagingWritePermit = {
    artifactKey: "all_hires",
    artifactId: artifact.artifactId,
    kind: "google_sheet",
    runId: plan.runId,
    issuedAt: "2026-07-11T12:00:10.000Z",
    expiresAt: "2026-07-11T12:10:10.000Z",
    sourceGeneratedAt: plan.sourceGeneratedAt,
    payloadFingerprint: plan.payloadFingerprint,
    structureHash: plan.structureHash,
    approvedRangeIds: plan.approvedRangeIds,
    killSwitchStoreReachable: true,
    killSwitchClear: true,
    canonicalOnly: true,
  }

  let structureReads = 0
  let activeStructure = before
  let driveVersion = 10
  let driveMetadataReads = 0
  let batchUpdateCalls = 0
  let typedVerificationReads = 0
  const initialCells = (options.typedPreimage ?? current.map((row) => row.map(cellFromScalar)))
    .map((row) => row.map(cloneCell))
  const cells = initialCells.map((row) => row.map(cloneCell))
  const formulaEffectiveValues = new Map<string, sheets_v4.Schema$ExtendedValue | undefined>()
  for (const row of initialCells) {
    for (const cell of row) {
      const formula = cell.userEnteredValue?.formulaValue
      if (formula !== undefined && formula !== null) {
        formulaEffectiveValues.set(formula, cloneExtendedValue(cell.effectiveValue))
      }
    }
  }
  const valuesBatchUpdate = vi.fn()
  const spreadsheetsBatchUpdate = vi.fn(async (request: {
    spreadsheetId?: string
    requestBody?: { requests?: readonly sheets_v4.Schema$Request[] }
  }) => {
    if (request.spreadsheetId !== artifact.artifactId) throw new Error("Unexpected write target.")
    const outcome = options.batchUpdateOutcomes?.[batchUpdateCalls]
    batchUpdateCalls += 1
    if (outcome?.apply !== false) {
      for (const mutation of request.requestBody?.requests ?? []) {
        applyTypedMutation(cells, mutation, formulaEffectiveValues)
      }
      driveVersion += 1
    }
    if (outcome?.error) throw outcome.error
    return { data: {} }
  })
  const typedResponse = (verification = false) => {
    const responseCells = verification && options.typedVerificationCells
      ? options.typedVerificationCells
      : cells
    return {
      spreadsheetId: artifact.artifactId,
      sheets: [{
        properties: { sheetId: 1324142221, title: activeStructure.sheets?.[0]?.properties?.title ?? "Data sheet" },
        data: planRanges.map((range) => ({
          startRow: range.startRowIndex,
          startColumn: range.startColumnIndex,
          rowData: range.currentValues.map((row, rowOffset) => ({
            values: row.map((_, columnOffset) => cloneCell(
              responseCells[range.startRowIndex - 1 + rowOffset]?.[
                range.startColumnIndex + columnOffset
              ] ?? {}
            )),
          })),
        })),
      }],
    }
  }
  const clients = {
    drive: {
      files: {
        get: vi.fn(async () => {
          const scriptedVersion = options.driveVersions?.[
            Math.min(driveMetadataReads, Math.max((options.driveVersions?.length ?? 1) - 1, 0))
          ]
          driveMetadataReads += 1
          return {
            data: {
              id: artifact.artifactId,
              version: scriptedVersion ?? String(driveVersion),
              capabilities: { canEdit: true, canModifyContent: true },
            },
          }
        }),
      },
    },
    docs: {},
    sheets: {
      spreadsheets: {
        get: vi.fn(async (request: { ranges?: readonly string[]; fields?: string }) => {
          // The append-date-format gap read: answer with the owned
          // date columns already rendering dates, so gaps = 0 and the write
          // stays exactly the value mutation these cases exercise. The
          // formats-missing case gets its own dedicated test.
          if (request.fields?.includes("userEnteredFormat.numberFormat") === true) {
            return { data: allHiresDateFormatResponse() }
          }
          if ((request.ranges?.length ?? 0) > 0) return { data: typedResponse() }
          activeStructure = structureReads === 0
            ? before
            : (options.postStructures?.[structureReads - 1] ?? options.postStructures?.at(-1) ?? before)
          structureReads += 1
          return { data: activeStructure }
        }),
        getByDataFilter: vi.fn(async (request: { fields?: string }) => {
          const isTypedVerification = request.fields?.includes("effectiveValue") === true
          if (isTypedVerification) typedVerificationReads += 1
          return { data: isTypedVerification ? typedResponse(true) : activeStructure }
        }),
        batchUpdate: spreadsheetsBatchUpdate,
        values: {
          batchGet: vi.fn(),
          batchUpdate: valuesBatchUpdate,
        },
      },
    },
  } as unknown as GoogleWorkspaceStagingClients
  return {
    plan,
    permit,
    env,
    clients,
    currentTimeMs: () => Date.parse("2026-07-11T12:01:00.000Z"),
    revalidateKillSwitchClear: vi.fn(async () => {}),
    spreadsheetsBatchUpdate,
    valuesBatchUpdate,
    cells: () => cells.map((row) => row.map(cloneCell)),
    typedVerificationReads: () => typedVerificationReads,
  }
}

function cellFromScalar(value: SheetCellValue): TypedCell {
  if (value === null || value === "") return {}
  const userEnteredValue = typeof value === "string"
    ? { stringValue: value }
    : typeof value === "number"
      ? { numberValue: value }
      : { boolValue: value }
  return { userEnteredValue, effectiveValue: { ...userEnteredValue } }
}

function unmaskedFixtureCellFields(): TypedCell {
  return {
    userEnteredFormat: {
      backgroundColor: { red: 0.25 },
      textFormat: { bold: true },
    },
    note: "preserved fixture note",
    dataValidation: {
      condition: { type: "NUMBER_GREATER", values: [{ userEnteredValue: "0" }] },
      strict: true,
    },
    textFormatRuns: [],
    chipRuns: [{ startIndex: 0, chip: {} }],
  }
}

function cloneExtendedValue(
  value: sheets_v4.Schema$ExtendedValue | null | undefined
): sheets_v4.Schema$ExtendedValue | undefined {
  return value === undefined || value === null ? undefined : structuredClone(value)
}

function cloneCell(cell: TypedCell): TypedCell {
  return structuredClone(cell)
}

function withReplacedTypedValue(
  cell: TypedCell | undefined,
  userEnteredValue: sheets_v4.Schema$ExtendedValue | undefined,
  effectiveValue: sheets_v4.Schema$ExtendedValue | undefined
): TypedCell {
  const next = cloneCell(cell ?? {})
  delete next.userEnteredValue
  delete next.effectiveValue
  if (userEnteredValue !== undefined) next.userEnteredValue = userEnteredValue
  if (effectiveValue !== undefined) next.effectiveValue = effectiveValue
  return next
}

function applyTypedMutation(
  cells: TypedCell[][],
  request: sheets_v4.Schema$Request,
  formulaEffectiveValues: ReadonlyMap<string, sheets_v4.Schema$ExtendedValue | undefined>
): void {
  if (request.repeatCell) {
    const range = request.repeatCell.range
    // Append-date-format requests touch display only, never the
    // typed values this matrix models.
    if (request.repeatCell.fields === "userEnteredFormat.numberFormat") return
    if (request.repeatCell.fields !== "userEnteredValue") throw new Error("Unexpected repeatCell mask.")
    for (let row = range?.startRowIndex ?? 0; row < (range?.endRowIndex ?? 0); row += 1) {
      for (let column = range?.startColumnIndex ?? 0; column < (range?.endColumnIndex ?? 0); column += 1) {
        cells[row - 1][column] = withReplacedTypedValue(
          cells[row - 1][column],
          undefined,
          undefined
        )
      }
    }
    return
  }
  if (request.updateCells) {
    if (request.updateCells.fields === "userEnteredFormat.numberFormat") return
    if (request.updateCells.fields !== "userEnteredValue") throw new Error("Unexpected updateCells mask.")
    if (request.updateCells.range && (request.updateCells.rows?.length ?? 0) === 0) {
      const range = request.updateCells.range
      for (let row = range.startRowIndex ?? 0; row < (range.endRowIndex ?? 0); row += 1) {
        for (let column = range.startColumnIndex ?? 0; column < (range.endColumnIndex ?? 0); column += 1) {
          cells[row - 1][column] = withReplacedTypedValue(
            cells[row - 1][column],
            undefined,
            undefined
          )
        }
      }
      return
    }
    const startRow = request.updateCells.start?.rowIndex ?? 0
    const startColumn = request.updateCells.start?.columnIndex ?? 0
    for (const [rowOffset, row] of (request.updateCells.rows ?? []).entries()) {
      for (const [columnOffset, cell] of (row.values ?? []).entries()) {
        const entered = cloneExtendedValue(cell.userEnteredValue)
        const formula = entered?.formulaValue
        const rowIndex = startRow + rowOffset - 1
        const columnIndex = startColumn + columnOffset
        cells[rowIndex][columnIndex] = withReplacedTypedValue(
          cells[rowIndex][columnIndex],
          entered,
          typeof formula === "string"
            ? cloneExtendedValue(formulaEffectiveValues.get(formula))
            : cloneExtendedValue(entered)
        )
      }
    }
    return
  }
  throw new Error("Unexpected typed staging mutation request.")
}

async function withFakeConsistencyTimers<T>(operation: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  try {
    const settled = operation().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    )
    await vi.runAllTimersAsync()
    const result = await settled
    if (result.status === "rejected") throw result.reason
    return result.value
  } finally {
    vi.useRealTimers()
  }
}

describe("guarded Google Workspace staging writer", () => {
  beforeEach(() => {
    process.env[PII_FINGERPRINT_SALT_ENV] = "writer-test-hmac-key"
  })

  test("writes one approved copy range and proves the post-state", async () => {
    const value = fixture()
    const summary = await writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })
    expect(summary).toMatchObject({
      status: "written",
      mutationCallCount: 1,
      changedRangeCount: 1,
      structureCertification: "exact",
    })
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
    expect(value.valuesBatchUpdate).not.toHaveBeenCalled()
    expect(value.spreadsheetsBatchUpdate.mock.calls[0][0]).toMatchObject({
      spreadsheetId: getStagingArtifact("all_hires").artifactId,
      requestBody: {
        includeSpreadsheetInResponse: false,
        requests: [{
          updateCells: {
            start: { sheetId: 1324142221, rowIndex: 1, columnIndex: 0 },
            rows: [{ values: [{ userEnteredValue: { stringValue: "new" } }] }],
            fields: "userEnteredValue",
          },
        }],
      },
    })
  })

  test("carries the date format with the serial into an unformatted All Hires runway and self-heals it", async () => {
    // Field defect: the first automation-appended row rendered as 46241 beside
    // human rows reading "Jul 14, 2026", because appended rows land below the
    // last hand-formatted row. The write must publish the number format in the
    // same batch as the value, over exactly the written rows, and certify that
    // no date cell is left unable to render afterwards.
    const value = fixture()
    const get = value.clients.sheets.spreadsheets.get as ReturnType<typeof vi.fn>
    const original = get.getMockImplementation() as (
      request: { ranges?: readonly string[]; fields?: string }
    ) => Promise<unknown>
    let formatReads = 0
    get.mockImplementation(async (request: { ranges?: readonly string[]; fields?: string }) => {
      if (request.fields?.includes("userEnteredFormat.numberFormat") === true) {
        formatReads += 1
        // Before the mutation the runway has no formats (the row 40 state);
        // after it, the batch's repeatCells have landed.
        return formatReads === 1
          ? {
              data: {
                spreadsheetId: getStagingArtifact("all_hires").artifactId,
                sheets: [{
                  properties: { sheetId: 1_324_142_221, title: "Data sheet" },
                  data: [{ startRow: 0, startColumn: 0, rowData: [] }],
                }],
              },
            }
          : { data: allHiresDateFormatResponse() }
      }
      return original(request)
    })

    const summary = await writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })
    expect(summary).toMatchObject({
      status: "written",
      mutationCallCount: 1,
      structureCertification: "exact_value_owned_format",
    })
    expect(formatReads).toBe(2)
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
    const requests = value.spreadsheetsBatchUpdate.mock.calls[0]![0].requestBody!.requests as {
      repeatCell?: {
        range?: Record<string, number>
        cell?: { userEnteredFormat?: { numberFormat?: Record<string, string> } }
        fields?: string
      }
    }[]
    const formatWrites = requests.filter((request) =>
      (request as { updateCells?: { fields?: string } }).updateCells?.fields === "userEnteredFormat.numberFormat"
    ) as { updateCells: { start: Record<string, number>; rows: { values: { userEnteredFormat?: { numberFormat?: Record<string, string> } }[] }[]; fields: string } }[]
    // Accepted Date (D) and Start Date (G), rows limited to exactly what the
    // plan writes (one data row anchored at row index 1), format matching the
    // human rows, field mask narrowed to the number format alone. updateCells,
    // never repeatCell - Google silently drops repeatCell on this file.
    expect(formatWrites.map((request) => request.updateCells.start)).toEqual([
      { sheetId: 1_324_142_221, rowIndex: 1, columnIndex: 3 },
      { sheetId: 1_324_142_221, rowIndex: 1, columnIndex: 6 },
    ])
    for (const request of formatWrites) {
      expect(request.updateCells.rows).toHaveLength(1)
      expect(request.updateCells.rows[0]!.values[0]!.userEnteredFormat?.numberFormat).toEqual({
        type: "DATE",
        pattern: "mmm d, yyyy",
      })
    }
  })

  test("anchors format requests at the write's own window, not the top of the sheet", async () => {
    // The 2026-08-13 live failure: All Hires' bounded write covered rows
    // 36..41, but the format projection assumed row 2, formatted six top rows
    // Sheets then re-quoted, and certification failed on its own mis-anchored
    // window. The requests must follow the write's A1 anchor.
    const preserved = Array.from({ length: 4 }, (_, index) => [`keep${index}`])
    // The typed matrix is indexed by absolute grid row; pad rows 0..34 so a
    // window anchored at grid row 35 resolves its own preimage cells.
    const typedPreimage = [
      ...Array.from({ length: 34 }, () => [{ userEnteredValue: { stringValue: "pad" }, effectiveValue: { stringValue: "pad" } }]),
      ...preserved.map((row) => row.map((valueText) => ({
        userEnteredValue: { stringValue: valueText },
        effectiveValue: { stringValue: valueText },
      }))),
    ]
    const value = fixture({
      currentValues: preserved.map((row) => [...row]),
      desiredValues: preserved.map((row, index) => (index >= 2 ? [`new${index}`] : [...row])),
      typedPreimage,
      planRanges: [{
        rangeId: "all_hires_data",
        a1Range: "'Data sheet'!A36:A39",
        currentValues: preserved,
        desiredValues: preserved.map((row, index) => (index >= 2 ? [`new${index}`] : [...row])),
        startRowIndex: 35,
        startColumnIndex: 0,
      }],
    })
    const get = value.clients.sheets.spreadsheets.get as ReturnType<typeof vi.fn>
    const original = get.getMockImplementation() as (
      request: { ranges?: readonly string[]; fields?: string }
    ) => Promise<unknown>
    let formatReads = 0
    const formatRanges: string[][] = []
    get.mockImplementation(async (request: { ranges?: readonly string[]; fields?: string }) => {
      if (request.fields?.includes("userEnteredFormat.numberFormat") === true) {
        formatReads += 1
        formatRanges.push([...(request.ranges ?? [])])
        return formatReads === 1
          ? {
              data: {
                spreadsheetId: getStagingArtifact("all_hires").artifactId,
                sheets: [{
                  properties: { sheetId: 1_324_142_221, title: "Data sheet" },
                  data: [{ startRow: 35, startColumn: 3, rowData: [] }],
                }],
              },
            }
          : {
              data: {
                spreadsheetId: getStagingArtifact("all_hires").artifactId,
                sheets: [{
                  properties: { sheetId: 1_324_142_221, title: "Data sheet" },
                  data: [3, 6].map((column) => ({
                    startRow: 35,
                    startColumn: column,
                    rowData: Array.from({ length: 4 }, () => ({
                      // Sheets' canonical re-quoted storage of the same display.
                      values: [{ userEnteredFormat: { numberFormat: { type: "DATE", pattern: 'mmm" "d", "yyyy' } } }],
                    })),
                  })),
                }],
              },
            }
      }
      return original(request)
    })

    const summary = await writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })
    // Certification accepts the canonicalized pattern, and the requests target
    // exactly the written window rows 36..39 (grid [35, 39)).
    expect(summary).toMatchObject({ status: "written", structureCertification: "exact_value_owned_format" })
    const requests = value.spreadsheetsBatchUpdate.mock.calls[0]![0].requestBody!.requests as {
      updateCells?: { start?: Record<string, number>; rows?: unknown[]; fields?: string }
    }[]
    const formatWrites = requests.filter(
      (request) => request.updateCells?.fields === "userEnteredFormat.numberFormat"
    )
    expect(formatWrites.map((request) => request.updateCells?.start)).toEqual([
      { sheetId: 1_324_142_221, rowIndex: 35, columnIndex: 3 },
      { sheetId: 1_324_142_221, rowIndex: 35, columnIndex: 6 },
    ])
    expect(formatWrites.every((request) => request.updateCells?.rows?.length === 4)).toBe(true)
    expect(formatRanges[0]).toEqual(["'Data sheet'!D36:D39", "'Data sheet'!G36:G39"])
  })

  test("fails certification when a date cell still cannot render after the write", async () => {
    const value = fixture()
    const get = value.clients.sheets.spreadsheets.get as ReturnType<typeof vi.fn>
    const original = get.getMockImplementation() as (
      request: { ranges?: readonly string[]; fields?: string }
    ) => Promise<unknown>
    get.mockImplementation(async (request: { ranges?: readonly string[]; fields?: string }) => {
      if (request.fields?.includes("userEnteredFormat.numberFormat") === true) {
        // Unformatted before AND after: the batch's format writes did not land.
        return {
          data: {
            spreadsheetId: getStagingArtifact("all_hires").artifactId,
            sheets: [{
              properties: { sheetId: 1_324_142_221, title: "Data sheet" },
              data: [{ startRow: 0, startColumn: 0, rowData: [] }],
            }],
          },
        }
      }
      return original(request)
    })

    let failure: unknown
    try {
      await writeStagingSheetValues({
        ...value,
        nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
      })
    } catch (error) {
      failure = error
    }
    // The settlement catch wraps certification failures (as it does for the
    // delivery dated-report formats); the root cause carries the real reason.
    expect(failure).toBeInstanceOf(StagingSheetValueWriteExecutionError)
    const rootCause = (failure as { cause?: { cause?: { message?: string } } }).cause?.cause
    expect(rootCause?.message).toContain("cannot display a date after the write")
  })

  test("certifies a Google full-cell auto-link URI update coupled to the exact written URL", async () => {
    const oldUrl = "https://example.com/jobs/old"
    const newUrl = "https://example.com/jobs/new"
    const preimageCell: TypedCell = {
      userEnteredValue: { stringValue: oldUrl },
      effectiveValue: { stringValue: oldUrl },
      userEnteredFormat: {
        backgroundColor: { red: 0.9 },
        textFormat: { link: { uri: oldUrl } },
      },
    }
    const postimageCell: TypedCell = {
      userEnteredValue: { stringValue: newUrl },
      effectiveValue: { stringValue: newUrl },
      userEnteredFormat: {
        backgroundColor: { red: 0.9 },
        textFormat: { link: { uri: newUrl } },
      },
    }
    const value = fixture({
      beforeStructure: structure("Data sheet", [[preimageCell]]),
      currentValues: [[oldUrl]],
      desiredValues: [[newUrl]],
      typedPreimage: [[preimageCell]],
      typedVerificationCells: [[postimageCell]],
      postStructures: [structure("Data sheet", [[postimageCell]])],
    })

    const summary = await writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })

    expect(summary).toMatchObject({
      status: "written",
      mutationCallCount: 1,
      structureCertification: "value_coupled_auto_link",
    })
    expect(summary.afterStructureHash).not.toBe(summary.beforeStructureHash)
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
  })

  test("accepts a raw-exact URL write when the cell had no link and Google adds none", async () => {
    const newUrl = "https://example.com/jobs/new"
    const value = fixture({
      currentValues: [["old"]],
      desiredValues: [[newUrl]],
      typedVerificationCells: [[{
        userEnteredValue: { stringValue: newUrl },
        effectiveValue: { stringValue: newUrl },
      }]],
    })

    const summary = await writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })

    expect(summary).toMatchObject({
      status: "written",
      structureCertification: "exact",
    })
    expect(summary.afterStructureHash).toBe(summary.beforeStructureHash)
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
  })

  test("rejects a stale old value-coupled link under a raw-exact structure hash", async () => {
    const oldUrl = "https://example.com/jobs/old"
    const newUrl = "https://example.com/jobs/new"
    const preimageCell: TypedCell = {
      userEnteredValue: { stringValue: oldUrl },
      effectiveValue: { stringValue: oldUrl },
      userEnteredFormat: { textFormat: { link: { uri: oldUrl } } },
    }
    const stalePostimageCell: TypedCell = {
      userEnteredValue: { stringValue: newUrl },
      effectiveValue: { stringValue: newUrl },
      userEnteredFormat: { textFormat: { link: { uri: oldUrl } } },
    }
    const unchangedStructure = structure("Data sheet", [[preimageCell]])
    const value = fixture({
      beforeStructure: unchangedStructure,
      currentValues: [[oldUrl]],
      desiredValues: [[newUrl]],
      typedPreimage: [[preimageCell]],
      typedVerificationCells: [[stalePostimageCell]],
      postStructures: [unchangedStructure],
    })

    await expect(withFakeConsistencyTimers(() => writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    }))).rejects.toThrow("reason=raw_auto_link_mismatch")
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
  })

  test("rejects an auto-link URI that does not equal the exact written URL", async () => {
    const oldUrl = "https://example.com/jobs/old"
    const newUrl = "https://example.com/jobs/new"
    const wrongUrl = "https://example.com/jobs/wrong"
    const preimageCell: TypedCell = {
      userEnteredValue: { stringValue: oldUrl },
      effectiveValue: { stringValue: oldUrl },
      userEnteredFormat: { textFormat: { link: { uri: oldUrl } } },
    }
    const postimageCell: TypedCell = {
      userEnteredValue: { stringValue: newUrl },
      effectiveValue: { stringValue: newUrl },
      userEnteredFormat: { textFormat: { link: { uri: wrongUrl } } },
    }
    const value = fixture({
      beforeStructure: structure("Data sheet", [[preimageCell]]),
      currentValues: [[oldUrl]],
      desiredValues: [[newUrl]],
      typedPreimage: [[preimageCell]],
      typedVerificationCells: [[postimageCell]],
      postStructures: [structure("Data sheet", [[postimageCell]])],
    })

    await expect(withFakeConsistencyTimers(() => writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    }))).rejects.toThrow("reason=value_coupled_auto_link_mismatch")
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
  })

  test("rejects non-link format drift at the exact auto-link coordinate", async () => {
    const oldUrl = "https://example.com/jobs/old"
    const newUrl = "https://example.com/jobs/new"
    const preimageCell: TypedCell = {
      userEnteredValue: { stringValue: oldUrl },
      effectiveValue: { stringValue: oldUrl },
      userEnteredFormat: {
        textFormat: { bold: false, link: { uri: oldUrl } },
      },
    }
    const postimageCell: TypedCell = {
      userEnteredValue: { stringValue: newUrl },
      effectiveValue: { stringValue: newUrl },
      userEnteredFormat: {
        textFormat: { bold: true, link: { uri: newUrl } },
      },
    }
    const value = fixture({
      beforeStructure: structure("Data sheet", [[preimageCell]]),
      currentValues: [[oldUrl]],
      desiredValues: [[newUrl]],
      typedPreimage: [[preimageCell]],
      typedVerificationCells: [[postimageCell]],
      postStructures: [structure("Data sheet", [[postimageCell]])],
    })

    await expect(withFakeConsistencyTimers(() => writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    }))).rejects.toThrow("stale compensation was not attempted")
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
  })

  test("rejects a full-cell link change outside the exact written coordinates", async () => {
    const oldUrl = "https://example.com/jobs/old"
    const newUrl = "https://example.com/jobs/new"
    const untouchedUrl = "https://example.com/jobs/untouched"
    const concurrentUrl = "https://example.com/jobs/concurrent"
    const preimageCells: TypedCell[][] = [[
      {
        userEnteredValue: { stringValue: oldUrl },
        effectiveValue: { stringValue: oldUrl },
        userEnteredFormat: { textFormat: { link: { uri: oldUrl } } },
      },
      {
        userEnteredValue: { stringValue: untouchedUrl },
        effectiveValue: { stringValue: untouchedUrl },
        userEnteredFormat: { textFormat: { link: { uri: untouchedUrl } } },
      },
    ]]
    const postimageCells: TypedCell[][] = [[
      {
        userEnteredValue: { stringValue: newUrl },
        effectiveValue: { stringValue: newUrl },
        userEnteredFormat: { textFormat: { link: { uri: newUrl } } },
      },
      {
        userEnteredValue: { stringValue: untouchedUrl },
        effectiveValue: { stringValue: untouchedUrl },
        userEnteredFormat: { textFormat: { link: { uri: concurrentUrl } } },
      },
    ]]
    const value = fixture({
      beforeStructure: structure("Data sheet", preimageCells),
      currentValues: [[oldUrl, untouchedUrl]],
      desiredValues: [[newUrl, untouchedUrl]],
      typedPreimage: preimageCells,
      typedVerificationCells: postimageCells,
      postStructures: [structure("Data sheet", postimageCells)],
    })

    await expect(withFakeConsistencyTimers(() => writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    }))).rejects.toThrow("stale compensation was not attempted")
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
  })

  test("blocks a non-value-coupled full-cell link before mutation", async () => {
    const value = fixture({
      currentValues: [["Job details"]],
      desiredValues: [["Updated job details"]],
      typedPreimage: [[{
        userEnteredValue: { stringValue: "Job details" },
        effectiveValue: { stringValue: "Job details" },
        userEnteredFormat: {
          textFormat: { link: { uri: "https://example.com/jobs/manual" } },
        },
      }]],
    })

    await expect(writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })).rejects.toThrow("would overwrite a non-value-coupled full-cell link")
    expect(value.spreadsheetsBatchUpdate).not.toHaveBeenCalled()
  })

  test("preserves a linked label when the same row has an unchanged companion URL", async () => {
    const uri = "https://example.com/jobs/approved"
    const linkedLabel: TypedCell = {
      userEnteredValue: { stringValue: "Old job name" },
      effectiveValue: { stringValue: "Old job name" },
      userEnteredFormat: { textFormat: { link: { uri } } },
    }
    const companionUrl: TypedCell = {
      userEnteredValue: { stringValue: uri },
      effectiveValue: { stringValue: uri },
    }
    const value = fixture({
      beforeStructure: structure("Data sheet", [[linkedLabel, companionUrl]]),
      currentValues: [["Old job name", uri]],
      desiredValues: [["Current job name", uri]],
      typedPreimage: [[linkedLabel, companionUrl]],
    })

    const summary = await writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })

    expect(summary).toMatchObject({ status: "written", structureCertification: "exact" })
    expect(value.cells()[0][0]).toMatchObject({
      userEnteredValue: { stringValue: "Current job name" },
      userEnteredFormat: { textFormat: { link: { uri } } },
    })
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
  })

  test("certifies a preserved linked label with a companion in another planned range", async () => {
    const uri = "https://example.com/jobs/approved"
    const oldAutoLink = "https://example.com/jobs/old"
    const newAutoLink = "https://example.com/jobs/current"
    const preimageCells: TypedCell[][] = [[{
      userEnteredValue: { stringValue: "Old job name" },
      effectiveValue: { stringValue: "Old job name" },
      userEnteredFormat: { textFormat: { link: { uri } } },
    }, {
      userEnteredValue: { stringValue: uri },
      effectiveValue: { stringValue: uri },
    }, {
      userEnteredValue: { stringValue: oldAutoLink },
      effectiveValue: { stringValue: oldAutoLink },
      userEnteredFormat: { textFormat: { link: { uri: oldAutoLink } } },
    }]]
    const postimageCells: TypedCell[][] = [[{
      userEnteredValue: { stringValue: "Current job name" },
      effectiveValue: { stringValue: "Current job name" },
      userEnteredFormat: { textFormat: { link: { uri } } },
    }, {
      userEnteredValue: { stringValue: uri },
      effectiveValue: { stringValue: uri },
    }, {
      userEnteredValue: { stringValue: newAutoLink },
      effectiveValue: { stringValue: newAutoLink },
      userEnteredFormat: { textFormat: { link: { uri: newAutoLink } } },
    }]]
    const value = fixture({
      beforeStructure: structure("Data sheet", preimageCells),
      currentValues: [["Old job name", uri, oldAutoLink]],
      desiredValues: [["Current job name", uri, newAutoLink]],
      typedPreimage: preimageCells,
      typedVerificationCells: postimageCells,
      postStructures: [structure("Data sheet", postimageCells)],
      planRanges: [{
        rangeId: "weekly_recruitment_a_c",
        a1Range: "'Data sheet'!A2:A2",
        currentValues: [["Old job name"]],
        desiredValues: [["Current job name"]],
        startRowIndex: 1,
        startColumnIndex: 0,
      }, {
        rangeId: "weekly_recruitment_y_z",
        a1Range: "'Data sheet'!B2:C2",
        currentValues: [[uri, oldAutoLink]],
        desiredValues: [[uri, newAutoLink]],
        startRowIndex: 1,
        startColumnIndex: 1,
      }],
    })

    const summary = await writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })

    expect(summary).toMatchObject({
      status: "written",
      structureCertification: "value_coupled_auto_link",
      changedRangeCount: 2,
    })
    expect(value.cells()[0][0]).toMatchObject({
      userEnteredValue: { stringValue: "Current job name" },
      userEnteredFormat: { textFormat: { link: { uri } } },
    })
  })

  test("blocks a linked label when its companion URL is also changing", async () => {
    const oldUri = "https://example.com/jobs/old"
    const value = fixture({
      beforeStructure: structure("Data sheet", [[{
        userEnteredValue: { stringValue: "Old job name" },
        effectiveValue: { stringValue: "Old job name" },
        userEnteredFormat: { textFormat: { link: { uri: oldUri } } },
      }, {
        userEnteredValue: { stringValue: oldUri },
        effectiveValue: { stringValue: oldUri },
      }]]),
      currentValues: [["Old job name", oldUri]],
      desiredValues: [["Current job name", "https://example.com/jobs/current"]],
      typedPreimage: [[{
        userEnteredValue: { stringValue: "Old job name" },
        effectiveValue: { stringValue: "Old job name" },
        userEnteredFormat: { textFormat: { link: { uri: oldUri } } },
      }, {
        userEnteredValue: { stringValue: oldUri },
        effectiveValue: { stringValue: oldUri },
      }]],
    })

    await expect(writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })).rejects.toThrow("would overwrite a non-value-coupled full-cell link")
    expect(value.spreadsheetsBatchUpdate).not.toHaveBeenCalled()
  })

  test("blocks a linked label when the unchanged companion URL is formula-derived", async () => {
    const uri = "https://example.com/jobs/approved"
    const linkedLabel: TypedCell = {
      userEnteredValue: { stringValue: "Old job name" },
      effectiveValue: { stringValue: "Old job name" },
      userEnteredFormat: { textFormat: { link: { uri } } },
    }
    const formulaCompanion: TypedCell = {
      userEnteredValue: { formulaValue: `="${uri}"` },
      effectiveValue: { stringValue: uri },
    }
    const value = fixture({
      beforeStructure: structure("Data sheet", [[linkedLabel, formulaCompanion]]),
      currentValues: [["Old job name", uri]],
      desiredValues: [["Current job name", uri]],
      typedPreimage: [[linkedLabel, formulaCompanion]],
    })

    await expect(writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })).rejects.toThrow("would overwrite a non-value-coupled full-cell link")
    expect(value.spreadsheetsBatchUpdate).not.toHaveBeenCalled()
  })

  test("waits through Drive lag and fence churn without repeating the forward write", async () => {
    const value = fixture({
      driveVersions: ["10", "10", "10", "10", "11", "12", "12", "12"],
    })
    const summary = await withFakeConsistencyTimers(() => writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    }))
    expect(summary).toMatchObject({
      status: "written",
      mutationCallCount: 1,
      beforeDriveVersion: "10",
      afterDriveVersion: "12",
    })
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
    expect(value.clients.drive.files.get).toHaveBeenCalledTimes(8)
    expect(value.typedVerificationReads()).toBe(2)
    expect(value.cells()[0][0]).toMatchObject({ userEnteredValue: { stringValue: "new" } })
  })

  test("mocked value replacement preserves every unmasked CellData field", async () => {
    const unmasked = unmaskedFixtureCellFields()
    const preimageCell: TypedCell = {
      ...structuredClone(unmasked),
      userEnteredValue: { stringValue: "old" },
      effectiveValue: { stringValue: "old" },
    }
    const value = fixture({
      beforeStructure: structure("Data sheet", [[preimageCell]]),
      typedPreimage: [[preimageCell]],
    })

    await writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })

    expect(value.cells()[0][0]).toEqual({
      ...unmasked,
      userEnteredValue: { stringValue: "new" },
      effectiveValue: { stringValue: "new" },
    })
  })

  test("clears nulls as true blanks without materializing empty strings", async () => {
    const unmasked = unmaskedFixtureCellFields()
    const preimageCell: TypedCell = {
      ...structuredClone(unmasked),
      userEnteredValue: { stringValue: "old" },
      effectiveValue: { stringValue: "old" },
    }
    const value = fixture({
      beforeStructure: structure("Data sheet", [[preimageCell]]),
      desiredValues: [[null]],
      typedPreimage: [[preimageCell]],
    })
    await writeStagingSheetValues({ ...value, nowMs: Date.parse("2026-07-11T12:01:00.000Z") })
    expect(value.spreadsheetsBatchUpdate.mock.calls[0][0]).toMatchObject({
      requestBody: {
        requests: [{
          updateCells: {
            start: {
              sheetId: 1324142221,
              rowIndex: 1,
              columnIndex: 0,
            },
            rows: [{ values: [{}] }],
            fields: "userEnteredValue",
          },
        }],
      },
    })
    expect(value.cells()[0][0]).toEqual(unmasked)
    expect(value.valuesBatchUpdate).not.toHaveBeenCalled()
  })

  test("normalizes a desired empty string to a true blank before writing", async () => {
    const value = fixture({ desiredValues: [[""]] })
    expect(value.plan.writes[0].values).toEqual([[null]])

    const summary = await writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })

    expect(summary).toMatchObject({ status: "written", mutationCallCount: 1 })
    expect(value.cells()[0][0].userEnteredValue).toBeUndefined()
  })

  test("an identical rerun performs zero mutation calls", async () => {
    const value = fixture({ desiredValues: [["old"]] })
    const summary = await writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })
    expect(summary.status).toBe("no_change")
    expect(summary.mutationCallCount).toBe(0)
    expect(value.spreadsheetsBatchUpdate).not.toHaveBeenCalled()
  })

  test("does not expire durable tier flags from legacy activation timestamps", async () => {
    const value = fixture()
    value.env[STAGING_HYDRATION_EXPIRES_AT_ENV] = "2026-07-11T12:01:00.000Z"
    await expect(
      writeStagingSheetValues({ ...value, nowMs: Date.parse("2026-07-11T12:01:00.000Z") })
    ).resolves.toMatchObject({ status: "written" })
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledOnce()
  })

  test("revalidates the short-lived mutation permit immediately before mutation", async () => {
    const value = fixture()
    value.currentTimeMs = () => Date.parse("2026-07-11T12:10:11.000Z")

    await expect(
      writeStagingSheetValues({ ...value, nowMs: Date.parse("2026-07-11T12:01:00.000Z") })
    ).rejects.toThrow("permit has expired")

    expect(value.revalidateKillSwitchClear).not.toHaveBeenCalled()
    expect(value.spreadsheetsBatchUpdate).not.toHaveBeenCalled()
  })

  test("revalidates the durable kill switch immediately before mutation", async () => {
    const value = fixture()
    value.revalidateKillSwitchClear.mockRejectedValueOnce(new Error("kill switch engaged"))

    await expect(
      writeStagingSheetValues({ ...value, nowMs: Date.parse("2026-07-11T12:01:00.000Z") })
    ).rejects.toThrow("kill switch engaged")

    expect(value.revalidateKillSwitchClear).toHaveBeenCalledTimes(1)
    expect(value.spreadsheetsBatchUpdate).not.toHaveBeenCalled()
  })

  test("rejects a non-decimal Drive revision before mutation", async () => {
    const value = fixture({ driveVersions: ["not-a-revision"] })
    await expect(
      writeStagingSheetValues({ ...value, nowMs: Date.parse("2026-07-11T12:01:00.000Z") })
    ).rejects.toThrow("not a decimal revision")
    expect(value.spreadsheetsBatchUpdate).not.toHaveBeenCalled()
  })

  test("blocks preimage drift before any mutation", async () => {
    const value = fixture({
      typedPreimage: [[{
        userEnteredValue: { stringValue: "changed elsewhere" },
        effectiveValue: { stringValue: "changed elsewhere" },
      }]],
    })
    await expect(
      writeStagingSheetValues({ ...value, nowMs: Date.parse("2026-07-11T12:01:00.000Z") })
    ).rejects.toThrow("changed after dry-run")
    expect(value.spreadsheetsBatchUpdate).not.toHaveBeenCalled()
  })

  test("fails closed before changing a cell with rich-text runs", async () => {
    const value = fixture({
      typedPreimage: [[{
        userEnteredValue: { stringValue: "old" },
        effectiveValue: { stringValue: "old" },
        textFormatRuns: [{ startIndex: 0, format: { bold: true } }],
      }]],
    })
    await expect(
      writeStagingSheetValues({ ...value, nowMs: Date.parse("2026-07-11T12:01:00.000Z") })
    ).rejects.toThrow("would erase text-format or smart-chip runs")
    expect(value.spreadsheetsBatchUpdate).not.toHaveBeenCalled()
    expect(value.valuesBatchUpdate).not.toHaveBeenCalled()
  })

  test("allows an empty chip run but blocks a populated smart chip", async () => {
    const emptyChip = fixture({
      typedPreimage: [[{
        userEnteredValue: { stringValue: "old" },
        effectiveValue: { stringValue: "old" },
        chipRuns: [{ startIndex: 0, chip: {} }],
      }]],
    })
    const summary = await writeStagingSheetValues({
      ...emptyChip,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    })
    expect(summary.status).toBe("written")
    expect(emptyChip.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)

    const populatedChip = fixture({
      typedPreimage: [[{
        userEnteredValue: { stringValue: "old" },
        effectiveValue: { stringValue: "old" },
        chipRuns: [{
          startIndex: 0,
          chip: { personProperties: { email: "candidate@example.com" } },
        }],
      }]],
    })
    await expect(
      writeStagingSheetValues({
        ...populatedChip,
        nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
      })
    ).rejects.toThrow("would erase text-format or smart-chip runs")
    expect(populatedChip.spreadsheetsBatchUpdate).not.toHaveBeenCalled()
    expect(populatedChip.valuesBatchUpdate).not.toHaveBeenCalled()
  })

  test("omits a preserved date formula when only its neighboring scalar changes", async () => {
    const value = fixture({
      currentValues: [[46_123, "old"]],
      desiredValues: [[46_123, "new"]],
      typedPreimage: [[
        {
          userEnteredValue: { formulaValue: "=DATE(2026,4,11)" },
          effectiveValue: { numberValue: 46_123 },
        },
        {
          userEnteredValue: { stringValue: "old" },
          effectiveValue: { stringValue: "old" },
        },
      ]],
    })
    await writeStagingSheetValues({ ...value, nowMs: Date.parse("2026-07-11T12:01:00.000Z") })
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
    expect(value.spreadsheetsBatchUpdate.mock.calls[0][0]).toMatchObject({
      requestBody: {
        requests: [{
          updateCells: {
            start: { sheetId: 1324142221, rowIndex: 1, columnIndex: 1 },
            rows: [{ values: [{ userEnteredValue: { stringValue: "new" } }] }],
            fields: "userEnteredValue",
          },
        }],
      },
    })
    expect(value.cells()[0][0]).toMatchObject({
      userEnteredValue: { formulaValue: "=DATE(2026,4,11)" },
      effectiveValue: { numberValue: 46_123 },
    })
    expect(value.cells()[0][1]).toMatchObject({ userEnteredValue: { stringValue: "new" } })
    expect(value.valuesBatchUpdate).not.toHaveBeenCalled()
  })

  test("retries a stale advanced snapshot and accepts the later exact typed post-state", async () => {
    const value = fixture({
      currentValues: [[10, 46_123, null, null]],
      desiredValues: [[11, 46_124, "filled empty", "filled blank"]],
      typedPreimage: [[
        {
          userEnteredValue: { formulaValue: "=5+5" },
          effectiveValue: { numberValue: 10 },
        },
        {
          userEnteredValue: { numberValue: 46_123 },
          effectiveValue: { numberValue: 46_123 },
        },
        {
          userEnteredValue: { stringValue: "" },
          effectiveValue: { stringValue: "" },
        },
        {},
      ]],
      postStructures: [structure("Changed tab"), structure()],
    })
    const summary = await withFakeConsistencyTimers(() => writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    }))
    expect(summary.status).toBe("written")
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
    expect(value.typedVerificationReads()).toBe(2)
    expect(value.cells()[0][0]).toMatchObject({ userEnteredValue: { numberValue: 11 } })
    expect(value.cells()[0][1]).toMatchObject({ userEnteredValue: { numberValue: 46_124 } })
    expect(value.cells()[0][2]).toMatchObject({ userEnteredValue: { stringValue: "filled empty" } })
    expect(value.cells()[0][3]).toMatchObject({ userEnteredValue: { stringValue: "filled blank" } })
    expect(value.valuesBatchUpdate).not.toHaveBeenCalled()
  })

  test("waits through ten minutes of delayed Drive publication and mutates exactly once", async () => {
    const value = fixture({
      driveVersions: [...Array<string>(30).fill("10"), "11", "11"],
    })

    const summary = await withFakeConsistencyTimers(() => writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    }))

    expect(summary).toMatchObject({
      status: "written",
      mutationCallCount: 1,
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
    })
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
    expect(value.clients.drive.files.get).toHaveBeenCalledTimes(32)
    expect(value.typedVerificationReads()).toBe(1)
  })

  test("does not overwrite a persistent unexpected post-state with stale compensation", async () => {
    const typedPreimage = [[
      {
        userEnteredValue: { formulaValue: "=5+5" },
        effectiveValue: { numberValue: 10 },
      },
      {
        userEnteredValue: { numberValue: 46_123 },
        effectiveValue: { numberValue: 46_123 },
      },
      {
        userEnteredValue: { stringValue: "" },
        effectiveValue: { stringValue: "" },
      },
      {},
    ]] satisfies readonly (readonly TypedCell[])[]
    const value = fixture({
      currentValues: [[10, 46_123, null, null]],
      desiredValues: [[11, 46_124, "filled empty", "filled blank"]],
      typedPreimage,
      postStructures: [structure("Changed tab")],
    })
    let failure: unknown
    try {
      await withFakeConsistencyTimers(() => writeStagingSheetValues({
        ...value,
        nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
      }))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(StagingSheetValueWriteExecutionError)
    expect(failure).toMatchObject({
      failureStage: "postimage_validation",
      mutationCallCount: 1,
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
      certificationStatus: "postimage_rejected",
    })
    expect((failure as Error).message).toContain("reason=non_value_structure_mismatch")
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
    expect(value.typedVerificationReads()).toBe(2)
    expect(value.cells()[0][0]).toMatchObject({ userEnteredValue: { numberValue: 11 } })
    expect(value.cells()[0][1]).toMatchObject({ userEnteredValue: { numberValue: 46_124 } })
    expect(value.cells()[0][2]).toMatchObject({ userEnteredValue: { stringValue: "filled empty" } })
    expect(value.cells()[0][3]).toMatchObject({ userEnteredValue: { stringValue: "filled blank" } })
  })

  test("reports a public-safe range code for normalized value settlement drift", async () => {
    const value = fixture({
      typedVerificationCells: [[{
        userEnteredValue: { stringValue: "concurrent value" },
        effectiveValue: { stringValue: "concurrent value" },
      }]],
    })

    await expect(withFakeConsistencyTimers(() => writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    }))).rejects.toThrow("reason=normalized_value_mismatch:all_hires_data")
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
  })

  test("reports a public-safe range code for typed value settlement drift", async () => {
    const value = fixture({
      typedVerificationCells: [[{
        userEnteredValue: { numberValue: 7 },
        effectiveValue: { stringValue: "new" },
      }]],
    })

    await expect(withFakeConsistencyTimers(() => writeStagingSheetValues({
      ...value,
      nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
    }))).rejects.toThrow("reason=typed_value_mismatch:all_hires_data")
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
  })

  test("reports an applied ambiguous failure without issuing an unowned rollback", async () => {
    const forwardError = new Error("ambiguous forward transport failure")
    const value = fixture({
      batchUpdateOutcomes: [{ apply: true, error: forwardError }],
    })
    let failure: unknown
    try {
      await withFakeConsistencyTimers(() => writeStagingSheetValues({
        ...value,
        nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
      }))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(StagingSheetValueWriteExecutionError)
    expect(failure).toMatchObject({
      failureStage: "ambiguous_settlement",
      mutationCallCount: 1,
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
      certificationStatus: "postimage_verified",
    })
    expect((failure as Error).message).toContain("without an exclusive writer lease")
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
    expect(value.clients.drive.files.get).toHaveBeenCalledTimes(9)
    expect(value.typedVerificationReads()).toBe(1)
    expect(value.cells()[0][0]).toEqual({
      userEnteredValue: { stringValue: "new" },
      effectiveValue: { stringValue: "new" },
    })
  })

  test("does not compensate an ambiguous failure that settles to a concurrent third state", async () => {
    const forwardError = new Error("ambiguous forward transport failure")
    const value = fixture({
      batchUpdateOutcomes: [{ apply: true, error: forwardError }],
      typedVerificationCells: [[{
        userEnteredValue: { stringValue: "concurrent value" },
        effectiveValue: { stringValue: "concurrent value" },
      }]],
    })
    let failure: unknown
    try {
      await withFakeConsistencyTimers(() => writeStagingSheetValues({
        ...value,
        nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
      }))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(StagingSheetValueWriteExecutionError)
    expect(failure).toMatchObject({
      failureStage: "ambiguous_settlement",
      mutationCallCount: 1,
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
      certificationStatus: "ambiguous",
    })
    expect((failure as Error).message).toContain("unexpected or concurrent state")
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
    expect(value.typedVerificationReads()).toBe(1)
  })

  test("does not roll back an ambiguous failure proven to have made no mutation", async () => {
    const forwardError = new Error("rejected before Sheets applied the request")
    const value = fixture({
      batchUpdateOutcomes: [{ apply: false, error: forwardError }],
    })
    let failure: unknown
    try {
      await withFakeConsistencyTimers(() => writeStagingSheetValues({
        ...value,
        nowMs: Date.parse("2026-07-11T12:01:00.000Z"),
      }))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(StagingSheetValueWriteExecutionError)
    expect(failure).toMatchObject({
      failureStage: "mutation",
      mutationCallCount: 1,
      beforeDriveVersion: "10",
      afterDriveVersion: "10",
      certificationStatus: "preimage_verified",
      cause: forwardError,
    })
    expect(value.spreadsheetsBatchUpdate).toHaveBeenCalledTimes(1)
    expect(value.clients.drive.files.get).toHaveBeenCalledTimes(9)
    expect(value.typedVerificationReads()).toBe(1)
    expect(value.cells()[0][0]).toEqual({
      userEnteredValue: { stringValue: "old" },
      effectiveValue: { stringValue: "old" },
    })
  })
})
