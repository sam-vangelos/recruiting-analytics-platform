import { afterEach, describe, expect, test, vi } from "vitest"

import {
  normalizeStagingSheetStructure,
  STAGING_STRUCTURAL_LITERAL_CELL_FIELDS,
  StagingStructuralNormalizationExecutionError,
  type GoogleSpreadsheet,
  type GoogleWorkspaceStagingClients,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import {
  buildSheetStructureSnapshot,
  SHEET_STRUCTURE_CELL_FIELDS,
  SHEET_STRUCTURE_COLUMN_METADATA_FIELDS,
  SHEET_STRUCTURE_METADATA_FIELDS,
} from "../lib/recruiting-ops/delivery/sheet-structure-snapshot"
import {
  getStagingArtifact,
  STAGING_HYDRATION_ENABLED_AT_ENV,
  STAGING_HYDRATION_EXPIRES_AT_ENV,
  STAGING_HYDRATION_GLOBAL_FLAG,
} from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import {
  allHiresNormalizationSpec,
  type StagingStructuralNormalizationSpec,
} from "../lib/recruiting-ops/delivery/staging-structural-normalization"
import {
  stagingStructuralNormalizationFingerprint,
  type StagingStructuralWritePermit,
} from "../lib/recruiting-ops/delivery/staging-structural-write-permit"

const NOW = Date.parse("2026-07-11T12:01:00.000Z")
const artifact = getStagingArtifact("all_hires")

function workbook(options: {
  normalized?: boolean
  sentinelTitle?: string
  pivotEndRowIndex?: number
} = {}): GoogleSpreadsheet {
  const source = {
    sheetId: 1324142221,
    startRowIndex: 0,
    ...(options.normalized
      ? {}
      : { endRowIndex: options.pivotEndRowIndex ?? 36 }),
    startColumnIndex: 0,
    endColumnIndex: 9,
  }
  return {
    spreadsheetId: artifact.artifactId,
    properties: { title: "Copy of All Hires", locale: "en_US", timeZone: "UTC" },
    sheets: [
      {
        properties: {
          sheetId: 1324142221,
          title: "Data sheet",
          index: 0,
          sheetType: "GRID",
          gridProperties: { rowCount: 1009, columnCount: 29 },
        },
      },
      {
        properties: {
          sheetId: 461163475,
          title: "Pivot Table 2",
          index: 1,
          sheetType: "GRID",
          gridProperties: { rowCount: 1000, columnCount: 20 },
        },
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowData: [{ values: [{ pivotTable: { source } }] }],
          },
        ],
      },
      {
        properties: {
          sheetId: 900000001,
          title: options.sentinelTitle ?? "Unrelated audit tab",
          index: 2,
          sheetType: "GRID",
          gridProperties: { rowCount: 50, columnCount: 5 },
        },
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowData: [{ values: [{ userEnteredValue: { formulaValue: "=1+1" } }] }],
          },
        ],
      },
    ],
  }
}

function driveMetadata(version: string) {
  return {
    id: artifact.artifactId,
    version,
    trashed: false,
    capabilities: { canEdit: true, canModifyContent: true },
  }
}

