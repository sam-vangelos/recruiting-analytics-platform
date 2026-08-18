import { createPayloadFingerprint, stableSerialize } from "../checksums"
import { fridayWeekLabels } from "../exec-definitions"
import { getStagingArtifact, type StagingArtifactKey } from "./staging-artifact-registry"
import { FINAL_OFFER_Q3_SHEET_IDS } from "./staging-sheet-contracts"
import {
  weeklyRecruitmentCycle,
  weeklyRecruitmentSheetTitleEndDate,
} from "./weekly-recruitment-rollover"

/**
 * Google Sheets API v4 batch-update request entries represented
 * as inert data. This module deliberately has no Google client or execution path.
 */
export type GoogleSheetsRequestData = Readonly<Record<string, unknown>>

export interface StagingStructuralNormalizationSpec {
  id: string
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">
  spreadsheetId: string
  expectedBefore: Readonly<Record<string, unknown>>
  expectedAfter: Readonly<Record<string, unknown>>
  forwardRequests: readonly GoogleSheetsRequestData[]
  rollbackRequests: readonly GoogleSheetsRequestData[]
}

export interface StagingStructuralNormalizationPlan {
  id: string
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">
  spreadsheetId: string
  status: "planned" | "already_normalized"
  expectedBefore: Readonly<Record<string, unknown>>
  expectedAfter: Readonly<Record<string, unknown>>
  requests: readonly GoogleSheetsRequestData[]
  rollback: {
    reversible: true
    preimage: Readonly<Record<string, unknown>>
    requests: readonly GoogleSheetsRequestData[]
  }
  requestMetadata: {
    requestShape: "sheets_v4_batch_update_requests"
    preimageFingerprint: string
    afterStateFingerprint: string
    forwardRequestsFingerprint: string
    rollbackRequestsFingerprint: string
    forwardRequestCount: number
    rollbackRequestCount: number
  }
}

/**
 * Produces a fail-closed, one-time migration plan. An exact after-state is an
 * idempotent no-op; anything other than the exact before/after state is drift.
 */
export function planStagingStructuralNormalization(
  spec: StagingStructuralNormalizationSpec,
  observedState: unknown
): StagingStructuralNormalizationPlan {
  assertRegisteredStagingBinding(spec)

  const observed = stableSerialize(observedState)
  const before = stableSerialize(spec.expectedBefore)
  const after = stableSerialize(spec.expectedAfter)
  let status: StagingStructuralNormalizationPlan["status"]

  if (observed === after) status = "already_normalized"
  else if (observed === before) status = "planned"
  else {
    throw new Error(
      `${spec.id} structural precondition drifted; expected the exact audited before-state or exact normalized after-state.`
    )
  }

  const shouldExecute = status === "planned"
  return {
    id: spec.id,
    artifactKey: spec.artifactKey,
    spreadsheetId: spec.spreadsheetId,
    status,
    expectedBefore: spec.expectedBefore,
    expectedAfter: spec.expectedAfter,
    requests: shouldExecute ? spec.forwardRequests : [],
    rollback: {
      reversible: true,
      preimage: spec.expectedBefore,
      requests: shouldExecute ? spec.rollbackRequests : [],
    },
    requestMetadata: {
      requestShape: "sheets_v4_batch_update_requests",
      preimageFingerprint: createPayloadFingerprint(spec.expectedBefore),
      afterStateFingerprint: createPayloadFingerprint(spec.expectedAfter),
      forwardRequestsFingerprint: createPayloadFingerprint(spec.forwardRequests),
      rollbackRequestsFingerprint: createPayloadFingerprint(spec.rollbackRequests),
      forwardRequestCount: spec.forwardRequests.length,
      rollbackRequestCount: spec.rollbackRequests.length,
    },
  }
}

/**
 * Reusable copy-only lifecycle step for a Weekly Recruitment Fri-Thu tab. The
 * caller-selected predecessor (the newest tab strictly before the target week,
 * not necessarily the immediately preceding one) is duplicated at index zero
 * so all legacy formatting, filter views, and human-owned columns carry
 * forward before bounded hydration.
 */
export function weeklyRecruitmentRolloverNormalizationSpec(input: {
  reportingWeekFriday: string
  predecessorSheetId: number
  predecessorSheetTitle: string
}): StagingStructuralNormalizationSpec {
  const artifact = sheetArtifact("weekly_recruitment")
  const cycle = weeklyRecruitmentCycle(input.reportingWeekFriday)
  const predecessorSheetId = requiredSheetId(input.predecessorSheetId, "predecessorSheetId")
  const predecessorSheetTitle = requiredText(
    input.predecessorSheetTitle,
    "predecessorSheetTitle"
  )
  const predecessorEndDate = weeklyRecruitmentSheetTitleEndDate(predecessorSheetTitle)
  if (
    predecessorEndDate === null ||
    Date.parse(`${predecessorEndDate}T00:00:00.000Z`) >=
      Date.parse(`${cycle.reportingWeekFriday}T00:00:00.000Z`)
  ) {
    throw new Error(
      `Weekly Recruitment predecessor must end strictly before ${cycle.reportingWeekFriday}.`
    )
  }
  if (predecessorSheetId === cycle.targetSheetId) {
    throw new Error("Weekly Recruitment predecessor and target sheet ids must differ.")
  }

  const predecessor = {
    sheetId: predecessorSheetId,
    sheetTitle: predecessorSheetTitle,
    reportingWeekThursday: predecessorEndDate,
  }
  const target = {
    sheetId: cycle.targetSheetId,
    sheetTitle: cycle.targetSheetTitle,
    reportingWeekFriday: cycle.reportingWeekFriday,
    reportingWeekThursday: cycle.reportingWeekThursday,
  }

  return {
    id: `weekly_recruitment_rollover_${cycle.reportingWeekFriday.replaceAll("-", "")}`,
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    expectedBefore: boundState(artifact.key, artifact.artifactId, {
      weeklyRecruitmentRollover: {
        reportingWeekFriday: cycle.reportingWeekFriday,
        predecessor: { ...predecessor, sheetIndex: 0 },
        targetSheetAbsent: target,
      },
    }),
    expectedAfter: boundState(artifact.key, artifact.artifactId, {
      weeklyRecruitmentRollover: {
        reportingWeekFriday: cycle.reportingWeekFriday,
        predecessor: { ...predecessor, sheetIndex: 1 },
        targetSheet: {
          ...target,
          sheetIndex: 0,
          duplicatedFromSheetId: predecessorSheetId,
        },
      },
    }),
    forwardRequests: [
      duplicateSheetRequest(
        predecessorSheetId,
        cycle.targetSheetId,
        cycle.targetSheetTitle,
        0
      ),
    ],
    rollbackRequests: [deleteSheetRequest(cycle.targetSheetId)],
  }
}

export function weeklyProgressNormalizationSpec(input: {
  currentWeekHeader: string
}): StagingStructuralNormalizationSpec {
  const artifact = sheetArtifact("weekly_progress")
  const currentWeekHeader = requiredText(input.currentWeekHeader, "currentWeekHeader")
  const sheets = [
    {
      sheetId: 0,
      sheetTitle: "FDL (Code + RL)",
      insertionColumnIndex: 25,
      qtdBeforeColumn: "Z",
      qtdAfterColumn: "AA",
      qtdFormulas: [
        "=SUM(B2:M2)",
        "=SUM(B3:M3)",
        "=SUM(B4:M4)",
        "=SUM(B5:O5)",
        "=SUM(B6:P6)",
        "=SUM(B7:T7)",
        "=SUM(B8:Y8)",
      ],
    },
    {
      sheetId: 1450892249,
      sheetTitle: "FDL (Brazil + Colombia)",
      insertionColumnIndex: 16,
      qtdBeforeColumn: "Q",
      qtdAfterColumn: "R",
      qtdFormulas: [
        "=SUM(C2:I2)",
        "=SUM(C3:I3)",
        "=SUM(C4:H4)",
        "=SUM(C5:I5)",
        "=SUM(C6:M6)",
        "=SUM(C7:H7)",
        "=SUM(C8:I8)",
      ],
    },
  ] as const

  return {
    id: "weekly_progress_insert_current_week_before_qtd",
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    expectedBefore: boundState(artifact.key, artifact.artifactId, {
      sheets: sheets.map((sheet) => ({
        sheetId: sheet.sheetId,
        sheetTitle: sheet.sheetTitle,
        currentWeekColumnAbsent: true,
        qtd: {
          column: sheet.qtdBeforeColumn,
          header: "QTD",
          formulas: sheet.qtdFormulas,
        },
      })),
    }),
    expectedAfter: boundState(artifact.key, artifact.artifactId, {
      sheets: sheets.map((sheet) => ({
        sheetId: sheet.sheetId,
        sheetTitle: sheet.sheetTitle,
        currentWeek: {
          columnIndex: sheet.insertionColumnIndex,
          header: currentWeekHeader,
        },
        qtd: {
          column: sheet.qtdAfterColumn,
          header: "QTD",
          formulas: sheet.qtdFormulas,
          shiftedByInsertedColumn: true,
        },
      })),
    }),
    forwardRequests: sheets.flatMap((sheet) => [
      insertColumnRequest(sheet.sheetId, sheet.insertionColumnIndex),
      writeCellRequest(sheet.sheetId, 0, sheet.insertionColumnIndex, currentWeekHeader),
    ]),
    rollbackRequests: [...sheets]
      .reverse()
      .map((sheet) => deleteColumnRequest(sheet.sheetId, sheet.insertionColumnIndex)),
  }
}

export interface WeeklyProgressLifecycleSheet {
  sheetId: number
  sheetTitle: string
  headers: readonly (string | null)[]
  qtdFormulas: readonly string[]
}

export interface WeeklyProgressQuarterOpeningOffsets {
  sheetId: number
  rowOffsets: readonly number[]
}

export interface WeeklyProgressQuarterClosingOffsets {
  sheetId: number
  rowOffsets: readonly number[]
}

export type WeeklyProgressRolloverPlan =
  | {
      status: "already_normalized"
      reportingWeekFriday: string
      weekHeader: string
      preservedSheetIds: readonly number[]
      spec: null
    }
  | {
      status: "planned"
      reportingWeekFriday: string
      weekHeader: string
      preservedSheetIds: readonly number[]
      spec: StagingStructuralNormalizationSpec
    }

const WEEKLY_PROGRESS_LIFECYCLE_SHEETS = [
  { sheetId: 0, sheetTitle: "FDL (Code + RL)", formulaRowCount: 7 },
  { sheetId: 242118538, sheetTitle: "FDE/PE", formulaRowCount: 6 },
  { sheetId: 1450892249, sheetTitle: "FDL (Brazil + Colombia)", formulaRowCount: 7 },
] as const

/**
 * Plans the recurring Weekly Progress column rollover from the three copied
 * tabs' live row-one/QTD observations. Existing period columns are retained;
 * missing current-week columns are inserted and stale calendar-QTD formulas
 * are corrected without reinserting an existing period.
 */
