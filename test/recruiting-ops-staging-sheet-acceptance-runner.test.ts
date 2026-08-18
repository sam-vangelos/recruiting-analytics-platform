import { beforeEach, describe, expect, test, vi } from "vitest"
import type { sheets_v4 } from "googleapis"

import type { KillSwitchState } from "../lib/recruiting-ops/autonomy"
import { PII_FINGERPRINT_SALT_ENV } from "../lib/recruiting-ops/checksums"
import type { OfferLifecycleExportRow } from "../lib/recruiting-ops/delivery-source/offer-lifecycle-export"
import type { StagingHydrationFacts } from "../lib/recruiting-ops/delivery-source/staging-hydration-source-loader"
import type {
  GoogleWorkspaceStagingClients,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { renderAllHiresRows } from "../lib/recruiting-ops/delivery/all-hires-renderer"
import { getCanonicalParityArtifact } from "../lib/recruiting-ops/delivery/canonical-parity-registry"
import {
  buildCanonicalParityRangeRequests,
  runStagingSheetAcceptance,
  type CanonicalSheetParityReadResult,
  type PinnedStagingSheetAcceptanceCut,
  type StagingSheetAcceptancePorts,
} from "../lib/recruiting-ops/delivery/staging-sheet-acceptance-runner"
import {
  getStagingArtifact,
  STAGING_HYDRATION_ENABLED_AT_ENV,
  STAGING_HYDRATION_EXPIRES_AT_ENV,
  STAGING_HYDRATION_GLOBAL_FLAG,
} from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import { STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID } from "../lib/recruiting-ops/delivery/staging-kill-switch"
import {
  expectedStagingSheetAcceptanceSurfaceIds,
  stagingSheetAcceptanceSurfaceRegistry,
} from "../lib/recruiting-ops/delivery/staging-sheet-acceptance-surfaces"
import { getStagingSheetContract } from "../lib/recruiting-ops/delivery/staging-sheet-contracts"
import { buildStagingSheetValuePlan } from "../lib/recruiting-ops/delivery/staging-value-plan"
import { legacyArtifactDisplayV1 } from "../lib/recruiting-ops/dimensions/config/legacy-artifact-display.v1"

const ARTIFACT = "all_hires" as const
const NOW = Date.parse("2026-07-11T12:01:00.000Z")
const FINGERPRINT_KEY = "acceptance-comparison-key-that-must-not-escape"

const clearSwitch: KillSwitchState = {
  scope: "global",
  scopeId: STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID,
  enabled: false,
  reason: "copy acceptance authorized",
  updatedAt: "2026-07-11T12:00:00.000Z",
  updatedBy: "operator",
}

beforeEach(() => {
  process.env[PII_FINGERPRINT_SALT_ENV] = "sheet-acceptance-test-hmac-key"
})

describe("copy-only staging Sheet acceptance runner", () => {
  test("independently registers every required surface for all ten copied Sheets", () => {
    expect(Object.keys(stagingSheetAcceptanceSurfaceRegistry)).toHaveLength(10)
    for (const artifactKey of Object.keys(stagingSheetAcceptanceSurfaceRegistry) as
      (keyof typeof stagingSheetAcceptanceSurfaceRegistry)[]) {
      const ids = expectedStagingSheetAcceptanceSurfaceIds(artifactKey)
      expect(ids.length).toBeGreaterThan(0)
      expect(new Set(ids).size).toBe(ids.length)
      expect(Object.isFrozen(ids)).toBe(true)
      expect(ids.every((id) => getStagingSheetContract(id).artifactKey === artifactKey)).toBe(true)
    }
  })

  test("pins one source cut, covers every planned range, proves parity, and requires a zero-mutation rerun", async () => {
    const value = fixture()
    const result = await run(value)

    expect(result).toMatchObject({
      artifactKey: ARTIFACT,
      status: "accepted",
      copyOnly: false,
      canonicalWriteAuthorized: true,
      sourceCounts: { offers: 1, diagnostics: 1 },
      initial: {
        plan: { rangeCount: 1, changedRangeCount: 1, noOp: false },
        write: { status: "written", mutationCallCount: 1 },
      },
      parity: {
        surfaceCount: 1,
        classificationCounts: { "exact-match": 1, "needs-investigation": 0 },
      },
      rerun: {
        plan: { rangeCount: 1, changedRangeCount: 0, noOp: true },
        write: { status: "no_change", changedRangeCount: 0, mutationCallCount: 0 },
      },
    })
    expect(value.loadPinnedCut).toHaveBeenCalledOnce()
    // Initial permit + immediate pre-mutation recheck + no-op rerun permit.
    expect(value.loadKillSwitchStates).toHaveBeenCalledTimes(3)
    expect(value.readCanonicalRanges).toHaveBeenCalledOnce()
    expect(value.batchUpdate).toHaveBeenCalledOnce()
    expect(value.readCanonicalRanges.mock.invocationCallOrder[0]).toBeLessThan(
      value.batchUpdate.mock.invocationCallOrder[0]
    )
    expect(value.batchUpdate.mock.calls[0][0]).toMatchObject({
      spreadsheetId: getStagingArtifact(ARTIFACT).artifactId,
    })
    // Post-cutover, the mutation registry's artifactId for every key equals
    // the canonical-parity registry's artifactId for that same key (both are
    // now the canonical file) — so the write necessarily touches it.
    expect(value.batchUpdate.mock.calls.some(([request]) =>
      request.spreadsheetId === getCanonicalParityArtifact(ARTIFACT).artifactId
    )).toBe(true)
    expect(result.initial?.plan.payloadFingerprint).toBe(result.rerun?.plan.payloadFingerprint)

    const canonicalRequest = value.readCanonicalRanges.mock.calls[0][0]
    expect(canonicalRequest).toMatchObject({
      artifactKey: ARTIFACT,
      canonicalArtifactId: getCanonicalParityArtifact(ARTIFACT).artifactId,
      readOnly: true,
      ranges: [{
        surfaceId: "all_hires_data",
        copiedA1Range: "'Data sheet'!A2:I2",
        canonicalA1Range: "'Data sheet'!A2:I2",
        rowCount: 1,
        columnCount: 9,
      }],
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("Fixture Candidate")
    expect(serialized).not.toContain(FINGERPRINT_KEY)
    expect(serialized).toMatch(/hmac-sha256:[a-f0-9]{64}/)
  })

  test("derives canonical requests from every private planned write without a caller surface list", () => {
    const plan = buildStagingSheetValuePlan({
      artifactKey: "pipeline_890",
      runId: "complete_surface_test",
      sourceGeneratedAt: "2026-07-11T12:00:00.000Z",
      structureHash: `sha256:${"a".repeat(64)}`,
      dataProvenance: "live",
      ranges: [
        {
          rangeId: "pipeline_890_candidate",
          a1Range: "'Candidate Level Data - 10 July'!A2:A3",
          currentValues: [[null], [null]],
          desiredValues: [[1], [2]],
        },
        {
          rangeId: "pipeline_890_job_week",
          a1Range: "'Job level pipeline'!A10:A10",
          currentValues: [[null]],
          desiredValues: [[3]],
        },
      ],
    })

    expect(buildCanonicalParityRangeRequests(plan)).toEqual([
      {
        surfaceId: "pipeline_890_candidate",
        copiedA1Range: "'Candidate Level Data - 10 July'!A2:A3",
        canonicalA1Range: "'Candidate Level Data - 10 July'!A2:A3",
        rowCount: 2,
        columnCount: 1,
      },
      {
        surfaceId: "pipeline_890_job_week",
        copiedA1Range: "'Job level pipeline'!A10:A10",
        canonicalA1Range: "'Job level pipeline'!A10:A10",
        rowCount: 1,
        columnCount: 1,
      },
    ])
  })

  test("rejects a planner result that omits an independently required artifact surface", () => {
    const incomplete = buildStagingSheetValuePlan({
      artifactKey: "final_offer",
      runId: "incomplete_final_offer_test",
      sourceGeneratedAt: "2026-07-11T12:00:00.000Z",
      structureHash: `sha256:${"b".repeat(64)}`,
      dataProvenance: "live",
      ranges: [{
        rangeId: "final_offer_master",
        a1Range: "'Mastersheet'!A2:A2",
        currentValues: [[null]],
        desiredValues: [[1]],
      }],
    })

    expect(() => buildCanonicalParityRangeRequests(incomplete)).toThrow("completely bind")
  })

  test("fails before Google or canonical access when any source diagnostic is truncated", async () => {
    const value = fixture({ truncated: true })
    const result = await run(value)

    expect(result).toMatchObject({ status: "blocked", blockCode: "source_truncated" })
    expect(value.loadPinnedCut).toHaveBeenCalledOnce()
    expect(value.batchUpdate).not.toHaveBeenCalled()
    expect(value.readCanonicalRanges).not.toHaveBeenCalled()
    expect(value.clients.sheets.spreadsheets.get).not.toHaveBeenCalled()
  })

  test("requires a fresh durable clear state before the initial copy writer", async () => {
    const value = fixture({ killSwitchBlocked: true })
    const result = await run(value)

    expect(result).toMatchObject({ status: "blocked", blockCode: "initial_kill_switch_blocked" })
    expect(value.loadKillSwitchStates).toHaveBeenCalledOnce()
    expect(value.batchUpdate).not.toHaveBeenCalled()
    expect(value.readCanonicalRanges).toHaveBeenCalledOnce()
  })

  test("fails closed when the canonical port is unreadable without echoing connector data", async () => {
    const privateConnectorError = "Fixture Candidate canonical read failed"
    const value = fixture({ canonicalError: privateConnectorError })
    const result = await run(value)

    expect(result).toMatchObject({
      status: "blocked",
      blockCode: "canonical_unreadable",
      initial: { plan: { rangeCount: 1 } },
    })
    expect(JSON.stringify(result)).not.toContain(privateConnectorError)
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("rejects an omitted canonical surface as incomplete coverage", async () => {
    const value = fixture({ omitCanonicalSurface: true })
    const result = await run(value)

    expect(result).toMatchObject({ status: "blocked", blockCode: "incomplete_range_coverage" })
    expect(result.parity).toBeUndefined()
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test.each([
    ["copied", { copiedWrongRange: true }],
    ["canonical", { canonicalWrongRange: true }],
  ] as const)("rejects a wrong %s A1 response as incomplete coverage", async (_label, options) => {
    const value = fixture(options)
    const result = await run(value)

    expect(result).toMatchObject({ status: "blocked", blockCode: "incomplete_range_coverage" })
    if ("canonicalWrongRange" in options && options.canonicalWrongRange) {
      expect(value.batchUpdate).not.toHaveBeenCalled()
    } else expect(value.batchUpdate).toHaveBeenCalledOnce()
  })

  test("blocks planned-value parity drift before kill-switch or write preflight", async () => {
    const value = fixture({ canonicalMismatch: true })
    const result = await run(value)

    expect(result).toMatchObject({
      status: "blocked",
      blockCode: "parity_needs_investigation",
      parity: {
        surfaceCount: 1,
        classificationCounts: { "needs-investigation": 1 },
        surfaces: [{
          surfaceId: "all_hires_data",
          classification: "needs-investigation",
          mismatchCounts: { copiedToPlatform: 0, canonicalToPlatform: 9 },
        }],
        matrixMismatchEvidence: {
          totalMismatchCount: 9,
          returnedMismatchCount: 9,
          truncated: false,
          entries: [
            { coordinate: "A2" },
            { coordinate: "B2" },
            { coordinate: "C2" },
            { coordinate: "D2" },
            { coordinate: "E2" },
            { coordinate: "F2" },
            { coordinate: "G2" },
            { coordinate: "H2" },
            { coordinate: "I2" },
          ],
        },
      },
    })
    expect(result.initial?.write).toBeUndefined()
    expect(value.loadKillSwitchStates).not.toHaveBeenCalled()
    expect(value.clients.drive.files.get).not.toHaveBeenCalled()
    expect(value.batchUpdate).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain("Canonical-only private value")
  })

  test("retains post-write parity verification before the idempotency rerun", async () => {
    const value = fixture({ copiedPostWriteMismatch: true })
    const result = await run(value)

    expect(result).toMatchObject({
      status: "blocked",
      blockCode: "parity_needs_investigation",
      initial: { write: { status: "written", mutationCallCount: 1 } },
      parity: {
        classificationCounts: { "needs-investigation": 1 },
        surfaces: [{
          surfaceId: "all_hires_data",
          classification: "needs-investigation",
          mismatchCounts: { canonicalToPlatform: 0, copiedToPlatform: 1 },
        }],
      },
    })
    expect(result.rerun).toBeUndefined()
    // Initial permit plus the immediate pre-mutation recheck.
    expect(value.loadKillSwitchStates).toHaveBeenCalledTimes(2)
    expect(value.batchUpdate).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain("Post-write copy drift")
  })
})

function fixture(options: {
  truncated?: boolean
  canonicalError?: string
  omitCanonicalSurface?: boolean
  canonicalMismatch?: boolean
  killSwitchBlocked?: boolean
  canonicalWrongRange?: boolean
  copiedWrongRange?: boolean
  copiedPostWriteMismatch?: boolean
} = {}) {
  const artifact = getStagingArtifact(ARTIFACT)
  const contract = getStagingSheetContract("all_hires_data")
  const cut: PinnedStagingSheetAcceptanceCut = {
    roster: [],
    facts: facts(options.truncated === true),
  }
  const canonicalRows = renderAllHiresRows({
    offers: cut.facts.offers,
    displayDimensions: legacyArtifactDisplayV1.map((entry) => ({
      requisitionId: entry.requisitionId,
      jobCategory: entry.allHiresCategory,
      jobName: entry.allHiresJobName,
    })),
  }).map((row) => [...row.cells])
  const copyRows: (string | number | boolean | null)[][] = []
  let driveVersion = 10
  const metadata = {
    spreadsheetId: artifact.artifactId,
    properties: { title: "Copy of All Hires", locale: "en_US", timeZone: "UTC" },
    sheets: [{
      properties: {
        sheetId: contract.sheetId,
        title: contract.sheetTitle,
        index: 0,
        sheetType: "GRID",
        gridProperties: { rowCount: 100, columnCount: 9 },
      },
    }],
  }
  const batchGet = vi.fn(async (request: { ranges?: readonly string[] }) => {
    const ranges = request.ranges ?? []
    if (ranges.length === 2 && ranges[0] === "'Data sheet'!A1:I1") {
      return {
        data: {
          valueRanges: [
            { range: ranges[0], values: [[...contract.headers]] },
            { range: ranges[1], values: copyRows },
          ],
        },
      }
    }
    if (ranges.length === 1 && ranges[0] === "'Data sheet'!A2:I2") {
      let values = copyRows
      if (options.copiedPostWriteMismatch && driveVersion > 10) {
        values = copyRows.map((row) => [...row])
        values[0][0] = "Post-write copy drift"
      }
      return {
        data: {
          valueRanges: [{
            range: options.copiedWrongRange ? "'Data sheet'!A3:I3" : ranges[0],
            values,
          }],
        },
      }
    }
    throw new Error("Unexpected copied range read")
  })
  const typedCell = (value: string | number | boolean | null | undefined) => {
    if (value === null || value === undefined) return {}
    const entered = typeof value === "string"
      ? { stringValue: value }
      : typeof value === "number"
        ? { numberValue: value }
        : { boolValue: value }
    return { userEnteredValue: entered, effectiveValue: { ...entered } }
  }
  const typedGridResponse = (
    filters: readonly { gridRange?: { startRowIndex?: number; startColumnIndex?: number } }[]
  ) => ({
    spreadsheetId: artifact.artifactId,
    sheets: [{
      properties: { sheetId: contract.sheetId, title: contract.sheetTitle },
      data: filters.map((filter) => ({
        startRow: filter.gridRange?.startRowIndex ?? 1,
        startColumn: filter.gridRange?.startColumnIndex ?? 0,
        rowData: copyRows.map((row) => ({ values: row.map(typedCell) })),
      })),
    }],
  })
  const get = vi.fn(async (request: { ranges?: readonly string[]; fields?: string }) => {
    // Append-date-format gap read: the owned columns already render
    // dates, so the acceptance write stays a pure value mutation.
    if (request.fields?.includes("userEnteredFormat.numberFormat")) {
      return {
        data: {
          spreadsheetId: artifact.artifactId,
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
        },
      }
    }
    if (request.fields?.includes("effectiveValue")) {
      return {
        data: typedGridResponse(
          (request.ranges ?? []).map(() => ({
            gridRange: { startRowIndex: 1, startColumnIndex: 0 },
          }))
        ),
      }
    }
    return { data: metadata }
  })
  const getByDataFilter = vi.fn(async (request: {
    fields?: string
    requestBody?: { dataFilters?: readonly { gridRange?: { startRowIndex?: number; startColumnIndex?: number } }[] }
  }) => request.fields?.includes("effectiveValue")
    ? { data: typedGridResponse(request.requestBody?.dataFilters ?? []) }
    : {
        data: {
          sheets: [{
            properties: { sheetId: contract.sheetId },
            data: (request.requestBody?.dataFilters ?? []).map((filter) => ({
              startRow: filter.gridRange?.startRowIndex ?? 0,
              startColumn: filter.gridRange?.startColumnIndex ?? 0,
            })),
          }],
        },
      })
  const batchUpdate = vi.fn(async (request: {
    spreadsheetId?: string
    requestBody?: { requests?: readonly sheets_v4.Schema$Request[] }
  }) => {
    if (request.spreadsheetId !== artifact.artifactId) throw new Error("Unexpected write target")
    const mutations = request.requestBody?.requests ?? []
    if (mutations.length === 0) throw new Error("Missing copied range write")
    const ensureCell = (rowIndex: number, columnIndex: number) => {
      while (copyRows.length <= rowIndex) copyRows.push([])
      while (copyRows[rowIndex].length <= columnIndex) copyRows[rowIndex].push(null)
    }
    const scalar = (value: sheets_v4.Schema$ExtendedValue | null | undefined) => {
      if (value === null || value === undefined) return null
      if (value.stringValue !== undefined && value.stringValue !== null) return value.stringValue
      if (value.numberValue !== undefined && value.numberValue !== null) return value.numberValue
      if (value.boolValue !== undefined && value.boolValue !== null) return value.boolValue
      throw new Error("Unexpected typed fixture value")
    }
    for (const mutation of mutations) {
      if (mutation.updateCells) {
        if (mutation.updateCells.range && (mutation.updateCells.rows?.length ?? 0) === 0) {
          const range = mutation.updateCells.range
          for (let row = range.startRowIndex ?? 0; row < (range.endRowIndex ?? 0); row += 1) {
            for (let column = range.startColumnIndex ?? 0; column < (range.endColumnIndex ?? 0); column += 1) {
              const rowIndex = row - 1
              ensureCell(rowIndex, column)
              copyRows[rowIndex][column] = null
            }
          }
          continue
        }
        const startRow = mutation.updateCells.start?.rowIndex ?? 0
        const startColumn = mutation.updateCells.start?.columnIndex ?? 0
        for (const [rowOffset, row] of (mutation.updateCells.rows ?? []).entries()) {
          for (const [columnOffset, cell] of (row.values ?? []).entries()) {
            const rowIndex = startRow + rowOffset - 1
            const columnIndex = startColumn + columnOffset
            ensureCell(rowIndex, columnIndex)
            copyRows[rowIndex][columnIndex] = scalar(cell.userEnteredValue)
          }
        }
        continue
      }
      if (mutation.repeatCell) {
        const range = mutation.repeatCell.range
        for (let row = range?.startRowIndex ?? 0; row < (range?.endRowIndex ?? 0); row += 1) {
          for (let column = range?.startColumnIndex ?? 0; column < (range?.endColumnIndex ?? 0); column += 1) {
            const rowIndex = row - 1
            ensureCell(rowIndex, column)
            copyRows[rowIndex][column] = null
          }
        }
        continue
      }
      throw new Error("Unexpected copied range mutation")
    }
    driveVersion += 1
    return { data: {} }
  })
  const clients = {
    drive: {
      files: {
        get: vi.fn(async () => ({
          data: {
            id: artifact.artifactId,
            version: String(driveVersion),
            trashed: false,
            capabilities: { canEdit: true, canModifyContent: true },
          },
        })),
      },
    },
    docs: {},
    sheets: {
      spreadsheets: {
        get,
        getByDataFilter,
        batchUpdate,
        values: { batchGet, batchUpdate },
      },
    },
  } as unknown as GoogleWorkspaceStagingClients

  const loadPinnedCut = vi.fn(async () => cut)
  const loadKillSwitchStates = vi.fn(async () => options.killSwitchBlocked ? [] : [clearSwitch])
  const readCanonicalRanges = vi.fn(async (request: Parameters<StagingSheetAcceptancePorts["canonical"]["readCanonicalRanges"]>[0]): Promise<CanonicalSheetParityReadResult> => {
    if (options.canonicalError) throw new Error(options.canonicalError)
    const values = options.canonicalMismatch
      ? [["Canonical-only private value", ...Array(8).fill(null)]]
      : canonicalRows
    return {
      canonicalArtifactId: request.canonicalArtifactId,
      readOnly: true,
      surfaces: options.omitCanonicalSurface
        ? []
        : [{
            surfaceId: "all_hires_data",
            canonicalA1Range: options.canonicalWrongRange
              ? "'Data sheet'!A3:I3"
              : request.ranges[0].canonicalA1Range,
            values: values as never,
          }],
    }
  })
  const env = {
    [STAGING_HYDRATION_GLOBAL_FLAG]: "true",
    [artifact.hydrationFlag]: "true",
    [STAGING_HYDRATION_ENABLED_AT_ENV]: "2026-07-11T12:00:00.000Z",
    [STAGING_HYDRATION_EXPIRES_AT_ENV]: "2026-07-11T12:10:00.000Z",
  }
  return {
    cut,
    clients,
    loadPinnedCut,
    loadKillSwitchStates,
    readCanonicalRanges,
    batchUpdate,
    env,
  }
}

async function run(value: ReturnType<typeof fixture>) {
  return runStagingSheetAcceptance({
    artifactKey: ARTIFACT,
    fingerprintKey: FINGERPRINT_KEY,
    ports: {
      clients: value.clients,
      loadPinnedCut: value.loadPinnedCut,
      loadKillSwitchStates: value.loadKillSwitchStates,
      canonical: { readCanonicalRanges: value.readCanonicalRanges },
    },
    env: value.env,
    nowMs: NOW,
  })
}

function facts(truncated: boolean): StagingHydrationFacts {
  const offer = {
    offer_id: "offer-1",
    offer_status: "accepted",
    requisition_id: "1027",
    candidate_name: "Fixture Candidate",
    resolved_at: "2026-07-08T00:00:00.000Z",
    start_date: "2026-08-01",
    created_at: "2026-07-04T00:00:00.000Z",
  } as OfferLifecycleExportRow
  return {
    generatedAt: "2026-07-11T12:00:00.000Z",
    reportingWeekFriday: "2026-07-03",
    quarterStart: "2026-07-01",
    candidateEvents: [],
    offers: [offer],
    scorecards: [],
    reqWeeks: [],
    diagnostics: [{ source: "/offers", records: 1, truncationSuspected: truncated }],
  }
}