function dataFilterProjection(
  snapshot: GoogleSpreadsheet,
  request: {
    fields?: string
    requestBody: { dataFilters: Array<{ gridRange: Record<string, number> }> }
  }
): GoogleSpreadsheet {
  const ranges = request.requestBody.dataFilters.map((filter) => filter.gridRange)
  const requestedSheetIds = new Set(ranges.map((range) => range.sheetId))
  return {
    sheets: (snapshot.sheets ?? [])
      .filter((sheet) => requestedSheetIds.has(sheet.properties?.sheetId as number))
      .map((sheet) => ({
        properties: { sheetId: sheet.properties?.sheetId },
        data: (sheet.data ?? []).map((grid) => {
          if (request.fields === SHEET_STRUCTURE_COLUMN_METADATA_FIELDS) {
            return {
              startColumn: grid.startColumn,
              columnMetadata: structuredClone(grid.columnMetadata ?? []),
            }
          }
          const startRow = grid.startRow ?? 0
          const startColumn = grid.startColumn ?? 0
          return {
            startRow: grid.startRow,
            startColumn: grid.startColumn,
            ...(request.fields === SHEET_STRUCTURE_CELL_FIELDS
              ? { rowMetadata: structuredClone(grid.rowMetadata ?? []) }
              : {}),
            rowData: (grid.rowData ?? []).map((row, rowOffset) => ({
              values: (row.values ?? []).map((cell, columnOffset) => {
                const rowIndex = startRow + rowOffset
                const columnIndex = startColumn + columnOffset
                if (request.fields === STAGING_STRUCTURAL_LITERAL_CELL_FIELDS) {
                  const sanctioned = ranges.some(
                    (range) =>
                      range.sheetId === sheet.properties?.sheetId &&
                      rowIndex >= (range.startRowIndex ?? 0) &&
                      rowIndex < (range.endRowIndex ?? 0) &&
                      columnIndex >= (range.startColumnIndex ?? 0) &&
                      columnIndex < (range.endColumnIndex ?? 0)
                  )
                  if (!sanctioned) return {}
                  const entered = cell.userEnteredValue
                  return {
                    ...(cell.note === undefined ? {} : { note: cell.note }),
                    ...(entered?.stringValue !== undefined ||
                    entered?.numberValue !== undefined ||
                    entered?.boolValue !== undefined
                      ? {
                          userEnteredValue: {
                            ...(entered.stringValue === undefined ? {} : { stringValue: entered.stringValue }),
                            ...(entered.numberValue === undefined ? {} : { numberValue: entered.numberValue }),
                            ...(entered.boolValue === undefined ? {} : { boolValue: entered.boolValue }),
                          },
                        }
                      : {}),
                  }
                }
                return {
                  ...(cell.userEnteredValue?.formulaValue === undefined
                    ? {}
                    : { userEnteredValue: { formulaValue: cell.userEnteredValue.formulaValue } }),
                  ...(cell.userEnteredFormat === undefined
                    ? {}
                    : { userEnteredFormat: structuredClone(cell.userEnteredFormat) }),
                  ...(cell.textFormatRuns === undefined
                    ? {}
                    : { textFormatRuns: structuredClone(cell.textFormatRuns) }),
                  ...(cell.dataValidation === undefined
                    ? {}
                    : { dataValidation: structuredClone(cell.dataValidation) }),
                  ...(cell.pivotTable === undefined
                    ? {}
                    : { pivotTable: structuredClone(cell.pivotTable) }),
                }
              }),
            })),
          }
        }),
      })),
  }
}

function fixture(options: {
  initial?: GoogleSpreadsheet
  post?: GoogleSpreadsheet
  recovered?: GoogleSpreadsheet
  snapshotSequence?: readonly GoogleSpreadsheet[]
  permitDriveVersion?: string
  driveVersions?: string[]
  expectedStatus?: StagingStructuralWritePermit["expectedStatus"]
  sourceGeneratedAt?: string
} = {}) {
  const spec = allHiresNormalizationSpec()
  const initial = options.initial ?? workbook()
  const snapshots =
    options.snapshotSequence ??
    [initial, options.post, options.recovered].filter(
      (value): value is GoogleSpreadsheet => value !== undefined
    )
  const versions = options.driveVersions ?? ["10", "10", "11", "11", "12", "12"]
  let snapshotRead = 0
  let versionRead = 0
  let activeSnapshot = initial
  const batchUpdate = vi.fn(async (request: unknown) => {
    void request
    return { data: {} }
  })
  const getByDataFilter = vi.fn(async (request: {
    fields?: string
    requestBody: { dataFilters: Array<{ gridRange: Record<string, number> }> }
  }) => ({ data: dataFilterProjection(activeSnapshot, request) }))
  const clients = {
    drive: {
      files: {
        get: vi.fn(async () => ({
          data: driveMetadata(versions[Math.min(versionRead++, versions.length - 1)]),
        })),
      },
    },
    docs: {},
    sheets: {
      spreadsheets: {
        get: vi.fn(async () => {
          activeSnapshot = snapshots[Math.min(snapshotRead++, snapshots.length - 1)]
          return { data: activeSnapshot }
        }),
        getByDataFilter,
        batchUpdate,
      },
    },
  } as unknown as GoogleWorkspaceStagingClients
  const permit: StagingStructuralWritePermit = {
    artifactKey: spec.artifactKey,
    artifactId: spec.spreadsheetId,
    kind: "google_sheet",
    normalizationId: spec.id,
    normalizationFingerprint: stagingStructuralNormalizationFingerprint(spec),
    expectedStatus: options.expectedStatus ?? "planned",
    observedStructureFingerprint: buildSheetStructureSnapshot(initial).structureHash,
    expectedDriveVersion: options.permitDriveVersion ?? "10",
    runId: "structural_20260711120000000",
    sourceGeneratedAt: options.sourceGeneratedAt ?? "2026-07-11T10:30:00.000Z",
    issuedAt: "2026-07-11T12:00:10.000Z",
    expiresAt: "2026-07-11T12:10:10.000Z",
    killSwitchStoreReachable: true,
    killSwitchClear: true,
    canonicalOnly: true,
  }
  const env = {
    [STAGING_HYDRATION_GLOBAL_FLAG]: "true",
    [artifact.hydrationFlag]: "true",
    [STAGING_HYDRATION_ENABLED_AT_ENV]: "2026-07-11T12:00:00.000Z",
    [STAGING_HYDRATION_EXPIRES_AT_ENV]: "2026-07-11T12:10:00.000Z",
  }
  return {
    spec,
    permit,
    env,
    clients,
    batchUpdate,
    getByDataFilter,
    currentTimeMs: () => NOW,
    revalidateKillSwitchClear: async () => {},
  }
}