export function planWeeklyProgressRolloverNormalization(input: {
  reportingWeekFriday: string
  sheets: readonly WeeklyProgressLifecycleSheet[]
  quarterOpeningOffsets?: readonly WeeklyProgressQuarterOpeningOffsets[]
  quarterClosingOffsets?: readonly WeeklyProgressQuarterClosingOffsets[]
}): WeeklyProgressRolloverPlan {
  const artifact = sheetArtifact("weekly_progress")
  const weekHeader = weeklyProgressHeaderForReportingWeek(input.reportingWeekFriday)
  const openingOffsets = weeklyProgressQuarterOpeningOffsets(
    input.reportingWeekFriday,
    input.quarterOpeningOffsets
  )
  const closingOffsets = weeklyProgressQuarterClosingOffsets(
    input.reportingWeekFriday,
    input.quarterClosingOffsets
  )
  const byId = new Map(input.sheets.map((sheet) => [sheet.sheetId, sheet] as const))
  if (byId.size !== input.sheets.length) {
    throw new Error("Weekly Progress lifecycle discovery contains duplicate sheet ids.")
  }

  const changes = WEEKLY_PROGRESS_LIFECYCLE_SHEETS.flatMap((contract) => {
    const sheet = byId.get(contract.sheetId)
    if (!sheet || sheet.sheetTitle !== contract.sheetTitle) {
      throw new Error(`Weekly Progress lifecycle requires exact copied tab ${contract.sheetTitle}.`)
    }
    const headers = sheet.headers.map((value) => value?.trim() ?? "")
    const qtdColumns = headers.flatMap((value, index) => value === "QTD" ? [index] : [])
    if (qtdColumns.length !== 1 || qtdColumns[0] === 0) {
      throw new Error(`${contract.sheetTitle} must contain exactly one non-leading QTD column.`)
    }
    const weekColumns = headers.flatMap((value, index) =>
      weeklyProgressHeaderIdentifiesReportingWeek(value, input.reportingWeekFriday)
        ? [index]
        : []
    )
    if (weekColumns.length > 1) {
      throw new Error(`${contract.sheetTitle} contains an ambiguous ${weekHeader} column.`)
    }
    if (
      sheet.qtdFormulas.length !== contract.formulaRowCount ||
      sheet.qtdFormulas.some((formula) => !formula.startsWith("="))
    ) {
      throw new Error(`${contract.sheetTitle} QTD formula block is incomplete.`)
    }
    if (weekColumns.length === 1) {
      // The target week's column is not necessarily the newest. Once a skipped
      // week has been inserted in date order, a later week's column sits between
      // it and QTD, so requiring adjacency to QTD would reject the very column
      // the backfill just created. What has to hold is that the column belongs
      // to the quarter's contiguous retained block -- which
      // weeklyProgressRetainedQuarterColumns proves, rejecting both an
      // unrecognized column inside the span and an out-of-order one.
      const retained = weeklyProgressRetainedQuarterColumns(
        contract.sheetTitle,
        headers,
        qtdColumns[0],
        // The full calendar quarter, not just the weeks up to the target: a week
        // newer than the one being written is legitimately retained after a
        // backfill, and scanning only through the target would read it as an
        // unrecognized column.
        weeklyProgressFullQuarterWeeks(input.reportingWeekFriday)
      )
      if (!retained.some((entry) => entry.columnIndex === weekColumns[0])) {
        throw new Error(
          `${contract.sheetTitle} ${weekHeader} column is outside the reporting-quarter columns.`
        )
      }
      const quarterStartColumnIndex = retained[0].columnIndex
      // QTD spans the whole retained quarter, through its newest week, never
      // stopping at the week being written. For the newest week these are the
      // same column, so this is the general form of the same total.
      const quarterEndColumnIndex = retained[retained.length - 1].columnIndex
      const expectedFormulas = weeklyProgressQtdFormulas(
        contract.formulaRowCount,
        quarterStartColumnIndex,
        quarterEndColumnIndex,
        openingOffsets.get(contract.sheetId) as readonly number[],
        closingOffsets.get(contract.sheetId) as readonly number[]
      )
      if (sheet.qtdFormulas.every((formula, index) => formula === expectedFormulas[index])) return []
      return [{
        ...contract,
        insertCurrentWeek: false,
        currentWeekColumnIndex: weekColumns[0],
        currentWeekHeader: headers[weekColumns[0]],
        qtdBeforeColumnIndex: qtdColumns[0],
        qtdAfterColumnIndex: qtdColumns[0],
        qtdBeforeFormulas: [...sheet.qtdFormulas],
        qtdAfterFormulas: expectedFormulas,
      }]
    }
    // The target week may not be the newest: a later week's column can already
    // be retained (e.g. backfilling a week the scheduled job skipped, after a
    // subsequent cycle already ran). Scan the full calendar-quarter week set
    // -- not just weeks at or before the target -- so a later retained column
    // is recognized rather than rejected, and the insert lands in date order.
    const retained = weeklyProgressRetainedQuarterColumns(
      contract.sheetTitle,
      headers,
      qtdColumns[0],
      weeklyProgressFullQuarterWeeks(input.reportingWeekFriday)
    )
    const targetFridayMs = Date.parse(`${input.reportingWeekFriday}T00:00:00.000Z`)
    const olderRetained = retained.filter(
      (entry) => Date.parse(`${entry.reportingWeekFriday}T00:00:00.000Z`) < targetFridayMs
    )
    const newerRetained = retained.filter(
      (entry) => Date.parse(`${entry.reportingWeekFriday}T00:00:00.000Z`) > targetFridayMs
    )
    const insertColumnIndex = newerRetained.length > 0
      ? newerRetained[0].columnIndex
      : qtdColumns[0]
    const qtdStartColumnIndex = olderRetained.length > 0
      ? olderRetained[0].columnIndex
      : insertColumnIndex
    const qtdEndColumnIndexAfterInsert = newerRetained.length > 0
      ? newerRetained[newerRetained.length - 1].columnIndex + 1
      : insertColumnIndex
    return [{
      ...contract,
      insertCurrentWeek: true,
      currentWeekColumnIndex: insertColumnIndex,
      currentWeekHeader: weekHeader,
      qtdBeforeColumnIndex: qtdColumns[0],
      qtdAfterColumnIndex: qtdColumns[0] + 1,
      qtdBeforeFormulas: [...sheet.qtdFormulas],
      qtdAfterFormulas: weeklyProgressQtdFormulas(
        contract.formulaRowCount,
        qtdStartColumnIndex,
        qtdEndColumnIndexAfterInsert,
        openingOffsets.get(contract.sheetId) as readonly number[],
        closingOffsets.get(contract.sheetId) as readonly number[]
      ),
    }]
  })

  const preservedSheetIds = WEEKLY_PROGRESS_LIFECYCLE_SHEETS.map(({ sheetId }) => sheetId)
  if (changes.length === 0) {
    return {
      status: "already_normalized",
      reportingWeekFriday: input.reportingWeekFriday,
      weekHeader,
      preservedSheetIds,
      spec: null,
    }
  }

  const expectedSheets = changes.map((sheet) => ({
    sheetId: sheet.sheetId,
    sheetTitle: sheet.sheetTitle,
    insertCurrentWeek: sheet.insertCurrentWeek,
    currentWeekColumnIndex: sheet.currentWeekColumnIndex,
    currentWeekHeader: sheet.currentWeekHeader,
    qtdBeforeColumnIndex: sheet.qtdBeforeColumnIndex,
    qtdAfterColumnIndex: sheet.qtdAfterColumnIndex,
    qtdBeforeColumn: spreadsheetColumnLabel(sheet.qtdBeforeColumnIndex),
    qtdAfterColumn: spreadsheetColumnLabel(sheet.qtdAfterColumnIndex),
    qtdBeforeFormulas: sheet.qtdBeforeFormulas,
    qtdAfterFormulas: sheet.qtdAfterFormulas,
  }))
  const spec: StagingStructuralNormalizationSpec = {
    id: `weekly_progress_rollover_${input.reportingWeekFriday.replaceAll("-", "")}`,
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    expectedBefore: boundState(artifact.key, artifact.artifactId, {
      sheets: expectedSheets.map((sheet) => ({
        sheetId: sheet.sheetId,
        sheetTitle: sheet.sheetTitle,
        ...(sheet.insertCurrentWeek
          ? { currentWeekColumnAbsent: true }
          : {
              currentWeek: {
                columnIndex: sheet.currentWeekColumnIndex,
                header: sheet.currentWeekHeader,
              },
            }),
        qtd: {
          column: sheet.qtdBeforeColumn,
          header: "QTD",
          formulas: sheet.qtdBeforeFormulas,
        },
      })),
    }),
    expectedAfter: boundState(artifact.key, artifact.artifactId, {
      sheets: expectedSheets.map((sheet) => ({
        sheetId: sheet.sheetId,
        sheetTitle: sheet.sheetTitle,
        currentWeek: {
          columnIndex: sheet.currentWeekColumnIndex,
          header: sheet.currentWeekHeader,
        },
        currentWeekColumnInserted: sheet.insertCurrentWeek,
        qtd: {
          column: sheet.qtdAfterColumn,
          header: "QTD",
          formulas: sheet.qtdAfterFormulas,
          ...(sheet.insertCurrentWeek ? { shiftedByInsertedColumn: true } : {}),
        },
      })),
    }),
    forwardRequests: expectedSheets.flatMap((sheet) => sheet.insertCurrentWeek
      ? [
          insertColumnRequest(sheet.sheetId, sheet.currentWeekColumnIndex),
          writeCellRequest(sheet.sheetId, 0, sheet.currentWeekColumnIndex, sheet.currentWeekHeader),
          writeFormulaColumnRequest(
            sheet.sheetId,
            1,
            sheet.qtdAfterColumnIndex,
            sheet.qtdAfterFormulas
          ),
        ]
      : [
          writeFormulaColumnRequest(
            sheet.sheetId,
            1,
            sheet.qtdAfterColumnIndex,
            sheet.qtdAfterFormulas
          ),
        ]),
    rollbackRequests: [...expectedSheets]
      .reverse()
      .flatMap((sheet) => [
        ...(sheet.insertCurrentWeek
          ? [deleteColumnRequest(sheet.sheetId, sheet.currentWeekColumnIndex)]
          : []),
        writeFormulaColumnRequest(
          sheet.sheetId,
          1,
          sheet.qtdBeforeColumnIndex,
          sheet.qtdBeforeFormulas
        ),
      ]),
  }
  return {
    status: "planned",
    reportingWeekFriday: input.reportingWeekFriday,
    weekHeader,
    preservedSheetIds,
    spec,
  }
}

export function allHiresNormalizationSpec(): StagingStructuralNormalizationSpec {
  const artifact = sheetArtifact("all_hires")
  const beforeSource = gridRange(1324142221, 0, 36, 0, 9)
  const afterSource = gridRange(1324142221, 0, undefined, 0, 9)
  return pivotOpenRangeSpec({
    id: "all_hires_open_pivot_source_a_i",
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    pivotSheetId: 461163475,
    pivotSheetTitle: "Pivot Table 2",
    anchor: "A1",
    sourceSheetTitle: "Data sheet",
    beforeSource,
    afterSource,
  })
}

export function rpsTrackingNormalizationSpec(): StagingStructuralNormalizationSpec {
  const artifact = sheetArtifact("rps_tracking")
  return pivotOpenRangeSpec({
    id: "rps_tracking_open_pivot_source_a_r",
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    pivotSheetId: 855929445,
    pivotSheetTitle: "RPS Table",
    anchor: "A1",
    sourceSheetTitle: "Data Dump",
    beforeSource: gridRange(1092300150, 0, 4000, 0, 18),
    afterSource: gridRange(1092300150, 0, undefined, 0, 18),
  })
}

export const RPS_TRACKING_MIN_DATA_ROW_HEADROOM = 1_000

export interface RpsTrackingLifecycleSheet {
  dataSheetId: number
  dataSheetTitle: string
  dataRowCount: number
  dataColumnCount: number
  pivotSheetId: number
  pivotSheetTitle: string
  pivotSource: Readonly<Record<string, number>>
}

/**
 * Keeps the copied continuous RPS ledger writable and its pivot source open.
 * The observed grid is only extended; populated history is never moved or
 * deleted. A bounded reserve avoids a structural write for every new row.
 */
export function rpsTrackingCapacityNormalizationSpec(input: {
  requiredDataRows: number
  sheet: RpsTrackingLifecycleSheet
}): StagingStructuralNormalizationSpec | null {
  const artifact = sheetArtifact("rps_tracking")
  const requiredDataRows = input.requiredDataRows
  const sheet = input.sheet
  if (!Number.isInteger(requiredDataRows) || requiredDataRows < 0) {
    throw new Error("RPS Tracking required data rows must be a non-negative integer.")
  }
  if (
    sheet.dataSheetId !== 1092300150 ||
    sheet.dataSheetTitle !== "Data Dump" ||
    !Number.isInteger(sheet.dataRowCount) ||
    sheet.dataRowCount < 1 ||
    sheet.dataColumnCount !== 18 ||
    sheet.pivotSheetId !== 855929445 ||
    sheet.pivotSheetTitle !== "RPS Table"
  ) {
    throw new Error("RPS Tracking lifecycle is not bound to the exact copied Data Dump and pivot tabs.")
  }

  const rawPivotSource = { ...sheet.pivotSource }
  const pivotEndRow = rawPivotSource.endRowIndex
  if (
    rawPivotSource.sheetId !== sheet.dataSheetId ||
    (rawPivotSource.startRowIndex ?? 0) !== 0 ||
    (rawPivotSource.startColumnIndex ?? 0) !== 0 ||
    rawPivotSource.endColumnIndex !== 18 ||
    (pivotEndRow !== undefined && (!Number.isInteger(pivotEndRow) || pivotEndRow <= 0))
  ) {
    throw new Error("RPS Tracking pivot source is outside the exact copied Data Dump A:R contract.")
  }

  const openPivotSource = gridRange(sheet.dataSheetId, 0, undefined, 0, 18)
  const canonicalBeforePivotSource = pivotEndRow === sheet.dataRowCount
    ? openPivotSource
    : rawPivotSource
  const currentDataCapacity = sheet.dataRowCount - 1
  const requiresHeadroom = currentDataCapacity - requiredDataRows < RPS_TRACKING_MIN_DATA_ROW_HEADROOM
  const targetDataCapacity = requiresHeadroom
    ? Math.max(currentDataCapacity, requiredDataRows + RPS_TRACKING_MIN_DATA_ROW_HEADROOM)
    : currentDataCapacity
  const targetRowCount = targetDataCapacity + 1
  const appendedRowCount = targetRowCount - sheet.dataRowCount
  const pivotNeedsOpen = canonicalBeforePivotSource.endRowIndex !== undefined

  if (appendedRowCount === 0 && !pivotNeedsOpen) return null

  const common = {
    requiredDataRows,
    dataSheet: {
      sheetId: sheet.dataSheetId,
      sheetTitle: sheet.dataSheetTitle,
      gridColumnCount: sheet.dataColumnCount,
    },
    pivot: {
      pivotSheetId: sheet.pivotSheetId,
      pivotSheetTitle: sheet.pivotSheetTitle,
      anchor: "A1",
    },
  }
  const forwardRequests: GoogleSheetsRequestData[] = []
  const rollbackRequests: GoogleSheetsRequestData[] = []
  if (appendedRowCount > 0) {
    forwardRequests.push(appendRowsRequest(sheet.dataSheetId, appendedRowCount))
  }
  if (appendedRowCount > 0 || pivotNeedsOpen) {
    forwardRequests.push(updatePivotSourceRequest(sheet.pivotSheetId, openPivotSource))
    rollbackRequests.push(updatePivotSourceRequest(sheet.pivotSheetId, rawPivotSource))
  }
  if (appendedRowCount > 0) {
    rollbackRequests.push(deleteRowsRequest(sheet.dataSheetId, sheet.dataRowCount, targetRowCount))
  }

  return {
    id: `rps_tracking_capacity_${requiredDataRows}_${targetDataCapacity}`,
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    expectedBefore: boundState(artifact.key, artifact.artifactId, {
      rpsTrackingLifecycle: {
        ...common,
        dataSheet: { ...common.dataSheet, gridRowCount: sheet.dataRowCount },
        pivot: { ...common.pivot, source: canonicalBeforePivotSource },
      },
    }),
    expectedAfter: boundState(artifact.key, artifact.artifactId, {
      rpsTrackingLifecycle: {
        ...common,
        dataSheet: { ...common.dataSheet, gridRowCount: targetRowCount },
        pivot: { ...common.pivot, source: openPivotSource },
      },
    }),
    forwardRequests,
    rollbackRequests,
  }
}

/**
 * Current-cycle Delivery hydration writes the existing 09 Jul output tab, so
 * its only required form change is opening the fixed Raw_Daily_RPS A:T filter.
 * This static spec remains usable for that one-time migration; the recurring
 * rollover below reuses the same exact fixed/open range transition when needed.
 */
export function deliveryRpsRawFilterNormalizationSpec(): StagingStructuralNormalizationSpec {
  const artifact = sheetArtifact("delivery_roles_rps")
  const { fixedFilter, openFilter } = deliveryRpsRawFilterRanges()
  return {
    id: "delivery_rps_open_existing_raw_filter_a_t",
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    expectedBefore: boundState(artifact.key, artifact.artifactId, {
      filter: {
        sheetId: 1072762955,
        sheetTitle: "Raw_Daily_RPS",
        basicFilter: fixedFilter,
      },
    }),
    expectedAfter: boundState(artifact.key, artifact.artifactId, {
      filter: {
        sheetId: 1072762955,
        sheetTitle: "Raw_Daily_RPS",
        basicFilter: openFilter,
      },
    }),
    forwardRequests: [setBasicFilterRequest(openFilter)],
    rollbackRequests: [setBasicFilterRequest(fixedFilter)],
  }
}

function deliveryRpsRawFilterRanges() {
  return {
    fixedFilter: gridRange(1072762955, 0, 176, 0, 20),
    openFilter: gridRange(1072762955, 0, undefined, 0, 20),
  }
}

export type PipelineArtifactKey =
  | "pipeline_890"
  | "pipeline_907"
  | "pipeline_1026_1027"
  | "pipeline_1118_1119"

export interface PipelineCandidateLifecycleSheet {
  sheetId: number
  sheetTitle: string
  sheetIndex: number
  gridRowCount: number
  gridColumnCount: number
  basicFilter: Readonly<Record<string, number>> | null
}

export interface PipelineJobSummaryLifecycleSheet {
  sheetId: number
  sheetTitle: string
  gridRowCount: number
  gridColumnCount: number
  basicFilter: Readonly<Record<string, number>> | null
  templateStartRowIndex: number
  appendStartRowIndex: number
  blockRowCount: number
}

export interface DeliveryRpsLifecycleSheet {
  sheetId: number
  sheetTitle: string
  sheetIndex: number
  gridRowCount: number
  gridColumnCount: number
  basicFilter: Readonly<Record<string, number>> | null
}

export interface DeliveryRpsProjectedValueTarget {
  targetSheetId: number
  targetSheetTitle: string
  templateSheetId: number
  templateSheetTitle: string
  firstValueRow: 3
  preservedValueRowCount: 2
}

export interface DeliveryRpsDatedRolloverNormalizationSpec
  extends StagingStructuralNormalizationSpec {
  projectedValueTarget: DeliveryRpsProjectedValueTarget
}

const PIPELINE_CANDIDATE_SHEET_ID_BASE = 1_970_000_000
const PIPELINE_CANDIDATE_SHEET_ID_EPOCH_FRIDAY_MS = Date.UTC(2000, 0, 7)
const DELIVERY_RPS_DATED_SHEET_ID_BASE = 1_980_000_000
const DELIVERY_RPS_DATED_SHEET_ID_EPOCH_MS = Date.UTC(2000, 0, 1)
export const DELIVERY_RPS_DATED_GRID_ROW_COUNT = 1_000
const DAY_MS = 86_400_000

export function deliveryRpsDatedTabTitle(reportDate: string): string {
  return formatDeliveryRpsDatedTab(validIsoDate(reportDate, "Delivery RPS report date"))
}

/** Stable date-owned id; title/id collisions with retained history fail closed. */
export function deliveryRpsTargetSheetId(reportDate: string): number {
  validIsoDate(reportDate, "Delivery RPS report date")
  const dateOrdinal = (Date.parse(`${reportDate}T00:00:00Z`) - DELIVERY_RPS_DATED_SHEET_ID_EPOCH_MS) / DAY_MS
  if (!Number.isSafeInteger(dateOrdinal) || dateOrdinal < 0) {
    throw new Error("Delivery RPS report date is outside the reserved sheet-id epoch.")
  }
  const sheetId = DELIVERY_RPS_DATED_SHEET_ID_BASE + dateOrdinal
  if (sheetId > 2_147_483_647) {
    throw new Error("Delivery RPS target sheet id exceeds the Google Sheets limit.")
  }
  return sheetId
}

/**
 * Duplicates the latest retained dated layout for the current report date.
 * Raw/Clean values and every existing dated tab are observation-only here; the
 * audited Raw filter is opened if needed, and the value planner owns the new
 * tab's complete A3:N daily report after this transition.
 */
export function deliveryRpsDatedRolloverNormalizationSpec(input: {
  reportDate: string
  sheets: readonly DeliveryRpsLifecycleSheet[]
}): DeliveryRpsDatedRolloverNormalizationSpec {
  const artifact = sheetArtifact("delivery_roles_rps")
  const reportDate = validIsoDate(input.reportDate, "Delivery RPS report date")
  const reportDateMs = Date.parse(`${reportDate}T00:00:00Z`)
  const targetSheetTitle = formatDeliveryRpsDatedTab(reportDate)
  const targetSheetId = deliveryRpsTargetSheetId(reportDate)
  const raw = exactDeliveryRpsLifecycleSheet(input.sheets, 1072762955, "Raw_Daily_RPS", "Raw")
  const clean = exactDeliveryRpsLifecycleSheet(input.sheets, 1598905318, "Cleaned_RPS", "Clean")
  const { fixedFilter, openFilter } = deliveryRpsRawFilterRanges()
  const serializedRawFilter = raw.basicFilter ? stableSerialize(raw.basicFilter) : null
  const rawFilterNeedsOpen = serializedRawFilter === stableSerialize(fixedFilter)
  if (
    raw.gridColumnCount < 20 ||
    raw.gridRowCount < 2 ||
    (serializedRawFilter !== stableSerialize(fixedFilter) &&
      serializedRawFilter !== stableSerialize(openFilter))
  ) {
    throw new Error("Delivery RPS Raw_Daily_RPS is not the exact audited fixed or open A:T copied ledger.")
  }
  if (clean.gridColumnCount < 20 || clean.gridRowCount < 2) {
    throw new Error("Delivery RPS Cleaned_RPS copied ledger dimensions drifted.")
  }

  const dated = input.sheets.flatMap((sheet) => {
    const dateMs = deliveryRpsDatedTabDateMs(sheet.sheetTitle)
    return dateMs === null ? [] : [{ sheet, dateMs }]
  })
  const duplicateDate = dated.find(({ dateMs }, index) =>
    dated.some((other, otherIndex) => otherIndex !== index && other.dateMs === dateMs)
  )
  if (duplicateDate) {
    throw new Error(`Delivery RPS retained dated-tab ownership is ambiguous for ${duplicateDate.sheet.sheetTitle}.`)
  }
  const targetMatches = input.sheets.filter((sheet) => sheet.sheetTitle === targetSheetTitle)
  if (targetMatches.length > 1) {
    throw new Error(`Delivery RPS rollover found an ambiguous target tab ${targetSheetTitle}.`)
  }
  const target = targetMatches[0]
  const idCollision = input.sheets.find(
    (sheet) => sheet.sheetId === targetSheetId && sheet.sheetTitle !== targetSheetTitle
  )
  if (idCollision) throw new Error("Delivery RPS target sheet id collides with retained history.")
  if (target && target.sheetId !== targetSheetId) {
    throw new Error("Delivery RPS target title is bound to an unexpected sheet id.")
  }

  const predecessorCandidates = dated
    .filter(({ dateMs }) => dateMs < reportDateMs)
    .sort((left, right) => right.dateMs - left.dateMs)
  if (predecessorCandidates.length === 0) {
    throw new Error("Delivery RPS rollover requires one retained dated predecessor.")
  }
  const predecessor = validDeliveryRpsDatedSheet(predecessorCandidates[0].sheet, "predecessor")
  const nearestFuture = dated
    .filter(({ dateMs }) => dateMs > reportDateMs)
    .sort((left, right) => left.dateMs - right.dateMs)[0]
  const insertSheetIndex = nearestFuture ? nearestFuture.sheet.sheetIndex + 1 : 0
  if (target && target.sheetIndex !== insertSheetIndex) {
    throw new Error("Delivery RPS target/predecessor tab ordering is ambiguous.")
  }
  if (target) {
    const validTarget = validDeliveryRpsDatedSheet(target, "target")
    if (
      validTarget.gridRowCount !== predecessor.gridRowCount ||
      validTarget.gridColumnCount !== predecessor.gridColumnCount
    ) {
      throw new Error("Delivery RPS target grid is not an exact predecessor copy.")
    }
  }

  const rawState = {
    sheetId: raw.sheetId,
    sheetTitle: raw.sheetTitle,
    grid: { rowCount: raw.gridRowCount, columnCount: raw.gridColumnCount },
    basicFilter: rawFilterNeedsOpen ? fixedFilter : openFilter,
  }
  const normalizedRawState = {
    ...rawState,
    basicFilter: openFilter,
  }
  const cleanState = {
    sheetId: clean.sheetId,
    sheetTitle: clean.sheetTitle,
    grid: { rowCount: clean.gridRowCount, columnCount: clean.gridColumnCount },
  }
  const summaryRange = gridRange(targetSheetId, 4, predecessor.gridRowCount, 0, 14)
  const templateLayout = deliveryRpsDatedLayout(predecessor.sheetTitle)
  const outputLayout = deliveryRpsDatedLayout(targetSheetTitle)
  // The predecessor's frozen row is historical, hand-applied cosmetic
  // formatting this write never touches (recent predecessors have drifted to
  // no frozen row at all) — so its expected layout omits frozenRowCount and
  // the observer skips that check for the template role. The output role
  // below keeps the requirement: this write creates that tab and force-sets
  // its frozen row explicitly, regardless of what the predecessor has.
  const {
    frozenRowCount: templateFrozenRowCountIgnored,
    ...templateLayoutWithoutFrozenRow
  } = templateLayout
  void templateFrozenRowCountIgnored
  const templateState = {
    sheetId: predecessor.sheetId,
    sheetTitle: predecessor.sheetTitle,
    sheetIndex: predecessor.sheetIndex,
    grid: { rowCount: predecessor.gridRowCount, columnCount: predecessor.gridColumnCount },
    staticLayout: templateLayoutWithoutFrozenRow,
  }
  const normalizedTemplateState = {
    ...templateState,
    sheetIndex: target
      ? predecessor.sheetIndex
      : predecessor.sheetIndex + (insertSheetIndex <= predecessor.sheetIndex ? 1 : 0),
  }
  const outputState = {
    sheetId: targetSheetId,
    sheetTitle: targetSheetTitle,
    insertedAtIndex: insertSheetIndex,
    duplicatedFromSheetId: predecessor.sheetId,
    grid: { rowCount: predecessor.gridRowCount, columnCount: predecessor.gridColumnCount },
    staticLayout: outputLayout,
    valueOwnedRange: summaryRange,
    // A newly duplicated tab must prove every stale report value was cleared.
    // Once hydrated, the same range is value-owned and an identical lifecycle
    // rerun recognizes the target without inspecting or erasing those values.
    ...(target ? {} : { clearedSummaryRange: summaryRange }),
  }

  return {
    id: `delivery_rps_dated_rollover_${reportDate.replaceAll("-", "")}`,
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    expectedBefore: boundState(artifact.key, artifact.artifactId, {
      raw: rawState,
      clean: cleanState,
      datedTemplate: templateState,
      targetSheetAbsent: { sheetId: targetSheetId, sheetTitle: targetSheetTitle },
    }),
    expectedAfter: boundState(artifact.key, artifact.artifactId, {
      raw: normalizedRawState,
      clean: cleanState,
      datedTemplate: normalizedTemplateState,
      datedOutput: outputState,
    }),
    forwardRequests: [
      ...(rawFilterNeedsOpen ? [setBasicFilterRequest(openFilter)] : []),
      duplicateSheetRequest(predecessor.sheetId, targetSheetId, targetSheetTitle, insertSheetIndex),
      // duplicateSheet inherits gridProperties from its source, so the new tab
      // starts with whatever frozen-row state the predecessor happens to have
      // (recently, none). Force it to the required 1 regardless of predecessor
      // drift, so every future dated tab is correct on its own.
      setFrozenRowCountRequest(targetSheetId, outputLayout.frozenRowCount),
      clearCellsRequest(summaryRange, "userEnteredValue"),
      writeCellRequest(targetSheetId, 0, 0, outputLayout.titleValue),
    ],
    rollbackRequests: [
      deleteSheetRequest(targetSheetId),
      ...(rawFilterNeedsOpen ? [setBasicFilterRequest(fixedFilter)] : []),
    ],
    projectedValueTarget: {
      targetSheetId,
      targetSheetTitle,
      templateSheetId: predecessor.sheetId,
      templateSheetTitle: predecessor.sheetTitle,
      firstValueRow: 3,
      preservedValueRowCount: 2,
    },
  }
}

/** Stable cross-month/year identity shared by candidate-tab rollover and hydration. */
export function candidateTabTitleForReportingWeek(reportingWeekFriday: string): string {
  const fridayMs = validReportingFridayMs(reportingWeekFriday, "Candidate tab title")
  const tabDate = new Date(fridayMs + 7 * DAY_MS)
  const day = tabDate.getUTCDate()
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(tabDate)
  return `Candidate Level Data - ${day} ${month}`
}

/** Stable target id; any title/id collision in a copied workbook fails closed. */
export function pipelineCandidateTargetSheetId(reportingWeekFriday: string): number {
  const fridayMs = validReportingFridayMs(reportingWeekFriday, "Pipeline candidate rollover")
  const weekOrdinal = (fridayMs - PIPELINE_CANDIDATE_SHEET_ID_EPOCH_FRIDAY_MS) / (7 * DAY_MS)
  if (!Number.isSafeInteger(weekOrdinal) || weekOrdinal < 0) {
    throw new Error("Pipeline candidate reporting week is outside the reserved sheet-id epoch.")
  }
  const sheetId = PIPELINE_CANDIDATE_SHEET_ID_BASE + weekOrdinal
  if (sheetId > 2_147_483_647) {
    throw new Error("Pipeline candidate target sheet id exceeds the Google Sheets limit.")
  }
  return sheetId
}

const PIPELINE_CANDIDATE_TAB_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const

/**
 * Parses only the exact canonical "Candidate Level Data - <day> <month>"
 * title produced by candidateTabTitleForReportingWeek, rejecting every
 * variant (a "Copy of ..." duplicate, a zero-padded day, an abbreviated
 * month) by round-tripping the parsed date back through that same formatter
 * and requiring a byte-for-byte match. The title carries no year, so year is
 * inferred relative to referenceMs: only the reference's own year and the
 * year before it can place the tab's Friday-based tabDate strictly before
 * the reference, and whichever of those two produces the tabDate nearest
 * below the reference wins, which both resolves the year ambiguity and caps
 * how far back an interpretation can reach. Returns null (never throws) for
 * anything that doesn't round-trip exactly.
 */
function pipelineCandidateTabTitleDateMs(title: string, referenceMs: number): number | null {
  const match = /^Candidate Level Data - (\d{1,2}) ([A-Za-z]+)$/.exec(title)
  if (!match) return null
  const day = Number(match[1])
  const monthIndex = PIPELINE_CANDIDATE_TAB_MONTHS.indexOf(
    match[2] as (typeof PIPELINE_CANDIDATE_TAB_MONTHS)[number]
  )
  if (monthIndex === -1) return null
  const referenceYear = new Date(referenceMs).getUTCFullYear()
  let best: number | null = null
  for (const year of [referenceYear, referenceYear - 1]) {
    const tabDateMs = Date.UTC(year, monthIndex, day)
    const tabDate = new Date(tabDateMs)
    if (
      tabDate.getUTCFullYear() !== year ||
      tabDate.getUTCMonth() !== monthIndex ||
      tabDate.getUTCDate() !== day ||
      tabDateMs >= referenceMs
    ) {
      continue
    }
    const reportingWeekFriday = new Date(tabDateMs - 7 * DAY_MS).toISOString().slice(0, 10)
    let regenerated: string | null
    try {
      regenerated = candidateTabTitleForReportingWeek(reportingWeekFriday)
    } catch {
      regenerated = null
    }
    if (regenerated === title && (best === null || tabDateMs > best)) best = tabDateMs
  }
  return best
}

/**
 * Duplicates the most recent candidate tab strictly older than the target
 * week to use as its structural template. Historical tabs stay in place, and
 * a missing week is never fabricated: the predecessor is whichever existing
 * tab is newest without being on or after the target week, however many
 * weeks back that lands. Candidate values are replaced later by the bounded
 * value planner, which can safely consume any older predecessor's structure.
 */