describe("guarded Google Workspace staging structural writer", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test("normalizes the exact registered copy through one bounded mutation call", async () => {
    const value = fixture({ post: workbook({ normalized: true }) })
    const summary = await normalizeStagingSheetStructure({ ...value, nowMs: NOW })

    expect(summary).toMatchObject({
      artifactKey: "all_hires",
      status: "normalized",
      mutationCallCount: 1,
      rollbackAttempted: false,
      forwardRequestCount: 1,
      rollbackRequestCount: 1,
      nonApprovedStructureUnchanged: true,
    })
    expect(summary.beforeStructureFingerprint).toMatch(/^sha256:/)
    expect(summary.afterStructureFingerprint).toMatch(/^sha256:/)
    expect(value.batchUpdate).toHaveBeenCalledTimes(1)
    expect(value.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: artifact.artifactId,
      requestBody: {
        includeSpreadsheetInResponse: false,
        requests: value.spec.forwardRequests,
      },
    })
    expect(value.clients.sheets.spreadsheets.get).toHaveBeenCalledWith({
      spreadsheetId: artifact.artifactId,
      includeGridData: false,
      fields: SHEET_STRUCTURE_METADATA_FIELDS,
    })
    const boundedReads = value.getByDataFilter.mock.calls
    expect(boundedReads.some(([request]) => request.fields === SHEET_STRUCTURE_COLUMN_METADATA_FIELDS)).toBe(true)
    expect(boundedReads.some(([request]) => request.fields === SHEET_STRUCTURE_CELL_FIELDS)).toBe(true)
    expect(boundedReads.some(([request]) => request.fields === STAGING_STRUCTURAL_LITERAL_CELL_FIELDS)).toBe(false)
  })

  test("rechecks the short-lived permit at the actual structural mutation boundary", async () => {
    const value = fixture()
    const times = [NOW, Date.parse("2026-07-11T12:10:11.000Z")]
    await expect(normalizeStagingSheetStructure({
      ...value,
      nowMs: NOW,
      currentTimeMs: () => times.shift() ?? NOW,
    })).rejects.toBeInstanceOf(StagingStructuralNormalizationExecutionError)
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("rechecks source freshness at the actual structural mutation boundary", async () => {
    const value = fixture({ sourceGeneratedAt: "2026-07-11T10:01:30.000Z" })
    const times = [NOW, Date.parse("2026-07-11T12:02:00.000Z")]
    await expect(normalizeStagingSheetStructure({
      ...value,
      nowMs: NOW,
      currentTimeMs: () => times.shift() ?? NOW,
    })).rejects.toBeInstanceOf(StagingStructuralNormalizationExecutionError)
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("does not roll back when the kill switch blocks before the forward call", async () => {
    const value = fixture()
    value.revalidateKillSwitchClear = async () => {
      vi.mocked(value.clients.sheets.spreadsheets.get).mockRejectedValue(
        new Error("recovery read must not run")
      )
      throw new Error("kill switch engaged")
    }

    await expect(
      normalizeStagingSheetStructure({ ...value, nowMs: NOW })
    ).rejects.toMatchObject({
      failureStage: "forward_mutation",
      mutationCallCount: 0,
      rollbackAttempted: false,
      safePreimageVerified: true,
      beforeDriveVersion: "10",
      afterDriveVersion: "10",
      certificationStatus: "not_attempted",
    })
    expect(value.clients.sheets.spreadsheets.get).toHaveBeenCalledTimes(1)
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test.each([
    ["canonical", "1ExampleDriveId00000000000000000000000000020"],
    ["unknown", "unknown-copy-id"],
  ])("rejects a %s spreadsheet id before any Google access", async (_name, spreadsheetId) => {
    const value = fixture()
    const invalid = structuredClone(value.spec) as StagingStructuralNormalizationSpec
    ;(invalid as { spreadsheetId: string }).spreadsheetId = spreadsheetId
    ;(invalid.expectedBefore as { spreadsheetId: string }).spreadsheetId = spreadsheetId
    ;(invalid.expectedAfter as { spreadsheetId: string }).spreadsheetId = spreadsheetId

    await expect(
      normalizeStagingSheetStructure({ ...value, spec: invalid, nowMs: NOW })
    ).rejects.toThrow("registered staging spreadsheet")
    expect(value.clients.drive.files.get).not.toHaveBeenCalled()
    expect(value.clients.sheets.spreadsheets.get).not.toHaveBeenCalled()
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("rejects a stale authorized Drive version before mutation", async () => {
    const value = fixture({ permitDriveVersion: "9" })
    await expect(
      normalizeStagingSheetStructure({ ...value, nowMs: NOW })
    ).rejects.toThrow("Drive version changed after authorization")
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("rejects approved-field and unrelated full-structure preimage drift", async () => {
    const approvedDrift = fixture({
      initial: workbook({ pivotEndRowIndex: 37 }),
    })
    // The permit represents the earlier audited snapshot, not the drifted read.
    approvedDrift.permit.observedStructureFingerprint = buildSheetStructureSnapshot(workbook()).structureHash
    await expect(
      normalizeStagingSheetStructure({ ...approvedDrift, nowMs: NOW })
    ).rejects.toThrow("matches neither exact state")
    expect(approvedDrift.batchUpdate).not.toHaveBeenCalled()

    const unrelatedDrift = fixture({
      initial: workbook({ sentinelTitle: "Concurrent rename" }),
    })
    unrelatedDrift.permit.observedStructureFingerprint = buildSheetStructureSnapshot(workbook()).structureHash
    await expect(
      normalizeStagingSheetStructure({ ...unrelatedDrift, nowMs: NOW })
    ).rejects.toThrow("structure changed after structural authorization")
    expect(unrelatedDrift.batchUpdate).not.toHaveBeenCalled()
  })

  test("declines to compensate a resolved forward write when only the non-approved fingerprint drifted", async () => {
    // The post-state reached the exact expected-after structure; a
    // concurrent rename of an unrelated tab is the only thing that drifted.
    // Once the forward batchUpdate has resolved, that is not ours to roll
    // back: a rollback here would act on someone else's concurrent edit.
    const value = fixture({
      post: workbook({ normalized: true, sentinelTitle: "Concurrent rename" }),
    })

    let failure: unknown
    try {
      await normalizeStagingSheetStructure({ ...value, nowMs: NOW })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(StagingStructuralNormalizationExecutionError)
    expect(failure).toMatchObject({
      failureStage: "post_verification",
      mutationCallCount: 1,
      rollbackAttempted: false,
      rollbackVerified: false,
      safePreimageVerified: false,
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
      certificationStatus: "postimage_verified",
    })
    expect((failure as Error).message).toContain("reason=non_approved_structure_drift")
    expect(value.batchUpdate).toHaveBeenCalledTimes(1)
    expect(value.batchUpdate.mock.calls[0][0]).toMatchObject({
      spreadsheetId: artifact.artifactId,
      requestBody: { requests: value.spec.forwardRequests },
    })
  })

  test("re-reads the post-state when the writer's own Drive version is still propagating", async () => {
    vi.useFakeTimers()
    const value = fixture({
      post: workbook({ normalized: true }),
      driveVersions: ["10", "10", "10", "10", "11", "11"],
    })

    const pending = normalizeStagingSheetStructure({ ...value, nowMs: NOW })
    await vi.runAllTimersAsync()
    const summary = await pending

    expect(summary).toMatchObject({
      status: "normalized",
      mutationCallCount: 1,
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
    })
    expect(value.batchUpdate).toHaveBeenCalledTimes(1)
    expect(value.clients.drive.files.get).toHaveBeenCalledTimes(6)
    expect(value.clients.sheets.spreadsheets.get).toHaveBeenCalledTimes(2)
  })

  test("accepts a resolved structural mutation after delayed Drive publication", async () => {
    vi.useFakeTimers()
    const value = fixture({
      post: workbook({ normalized: true }),
      driveVersions: [...Array(30).fill("10"), "11", "11"],
    })

    const pending = normalizeStagingSheetStructure({ ...value, nowMs: NOW })
    await vi.runAllTimersAsync()
    const summary = await pending

    expect(summary).toMatchObject({
      status: "normalized",
      mutationCallCount: 1,
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
    })
    expect(value.batchUpdate).toHaveBeenCalledTimes(1)
    expect(value.clients.drive.files.get).toHaveBeenCalledTimes(32)
  })

  test("retries an advanced stable Drive version until Sheets projects the exact after-state", async () => {
    vi.useFakeTimers()
    const initial = workbook()
    const normalized = workbook({ normalized: true })
    const value = fixture({
      initial,
      snapshotSequence: [initial, initial, normalized],
      driveVersions: ["10", "10", "11", "11", "11", "11", "11", "11", "11", "11"],
    })

    const pending = normalizeStagingSheetStructure({ ...value, nowMs: NOW })
    await vi.runAllTimersAsync()
    const summary = await pending

    expect(summary).toMatchObject({
      status: "normalized",
      mutationCallCount: 1,
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
    })
    expect(value.batchUpdate).toHaveBeenCalledTimes(1)
    expect(value.clients.drive.files.get).toHaveBeenCalledTimes(33)
    expect(value.clients.sheets.spreadsheets.get).toHaveBeenCalledTimes(3)
  })

  test("declines to compensate when an advanced stable Drive version persistently projects structural drift", async () => {
    // The post-read never settles into the exact expected-after structure
    // (or the exact preimage) across the whole settlement window. The
    // forward batchUpdate already resolved, so this is certified ambiguous
    // rather than rolled back.
    vi.useFakeTimers()
    const initial = workbook()
    const drifted = workbook({ pivotEndRowIndex: 37 })
    const value = fixture({
      initial,
      snapshotSequence: [initial, drifted, drifted, initial],
      driveVersions: ["10", "10", "11", "11"],
    })

    const expectation = expect(
      normalizeStagingSheetStructure({ ...value, nowMs: NOW })
    ).rejects.toMatchObject({
      failureStage: "post_verification",
      mutationCallCount: 1,
      rollbackAttempted: false,
      rollbackVerified: false,
      safePreimageVerified: false,
      certificationStatus: "ambiguous",
    })
    await vi.runAllTimersAsync()
    await expectation

    // No rollback batchUpdate: exactly the one forward call.
    expect(value.batchUpdate).toHaveBeenCalledTimes(1)
  })

  test("declines to compensate a concurrent rename once the writer's own Drive version finishes propagating", async () => {
    // Same shape as "re-reads the post-state when the writer's own Drive
    // version is still propagating" (still green, unchanged): Drive metadata
    // lags before advancing. The only difference is the eventual settled
    // content carries a concurrent rename of an unrelated tab, so once the
    // post-state settles at the exact expected-after structure, the write is
    // certified rather than rolled back.
    vi.useFakeTimers()
    const value = fixture({
      post: workbook({ normalized: true, sentinelTitle: "Concurrent rename" }),
      driveVersions: ["10", "10", "10", "10", "11", "11"],
    })

    const expectation = expect(
      normalizeStagingSheetStructure({ ...value, nowMs: NOW })
    ).rejects.toMatchObject({
      failureStage: "post_verification",
      mutationCallCount: 1,
      rollbackAttempted: false,
      certificationStatus: "postimage_verified",
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
    })
    await vi.runAllTimersAsync()
    await expectation

    expect(value.batchUpdate).toHaveBeenCalledTimes(1)
    expect(value.clients.drive.files.get).toHaveBeenCalledTimes(6)
    expect(value.clients.sheets.spreadsheets.get).toHaveBeenCalledTimes(2)
  })

  test("declines to compensate a concurrent rename discovered only after Sheets catches up to an advanced stable Drive version", async () => {
    // Same shape as "retries an advanced stable Drive version until Sheets
    // projects the exact after-state" (still green, unchanged): Drive
    // advances and stabilizes immediately, but Sheets keeps projecting the
    // preimage for a couple of reads before it catches up. The only
    // difference is the eventual after-state carries a concurrent rename, so
    // settling on it certifies rather than rolls back.
    vi.useFakeTimers()
    const initial = workbook()
    const driftedPost = workbook({ normalized: true, sentinelTitle: "Concurrent rename" })
    const value = fixture({
      initial,
      snapshotSequence: [initial, initial, driftedPost],
      driveVersions: ["10", "10", "11", "11", "11", "11", "11", "11", "11", "11"],
    })

    const expectation = expect(
      normalizeStagingSheetStructure({ ...value, nowMs: NOW })
    ).rejects.toMatchObject({
      failureStage: "post_verification",
      mutationCallCount: 1,
      rollbackAttempted: false,
      certificationStatus: "postimage_verified",
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
    })
    await vi.runAllTimersAsync()
    await expectation

    expect(value.batchUpdate).toHaveBeenCalledTimes(1)
    expect(value.clients.drive.files.get).toHaveBeenCalledTimes(33)
    expect(value.clients.sheets.spreadsheets.get).toHaveBeenCalledTimes(3)
  })

  test("rolls back when the forward mutation rejects ambiguously and the preimage cannot be confirmed intact", async () => {
    // The forward call itself throws (forwardResolved never becomes true),
    // and the first preimage-recovery poll observes a post-normalized
    // structure rather than the original preimage, so recovery cannot prove
    // the write never landed. This is the surviving legitimate rollback: a
    // rollback batchUpdate runs, and the exact preimage republishes.
    vi.useFakeTimers()
    const initial = workbook()
    const post = workbook({ normalized: true })
    const recovered = workbook()
    const value = fixture({
      initial,
      snapshotSequence: [initial, post, post, recovered],
      driveVersions: ["10", "10", "11", "11"],
    })
    value.batchUpdate.mockRejectedValueOnce(new Error("ambiguous network failure"))

    const expectation = expect(
      normalizeStagingSheetStructure({ ...value, nowMs: NOW })
    ).rejects.toMatchObject({
      failureStage: "post_verification",
      mutationCallCount: 2,
      rollbackAttempted: true,
      rollbackVerified: true,
      safePreimageVerified: true,
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
      certificationStatus: "rollback_verified",
    })
    await vi.runAllTimersAsync()
    await expectation

    expect(value.batchUpdate).toHaveBeenCalledTimes(2)
    expect(value.batchUpdate.mock.calls[0][0]).toMatchObject({
      spreadsheetId: artifact.artifactId,
      requestBody: { requests: value.spec.forwardRequests },
    })
    expect(value.batchUpdate.mock.calls[1][0]).toMatchObject({
      spreadsheetId: artifact.artifactId,
      requestBody: { requests: value.spec.rollbackRequests },
    })
  })

  test("declines to compensate when the Drive revision never stabilizes across post-read windows", async () => {
    // The eventual clamped-stable read reflects the untouched preimage (the
    // version metadata never settles during the real window), so the
    // post-state is never observed matching the expected-after structure.
    vi.useFakeTimers()
    const value = fixture({
      post: workbook({ normalized: true }),
      recovered: workbook(),
      driveVersions: [
        "10", "10",
        "11", "12",
        "13", "14",
        "15", "16",
        "17", "18",
        "19", "20",
        "21", "22",
        "23", "23",
      ],
    })

    const expectation = expect(
      normalizeStagingSheetStructure({ ...value, nowMs: NOW })
    ).rejects.toMatchObject({
      failureStage: "post_verification",
      mutationCallCount: 1,
      rollbackAttempted: false,
      certificationStatus: "ambiguous",
    })
    await vi.runAllTimersAsync()
    await expectation
    expect(value.batchUpdate).toHaveBeenCalledTimes(1)
  })

  test("an exact normalized rerun performs zero mutation calls", async () => {
    const normalized = workbook({ normalized: true })
    const value = fixture({
      initial: normalized,
      expectedStatus: "already_normalized",
      driveVersions: ["20", "20"],
      permitDriveVersion: "20",
    })
    const summary = await normalizeStagingSheetStructure({ ...value, nowMs: NOW })

    expect(summary).toMatchObject({
      status: "already_normalized",
      mutationCallCount: 0,
      forwardRequestCount: 0,
      rollbackRequestCount: 0,
    })
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })
})