export function pipelineCandidateRolloverNormalizationSpec(input: {
  artifactKey: PipelineArtifactKey
  reportingWeekFriday: string
  sheets: readonly PipelineCandidateLifecycleSheet[]
  jobSummary?: PipelineJobSummaryLifecycleSheet
}): StagingStructuralNormalizationSpec | null {
  const artifact = sheetArtifact(input.artifactKey)
  const fridayMs = validReportingFridayMs(input.reportingWeekFriday, "Pipeline candidate rollover")
  const targetSheetTitle = candidateTabTitleForReportingWeek(input.reportingWeekFriday)
  const targetTabDateMs = fridayMs + 7 * DAY_MS
  const targetSheetId = pipelineCandidateTargetSheetId(input.reportingWeekFriday)

  const dated = input.sheets.flatMap((sheet) => {
    if (sheet.sheetTitle === targetSheetTitle) return []
    const dateMs = pipelineCandidateTabTitleDateMs(sheet.sheetTitle, targetTabDateMs)
    return dateMs === null ? [] : [{ sheet, dateMs }]
  })
  const duplicateDate = dated.find(({ dateMs }, index) =>
    dated.some((other, otherIndex) => otherIndex !== index && other.dateMs === dateMs)
  )
  if (duplicateDate) {
    throw new Error(
      `${input.artifactKey} retained candidate-tab date ownership is ambiguous for ${duplicateDate.sheet.sheetTitle}.`
    )
  }

  const targetMatches = input.sheets.filter((sheet) => sheet.sheetTitle === targetSheetTitle)
  if (targetMatches.length > 1) {
    throw new Error(`${input.artifactKey} rollover found an ambiguous target tab ${targetSheetTitle}.`)
  }
  const target = targetMatches[0]
  const idCollision = input.sheets.find(
    (sheet) => sheet.sheetId === targetSheetId && sheet.sheetTitle !== targetSheetTitle
  )
  if (idCollision) {
    throw new Error(`${input.artifactKey} target sheet id collides with retained history.`)
  }
  if (target && target.sheetId !== targetSheetId) {
    throw new Error(`${input.artifactKey} target title is bound to an unexpected sheet id.`)
  }

  const predecessorCandidates = [...dated].sort((left, right) => right.dateMs - left.dateMs)
  if (predecessorCandidates.length === 0) {
    throw new Error(
      `${input.artifactKey} rollover requires at least one predecessor tab older than ${targetSheetTitle}; found 0.`
    )
  }
  const predecessor = validPipelineCandidateLifecycleSheet(
    predecessorCandidates[0].sheet,
    PIPELINE_CONFIG[input.artifactKey].candidate.endColumnIndex,
    "predecessor"
  )

  const insertSheetIndex = target ? target.sheetIndex : predecessor.sheetIndex
  if (target && predecessor.sheetIndex !== target.sheetIndex + 1) {
    throw new Error(`${input.artifactKey} target/predecessor tab ordering is ambiguous.`)
  }
  const sourceFilter = predecessor.basicFilter
    ? predecessor.basicFilter.endRowIndex === predecessor.gridRowCount
      ? withoutEndRowIndex(predecessor.basicFilter)
      : predecessor.basicFilter
    : null
  const targetFilter = sourceFilter
    ? withoutEndRowIndex({ ...sourceFilter, sheetId: targetSheetId })
    : null
  const candidateDataRange = gridRange(
    targetSheetId,
    1,
    predecessor.gridRowCount,
    0,
    PIPELINE_CONFIG[input.artifactKey].candidate.endColumnIndex
  )

  const beforePredecessor = {
    sheetId: predecessor.sheetId,
    sheetTitle: predecessor.sheetTitle,
    sheetIndex: target ? predecessor.sheetIndex : insertSheetIndex,
    gridRowCount: predecessor.gridRowCount,
    gridColumnCount: predecessor.gridColumnCount,
    basicFilter: sourceFilter,
  }
  const afterPredecessor = {
    ...beforePredecessor,
    sheetIndex: target ? predecessor.sheetIndex : insertSheetIndex + 1,
  }
  let jobSummary = null
  if (input.jobSummary) {
    try {
      jobSummary = pipelineRecurringJobSummaryStates(input.artifactKey, input.jobSummary)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith("recurring job-summary lifecycle metadata is incomplete or drifted.")) {
        throw error
      }
      // The swallow is deliberate (the weekly rollover must not block on
      // summary-format drift), but silence here removed the only signal that
      // the format prep was skipped — and, before the filter discriminator
      // below existed, silently collapsed the spec's two states into one.
      console.error(
        `[recruiting-ops-recurring-lifecycle] ${input.artifactKey} job-summary prep skipped: metadata incomplete or drifted`
      )
    }
  }
  // The target's OBSERVED filter, normalized by the same rule as the
  // predecessor's. The spec's two states must describe the sheet as it is and
  // as the work leaves it; stamping the DESIRED filter into both made them
  // byte-identical once the tab existed with its filter already correct, and
  // the observer then had no way to tell "done" from "not done" — the
  // guaranteed weekly ambiguity block on every pipeline whose predecessor
  // carries a filter.
  const observedTargetFilter = target?.basicFilter
    ? target.basicFilter.endRowIndex === target.gridRowCount
      ? withoutEndRowIndex(target.basicFilter)
      : target.basicFilter
    : null
  const repairTargetFilter =
    Boolean(target) &&
    !jobSummary &&
    targetFilter !== null &&
    stableSerialize(observedTargetFilter) !== stableSerialize(targetFilter)
  const targetIdentity = {
    sheetId: targetSheetId,
    sheetTitle: targetSheetTitle,
    sheetIndex: insertSheetIndex,
    gridRowCount: predecessor.gridRowCount,
    gridColumnCount: predecessor.gridColumnCount,
  }
  const beforeTargetState = {
    ...targetIdentity,
    basicFilter: target ? observedTargetFilter : targetFilter,
    duplicatedFromSheetId: predecessor.sheetId,
    ...(target ? {} : { dataRowsCleared: candidateDataRange }),
  }
  const afterTargetState = {
    ...beforeTargetState,
    // The after-state may only promise what the planned requests deliver: the
    // desired filter when this spec repairs it (or creates the tab), the
    // observed one otherwise.
    basicFilter: !target || repairTargetFilter ? targetFilter : observedTargetFilter,
  }

  const forwardRequests = [
    ...(!target
      ? [
          duplicateSheetRequest(
            predecessor.sheetId,
            targetSheetId,
            targetSheetTitle,
            insertSheetIndex
          ),
          clearCellsRequest(candidateDataRange, "userEnteredValue,note"),
          ...(targetFilter ? [setBasicFilterRequest(targetFilter)] : []),
        ]
      : []),
    ...(jobSummary ? [copyPasteRequest(jobSummary.template, jobSummary.destination, "PASTE_FORMAT")] : []),
    ...(repairTargetFilter && targetFilter ? [setBasicFilterRequest(targetFilter)] : []),
  ]

  // Nothing structural left to do: the target tab already exists, the
  // predecessor carries no basic filter to copy forward, and the job-summary
  // format block is not applicable. That is a legitimate no-op, not a broken
  // spec -- a previous cycle can create the tab and then fail before writing
  // values, which is exactly the state pipeline_907 was left in. Building a
  // request-less spec instead trips the "both forward and rollback" invariant
  // and blocks the value phase behind a structural error that does not exist.
  // The caller reads null as already-normalized and proceeds to write values.
  if (forwardRequests.length === 0) return null

  return {
    id: `${input.artifactKey}_candidate_rollover_${input.reportingWeekFriday.replaceAll("-", "")}`,
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    expectedBefore: boundState(artifact.key, artifact.artifactId, {
      pipelineCandidateRollover: {
        reportingWeekFriday: input.reportingWeekFriday,
        predecessor: beforePredecessor,
        ...(target
          ? { targetSheet: beforeTargetState }
          : {
              targetSheetAbsent: {
                sheetId: targetSheetId,
                sheetTitle: targetSheetTitle,
              },
            }),
        ...(jobSummary ? { jobSummary: jobSummary.before } : {}),
      },
    }),
    expectedAfter: boundState(artifact.key, artifact.artifactId, {
      pipelineCandidateRollover: {
        reportingWeekFriday: input.reportingWeekFriday,
        predecessor: afterPredecessor,
        targetSheet: afterTargetState,
        ...(jobSummary ? { jobSummary: jobSummary.after } : {}),
      },
    }),
    forwardRequests,
    rollbackRequests: [
      ...(jobSummary
        ? [copyPasteRequest(jobSummary.rollbackSource, jobSummary.destination, "PASTE_FORMAT")]
        : []),
      ...(!target ? [deleteSheetRequest(targetSheetId)] : []),
      ...(target && !jobSummary && targetFilter ? [setBasicFilterRequest(targetFilter)] : []),
    ],
  }
}

function pipelineRecurringJobSummaryStates(
  artifactKey: PipelineArtifactKey,
  sheet: PipelineJobSummaryLifecycleSheet
): {
  before: Readonly<Record<string, unknown>>
  after: Readonly<Record<string, unknown>>
  template: Readonly<Record<string, number>>
  destination: Readonly<Record<string, number>>
  rollbackSource: Readonly<Record<string, number>>
} {
  const config = PIPELINE_CONFIG[artifactKey].job
  if (
    sheet.sheetId !== config.sheetId ||
    sheet.sheetTitle !== config.sheetTitle ||
    !Number.isInteger(sheet.gridRowCount) ||
    sheet.gridRowCount <= 0 ||
    !Number.isInteger(sheet.gridColumnCount) ||
    sheet.gridColumnCount < config.endColumnIndex ||
    !sheet.basicFilter ||
    sheet.basicFilter.sheetId !== sheet.sheetId ||
    (sheet.basicFilter.startRowIndex ?? 0) !== config.filterStartRowIndex ||
    (sheet.basicFilter.startColumnIndex ?? 0) !== 0 ||
    sheet.basicFilter.endColumnIndex !== config.endColumnIndex ||
    sheet.basicFilter.endRowIndex !== undefined ||
    !Number.isInteger(sheet.templateStartRowIndex) ||
    !Number.isInteger(sheet.appendStartRowIndex) ||
    !Number.isInteger(sheet.blockRowCount) ||
    sheet.blockRowCount !== config.templateEndRowIndex - config.templateStartRowIndex ||
    sheet.templateStartRowIndex < 0 ||
    sheet.templateStartRowIndex + sheet.blockRowCount > sheet.appendStartRowIndex ||
    sheet.appendStartRowIndex + 2 * sheet.blockRowCount > sheet.gridRowCount
  ) {
    throw new Error(`${artifactKey} recurring job-summary lifecycle metadata is incomplete or drifted.`)
  }
  const template = gridRange(
    sheet.sheetId,
    sheet.templateStartRowIndex,
    sheet.templateStartRowIndex + sheet.blockRowCount,
    0,
    config.endColumnIndex
  )
  const destination = gridRange(
    sheet.sheetId,
    sheet.appendStartRowIndex,
    sheet.appendStartRowIndex + sheet.blockRowCount,
    0,
    config.endColumnIndex
  )
  const rollbackSource = gridRange(
    sheet.sheetId,
    sheet.appendStartRowIndex + sheet.blockRowCount,
    sheet.appendStartRowIndex + 2 * sheet.blockRowCount,
    0,
    config.endColumnIndex
  )
  const common = {
    sheetId: sheet.sheetId,
    sheetTitle: sheet.sheetTitle,
    basicFilter: sheet.basicFilter,
  }
  return {
    before: {
      ...common,
      lastWeekTemplate: template,
      appendDestination: destination,
      appendDestinationBlankExceptBackgroundFormat: true,
      backgroundFormatPreimage: {
        source: rollbackSource,
        destination,
        pasteType: "PASTE_FORMAT",
      },
    },
    after: {
      ...common,
      appendedTemplate: {
        source: template,
        destination,
        pasteType: "PASTE_FORMAT",
        valuesOwnedByBoundedWriter: true,
      },
    },
    template,
    destination,
    rollbackSource,
  }
}

export function pipelineNormalizationSpec(input: {
  artifactKey: PipelineArtifactKey
  currentCandidateTitle: string
  reservedCandidateSheetId?: number
}): StagingStructuralNormalizationSpec {
  const config = PIPELINE_CONFIG[input.artifactKey]
  const artifact = sheetArtifact(input.artifactKey)
  const currentCandidateTitle = requiredText(input.currentCandidateTitle, "currentCandidateTitle")
  const currentCandidateExists = currentCandidateTitle === config.candidate.sheetTitle
  const targetCandidateSheetId = currentCandidateExists
    ? config.candidate.sheetId
    : requiredSheetId(input.reservedCandidateSheetId, "reservedCandidateSheetId")

  if (
    !currentCandidateExists &&
    [config.candidate.sheetId, config.job.sheetId].includes(targetCandidateSheetId)
  ) {
    throw new Error("reservedCandidateSheetId collides with an audited source sheet id")
  }

  const fixedCandidateFilter = gridRange(
    config.candidate.sheetId,
    0,
    config.candidate.filterEndRowIndex,
    0,
    config.candidate.endColumnIndex
  )
  const targetOpenCandidateFilter = gridRange(
    targetCandidateSheetId,
    0,
    undefined,
    0,
    config.candidate.endColumnIndex
  )
  const fixedJobFilter = gridRange(
    config.job.sheetId,
    config.job.filterStartRowIndex,
    config.job.filterEndRowIndex,
    0,
    config.job.endColumnIndex
  )
  const openJobFilter = gridRange(
    config.job.sheetId,
    config.job.filterStartRowIndex,
    undefined,
    0,
    config.job.endColumnIndex
  )
  const templateRange = gridRange(
    config.job.sheetId,
    config.job.templateStartRowIndex,
    config.job.templateEndRowIndex,
    0,
    config.job.endColumnIndex
  )
  const appendRange = gridRange(
    config.job.sheetId,
    config.job.appendStartRowIndex,
    config.job.appendEndRowIndex,
    0,
    config.job.endColumnIndex
  )
  const rollbackFormatRange = config.job.rollbackFormatSource
    ? gridRange(
        config.job.sheetId,
        config.job.rollbackFormatSource.startRowIndex,
        config.job.rollbackFormatSource.endRowIndex,
        0,
        config.job.endColumnIndex
      )
    : undefined
  if (
    rollbackFormatRange &&
    config.job.rollbackFormatSource!.endRowIndex -
      config.job.rollbackFormatSource!.startRowIndex !==
      config.job.appendEndRowIndex - config.job.appendStartRowIndex
  ) {
    throw new Error("pipeline rollback format source must match the append block height")
  }

  const candidateBefore = currentCandidateExists
    ? {
        mode: "existing_current_tab",
        sheetId: config.candidate.sheetId,
        sheetTitle: config.candidate.sheetTitle,
        basicFilter: fixedCandidateFilter,
      }
    : {
        mode: "missing_current_tab",
        targetSheetAbsent: { sheetId: targetCandidateSheetId, sheetTitle: currentCandidateTitle },
        template: {
          sheetId: config.candidate.sheetId,
          sheetTitle: config.candidate.sheetTitle,
          sheetIndex: config.candidate.sheetIndex,
          gridRowCount: config.candidate.gridRowCount,
          basicFilter: fixedCandidateFilter,
        },
      }
  const candidateAfter = {
    mode: currentCandidateExists ? "existing_current_tab" : "duplicated_current_tab",
    sheetId: targetCandidateSheetId,
    sheetTitle: currentCandidateTitle,
    basicFilter: targetOpenCandidateFilter,
    ...(currentCandidateExists
      ? {}
      : {
          insertedAtIndex: config.candidate.sheetIndex,
          dataRowsCleared: gridRange(
            targetCandidateSheetId,
            1,
            config.candidate.gridRowCount,
            0,
            config.candidate.endColumnIndex
          ),
        }),
  }

  const candidateRequests: GoogleSheetsRequestData[] = currentCandidateExists
    ? [setBasicFilterRequest(targetOpenCandidateFilter)]
    : [
        duplicateSheetRequest(
          config.candidate.sheetId,
          targetCandidateSheetId,
          currentCandidateTitle,
          config.candidate.sheetIndex
        ),
        clearCellsRequest(
          gridRange(
            targetCandidateSheetId,
            1,
            config.candidate.gridRowCount,
            0,
            config.candidate.endColumnIndex
          ),
          "userEnteredValue,note"
        ),
        setBasicFilterRequest(targetOpenCandidateFilter),
      ]

  const candidateRollback: GoogleSheetsRequestData[] = currentCandidateExists
    ? [setBasicFilterRequest(fixedCandidateFilter)]
    : [deleteSheetRequest(targetCandidateSheetId)]

  return {
    id: `${input.artifactKey}_current_candidate_and_job_summary`,
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    expectedBefore: boundState(artifact.key, artifact.artifactId, {
      candidate: candidateBefore,
      jobSummary: {
        sheetId: config.job.sheetId,
        sheetTitle: config.job.sheetTitle,
        basicFilter: fixedJobFilter,
        lastWeekTemplate: templateRange,
        appendDestination: appendRange,
        ...(rollbackFormatRange
          ? {
              appendDestinationBlankExceptBackgroundFormat: true,
              backgroundFormatPreimage: {
                source: rollbackFormatRange,
                destination: appendRange,
                pasteType: "PASTE_FORMAT",
              },
            }
          : { appendDestinationBlankAndUnformatted: true }),
      },
    }),
    expectedAfter: boundState(artifact.key, artifact.artifactId, {
      candidate: candidateAfter,
      jobSummary: {
        sheetId: config.job.sheetId,
        sheetTitle: config.job.sheetTitle,
        basicFilter: openJobFilter,
        appendedTemplate: {
          source: templateRange,
          destination: appendRange,
          pasteType: "PASTE_FORMAT",
        },
      },
    }),
    forwardRequests: [
      ...candidateRequests,
      setBasicFilterRequest(openJobFilter),
      copyPasteRequest(templateRange, appendRange, "PASTE_FORMAT"),
    ],
    rollbackRequests: [
      ...(rollbackFormatRange
        ? [copyPasteRequest(rollbackFormatRange, appendRange, "PASTE_FORMAT")]
        : [
            clearCellsRequest(
              appendRange,
              "userEnteredValue,userEnteredFormat,dataValidation,note"
            ),
          ]),
      setBasicFilterRequest(fixedJobFilter),
      ...candidateRollback,
    ],
  }
}

const FINAL_OFFER_MONTH_NAMES = [
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
const FINAL_OFFER_LEGACY_Q3_START = "2026-07-01"
const FINAL_OFFER_FUTURE_SHEET_ID_BASE = 1_900_000_000
const FINAL_OFFER_FUTURE_SHEET_ID_EPOCH_MONTH = 2026 * 12 + 9

export type FinalOfferMonthName = (typeof FINAL_OFFER_MONTH_NAMES)[number]
export type FinalOfferLifecycleRole = "offerData" | "recruiterPerformance" | "sourcerPerformance"

export interface FinalOfferLifecycleSheet {
  sheetId: number
  sheetTitle: string
  sheetIndex: number
  gridRowCount: number
  gridColumnCount: number
  basicFilter: Readonly<Record<string, number>> | null
  pivotSource: Readonly<Record<string, number>> | null
}

export interface FinalOfferMonthTriplet {
  monthKey: string
  offerData: FinalOfferLifecycleSheet
  recruiterPerformance: FinalOfferLifecycleSheet
  sourcerPerformance: FinalOfferLifecycleSheet
}

/** Three calendar-month identities for a valid quarter boundary. */
export function finalOfferQuarterMonthKeys(quarterStart: string): readonly [string, string, string] {
  const start = validFinalOfferMonthKey(quarterStart, "Final Offer quarter")
  if (start.getUTCMonth() % 3 !== 0) {
    throw new Error("Final Offer quarter start must be January, April, July, or October.")
  }
  return [0, 1, 2].map((offset) => formatFinalOfferMonthKey(
    start.getUTCFullYear(),
    start.getUTCMonth() + offset
  )) as [string, string, string]
}

/** Legacy Q3 stays unqualified; every lifecycle-created destination names its year. */
export function finalOfferMonthTabTitles(monthKey: string): {
  offerData: string
  recruiterPerformance: string
  sourcerPerformance: string
} {
  const date = validFinalOfferMonthKey(monthKey, "Final Offer month")
  const month = FINAL_OFFER_MONTH_NAMES[date.getUTCMonth()]
  const suffix = isLegacyQ3MonthKey(monthKey) ? month : `${month} ${date.getUTCFullYear()}`
  return {
    offerData: `${suffix} Offer Data`,
    recruiterPerformance: `Recruiter Performance Table_${suffix}`,
    sourcerPerformance: `Sourcer Performance Table_${suffix}`,
  }
}

/** Stable year-aware ids; legacy Q3 retains the already-created reserved ids. */
export function finalOfferMonthSheetIds(monthKey: string): Readonly<Record<FinalOfferLifecycleRole, number>> {
  const date = validFinalOfferMonthKey(monthKey, "Final Offer month")
  if (isLegacyQ3MonthKey(monthKey)) {
    const month = FINAL_OFFER_MONTH_NAMES[date.getUTCMonth()] as "July" | "August" | "September"
    return FINAL_OFFER_Q3_SHEET_IDS[month]
  }
  const ordinal = date.getUTCFullYear() * 12 + date.getUTCMonth() - FINAL_OFFER_FUTURE_SHEET_ID_EPOCH_MONTH
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error("Final Offer lifecycle month predates the year-qualified sheet-id epoch.")
  }
  const firstId = FINAL_OFFER_FUTURE_SHEET_ID_BASE + ordinal * 3 + 1
  if (firstId + 2 > 2_147_483_647) {
    throw new Error("Final Offer lifecycle sheet id exceeds the Google Sheets limit.")
  }
  return {
    offerData: firstId,
    recruiterPerformance: firstId + 1,
    sourcerPerformance: firstId + 2,
  }
}

/**
 * Creates one future quarter in the registered copy from the latest complete
 * retained triplet. The batch is all-or-nothing and its rollback deletes only
 * the nine deterministic sheets introduced by this transition.
 */
export function finalOfferQuarterRolloverNormalizationSpec(input: {
  quarterStart: string
  sheets: readonly FinalOfferLifecycleSheet[]
}): StagingStructuralNormalizationSpec | null {
  const artifact = sheetArtifact("final_offer")
  const targetMonthKeys = finalOfferQuarterMonthKeys(input.quarterStart)
  if (input.quarterStart === FINAL_OFFER_LEGACY_Q3_START) return null
  assertUniqueFinalOfferSheetOwnership(input.sheets)
  const retained = discoverManagedFinalOfferTriplets(input.sheets)
  const legacyQ3 = finalOfferQuarterMonthKeys(FINAL_OFFER_LEGACY_Q3_START).map((monthKey) =>
    exactFinalOfferTriplet(retained, monthKey, "legacy Q3")
  )
  legacyQ3.forEach((triplet) => assertFinalOfferLegacyQ3Ids(triplet))
  if (
    legacyQ3[2].offerData.sheetIndex + 3 !== legacyQ3[1].offerData.sheetIndex ||
    legacyQ3[1].offerData.sheetIndex + 3 !== legacyQ3[0].offerData.sheetIndex
  ) {
    throw new Error("Final Offer retained legacy Q3 triplet ordering is ambiguous.")
  }

  if (input.quarterStart < "2026-10-01") {
    throw new Error("Final Offer recurring lifecycle starts after the retained legacy Q3 2026 quarter.")
  }

  const targetParts = targetMonthKeys.map((monthKey) => retained.get(monthKey))
  const targetPartCount = targetParts.filter(Boolean).length
  if (targetPartCount !== 0 && targetPartCount !== targetMonthKeys.length) {
    throw new Error("Final Offer target quarter has partial retained month ownership.")
  }
  const targetExists = targetPartCount === targetMonthKeys.length
  const targetTriplets = targetExists
    ? targetMonthKeys.map((monthKey) => exactFinalOfferTriplet(retained, monthKey, "target"))
    : []

  for (const monthKey of targetMonthKeys) {
    const titles = finalOfferMonthTabTitles(monthKey)
    const ids = finalOfferMonthSheetIds(monthKey)
    for (const role of finalOfferRoles()) {
      const titleMatches = input.sheets.filter((sheet) => sheet.sheetTitle === titles[role])
      if (titleMatches.length > 1) throw new Error("Final Offer target title ownership is ambiguous.")
      if (titleMatches[0] && titleMatches[0].sheetId !== ids[role]) {
        throw new Error("Final Offer target title is bound to an unexpected deterministic sheet id.")
      }
      const idMatch = input.sheets.find((sheet) => sheet.sheetId === ids[role])
      if (idMatch && idMatch.sheetTitle !== titles[role]) {
        throw new Error("Final Offer deterministic target sheet id collides with retained history.")
      }
    }
  }

  const targetEnd = addFinalOfferMonths(targetMonthKeys[2], 1)
  const unexpectedFuture = [...retained.keys()].find(
    (monthKey) => monthKey >= targetEnd
  )
  if (unexpectedFuture) {
    throw new Error("Final Offer retained lifecycle history extends beyond the requested quarter.")
  }

  const predecessorMonthKey = addFinalOfferMonths(targetMonthKeys[0], -1)
  const predecessor = exactFinalOfferTriplet(retained, predecessorMonthKey, "latest predecessor")
  const latestPriorMonth = [...retained.keys()]
    .filter((monthKey) => monthKey < targetMonthKeys[0])
    .sort()
    .at(-1)
  if (latestPriorMonth !== predecessorMonthKey) {
    throw new Error("Final Offer latest complete retained triplet is not the immediately preceding month.")
  }

  const targetIds = targetMonthKeys.map((monthKey) => finalOfferMonthSheetIds(monthKey))
  if (targetExists) {
    targetTriplets.forEach((triplet, index) => assertFinalOfferTargetIds(triplet, targetIds[index]))
  }
  const baseIndex = targetExists
    ? Math.min(...targetTriplets.map((triplet) => triplet.offerData.sheetIndex))
    : predecessor.offerData.sheetIndex
  const predecessorBefore = finalOfferTripletState(predecessor, baseIndex)
  const predecessorAfter = finalOfferTripletState(predecessor, baseIndex + 9)
  const expectedTargetTriplets = targetMonthKeys.map((monthKey, index) => {
    const ids = targetIds[index]
    const titles = finalOfferMonthTabTitles(monthKey)
    const insertedAtIndex = baseIndex + (targetMonthKeys.length - index - 1) * 3
    return {
      monthKey,
      offerData: {
        sheetId: ids.offerData,
        sheetTitle: titles.offerData,
        sheetIndex: insertedAtIndex,
        gridRowCount: predecessor.offerData.gridRowCount,
        gridColumnCount: predecessor.offerData.gridColumnCount,
        basicFilter: rebindFinalOfferRange(predecessor.offerData.basicFilter!, ids.offerData),
        duplicatedFromSheetId: predecessor.offerData.sheetId,
        ...(!targetExists
          ? {
              rowsCleared: gridRange(
                ids.offerData,
                1,
                predecessor.offerData.gridRowCount,
                0,
                predecessor.offerData.gridColumnCount
              ),
            }
          : {}),
      },
      recruiterPerformance: {
        sheetId: ids.recruiterPerformance,
        sheetTitle: titles.recruiterPerformance,
        sheetIndex: insertedAtIndex + 1,
        gridRowCount: predecessor.recruiterPerformance.gridRowCount,
        gridColumnCount: predecessor.recruiterPerformance.gridColumnCount,
        pivotSource: rebindFinalOfferRange(
          predecessor.recruiterPerformance.pivotSource!,
          ids.offerData
        ),
        duplicatedFromSheetId: predecessor.recruiterPerformance.sheetId,
      },
      sourcerPerformance: {
        sheetId: ids.sourcerPerformance,
        sheetTitle: titles.sourcerPerformance,
        sheetIndex: insertedAtIndex + 2,
        gridRowCount: predecessor.sourcerPerformance.gridRowCount,
        gridColumnCount: predecessor.sourcerPerformance.gridColumnCount,
        pivotSource: rebindFinalOfferRange(
          predecessor.sourcerPerformance.pivotSource!,
          ids.offerData
        ),
        duplicatedFromSheetId: predecessor.sourcerPerformance.sheetId,
      },
    }
  })

  if (targetExists) {
    expectedTargetTriplets.forEach((expected, index) => {
      const observed = targetTriplets[index]
      if (
        observed.offerData.sheetIndex !== expected.offerData.sheetIndex ||
        observed.recruiterPerformance.sheetIndex !== expected.recruiterPerformance.sheetIndex ||
        observed.sourcerPerformance.sheetIndex !== expected.sourcerPerformance.sheetIndex ||
        predecessor.offerData.sheetIndex !== baseIndex + 9
      ) {
        throw new Error("Final Offer target/predecessor triplet ordering is ambiguous.")
      }
    })
  }

  const forwardRequests: GoogleSheetsRequestData[] = []
  for (const [index, monthKey] of targetMonthKeys.entries()) {
    const ids = targetIds[index]
    const titles = finalOfferMonthTabTitles(monthKey)
    const targetFilter = rebindFinalOfferRange(predecessor.offerData.basicFilter!, ids.offerData)
    forwardRequests.push(
      duplicateSheetRequest(predecessor.offerData.sheetId, ids.offerData, titles.offerData, baseIndex),
      clearCellsRequest(
        gridRange(ids.offerData, 1, predecessor.offerData.gridRowCount, 0, predecessor.offerData.gridColumnCount),
        "userEnteredValue,note"
      ),
      setBasicFilterRequest(targetFilter),
      duplicateSheetRequest(
        predecessor.recruiterPerformance.sheetId,
        ids.recruiterPerformance,
        titles.recruiterPerformance,
        baseIndex + 1
      ),
      updatePivotSourceRequest(
        ids.recruiterPerformance,
        rebindFinalOfferRange(predecessor.recruiterPerformance.pivotSource!, ids.offerData)
      ),
      duplicateSheetRequest(
        predecessor.sourcerPerformance.sheetId,
        ids.sourcerPerformance,
        titles.sourcerPerformance,
        baseIndex + 2
      ),
      updatePivotSourceRequest(
        ids.sourcerPerformance,
        rebindFinalOfferRange(predecessor.sourcerPerformance.pivotSource!, ids.offerData)
      )
    )
  }
  const targetSheetIdentities = expectedTargetTriplets.flatMap((triplet) => [
    { sheetId: triplet.offerData.sheetId, sheetTitle: triplet.offerData.sheetTitle },
    { sheetId: triplet.recruiterPerformance.sheetId, sheetTitle: triplet.recruiterPerformance.sheetTitle },
    { sheetId: triplet.sourcerPerformance.sheetId, sheetTitle: triplet.sourcerPerformance.sheetTitle },
  ])

  return {
    id: `final_offer_quarter_rollover_${input.quarterStart.replaceAll("-", "")}`,
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    expectedBefore: boundState(artifact.key, artifact.artifactId, {
      finalOfferQuarterRollover: {
        quarterStart: input.quarterStart,
        annualPolicy: "same_registered_copy_year_qualified_month_tabs",
        predecessor: predecessorBefore,
        targetSheetsAbsent: targetSheetIdentities,
      },
    }),
    expectedAfter: boundState(artifact.key, artifact.artifactId, {
      finalOfferQuarterRollover: {
        quarterStart: input.quarterStart,
        annualPolicy: "same_registered_copy_year_qualified_month_tabs",
        predecessor: predecessorAfter,
        targetMonths: expectedTargetTriplets,
        finalMonthOrdering: [...targetMonthKeys].reverse(),
      },
    }),
    forwardRequests,
    rollbackRequests: [...targetSheetIdentities]
      .reverse()
      .map(({ sheetId }) => deleteSheetRequest(sheetId)),
  }
}

export type FinalOfferQ3Month = "July" | "August" | "September"

export type FinalOfferQ3SheetIds = Readonly<
  Record<
    FinalOfferQ3Month,
    Readonly<{
      offerData: number
      recruiterPerformance: number
      sourcerPerformance: number
    }>
  >
>

export function finalOfferNormalizationSpec(input: {
  q3SheetIds: FinalOfferQ3SheetIds
}): StagingStructuralNormalizationSpec {
  const artifact = sheetArtifact("final_offer")
  const ids = validateQ3SheetIds(input.q3SheetIds)
  const existingPivots = FINAL_OFFER_EXISTING_PIVOTS.map((pivot) => ({
    ...pivot,
    afterSource: withoutEndRowIndex(pivot.beforeSource),
  }))
  const q3Sheets = FINAL_OFFER_Q3_MONTHS.flatMap((month) => {
    const monthIds = ids[month]
    const finalBaseIndex = { July: 11, August: 8, September: 5 }[month]
    return [
      {
        sheetId: monthIds.offerData,
        sheetTitle: `${month} Offer Data`,
        kind: "offer_data",
        insertedAtIndex: finalBaseIndex,
      },
      {
        sheetId: monthIds.recruiterPerformance,
        sheetTitle: `Recruiter Performance Table_${month}`,
        kind: "recruiter_pivot",
        insertedAtIndex: finalBaseIndex + 1,
      },
      {
        sheetId: monthIds.sourcerPerformance,
        sheetTitle: `Sourcer Performance Table_${month}`,
        kind: "sourcer_pivot",
        insertedAtIndex: finalBaseIndex + 2,
      },
    ]
  })

  const q3Forward: GoogleSheetsRequestData[] = []
  for (const month of FINAL_OFFER_Q3_MONTHS) {
    const monthIds = ids[month]
    q3Forward.push(
      duplicateSheetRequest(310815017, monthIds.offerData, `${month} Offer Data`, 5),
      clearCellsRequest(gridRange(monthIds.offerData, 1, 997, 0, 31), "userEnteredValue,note"),
      setBasicFilterRequest(gridRange(monthIds.offerData, 0, undefined, 0, 31)),
      duplicateSheetRequest(
        987616061,
        monthIds.recruiterPerformance,
        `Recruiter Performance Table_${month}`,
        6
      ),
      updatePivotSourceRequest(
        monthIds.recruiterPerformance,
        gridRange(monthIds.offerData, 0, undefined, 0, 31)
      ),
      duplicateSheetRequest(
        403204078,
        monthIds.sourcerPerformance,
        `Sourcer Performance Table_${month}`,
        7
      ),
      updatePivotSourceRequest(
        monthIds.sourcerPerformance,
        gridRange(monthIds.offerData, 0, undefined, 0, 30)
      )
    )
  }

  return {
    id: "final_offer_preserve_q2_add_q3_and_open_pivots",
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    expectedBefore: boundState(artifact.key, artifact.artifactId, {
      preservedQ2Sheets: FINAL_OFFER_Q2_SHEETS,
      existingPivotSources: existingPivots.map((pivot) => ({
        pivotSheetId: pivot.pivotSheetId,
        pivotSheetTitle: pivot.pivotSheetTitle,
        anchor: pivot.anchor,
        source: pivot.beforeSource,
      })),
      q3SheetsAbsent: q3Sheets.map(({ sheetId, sheetTitle }) => ({ sheetId, sheetTitle })),
    }),
    expectedAfter: boundState(artifact.key, artifact.artifactId, {
      preservedQ2Sheets: FINAL_OFFER_Q2_SHEETS,
      existingPivotSources: existingPivots.map((pivot) => ({
        pivotSheetId: pivot.pivotSheetId,
        pivotSheetTitle: pivot.pivotSheetTitle,
        anchor: pivot.anchor,
        source: pivot.afterSource,
      })),
      q3Sheets: q3Sheets.map((sheet) => ({
        ...sheet,
        ...(sheet.kind === "offer_data"
          ? {
              rowsCleared: { startRowIndex: 1, endRowIndex: 997 },
              basicFilter: gridRange(sheet.sheetId, 0, undefined, 0, 31),
            }
          : {
              pivotSource: gridRange(
                ids[monthFromTitle(sheet.sheetTitle)].offerData,
                0,
                undefined,
                0,
                sheet.kind === "recruiter_pivot" ? 31 : 30
              ),
            }),
      })),
      q3FinalOrdering: ["September", "August", "July"],
    }),
    forwardRequests: [
      ...existingPivots.map((pivot) => updatePivotSourceRequest(pivot.pivotSheetId, pivot.afterSource)),
      ...q3Forward,
    ],
    rollbackRequests: [
      ...[...q3Sheets].reverse().map((sheet) => deleteSheetRequest(sheet.sheetId)),
      ...existingPivots.map((pivot) => updatePivotSourceRequest(pivot.pivotSheetId, pivot.beforeSource)),
    ],
  }
}

export function deliveryRpsNormalizationSpec(input: {
  newDatedSheetId: number
  newDatedSheetIndex: number
  newDatedSheetTitle: string
  newDatedTitleValue: string
}): StagingStructuralNormalizationSpec {
  const artifact = sheetArtifact("delivery_roles_rps")
  const newDatedSheetId = requiredSheetId(input.newDatedSheetId, "newDatedSheetId")
  const newDatedSheetIndex = requiredSheetId(input.newDatedSheetIndex, "newDatedSheetIndex")
  const newDatedSheetTitle = requiredText(input.newDatedSheetTitle, "newDatedSheetTitle")
  const newDatedTitleValue = requiredText(input.newDatedTitleValue, "newDatedTitleValue")
  if ([1072762955, 1598905318, 2061940582].includes(newDatedSheetId)) {
    throw new Error("newDatedSheetId collides with an audited source sheet id")
  }

  const fixedRawFilter = gridRange(1072762955, 0, 176, 0, 20)
  const openRawFilter = gridRange(1072762955, 0, undefined, 0, 20)
  const clearedSummaryRange = gridRange(newDatedSheetId, 4, 1000, 0, 8)
  const layout = {
    frozenRowCount: 1,
    titleCell: "A1",
    titleValue: newDatedTitleValue,
    mergedRange: "A1:N1",
    sectionLabel: { cell: "A3", value: "Summary by Team" },
    headerRange: "A4:H4",
    headers: ["Team", "Total RPS", "Match", "Mismatch", "Strong Yes", "Yes", "No", "Other"],
    valuesStartCell: "A5",
  }

  return {
    id: "delivery_rps_open_raw_filter_and_duplicate_dated_layout",
    artifactKey: artifact.key,
    spreadsheetId: artifact.artifactId,
    expectedBefore: boundState(artifact.key, artifact.artifactId, {
      raw: {
        sheetId: 1072762955,
        sheetTitle: "Raw_Daily_RPS",
        basicFilter: fixedRawFilter,
      },
      datedTemplate: {
        sheetId: 2061940582,
        sheetTitle: "09 Jul 2026",
        grid: { rowCount: 1000, columnCount: 26 },
        staticLayout: {
          ...layout,
          titleValue: "Recruiter Role Report - 09 Jul 2026",
        },
      },
      targetSheetAbsent: { sheetId: newDatedSheetId, sheetTitle: newDatedSheetTitle },
    }),
    expectedAfter: boundState(artifact.key, artifact.artifactId, {
      raw: {
        sheetId: 1072762955,
        sheetTitle: "Raw_Daily_RPS",
        basicFilter: openRawFilter,
      },
      datedOutput: {
        sheetId: newDatedSheetId,
        sheetTitle: newDatedSheetTitle,
        insertedAtIndex: newDatedSheetIndex,
        duplicatedFromSheetId: 2061940582,
        grid: { rowCount: 1000, columnCount: 26 },
        staticLayout: layout,
        clearedSummaryRange,
      },
    }),
    forwardRequests: [
      setBasicFilterRequest(openRawFilter),
      duplicateSheetRequest(2061940582, newDatedSheetId, newDatedSheetTitle, newDatedSheetIndex),
      clearCellsRequest(clearedSummaryRange, "userEnteredValue,note"),
      writeCellRequest(newDatedSheetId, 0, 0, newDatedTitleValue),
    ],
    rollbackRequests: [
      deleteSheetRequest(newDatedSheetId),
      setBasicFilterRequest(fixedRawFilter),
    ],
  }
}

interface PipelineConfig {
  candidate: {
    sheetId: number
    sheetTitle: string
    sheetIndex: number
    gridRowCount: number
    filterEndRowIndex: number
    endColumnIndex: number
  }
  job: {
    sheetId: number
    sheetTitle: string
    filterStartRowIndex: number
    filterEndRowIndex: number
    endColumnIndex: number
    templateStartRowIndex: number
    templateEndRowIndex: number
    appendStartRowIndex: number
    appendEndRowIndex: number
    rollbackFormatSource?: {
      startRowIndex: number
      endRowIndex: number
    }
  }
}

const PIPELINE_CONFIG: Readonly<Record<PipelineArtifactKey, PipelineConfig>> = {
  pipeline_890: {
    candidate: {
      sheetId: 1760537585,
      sheetTitle: "Candidate Level Data - 02 July",
      sheetIndex: 2,
      gridRowCount: 998,
      filterEndRowIndex: 100,
      endColumnIndex: 17,
    },
    job: {
      sheetId: 958156097,
      sheetTitle: "Job level pipeline",
      filterStartRowIndex: 714,
      filterEndRowIndex: 718,
      endColumnIndex: 29,
      templateStartRowIndex: 717,
      templateEndRowIndex: 718,
      appendStartRowIndex: 718,
      appendEndRowIndex: 719,
      // The adjacent value-blank row carries the copy's human-owned A:E
      // background format. Preserve its exact preimage by restoring from the
      // next audited row, whose format matrix is identical.
      rollbackFormatSource: { startRowIndex: 719, endRowIndex: 720 },
    },
  },
  pipeline_907: {
    candidate: {
      sheetId: 156193952,
      sheetTitle: "Candidate Level Data - 10 July",
      sheetIndex: 1,
      gridRowCount: 998,
      filterEndRowIndex: 64,
      endColumnIndex: 14,
    },
    job: {
      sheetId: 0,
      sheetTitle: "Job level pipeline",
      filterStartRowIndex: 622,
      filterEndRowIndex: 626,
      endColumnIndex: 29,
      // Re-audited read-only on 2026-07-11 after the copy received two manual
      // Jul 3-Jul 9 snapshots in rows 630-631. Preserve both: row 631 is now
      // the format source and row 632 is the verified blank destination for
      // the first platform-owned append.
      templateStartRowIndex: 630,
      templateEndRowIndex: 631,
      appendStartRowIndex: 631,
      appendEndRowIndex: 632,
    },
  },
  pipeline_1026_1027: {
    candidate: {
      sheetId: 757546275,
      sheetTitle: "Candidate Level Data - 02 July",
      sheetIndex: 1,
      gridRowCount: 998,
      filterEndRowIndex: 77,
      endColumnIndex: 14,
    },
    job: {
      sheetId: 0,
      sheetTitle: "Job Level Pipeline",
      filterStartRowIndex: 1166,
      filterEndRowIndex: 1173,
      endColumnIndex: 33,
      templateStartRowIndex: 1171,
      templateEndRowIndex: 1173,
      appendStartRowIndex: 1173,
      appendEndRowIndex: 1175,
      // R:T background formatting continues through the remaining grid. The
      // next two blank rows are the exact preserved rollback template.
      rollbackFormatSource: { startRowIndex: 1175, endRowIndex: 1177 },
    },
  },
  pipeline_1118_1119: {
    candidate: {
      sheetId: 213573418,
      sheetTitle: "Candidate Level Data - 11 May",
      sheetIndex: 2,
      gridRowCount: 1000,
      filterEndRowIndex: 473,
      endColumnIndex: 14,
    },
    job: {
      sheetId: 0,
      sheetTitle: "Job level pipeline",
      filterStartRowIndex: 1034,
      filterEndRowIndex: 1041,
      endColumnIndex: 32,
      templateStartRowIndex: 1039,
      templateEndRowIndex: 1041,
      appendStartRowIndex: 1041,
      appendEndRowIndex: 1043,
    },
  },
}

const FINAL_OFFER_Q3_MONTHS = ["July", "August", "September"] as const

const FINAL_OFFER_Q2_SHEETS = [
  { sheetId: 310815017, sheetTitle: "June Offer Data", role: "data_template" },
  { sheetId: 2099603454, sheetTitle: "May Offer Data", role: "data" },
  { sheetId: 356344017, sheetTitle: "April Offer Data", role: "data" },
  { sheetId: 272472654, sheetTitle: "Quarterly Performance", role: "pivot" },
  { sheetId: 987616061, sheetTitle: "Recruiter Performance Table_June", role: "recruiter_template" },
  { sheetId: 517830117, sheetTitle: "Recruiter Performance Table_May", role: "pivot" },
  { sheetId: 403204078, sheetTitle: "Sourcer Performance Table_May", role: "sourcer_template" },
  { sheetId: 767782967, sheetTitle: "Recruiter Performance Table_April", role: "pivot" },
  { sheetId: 1765352829, sheetTitle: "Sourcer Performance Table_April", role: "pivot" },
] as const

const FINAL_OFFER_EXISTING_PIVOTS = [
  {
    pivotSheetId: 272472654,
    pivotSheetTitle: "Quarterly Performance",
    anchor: "A1",
    beforeSource: gridRange(1083291166, 0, 110, 0, 31),
  },
  {
    pivotSheetId: 987616061,
    pivotSheetTitle: "Recruiter Performance Table_June",
    anchor: "A1",
    beforeSource: gridRange(310815017, 0, 51, 0, 31),
  },
  {
    pivotSheetId: 517830117,
    pivotSheetTitle: "Recruiter Performance Table_May",
    anchor: "A1",
    beforeSource: gridRange(2099603454, 0, 57, 0, 31),
  },
  {
    pivotSheetId: 403204078,
    pivotSheetTitle: "Sourcer Performance Table_May",
    anchor: "A1",
    beforeSource: gridRange(2099603454, 0, 57, 0, 30),
  },
  {
    pivotSheetId: 767782967,
    pivotSheetTitle: "Recruiter Performance Table_April",
    anchor: "A1",
    beforeSource: gridRange(356344017, 0, 56, 0, 30),
  },
  {
    pivotSheetId: 1765352829,
    pivotSheetTitle: "Sourcer Performance Table_April",
    anchor: "A1",
    beforeSource: gridRange(356344017, 0, 55, 0, 30),
  },
] as const

function sheetArtifact<K extends Exclude<StagingArtifactKey, "elt_doc">>(key: K) {
  const artifact = getStagingArtifact(key)
  if (artifact.kind !== "google_sheet") throw new Error(`${key} is not a staging spreadsheet`)
  return { ...artifact, key }
}

function assertRegisteredStagingBinding(spec: StagingStructuralNormalizationSpec): void {
  const artifact = sheetArtifact(spec.artifactKey)
  if (artifact.artifactId !== spec.spreadsheetId) {
    throw new Error(`${spec.id} is not bound to the registered staging spreadsheet id`)
  }
  for (const state of [spec.expectedBefore, spec.expectedAfter]) {
    if (state.artifactKey !== spec.artifactKey || state.spreadsheetId !== spec.spreadsheetId) {
      throw new Error(`${spec.id} expected state is not bound to the same staging artifact`)
    }
  }
  if (spec.forwardRequests.length === 0 || spec.rollbackRequests.length === 0) {
    throw new Error(`${spec.id} must define both forward and rollback requests`)
  }
}

function boundState(
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">,
  spreadsheetId: string,
  state: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return { artifactKey, spreadsheetId, ...state }
}

function gridRange(
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number | undefined,
  startColumnIndex: number,
  endColumnIndex: number
): Readonly<Record<string, number>> {
  return {
    sheetId,
    startRowIndex,
    ...(endRowIndex === undefined ? {} : { endRowIndex }),
    startColumnIndex,
    endColumnIndex,
  }
}

function insertColumnRequest(sheetId: number, columnIndex: number): GoogleSheetsRequestData {
  return {
    insertDimension: {
      range: {
        sheetId,
        dimension: "COLUMNS",
        startIndex: columnIndex,
        endIndex: columnIndex + 1,
      },
      inheritFromBefore: true,
    },
  }
}

function deleteColumnRequest(sheetId: number, columnIndex: number): GoogleSheetsRequestData {
  return {
    deleteDimension: {
      range: {
        sheetId,
        dimension: "COLUMNS",
        startIndex: columnIndex,
        endIndex: columnIndex + 1,
      },
    },
  }
}

function appendRowsRequest(sheetId: number, length: number): GoogleSheetsRequestData {
  return {
    appendDimension: {
      sheetId,
      dimension: "ROWS",
      length,
    },
  }
}

function deleteRowsRequest(
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number
): GoogleSheetsRequestData {
  return {
    deleteDimension: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: startRowIndex,
        endIndex: endRowIndex,
      },
    },
  }
}

function writeCellRequest(
  sheetId: number,
  rowIndex: number,
  columnIndex: number,
  value: string
): GoogleSheetsRequestData {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rows: [{ values: [{ userEnteredValue: { stringValue: value } }] }],
      fields: "userEnteredValue",
    },
  }
}

function writeFormulaColumnRequest(
  sheetId: number,
  startRowIndex: number,
  columnIndex: number,
  formulas: readonly string[]
): GoogleSheetsRequestData {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex,
        endRowIndex: startRowIndex + formulas.length,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rows: formulas.map((formula) => ({
        values: [{ userEnteredValue: { formulaValue: formula } }],
      })),
      fields: "userEnteredValue",
    },
  }
}

function updatePivotSourceRequest(
  pivotSheetId: number,
  source: Readonly<Record<string, number>>
): GoogleSheetsRequestData {
  return {
    updateCells: {
      range: {
        sheetId: pivotSheetId,
        startRowIndex: 0,
        endRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: 1,
      },
      rows: [{ values: [{ pivotTable: { source } }] }],
      fields: "pivotTable.source",
    },
  }
}

function pivotOpenRangeSpec(input: {
  id: string
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">
  spreadsheetId: string
  pivotSheetId: number
  pivotSheetTitle: string
  anchor: "A1"
  sourceSheetTitle: string
  beforeSource: Readonly<Record<string, number>>
  afterSource: Readonly<Record<string, number>>
}): StagingStructuralNormalizationSpec {
  const common = {
    pivotSheetId: input.pivotSheetId,
    pivotSheetTitle: input.pivotSheetTitle,
    anchor: input.anchor,
    sourceSheetTitle: input.sourceSheetTitle,
  }
  return {
    id: input.id,
    artifactKey: input.artifactKey,
    spreadsheetId: input.spreadsheetId,
    expectedBefore: boundState(input.artifactKey, input.spreadsheetId, {
      pivot: { ...common, source: input.beforeSource },
    }),
    expectedAfter: boundState(input.artifactKey, input.spreadsheetId, {
      pivot: { ...common, source: input.afterSource },
    }),
    forwardRequests: [updatePivotSourceRequest(input.pivotSheetId, input.afterSource)],
    rollbackRequests: [updatePivotSourceRequest(input.pivotSheetId, input.beforeSource)],
  }
}

function setBasicFilterRequest(range: Readonly<Record<string, number>>): GoogleSheetsRequestData {
  return { setBasicFilter: { filter: { range } } }
}

function duplicateSheetRequest(
  sourceSheetId: number,
  newSheetId: number,
  newSheetName: string,
  insertSheetIndex?: number
): GoogleSheetsRequestData {
  return {
    duplicateSheet: {
      sourceSheetId,
      newSheetId,
      newSheetName,
      ...(insertSheetIndex === undefined ? {} : { insertSheetIndex }),
    },
  }
}

function deleteSheetRequest(sheetId: number): GoogleSheetsRequestData {
  return { deleteSheet: { sheetId } }
}

function setFrozenRowCountRequest(sheetId: number, frozenRowCount: number): GoogleSheetsRequestData {
  return {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount } },
      fields: "gridProperties.frozenRowCount",
    },
  }
}

function clearCellsRequest(
  range: Readonly<Record<string, number>>,
  fields: string
): GoogleSheetsRequestData {
  const cell = Object.fromEntries(
    fields.split(",").map((field) => [field.trim(), null])
  )
  return { repeatCell: { range, cell, fields } }
}

function copyPasteRequest(
  source: Readonly<Record<string, number>>,
  destination: Readonly<Record<string, number>>,
  pasteType: "PASTE_FORMAT"
): GoogleSheetsRequestData {
  return { copyPaste: { source, destination, pasteType, pasteOrientation: "NORMAL" } }
}

function withoutEndRowIndex(
  range: Readonly<Record<string, number>>
): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(range).filter(([key]) => key !== "endRowIndex"))
}

/** Exact Fri-Thu header used by Weekly Progress value and structural plans. */
export function weeklyProgressHeaderForReportingWeek(reportingWeekFriday: string): string {
  const fridayMs = validReportingFridayMs(reportingWeekFriday, "Weekly Progress header")
  const start = new Date(fridayMs)
  const end = new Date(fridayMs + 6 * DAY_MS)
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
  return `${String(start.getUTCDate()).padStart(2, "0")} ${month.format(start)} - ${String(end.getUTCDate()).padStart(2, "0")} ${month.format(end)}`
}

interface WeeklyProgressQuarterWeek {
  reportingWeekFriday: string
  header: string
}

function weeklyProgressHeaderIdentifiesReportingWeek(
  header: string,
  reportingWeekFriday: string
): boolean {
  const start = new Date(validReportingFridayMs(reportingWeekFriday, "Weekly Progress header"))
  const end = new Date(start.getTime() + 6 * DAY_MS)
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const startMonth = months[start.getUTCMonth()]
  const endMonth = months[end.getUTCMonth()]
  const startDay = start.getUTCDate()
  const endDay = end.getUTCDate()
  const paddedStart = String(startDay).padStart(2, "0")
  const paddedEnd = String(endDay).padStart(2, "0")
  const labels = fridayWeekLabels(reportingWeekFriday)
  return new Set([
    labels.weekShort,
    labels.weekLabel,
    `${paddedStart} ${startMonth} - ${paddedEnd} ${endMonth}`,
    `${paddedStart} ${startMonth} to ${paddedEnd} ${endMonth}`,
    `${startDay} ${startMonth} - ${endDay} ${endMonth}`,
    `${startDay} ${startMonth} to ${endDay} ${endMonth}`,
    `${startMonth} ${startDay} - ${endMonth} ${endDay}`,
    `${startMonth} ${startDay} to ${endMonth} ${endDay}`,
  ]).has(header)
}

interface WeeklyProgressRetainedQuarterColumn {
  columnIndex: number
  reportingWeekFriday: string
}

/**
 * Every quarter-week column between the leftmost recognized week and QTD,
 * validated contiguous and chronologically ordered against `quarterWeeks`.
 * Fails closed the same way regardless of which week set is passed in: a
 * column in that span that isn't one of the recognized weeks is genuine
 * drift, not a week to tolerate.
 */
function weeklyProgressRetainedQuarterColumns(
  sheetTitle: string,
  headers: readonly string[],
  qtdColumnIndex: number,
  quarterWeeks: readonly WeeklyProgressQuarterWeek[]
): readonly WeeklyProgressRetainedQuarterColumn[] {
  if (qtdColumnIndex < 1) {
    throw new Error(`${sheetTitle} does not have room for the reporting-quarter columns.`)
  }
  const observed = quarterWeeks.flatMap((expected, expectedIndex) => {
    const matches = headers.flatMap((header, index) =>
      index < qtdColumnIndex && weeklyProgressHeaderIdentifiesReportingWeek(header, expected.reportingWeekFriday)
        ? [index]
        : []
    )
    return matches.length === 1
      ? [{ expectedIndex, columnIndex: matches[0], reportingWeekFriday: expected.reportingWeekFriday }]
      : []
  })
  if (observed.length === 0) return []
  const startColumnIndex = observed[0].columnIndex
  const byColumn = new Map(observed.map((entry) => [entry.columnIndex, entry.expectedIndex]))
  for (let columnIndex = startColumnIndex; columnIndex < qtdColumnIndex; columnIndex += 1) {
    if (!byColumn.has(columnIndex)) {
      throw new Error(`${sheetTitle} reporting-quarter columns contain an unrecognized retained column.`)
    }
  }
  if (observed.some((entry, index) => index > 0 && entry.columnIndex <= observed[index - 1].columnIndex)) {
    throw new Error(`${sheetTitle} reporting-quarter columns are not ordered.`)
  }
  return observed.map(({ columnIndex, reportingWeekFriday }) => ({ columnIndex, reportingWeekFriday }))
}


/**
 * Every Fri-Thu week in the calendar quarter containing reportingWeekFriday,
 * not just the weeks at or before it. Backfilling an earlier week the
 * scheduled job skipped needs to recognize an already-retained LATER week's
 * column as a legitimate quarter column instead of rejecting it.
 */
function weeklyProgressFullQuarterWeeks(reportingWeekFriday: string): WeeklyProgressQuarterWeek[] {
  const currentFridayMs = validReportingFridayMs(reportingWeekFriday, "Weekly Progress quarter")
  const current = new Date(currentFridayMs)
  const quarterStartMs = Date.UTC(
    current.getUTCFullYear(),
    Math.floor(current.getUTCMonth() / 3) * 3,
    1
  )
  const quarterEndExclusiveMs = Date.UTC(
    current.getUTCFullYear(),
    Math.floor(current.getUTCMonth() / 3) * 3 + 3,
    1
  )
  const daysToFriday = (5 - new Date(quarterStartMs).getUTCDay() + 7) % 7
  const weeks: WeeklyProgressQuarterWeek[] = []
  for (
    let fridayMs = quarterStartMs + daysToFriday * DAY_MS;
    fridayMs < quarterEndExclusiveMs;
    fridayMs += 7 * DAY_MS
  ) {
    const friday = new Date(fridayMs).toISOString().slice(0, 10)
    weeks.push({
      reportingWeekFriday: friday,
      header: weeklyProgressHeaderForReportingWeek(friday),
    })
  }
  return weeks
}

function weeklyProgressQtdFormulas(
  rowCount: number,
  startColumnIndex: number,
  endColumnIndex: number,
  openingOffsets: readonly number[],
  closingOffsets: readonly number[]
): string[] {
  if (openingOffsets.length !== rowCount || closingOffsets.length !== rowCount) {
    throw new Error("Weekly Progress quarter-boundary offsets do not match the QTD row count.")
  }
  const startColumn = spreadsheetColumnLabel(startColumnIndex)
  const endColumn = spreadsheetColumnLabel(endColumnIndex)
  return Array.from(
    { length: rowCount },
    (_, index) => {
      const formula = `=SUM(${startColumn}${index + 2}:${endColumn}${index + 2})`
      const withOpening = openingOffsets[index] === 0
        ? formula
        : `${formula}+${openingOffsets[index]}`
      return closingOffsets[index] === 0
        ? withOpening
        : `${withOpening}-${closingOffsets[index]}`
    }
  )
}

function weeklyProgressQuarterClosingOffsets(
  reportingWeekFriday: string,
  supplied: readonly WeeklyProgressQuarterClosingOffsets[] | undefined
): ReadonlyMap<number, readonly number[]> {
  const reportingFridayMs = validReportingFridayMs(
    reportingWeekFriday,
    "Weekly Progress quarter-closing offsets"
  )
  const reportingFriday = new Date(reportingFridayMs)
  const quarterEndExclusiveMs = Date.UTC(
    reportingFriday.getUTCFullYear(),
    Math.floor(reportingFriday.getUTCMonth() / 3) * 3 + 3,
    1
  )
  return weeklyProgressQuarterBoundaryOffsets({
    supplied,
    required: reportingFridayMs + 6 * DAY_MS >= quarterEndExclusiveMs,
    label: "quarter-closing",
  })
}

function weeklyProgressQuarterOpeningOffsets(
  reportingWeekFriday: string,
  supplied: readonly WeeklyProgressQuarterOpeningOffsets[] | undefined
): ReadonlyMap<number, readonly number[]> {
  const reportingFridayMs = validReportingFridayMs(
    reportingWeekFriday,
    "Weekly Progress quarter-opening offsets"
  )
  const reportingFriday = new Date(reportingFridayMs)
  const quarterStartMs = Date.UTC(
    reportingFriday.getUTCFullYear(),
    Math.floor(reportingFriday.getUTCMonth() / 3) * 3,
    1
  )
  const firstFridayMs = quarterStartMs +
    ((5 - new Date(quarterStartMs).getUTCDay() + 7) % 7) * DAY_MS
  return weeklyProgressQuarterBoundaryOffsets({
    supplied,
    required: firstFridayMs > quarterStartMs,
    label: "quarter-opening",
  })
}

function weeklyProgressQuarterBoundaryOffsets(input: {
  supplied: readonly { sheetId: number; rowOffsets: readonly number[] }[] | undefined
  required: boolean
  label: "quarter-opening" | "quarter-closing"
}): ReadonlyMap<number, readonly number[]> {
  if (input.required && input.supplied === undefined) {
    throw new Error(
      `Weekly Progress calendar-QTD requires exact per-row ${input.label} offsets.`
    )
  }
  if (input.supplied === undefined) {
    return new Map(
      WEEKLY_PROGRESS_LIFECYCLE_SHEETS.map((sheet) => [
        sheet.sheetId,
        Array<number>(sheet.formulaRowCount).fill(0),
      ] as const)
    )
  }
  const byId = new Map(input.supplied.map((entry) => [entry.sheetId, entry.rowOffsets] as const))
  if (
    byId.size !== input.supplied.length ||
    byId.size !== WEEKLY_PROGRESS_LIFECYCLE_SHEETS.length
  ) {
    throw new Error(`Weekly Progress ${input.label} offsets must cover each copied tab exactly once.`)
  }
  const result = new Map<number, readonly number[]>()
  for (const contract of WEEKLY_PROGRESS_LIFECYCLE_SHEETS) {
    const offsets = byId.get(contract.sheetId)
    if (
      offsets?.length !== contract.formulaRowCount ||
      offsets.some((offset) => !Number.isInteger(offset) || offset < 0)
    ) {
      throw new Error(`${contract.sheetTitle} ${input.label} offsets are incomplete or invalid.`)
    }
    if (!input.required && offsets.some((offset) => offset !== 0)) {
      throw new Error(`${contract.sheetTitle} cannot have ${input.label} offsets outside its boundary window.`)
    }
    result.set(contract.sheetId, [...offsets])
  }
  return result
}

function validReportingFridayMs(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} requires an ISO reporting-week Friday.`)
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  const date = new Date(timestamp)
  if (Number.isNaN(timestamp) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} requires an ISO reporting-week Friday.`)
  }
  if (date.getUTCDay() !== 5) {
    throw new Error(`${label} requires a Friday reporting-week start.`)
  }
  return timestamp
}

function validIsoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} requires an ISO date.`)
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} requires an ISO date.`)
  }
  return value
}

function spreadsheetColumnLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Spreadsheet column index must be a non-negative integer.")
  }
  let ordinal = index + 1
  let label = ""
  while (ordinal > 0) {
    label = String.fromCharCode(65 + ((ordinal - 1) % 26)) + label
    ordinal = Math.floor((ordinal - 1) / 26)
  }
  return label
}

function exactDeliveryRpsLifecycleSheet(
  sheets: readonly DeliveryRpsLifecycleSheet[],
  sheetId: number,
  sheetTitle: string,
  role: string
): DeliveryRpsLifecycleSheet {
  const matches = sheets.filter(
    (sheet) => sheet.sheetId === sheetId || sheet.sheetTitle === sheetTitle
  )
  if (
    matches.length !== 1 ||
    matches[0].sheetId !== sheetId ||
    matches[0].sheetTitle !== sheetTitle
  ) {
    throw new Error(`Delivery RPS ${role} ownership is ambiguous.`)
  }
  const sheet = matches[0]
  if (
    !Number.isInteger(sheet.sheetIndex) ||
    sheet.sheetIndex < 0 ||
    !Number.isInteger(sheet.gridRowCount) ||
    !Number.isInteger(sheet.gridColumnCount)
  ) {
    throw new Error(`Delivery RPS ${role} metadata is incomplete.`)
  }
  return sheet
}

function validDeliveryRpsDatedSheet(
  sheet: DeliveryRpsLifecycleSheet,
  role: string
): DeliveryRpsLifecycleSheet {
  if (
    !Number.isInteger(sheet.sheetId) ||
    sheet.sheetId < 0 ||
    !Number.isInteger(sheet.sheetIndex) ||
    sheet.sheetIndex < 0 ||
    !Number.isInteger(sheet.gridRowCount) ||
    sheet.gridRowCount !== DELIVERY_RPS_DATED_GRID_ROW_COUNT ||
    !Number.isInteger(sheet.gridColumnCount) ||
    sheet.gridColumnCount < 14 ||
    deliveryRpsDatedTabDateMs(sheet.sheetTitle) === null
  ) {
    throw new Error(`Delivery RPS dated ${role} metadata is incomplete.`)
  }
  return sheet
}

function deliveryRpsDatedLayout(sheetTitle: string) {
  return {
    frozenRowCount: 1,
    titleCell: "A1",
    titleValue: `Recruiter Role Report - ${sheetTitle}`,
    mergedRange: "A1:N1",
    sectionLabel: { cell: "A3", value: "Summary by Team" },
    headerRange: "A4:H4",
    headers: ["Team", "Total RPS", "Match", "Mismatch", "Strong Yes", "Yes", "No", "Other"],
    valuesStartCell: "A5",
  }
}

function formatDeliveryRpsDatedTab(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date)
  return `${String(date.getUTCDate()).padStart(2, "0")} ${month} ${date.getUTCFullYear()}`
}

function deliveryRpsDatedTabDateMs(sheetTitle: string): number | null {
  const match = /^(\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/.exec(sheetTitle)
  if (!match) return null
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    .indexOf(match[2])
  const timestamp = Date.UTC(Number(match[3]), month, Number(match[1]))
  return formatDeliveryRpsDatedTab(new Date(timestamp).toISOString().slice(0, 10)) === sheetTitle
    ? timestamp
    : null
}

function validPipelineCandidateLifecycleSheet(
  sheet: PipelineCandidateLifecycleSheet,
  expectedColumnCount: number,
  role: string
): PipelineCandidateLifecycleSheet {
  if (
    !Number.isInteger(sheet.sheetId) ||
    sheet.sheetId < 0 ||
    !sheet.sheetTitle.trim() ||
    !Number.isInteger(sheet.sheetIndex) ||
    sheet.sheetIndex < 0 ||
    !Number.isInteger(sheet.gridRowCount) ||
    sheet.gridRowCount <= 1 ||
    !Number.isInteger(sheet.gridColumnCount) ||
    sheet.gridColumnCount < expectedColumnCount
  ) {
    throw new Error(`Pipeline candidate ${role} metadata is incomplete.`)
  }
  const filter = sheet.basicFilter
  if (!filter) return sheet
  if (
    filter.sheetId !== sheet.sheetId ||
    (filter.startRowIndex ?? 0) !== 0 ||
    (filter.startColumnIndex ?? 0) !== 0 ||
    filter.endColumnIndex !== expectedColumnCount
  ) {
    throw new Error(`Pipeline candidate ${role} basic filter drifted from its copied-tab bounds.`)
  }
  return sheet
}

type FinalOfferTripletParts = Partial<Record<FinalOfferLifecycleRole, FinalOfferLifecycleSheet>>

function discoverManagedFinalOfferTriplets(
  sheets: readonly FinalOfferLifecycleSheet[]
): Map<string, FinalOfferMonthTriplet> {
  const partial = new Map<string, FinalOfferTripletParts>()
  for (const sheet of sheets) {
    const ownership = finalOfferTitleOwnership(sheet.sheetTitle)
    if (!ownership) continue
    const existing = partial.get(ownership.monthKey) ?? {}
    if (existing[ownership.role]) {
      throw new Error(`Final Offer retained ${ownership.monthKey} ${ownership.role} ownership is ambiguous.`)
    }
    existing[ownership.role] = sheet
    partial.set(ownership.monthKey, existing)
  }

  const complete = new Map<string, FinalOfferMonthTriplet>()
  for (const [monthKey, parts] of partial) {
    if (!parts.offerData || !parts.recruiterPerformance || !parts.sourcerPerformance) {
      throw new Error(`Final Offer retained ${monthKey} triplet ownership is partial.`)
    }
    complete.set(monthKey, validateFinalOfferTriplet({
      monthKey,
      offerData: parts.offerData,
      recruiterPerformance: parts.recruiterPerformance,
      sourcerPerformance: parts.sourcerPerformance,
    }))
  }
  return complete
}

/**
 * Canonical legacy-Q3 2026 tab titles that Google truncated at its 31-character
 * sheet-name cap, so the regex below (which requires the full month name)
 * cannot recognize them. Exact aliases only — never widen this into a prefix
 * match, since a future longer month name could collide with a shorter
 * truncation (e.g. "..._Sept" vs "..._September").
 */
const FINAL_OFFER_TRUNCATED_TITLE_ALIASES: Readonly<
  Record<string, { monthKey: string; role: FinalOfferLifecycleRole }>
> = {
  "Recruiter Performance Table_Jul": {
    monthKey: formatFinalOfferMonthKey(2026, 6),
    role: "recruiterPerformance",
  },
  "Recruiter Performance Table_Aug": {
    monthKey: formatFinalOfferMonthKey(2026, 7),
    role: "recruiterPerformance",
  },
  "Recruiter Performance Table_Sep": {
    monthKey: formatFinalOfferMonthKey(2026, 8),
    role: "recruiterPerformance",
  },
  "Sourcer Performance Table_Augus": {
    monthKey: formatFinalOfferMonthKey(2026, 7),
    role: "sourcerPerformance",
  },
  "Sourcer Performance Table_Septe": {
    monthKey: formatFinalOfferMonthKey(2026, 8),
    role: "sourcerPerformance",
  },
}

function finalOfferTitleOwnership(
  title: string
): { monthKey: string; role: FinalOfferLifecycleRole } | null {
  const alias = FINAL_OFFER_TRUNCATED_TITLE_ALIASES[title]
  if (alias) return alias
  const roles = [
    ["offerData", /^([A-Z][a-z]+)(?: (\d{4}))? Offer Data$/],
    ["recruiterPerformance", /^Recruiter Performance Table_([A-Z][a-z]+)(?: (\d{4}))?$/],
    ["sourcerPerformance", /^Sourcer Performance Table_([A-Z][a-z]+)(?: (\d{4}))?$/],
  ] as const
  for (const [role, pattern] of roles) {
    const match = pattern.exec(title)
    if (!match) continue
    const monthIndex = FINAL_OFFER_MONTH_NAMES.indexOf(match[1] as FinalOfferMonthName)
    if (monthIndex < 0) return null
    if (match[2]) {
      const year = Number(match[2])
      return { role, monthKey: formatFinalOfferMonthKey(year, monthIndex) }
    }
    if (monthIndex >= 6 && monthIndex <= 8) {
      return { role, monthKey: formatFinalOfferMonthKey(2026, monthIndex) }
    }
    if (monthIndex >= 9) {
      throw new Error("Final Offer unqualified future-month ownership violates the year-qualified annual policy.")
    }
    // Q1/Q2 predate lifecycle ownership and remain preserved observation-only history.
    return null
  }
  return null
}

function validateFinalOfferTriplet(triplet: FinalOfferMonthTriplet): FinalOfferMonthTriplet {
  const offerData = validFinalOfferLifecycleSheet(triplet.offerData, "offer data")
  const recruiterPerformance = validFinalOfferLifecycleSheet(
    triplet.recruiterPerformance,
    "recruiter performance"
  )
  const sourcerPerformance = validFinalOfferLifecycleSheet(
    triplet.sourcerPerformance,
    "sourcer performance"
  )
  if (
    recruiterPerformance.sheetIndex !== offerData.sheetIndex + 1 ||
    sourcerPerformance.sheetIndex !== offerData.sheetIndex + 2
  ) {
    throw new Error(`Final Offer retained ${triplet.monthKey} triplet ordering is ambiguous.`)
  }
  if (offerData.gridColumnCount !== 31 || offerData.gridRowCount <= 1 || !offerData.basicFilter) {
    throw new Error(`Final Offer retained ${triplet.monthKey} offer-data form is incomplete.`)
  }
  const offerFilter = normalizeFinalOfferOpenRange(
    offerData.basicFilter,
    offerData.sheetId,
    offerData.gridRowCount,
    31,
    `${triplet.monthKey} offer-data filter`
  )
  const recruiterSource = normalizeFinalOfferOpenRange(
    recruiterPerformance.pivotSource,
    offerData.sheetId,
    offerData.gridRowCount,
    31,
    `${triplet.monthKey} recruiter pivot`
  )
  const sourcerSource = normalizeFinalOfferOpenRange(
    sourcerPerformance.pivotSource,
    offerData.sheetId,
    offerData.gridRowCount,
    30,
    `${triplet.monthKey} sourcer pivot`
  )
  return {
    monthKey: triplet.monthKey,
    offerData: { ...offerData, basicFilter: offerFilter },
    recruiterPerformance: { ...recruiterPerformance, pivotSource: recruiterSource },
    sourcerPerformance: { ...sourcerPerformance, pivotSource: sourcerSource },
  }
}

function validFinalOfferLifecycleSheet(
  sheet: FinalOfferLifecycleSheet,
  role: string
): FinalOfferLifecycleSheet {
  if (
    !Number.isInteger(sheet.sheetId) ||
    sheet.sheetId < 0 ||
    !sheet.sheetTitle.trim() ||
    !Number.isInteger(sheet.sheetIndex) ||
    sheet.sheetIndex < 0 ||
    !Number.isInteger(sheet.gridRowCount) ||
    sheet.gridRowCount <= 0 ||
    !Number.isInteger(sheet.gridColumnCount) ||
    sheet.gridColumnCount <= 0
  ) {
    throw new Error(`Final Offer retained ${role} metadata is incomplete.`)
  }
  return sheet
}

function normalizeFinalOfferOpenRange(
  range: Readonly<Record<string, number>> | null,
  expectedSheetId: number,
  gridRowCount: number,
  expectedColumnCount: number,
  label: string
): Readonly<Record<string, number>> {
  if (
    !range ||
    range.sheetId !== expectedSheetId ||
    (range.startRowIndex ?? 0) !== 0 ||
    (range.startColumnIndex ?? 0) !== 0 ||
    range.endColumnIndex !== expectedColumnCount ||
    (range.endRowIndex !== undefined && range.endRowIndex !== gridRowCount)
  ) {
    throw new Error(`Final Offer ${label} is outside its exact copied open-range contract.`)
  }
  return withoutEndRowIndex({
    ...range,
    sheetId: expectedSheetId,
    startRowIndex: 0,
    startColumnIndex: 0,
    endColumnIndex: expectedColumnCount,
  })
}

function exactFinalOfferTriplet(
  retained: ReadonlyMap<string, FinalOfferMonthTriplet>,
  monthKey: string,
  role: string
): FinalOfferMonthTriplet {
  const triplet = retained.get(monthKey)
  if (!triplet) throw new Error(`Final Offer ${role} requires one complete ${monthKey} triplet.`)
  return triplet
}

function assertFinalOfferLegacyQ3Ids(triplet: FinalOfferMonthTriplet): void {
  assertFinalOfferTargetIds(triplet, finalOfferMonthSheetIds(triplet.monthKey))
}

function assertFinalOfferTargetIds(
  triplet: FinalOfferMonthTriplet,
  ids: Readonly<Record<FinalOfferLifecycleRole, number>>
): void {
  for (const role of finalOfferRoles()) {
    if (triplet[role].sheetId !== ids[role]) {
      throw new Error(`Final Offer ${triplet.monthKey} ${role} is bound to an unexpected sheet id.`)
    }
  }
}

function finalOfferTripletState(
  triplet: FinalOfferMonthTriplet,
  offerDataSheetIndex: number
): Readonly<Record<string, unknown>> {
  return {
    monthKey: triplet.monthKey,
    offerData: {
      sheetId: triplet.offerData.sheetId,
      sheetTitle: triplet.offerData.sheetTitle,
      sheetIndex: offerDataSheetIndex,
      gridRowCount: triplet.offerData.gridRowCount,
      gridColumnCount: triplet.offerData.gridColumnCount,
      basicFilter: triplet.offerData.basicFilter,
    },
    recruiterPerformance: {
      sheetId: triplet.recruiterPerformance.sheetId,
      sheetTitle: triplet.recruiterPerformance.sheetTitle,
      sheetIndex: offerDataSheetIndex + 1,
      gridRowCount: triplet.recruiterPerformance.gridRowCount,
      gridColumnCount: triplet.recruiterPerformance.gridColumnCount,
      pivotSource: triplet.recruiterPerformance.pivotSource,
    },
    sourcerPerformance: {
      sheetId: triplet.sourcerPerformance.sheetId,
      sheetTitle: triplet.sourcerPerformance.sheetTitle,
      sheetIndex: offerDataSheetIndex + 2,
      gridRowCount: triplet.sourcerPerformance.gridRowCount,
      gridColumnCount: triplet.sourcerPerformance.gridColumnCount,
      pivotSource: triplet.sourcerPerformance.pivotSource,
    },
  }
}

function assertUniqueFinalOfferSheetOwnership(sheets: readonly FinalOfferLifecycleSheet[]): void {
  if (new Set(sheets.map((sheet) => sheet.sheetId)).size !== sheets.length) {
    throw new Error("Final Offer retained sheet-id ownership is ambiguous.")
  }
  if (new Set(sheets.map((sheet) => sheet.sheetTitle)).size !== sheets.length) {
    throw new Error("Final Offer retained sheet-title ownership is ambiguous.")
  }
}

function finalOfferRoles(): readonly FinalOfferLifecycleRole[] {
  return ["offerData", "recruiterPerformance", "sourcerPerformance"]
}

function rebindFinalOfferRange(
  range: Readonly<Record<string, number>>,
  sheetId: number
): Readonly<Record<string, number>> {
  return { ...withoutEndRowIndex(range), sheetId }
}

function validFinalOfferMonthKey(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-01$/.test(value)) {
    throw new Error(`${label} requires a first-of-month ISO date.`)
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  const date = new Date(timestamp)
  if (Number.isNaN(timestamp) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} requires a first-of-month ISO date.`)
  }
  return date
}

function formatFinalOfferMonthKey(year: number, zeroBasedMonth: number): string {
  return new Date(Date.UTC(year, zeroBasedMonth, 1)).toISOString().slice(0, 10)
}

function addFinalOfferMonths(monthKey: string, count: number): string {
  const date = validFinalOfferMonthKey(monthKey, "Final Offer month")
  return formatFinalOfferMonthKey(date.getUTCFullYear(), date.getUTCMonth() + count)
}

function isLegacyQ3MonthKey(monthKey: string): boolean {
  return monthKey >= "2026-07-01" && monthKey <= "2026-09-01"
}

function requiredText(value: string, field: string): string {
  const text = value.trim()
  if (!text) throw new Error(`${field} is required`)
  return text
}

function requiredSheetId(value: number | undefined, field: string): number {
  if (!Number.isInteger(value) || (value ?? -1) < 0) throw new Error(`${field} must be a non-negative integer`)
  return value as number
}

function validateQ3SheetIds(input: FinalOfferQ3SheetIds): FinalOfferQ3SheetIds {
  const ids = FINAL_OFFER_Q3_MONTHS.flatMap((month) => Object.values(input[month] ?? {}))
  if (ids.length !== 9 || ids.some((id) => !Number.isInteger(id) || id < 0)) {
    throw new Error("q3SheetIds must reserve nine non-negative integer sheet ids")
  }
  if (new Set(ids).size !== ids.length) throw new Error("q3SheetIds must be unique")
  const existing = new Set<number>(FINAL_OFFER_Q2_SHEETS.map((sheet) => sheet.sheetId))
  if (ids.some((id) => existing.has(id))) throw new Error("q3SheetIds collide with preserved Q2 sheet ids")
  return input
}

function monthFromTitle(title: string): FinalOfferQ3Month {
  const month = FINAL_OFFER_Q3_MONTHS.find((candidate) => title.includes(candidate))
  if (!month) throw new Error(`No Q3 month in sheet title: ${title}`)
  return month
}
