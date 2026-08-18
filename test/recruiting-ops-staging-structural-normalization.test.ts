import { describe, expect, test } from "vitest"

import {
  allHiresNormalizationSpec,
  candidateTabTitleForReportingWeek,
  deliveryRpsDatedRolloverNormalizationSpec,
  deliveryRpsDatedTabTitle,
  deliveryRpsRawFilterNormalizationSpec,
  deliveryRpsNormalizationSpec,
  deliveryRpsTargetSheetId,
  finalOfferMonthSheetIds,
  finalOfferMonthTabTitles,
  finalOfferNormalizationSpec,
  finalOfferQuarterRolloverNormalizationSpec,
  pipelineCandidateRolloverNormalizationSpec,
  pipelineCandidateTargetSheetId,
  pipelineNormalizationSpec,
  planWeeklyProgressRolloverNormalization,
  planStagingStructuralNormalization,
  rpsTrackingCapacityNormalizationSpec,
  rpsTrackingNormalizationSpec,
  weeklyProgressNormalizationSpec,
  type FinalOfferQ3SheetIds,
  type FinalOfferLifecycleSheet,
  type GoogleSheetsRequestData,
  type StagingStructuralNormalizationSpec,
} from "../lib/recruiting-ops/delivery/staging-structural-normalization"

/**
 * The pipeline candidate rollover spec builder returns null when there is no
 * structural work left to do (target tab already present, no filter to carry,
 * no job-summary block). Tests that exercise a real rollover assert a spec.
 */
function requirePipelineRolloverSpec(
  spec: StagingStructuralNormalizationSpec | null
): StagingStructuralNormalizationSpec {
  if (!spec) throw new Error("Expected a pipeline candidate rollover spec")
  return spec
}


function requestWith(requests: readonly GoogleSheetsRequestData[], key: string) {
  return requests.filter((request) => key in request)
}

function formulaColumnRequest(
  sheetId: number,
  columnIndex: number,
  formulas: readonly string[]
): GoogleSheetsRequestData {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: 1,
        endRowIndex: formulas.length + 1,
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

function weeklyProgressQuarterOpeningOffsets() {
  return [
    { sheetId: 0, rowOffsets: [0, 0, 0, 0, 0, 0, 0] },
    { sheetId: 242118538, rowOffsets: [0, 0, 0, 0, 0, 2] },
    { sheetId: 1450892249, rowOffsets: [0, 0, 0, 0, 0, 0, 0] },
  ]
}

function deliveryBaseSheets() {
  return [
    {
      sheetId: 1072762955,
      sheetTitle: "Raw_Daily_RPS",
      sheetIndex: 0,
      gridRowCount: 1000,
      gridColumnCount: 20,
      basicFilter: {
        sheetId: 1072762955,
        startRowIndex: 0,
        startColumnIndex: 0,
        endColumnIndex: 20,
      },
    },
    {
      sheetId: 1598905318,
      sheetTitle: "Cleaned_RPS",
      sheetIndex: 1,
      gridRowCount: 1000,
      gridColumnCount: 20,
      basicFilter: null,
    },
  ]
}

function deliveryDatedSheet(sheetId: number, sheetTitle: string, sheetIndex: number) {
  return {
    sheetId,
    sheetTitle,
    sheetIndex,
    gridRowCount: 1000,
    gridColumnCount: 26,
    basicFilter: null,
  }
}

function deliveryLifecycleSheets(input: { rawColumnCount?: number; cleanColumnCount?: number } = {}) {
  const [raw, clean] = deliveryBaseSheets()
  return [
    { ...raw, gridColumnCount: input.rawColumnCount ?? raw.gridColumnCount },
    { ...clean, gridColumnCount: input.cleanColumnCount ?? clean.gridColumnCount },
    deliveryDatedSheet(2061940581, "08 Jul 2026", 2),
    deliveryDatedSheet(2061940582, "09 Jul 2026", 3),
  ]
}

function finalOfferTriplet(monthKey: string, sheetIndex: number): FinalOfferLifecycleSheet[] {
  const ids = finalOfferMonthSheetIds(monthKey)
  const titles = finalOfferMonthTabTitles(monthKey)
  return [
    {
      sheetId: ids.offerData,
      sheetTitle: titles.offerData,
      sheetIndex,
      gridRowCount: 997,
      gridColumnCount: 31,
      basicFilter: { sheetId: ids.offerData, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 31 },
      pivotSource: null,
    },
    {
      sheetId: ids.recruiterPerformance,
      sheetTitle: titles.recruiterPerformance,
      sheetIndex: sheetIndex + 1,
      gridRowCount: 1000,
      gridColumnCount: 31,
      basicFilter: null,
      pivotSource: { sheetId: ids.offerData, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 31 },
    },
    {
      sheetId: ids.sourcerPerformance,
      sheetTitle: titles.sourcerPerformance,
      sheetIndex: sheetIndex + 2,
      gridRowCount: 1000,
      gridColumnCount: 31,
      basicFilter: null,
      pivotSource: { sheetId: ids.offerData, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 30 },
    },
  ]
}

function finalOfferLegacyQ3(baseIndex = 5): FinalOfferLifecycleSheet[] {
  return [
    ...finalOfferTriplet("2026-09-01", baseIndex),
    ...finalOfferTriplet("2026-08-01", baseIndex + 3),
    ...finalOfferTriplet("2026-07-01", baseIndex + 6),
  ]
}

// The canonical workbook's real tab titles for Recruiter/Sourcer Performance
// are truncated at Google Sheets' 31-character sheet-name cap; offer-data
// titles happen to fit and stay full. Confirmed live on
// 1ExampleDriveId00000000000000000000000000003.
const FINAL_OFFER_CANONICAL_TRUNCATED_TITLES: Readonly<
  Record<string, { recruiterPerformance: string; sourcerPerformance: string }>
> = {
  "2026-07-01": {
    recruiterPerformance: "Recruiter Performance Table_Jul",
    sourcerPerformance: "Sourcer Performance Table_July",
  },
  "2026-08-01": {
    recruiterPerformance: "Recruiter Performance Table_Aug",
    sourcerPerformance: "Sourcer Performance Table_Augus",
  },
  "2026-09-01": {
    recruiterPerformance: "Recruiter Performance Table_Sep",
    sourcerPerformance: "Sourcer Performance Table_Septe",
  },
}

function finalOfferTripletWithCanonicalTruncatedTitles(
  monthKey: string,
  sheetIndex: number
): FinalOfferLifecycleSheet[] {
  const [offerData, recruiterPerformance, sourcerPerformance] = finalOfferTriplet(monthKey, sheetIndex)
  const titles = FINAL_OFFER_CANONICAL_TRUNCATED_TITLES[monthKey]
  return [
    offerData,
    { ...recruiterPerformance, sheetTitle: titles.recruiterPerformance },
    { ...sourcerPerformance, sheetTitle: titles.sourcerPerformance },
  ]
}

function finalOfferLegacyQ3WithCanonicalTruncatedTitles(baseIndex = 5): FinalOfferLifecycleSheet[] {
  return [
    ...finalOfferTripletWithCanonicalTruncatedTitles("2026-09-01", baseIndex),
    ...finalOfferTripletWithCanonicalTruncatedTitles("2026-08-01", baseIndex + 3),
    ...finalOfferTripletWithCanonicalTruncatedTitles("2026-07-01", baseIndex + 6),
  ]
}

describe("staging structural normalization plans", () => {
  test("plans only from the exact preimage, emits reversible fingerprints, and no-ops at the after-state", () => {
    const spec = weeklyProgressNormalizationSpec({ currentWeekHeader: "03 Jul - 09 Jul" })
    const planned = planStagingStructuralNormalization(spec, spec.expectedBefore)

    expect(planned).toMatchObject({
      id: "weekly_progress_insert_current_week_before_qtd",
      artifactKey: "weekly_progress",
      spreadsheetId: "1ExampleDriveId00000000000000000000000000002",
      status: "planned",
      rollback: { reversible: true, preimage: spec.expectedBefore },
      requestMetadata: {
        requestShape: "sheets_v4_batch_update_requests",
        forwardRequestCount: 4,
        rollbackRequestCount: 2,
      },
    })
    expect(planned.requests).toEqual(spec.forwardRequests)
    expect(planned.rollback.requests).toEqual(spec.rollbackRequests)
    expect(planned.requestMetadata.preimageFingerprint).toMatch(/^sha256:/)
    expect(planned.requestMetadata.forwardRequestsFingerprint).toMatch(/^sha256:/)

    const noOp = planStagingStructuralNormalization(spec, spec.expectedAfter)
    expect(noOp.status).toBe("already_normalized")
    expect(noOp.requests).toEqual([])
    expect(noOp.rollback.requests).toEqual([])

    expect(() =>
      planStagingStructuralNormalization(spec, { ...spec.expectedBefore, unexpectedDrift: true })
    ).toThrow("structural precondition drifted")
  })

  test("inserts the Code+RL and Brazil+Colombia current-week columns immediately before QTD", () => {
    const spec = weeklyProgressNormalizationSpec({ currentWeekHeader: "03 Jul - 09 Jul" })

    expect(requestWith(spec.forwardRequests, "insertDimension")).toEqual([
      {
        insertDimension: {
          range: { sheetId: 0, dimension: "COLUMNS", startIndex: 25, endIndex: 26 },
          inheritFromBefore: true,
        },
      },
      {
        insertDimension: {
          range: { sheetId: 1450892249, dimension: "COLUMNS", startIndex: 16, endIndex: 17 },
          inheritFromBefore: true,
        },
      },
    ])
    const beforeSheets = spec.expectedBefore.sheets as Array<Record<string, unknown>>
    expect(beforeSheets[0]).toMatchObject({
      sheetId: 0,
      qtd: { column: "Z" },
    })
    expect((beforeSheets[0].qtd as { formulas: string[] }).formulas.slice(0, 2)).toEqual([
      "=SUM(B2:M2)",
      "=SUM(B3:M3)",
    ])
    expect(beforeSheets[1]).toMatchObject({
      sheetId: 1450892249,
      qtd: { column: "Q" },
    })
    expect((beforeSheets[1].qtd as { formulas: string[] }).formulas.slice(0, 2)).toEqual([
      "=SUM(C2:I2)",
      "=SUM(C3:I3)",
    ])
    expect(spec.expectedAfter).toMatchObject({
      sheets: [
        { currentWeek: { columnIndex: 25 }, qtd: { column: "AA", shiftedByInsertedColumn: true } },
        { currentWeek: { columnIndex: 16 }, qtd: { column: "R", shiftedByInsertedColumn: true } },
      ],
    })
    expect(requestWith(spec.rollbackRequests, "deleteDimension")).toHaveLength(2)
  })

  test("plans only missing Weekly Progress period columns from live QTD positions", () => {
    const result = planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2026-07-10",
      quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      sheets: [
        {
          sheetId: 0,
          sheetTitle: "FDL (Code + RL)",
          headers: ["Stage", "03 Jul - 09 Jul", "QTD"],
          qtdFormulas: Array.from({ length: 7 }, (_, index) => `=SUM(B${index + 2}:B${index + 2})`),
        },
        {
          sheetId: 242118538,
          sheetTitle: "FDE/PE",
          headers: ["Stage", "03 Jul - 09 Jul", "10 Jul - 16 Jul", "QTD"],
          qtdFormulas: Array.from(
            { length: 6 },
            (_, index) => `=SUM(B${index + 2}:C${index + 2})${index === 5 ? "+2" : ""}`
          ),
        },
        {
          sheetId: 1450892249,
          sheetTitle: "FDL (Brazil + Colombia)",
          headers: ["Stage", "03 Jul - 09 Jul", "QTD"],
          qtdFormulas: Array.from({ length: 7 }, (_, index) => `=SUM(B${index + 2}:B${index + 2})`),
        },
      ],
    })

    expect(result).toMatchObject({
      status: "planned",
      weekHeader: "10 Jul - 16 Jul",
      preservedSheetIds: [0, 242118538, 1450892249],
      spec: {
        artifactKey: "weekly_progress",
        spreadsheetId: "1ExampleDriveId00000000000000000000000000002",
        id: "weekly_progress_rollover_20260710",
      },
    })
    if (result.status !== "planned") throw new Error("Expected a Weekly Progress plan")
    expect(requestWith(result.spec.forwardRequests, "insertDimension")).toEqual([
      {
        insertDimension: {
          range: { sheetId: 0, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
          inheritFromBefore: true,
        },
      },
      {
        insertDimension: {
          range: { sheetId: 1450892249, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
          inheritFromBefore: true,
        },
      },
    ])
    expect(requestWith(result.spec.forwardRequests, "updateCells")).toHaveLength(4)
    expect(requestWith(result.spec.forwardRequests, "repeatCell")).toEqual([])
    expect(requestWith(result.spec.forwardRequests, "deleteDimension")).toEqual([])
    expect((result.spec.expectedBefore.sheets as unknown[])).toHaveLength(2)
    expect(planStagingStructuralNormalization(result.spec, result.spec.expectedBefore).status).toBe("planned")
    expect(planStagingStructuralNormalization(result.spec, result.spec.expectedAfter).status).toBe("already_normalized")
  })

  test("retains a Weekly Progress gap without fabricating the missed week", () => {
    const sheets = [
      [0, "FDL (Code + RL)", 7],
      [242118538, "FDE/PE", 6],
      [1450892249, "FDL (Brazil + Colombia)", 7],
    ] as const
    const result = planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2026-07-31",
      quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      sheets: sheets.map(([sheetId, sheetTitle, formulaCount]) => ({
        sheetId,
        sheetTitle,
        headers: ["Stage", "03 Jul - 09 Jul", "10 Jul - 16 Jul", "17 Jul - 23 Jul", "QTD"],
        qtdFormulas: Array.from({ length: formulaCount }, (_, index) => `=SUM(B${index + 2}:D${index + 2})`),
      })),
    })

    if (result.status !== "planned") throw new Error("Expected a Weekly Progress gap-tolerant plan")
    const [first] = result.spec.expectedAfter.sheets as Array<{
      currentWeek: { header: string }
      qtd: { formulas: string[] }
    }>
    expect(first.currentWeek.header).toBe("31 Jul - 06 Aug")
    expect(first.qtd.formulas[0]).toBe("=SUM(B2:E2)")
  })

  test("backfills a week between two already-retained weeks, in date order, not before QTD", () => {
    const sheets = [
      [0, "FDL (Code + RL)", 7],
      [242118538, "FDE/PE", 6],
      [1450892249, "FDL (Brazil + Colombia)", 7],
    ] as const
    // The scheduled job skipped 24 Jul - 30 Jul, then a later cycle already
    // wrote 31 Jul - 06 Aug. Backfilling the missed week must not be blocked
    // by that later column, and must insert before it, not before QTD.
    const headers = ["Stage", "03 Jul - 09 Jul", "10 Jul - 16 Jul", "17 Jul - 23 Jul", "31 Jul - 06 Aug", "QTD"]
    const result = planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2026-07-24",
      quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      sheets: sheets.map(([sheetId, sheetTitle, formulaCount]) => ({
        sheetId,
        sheetTitle,
        headers,
        qtdFormulas: Array.from(
          { length: formulaCount },
          (_, index) => `=SUM(B${index + 2}:E${index + 2})${sheetId === 242118538 && index === 5 ? "+2" : ""}`
        ),
      })),
    })

    if (result.status !== "planned") throw new Error("Expected a Weekly Progress backfill plan")
    expect(result.weekHeader).toBe("24 Jul - 30 Jul")
    expect(requestWith(result.spec.forwardRequests, "insertDimension")).toEqual([
      { insertDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, inheritFromBefore: true } },
      { insertDimension: { range: { sheetId: 242118538, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, inheritFromBefore: true } },
      { insertDimension: { range: { sheetId: 1450892249, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, inheritFromBefore: true } },
    ])
    expect(requestWith(result.spec.forwardRequests, "updateCells")).toEqual([
      { updateCells: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 4, endColumnIndex: 5 }, rows: [{ values: [{ userEnteredValue: { stringValue: "24 Jul - 30 Jul" } }] }], fields: "userEnteredValue" } },
      formulaColumnRequest(0, 6, ["=SUM(B2:F2)", "=SUM(B3:F3)", "=SUM(B4:F4)", "=SUM(B5:F5)", "=SUM(B6:F6)", "=SUM(B7:F7)", "=SUM(B8:F8)"]),
      { updateCells: { range: { sheetId: 242118538, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 4, endColumnIndex: 5 }, rows: [{ values: [{ userEnteredValue: { stringValue: "24 Jul - 30 Jul" } }] }], fields: "userEnteredValue" } },
      formulaColumnRequest(242118538, 6, ["=SUM(B2:F2)", "=SUM(B3:F3)", "=SUM(B4:F4)", "=SUM(B5:F5)", "=SUM(B6:F6)", "=SUM(B7:F7)+2"]),
      { updateCells: { range: { sheetId: 1450892249, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 4, endColumnIndex: 5 }, rows: [{ values: [{ userEnteredValue: { stringValue: "24 Jul - 30 Jul" } }] }], fields: "userEnteredValue" } },
      formulaColumnRequest(1450892249, 6, ["=SUM(B2:F2)", "=SUM(B3:F3)", "=SUM(B4:F4)", "=SUM(B5:F5)", "=SUM(B6:F6)", "=SUM(B7:F7)", "=SUM(B8:F8)"]),
    ])
    // Exactly one insert + one header write + one QTD rewrite per sheet --
    // nothing else in any tab is touched.
    expect(result.spec.forwardRequests).toHaveLength(9)
    expect(planStagingStructuralNormalization(result.spec, result.spec.expectedBefore).status).toBe("planned")
    expect(planStagingStructuralNormalization(result.spec, result.spec.expectedAfter).status).toBe("already_normalized")
  })

  test("still inserts immediately before QTD when the target week is the newest (regression guard)", () => {
    const sheets = [
      [0, "FDL (Code + RL)", 7],
      [242118538, "FDE/PE", 6],
      [1450892249, "FDL (Brazil + Colombia)", 7],
    ] as const
    const headers = ["Stage", "03 Jul - 09 Jul", "10 Jul - 16 Jul", "17 Jul - 23 Jul", "QTD"]
    const result = planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2026-07-31",
      quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      sheets: sheets.map(([sheetId, sheetTitle, formulaCount]) => ({
        sheetId,
        sheetTitle,
        headers,
        qtdFormulas: Array.from({ length: formulaCount }, (_, index) => `=SUM(B${index + 2}:D${index + 2})`),
      })),
    })

    if (result.status !== "planned") throw new Error("Expected a Weekly Progress plan")
    // No later week is retained, so the insert position is unchanged: the
    // Thursday every-week path still lands immediately before QTD.
    expect(requestWith(result.spec.forwardRequests, "insertDimension")).toEqual([
      { insertDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, inheritFromBefore: true } },
      { insertDimension: { range: { sheetId: 242118538, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, inheritFromBefore: true } },
      { insertDimension: { range: { sheetId: 1450892249, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, inheritFromBefore: true } },
    ])
    expect(result.spec.expectedAfter).toMatchObject({
      sheets: [
        {
          currentWeek: { columnIndex: 4, header: "31 Jul - 06 Aug" },
          qtd: {
            formulas: [
              "=SUM(B2:E2)", "=SUM(B3:E3)", "=SUM(B4:E4)", "=SUM(B5:E5)",
              "=SUM(B6:E6)", "=SUM(B7:E7)", "=SUM(B8:E8)",
            ],
          },
        },
        { currentWeek: { columnIndex: 4, header: "31 Jul - 06 Aug" } },
        { currentWeek: { columnIndex: 4, header: "31 Jul - 06 Aug" } },
      ],
    })
  })

  test("plans the Jan Weekly Progress column from observed Dec headers", () => {
    const sheets = [
      [0, "FDL (Code + RL)", 7],
      [242118538, "FDE/PE", 6],
      [1450892249, "FDL (Brazil + Colombia)", 7],
    ] as const
    const result = planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2027-01-01",
      sheets: sheets.map(([sheetId, sheetTitle, formulaCount]) => ({
        sheetId,
        sheetTitle,
        headers: ["Stage", "25 Dec - 31 Dec", "QTD"],
        qtdFormulas: Array.from(
          { length: formulaCount },
          (_, index) => `=SUM(B${index + 2}:B${index + 2})`
        ),
      })),
    })

    expect(result).toMatchObject({
      status: "planned",
      weekHeader: "01 Jan - 07 Jan",
      spec: { id: "weekly_progress_rollover_20270101" },
    })
    if (result.status !== "planned") throw new Error("Expected a Weekly Progress plan")
    expect(result.spec.expectedAfter).toMatchObject({
      sheets: [
        { currentWeek: { header: "01 Jan - 07 Jan" } },
        { currentWeek: { header: "01 Jan - 07 Jan" } },
        { currentWeek: { header: "01 Jan - 07 Jan" } },
      ],
    })
    expect(planStagingStructuralNormalization(result.spec, result.spec.expectedBefore).status).toBe("planned")
    expect(planStagingStructuralNormalization(result.spec, result.spec.expectedAfter).status).toBe("already_normalized")
  })

  test("repairs stale Weekly Progress QTD formulas without reinserting the current week", () => {
    const headers = (
      length: number,
      priorWeekColumn: number,
      currentWeekColumn: number,
      qtdColumn: number,
      priorHeader = "03 Jul - 09 Jul"
    ) => {
      const values = Array<string | null>(length).fill(null)
      values[0] = "Stage"
      values[priorWeekColumn] = priorHeader
      values[currentWeekColumn] = "10 Jul - 16 Jul"
      values[qtdColumn] = "QTD"
      return values
    }
    const sheets = [
      {
        sheetId: 0,
        sheetTitle: "FDL (Code + RL)",
        headers: headers(28, 25, 26, 27),
        qtdFormulas: [
          "=SUM(B2:M2)", "=SUM(B3:M3)", "=SUM(B4:M4)", "=SUM(B5:O5)",
          "=SUM(B6:P6)", "=SUM(B7:T7)", "=SUM(B8:Y8)",
        ],
      },
      {
        sheetId: 242118538,
        sheetTitle: "FDE/PE",
        headers: headers(27, 24, 25, 26, "Jul 3 - Jul 9"),
        qtdFormulas: [
          "=sum(B2:N2)", "=sum(B3:N3)", "=sum(B4:N4)",
          "=sum(B5:V5)", "=sum(B6:U6)", "=sum(B7:Y7)",
        ],
      },
      {
        sheetId: 1450892249,
        sheetTitle: "FDL (Brazil + Colombia)",
        headers: headers(19, 16, 17, 18),
        qtdFormulas: [
          "=SUM(C2:I2)", "=SUM(C3:I3)", "=SUM(C4:H4)", "=SUM(C5:I5)",
          "=SUM(C6:M6)", "=SUM(C7:H7)", "=SUM(C8:I8)",
        ],
      },
    ]
    const result = planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2026-07-10",
      quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      sheets,
    })

    if (result.status !== "planned") throw new Error("Expected a Weekly Progress plan")
    expect(requestWith(result.spec.forwardRequests, "insertDimension")).toEqual([])
    const formulaWrites = requestWith(result.spec.forwardRequests, "updateCells")
      .filter((request) => {
        const update = request.updateCells as { rows?: Array<{ values?: Array<{ userEnteredValue?: unknown }> }> }
        return Boolean(
          (update.rows?.[0]?.values?.[0]?.userEnteredValue as { formulaValue?: string } | undefined)
            ?.formulaValue
        )
      })
    expect(formulaWrites).toEqual([
      formulaColumnRequest(0, 27, ["=SUM(Z2:AA2)", "=SUM(Z3:AA3)", "=SUM(Z4:AA4)", "=SUM(Z5:AA5)", "=SUM(Z6:AA6)", "=SUM(Z7:AA7)", "=SUM(Z8:AA8)"]),
      formulaColumnRequest(242118538, 26, ["=SUM(Y2:Z2)", "=SUM(Y3:Z3)", "=SUM(Y4:Z4)", "=SUM(Y5:Z5)", "=SUM(Y6:Z6)", "=SUM(Y7:Z7)+2"]),
      formulaColumnRequest(1450892249, 18, ["=SUM(Q2:R2)", "=SUM(Q3:R3)", "=SUM(Q4:R4)", "=SUM(Q5:R5)", "=SUM(Q6:R6)", "=SUM(Q7:R7)", "=SUM(Q8:R8)"]),
    ])
    expect(result.spec.expectedAfter).toMatchObject({
      sheets: [
        {
          qtd: {
            column: "AB",
            formulas: ["=SUM(Z2:AA2)", "=SUM(Z3:AA3)", "=SUM(Z4:AA4)", "=SUM(Z5:AA5)", "=SUM(Z6:AA6)", "=SUM(Z7:AA7)", "=SUM(Z8:AA8)"],
          },
        },
        {
          qtd: {
            column: "AA",
            formulas: ["=SUM(Y2:Z2)", "=SUM(Y3:Z3)", "=SUM(Y4:Z4)", "=SUM(Y5:Z5)", "=SUM(Y6:Z6)", "=SUM(Y7:Z7)+2"],
          },
        },
        {
          qtd: {
            column: "S",
            formulas: ["=SUM(Q2:R2)", "=SUM(Q3:R3)", "=SUM(Q4:R4)", "=SUM(Q5:R5)", "=SUM(Q6:R6)", "=SUM(Q7:R7)", "=SUM(Q8:R8)"],
          },
        },
      ],
    })
    expect(result.spec.rollbackRequests).toEqual([
      formulaColumnRequest(1450892249, 18, sheets[2].qtdFormulas),
      formulaColumnRequest(242118538, 26, sheets[1].qtdFormulas),
      formulaColumnRequest(0, 27, sheets[0].qtdFormulas),
    ])
    const correctedSheets = (result.spec.expectedAfter.sheets as Array<{
      sheetId: number
      qtd: { formulas: string[] }
    }>).map((expected) => ({
      ...sheets.find((sheet) => sheet.sheetId === expected.sheetId)!,
      qtdFormulas: expected.qtd.formulas,
    }))
    expect(planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2026-07-10",
      quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      sheets: correctedSheets,
    })).toMatchObject({ status: "already_normalized", spec: null })
  })

  test("subtracts exact post-quarter activity from a quarter-closing Weekly Progress column", () => {
    const quarterHeaders = [
      "03 Jul - 09 Jul",
      "10 Jul - 16 Jul",
      "17 Jul - 23 Jul",
      "24 Jul - 30 Jul",
      "31 Jul - 06 Aug",
      "07 Aug - 13 Aug",
      "14 Aug - 20 Aug",
      "21 Aug - 27 Aug",
      "28 Aug - 03 Sep",
      "04 Sep - 10 Sep",
      "11 Sep - 17 Sep",
      "18 Sep - 24 Sep",
      "25 Sep - 01 Oct",
    ]
    const contracts = [
      [0, "FDL (Code + RL)", 7],
      [242118538, "FDE/PE", 6],
      [1450892249, "FDL (Brazil + Colombia)", 7],
    ] as const
    const sheets = contracts.map(([sheetId, sheetTitle, formulaCount]) => ({
      sheetId,
      sheetTitle,
      headers: ["Stage", ...quarterHeaders, "QTD"],
      qtdFormulas: Array.from(
        { length: formulaCount },
        (_, row) => `=SUM(B${row + 2}:N${row + 2})`
      ),
    }))
    const closingOffsets = [
      { sheetId: 0, rowOffsets: [1, 0, 0, 0, 0, 0, 0] },
      { sheetId: 242118538, rowOffsets: [0, 0, 0, 0, 0, 3] },
      { sheetId: 1450892249, rowOffsets: [0, 0, 0, 0, 0, 0, 1] },
    ]

    expect(() => planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2026-09-25",
      quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      sheets,
    })).toThrow("quarter-closing offsets")
    expect(() => planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2026-09-25",
      quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      quarterClosingOffsets: closingOffsets.map((entry, index) => index === 0
        ? { ...entry, rowOffsets: [-1, 0, 0, 0, 0, 0, 0] }
        : entry),
      sheets,
    })).toThrow("quarter-closing offsets are incomplete or invalid")

    const result = planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2026-09-25",
      quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      quarterClosingOffsets: closingOffsets,
      sheets,
    })
    if (result.status !== "planned") throw new Error("Expected a quarter-closing correction")
    expect(requestWith(result.spec.forwardRequests, "insertDimension")).toEqual([])
    expect(result.spec.forwardRequests).toEqual([
      formulaColumnRequest(0, 14, [
        "=SUM(B2:N2)-1", "=SUM(B3:N3)", "=SUM(B4:N4)", "=SUM(B5:N5)",
        "=SUM(B6:N6)", "=SUM(B7:N7)", "=SUM(B8:N8)",
      ]),
      formulaColumnRequest(242118538, 14, [
        "=SUM(B2:N2)", "=SUM(B3:N3)", "=SUM(B4:N4)",
        "=SUM(B5:N5)", "=SUM(B6:N6)", "=SUM(B7:N7)+2-3",
      ]),
      formulaColumnRequest(1450892249, 14, [
        "=SUM(B2:N2)", "=SUM(B3:N3)", "=SUM(B4:N4)", "=SUM(B5:N5)",
        "=SUM(B6:N6)", "=SUM(B7:N7)", "=SUM(B8:N8)-1",
      ]),
    ])
    expect(result.spec.rollbackRequests).toEqual([
      formulaColumnRequest(1450892249, 14, sheets[2].qtdFormulas),
      formulaColumnRequest(242118538, 14, sheets[1].qtdFormulas),
      formulaColumnRequest(0, 14, sheets[0].qtdFormulas),
    ])

    const correctedSheets = (result.spec.expectedAfter.sheets as Array<{
      sheetId: number
      qtd: { formulas: string[] }
    }>).map((expected) => ({
      ...sheets.find((sheet) => sheet.sheetId === expected.sheetId)!,
      qtdFormulas: expected.qtd.formulas,
    }))
    expect(planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2026-09-25",
      quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      quarterClosingOffsets: closingOffsets,
      sheets: correctedSheets,
    })).toMatchObject({ status: "already_normalized", spec: null })
  })

  test("recognizes complete Weekly Progress rollover and fails closed on ambiguous placement", () => {
    const sheets = [
      [0, "FDL (Code + RL)", 7],
      [242118538, "FDE/PE", 6],
      [1450892249, "FDL (Brazil + Colombia)", 7],
    ] as const
    const complete = sheets.map(([sheetId, sheetTitle, formulaCount]) => ({
      sheetId,
      sheetTitle,
      headers: ["Stage", "03 Jul - 09 Jul", "10 Jul - 16 Jul", "QTD"],
      qtdFormulas: Array.from(
        { length: formulaCount },
        (_, index) =>
          `=SUM(B${index + 2}:C${index + 2})${sheetId === 242118538 && index === 5 ? "+2" : ""}`
      ),
    }))
    expect(
      planWeeklyProgressRolloverNormalization({
        reportingWeekFriday: "2026-07-10",
        quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
        sheets: complete,
      })
    ).toMatchObject({ status: "already_normalized", spec: null })
    expect(() =>
      planWeeklyProgressRolloverNormalization({
        reportingWeekFriday: "2026-07-10",
        quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
        sheets: complete.map((sheet, index) =>
          index === 0
            ? { ...sheet, headers: ["Stage", "03 Jul - 09 Jul", "10 Jul - 16 Jul", "History", "QTD"] }
            : sheet
        ),
      })
    ).toThrow("unrecognized retained column")
  })

  test("accepts a backfilled week that a later week's column already sits after", () => {
    // A week the scheduled job skipped is inserted in date order, so once a
    // later cycle has run the backfilled column is no longer adjacent to QTD.
    // Requiring adjacency rejected exactly the column the backfill created.
    const sheets = [
      [0, "FDL (Code + RL)", 7],
      [242118538, "FDE/PE", 6],
      [1450892249, "FDL (Brazil + Colombia)", 7],
    ] as const
    const withLaterWeek = sheets.map(([sheetId, sheetTitle, formulaCount]) => ({
      sheetId,
      sheetTitle,
      headers: ["Stage", "03 Jul - 09 Jul", "10 Jul - 16 Jul", "17 Jul - 23 Jul", "QTD"],
      // QTD spans the whole retained quarter through its newest week, not
      // through the week being written.
      qtdFormulas: Array.from(
        { length: formulaCount },
        (_, index) =>
          `=SUM(B${index + 2}:D${index + 2})${sheetId === 242118538 && index === 5 ? "+2" : ""}`
      ),
    }))
    expect(
      planWeeklyProgressRolloverNormalization({
        reportingWeekFriday: "2026-07-10",
        quarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
        sheets: withLaterWeek,
      })
    ).toMatchObject({ status: "already_normalized", spec: null })
  })

  test("opens only the audited All Hires A:I and RPS Data Dump A:R pivot sources", () => {
    const allHires = allHiresNormalizationSpec()
    const rps = rpsTrackingNormalizationSpec()

    expect(allHires).toMatchObject({
      artifactKey: "all_hires",
      spreadsheetId: "1ExampleDriveId00000000000000000000000000018",
      expectedBefore: {
        pivot: { pivotSheetId: 461163475, source: { sheetId: 1324142221, endRowIndex: 36, endColumnIndex: 9 } },
      },
      expectedAfter: {
        pivot: { pivotSheetId: 461163475, source: { sheetId: 1324142221, endColumnIndex: 9 } },
      },
    })
    expect((allHires.expectedAfter.pivot as { source: Record<string, unknown> }).source).not.toHaveProperty(
      "endRowIndex"
    )
    expect(rps).toMatchObject({
      artifactKey: "rps_tracking",
      spreadsheetId: "1ExampleDriveId00000000000000000000000000008",
      expectedBefore: {
        pivot: { pivotSheetId: 855929445, source: { sheetId: 1092300150, endRowIndex: 4000, endColumnIndex: 18 } },
      },
      expectedAfter: {
        pivot: { pivotSheetId: 855929445, source: { sheetId: 1092300150, endColumnIndex: 18 } },
      },
    })
    expect(requestWith(allHires.forwardRequests, "updateCells")[0]).toMatchObject({
      updateCells: { range: { sheetId: 461163475 }, fields: "pivotTable.source" },
    })
    expect(requestWith(rps.rollbackRequests, "updateCells")[0]).toMatchObject({
      updateCells: {
        rows: [{ values: [{ pivotTable: { source: { endRowIndex: 4000 } } }] }],
      },
    })
  })

  test("extends only the copied RPS Data Dump with bounded headroom and reopens its pivot", () => {
    const spec = rpsTrackingCapacityNormalizationSpec({
      requiredDataRows: 3_448,
      sheet: {
        dataSheetId: 1092300150,
        dataSheetTitle: "Data Dump",
        dataRowCount: 4_251,
        dataColumnCount: 18,
        pivotSheetId: 855929445,
        pivotSheetTitle: "RPS Table",
        pivotSource: {
          sheetId: 1092300150,
          startRowIndex: 0,
          startColumnIndex: 0,
          endColumnIndex: 18,
        },
      },
    })!

    expect(spec).toMatchObject({
      id: "rps_tracking_capacity_3448_4448",
      artifactKey: "rps_tracking",
      expectedBefore: {
        rpsTrackingLifecycle: { dataSheet: { gridRowCount: 4_251 } },
      },
      expectedAfter: {
        rpsTrackingLifecycle: {
          dataSheet: { gridRowCount: 4_449 },
          pivot: { source: { sheetId: 1092300150, endColumnIndex: 18 } },
        },
      },
    })
    expect(spec.forwardRequests).toEqual([
      { appendDimension: { sheetId: 1092300150, dimension: "ROWS", length: 198 } },
      expect.objectContaining({ updateCells: expect.any(Object) }),
    ])
    expect(spec.rollbackRequests).toEqual([
      expect.objectContaining({ updateCells: expect.any(Object) }),
      {
        deleteDimension: {
          range: {
            sheetId: 1092300150,
            dimension: "ROWS",
            startIndex: 4_251,
            endIndex: 4_449,
          },
        },
      },
    ])
    expect(planStagingStructuralNormalization(spec, spec.expectedBefore).status).toBe("planned")
    expect(planStagingStructuralNormalization(spec, spec.expectedAfter).status).toBe("already_normalized")
  })

  test("leaves an open RPS pivot with sufficient row headroom unchanged", () => {
    expect(rpsTrackingCapacityNormalizationSpec({
      requiredDataRows: 3_448,
      sheet: {
        dataSheetId: 1092300150,
        dataSheetTitle: "Data Dump",
        dataRowCount: 5_001,
        dataColumnCount: 18,
        pivotSheetId: 855929445,
        pivotSheetTitle: "RPS Table",
        pivotSource: {
          sheetId: 1092300150,
          startRowIndex: 0,
          startColumnIndex: 0,
          endColumnIndex: 18,
        },
      },
    })).toBeNull()
  })

  test("opens only the existing Delivery Raw A:T filter for the current dated tab", () => {
    const spec = deliveryRpsRawFilterNormalizationSpec()
    expect(spec).toMatchObject({
      artifactKey: "delivery_roles_rps",
      spreadsheetId: "1ExampleDriveId00000000000000000000000000013",
      expectedBefore: {
        filter: {
          sheetId: 1072762955,
          sheetTitle: "Raw_Daily_RPS",
          basicFilter: { endRowIndex: 176, endColumnIndex: 20 },
        },
      },
      expectedAfter: {
        filter: {
          basicFilter: { endColumnIndex: 20 },
        },
      },
    })
    expect(spec.expectedAfter.filter).not.toHaveProperty("basicFilter.endRowIndex")
    expect(requestWith(spec.forwardRequests, "setBasicFilter")).toHaveLength(1)
    expect(requestWith(spec.forwardRequests, "duplicateSheet")).toEqual([])
    expect(spec.rollbackRequests).toEqual([
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId: 1072762955,
              startRowIndex: 0,
              endRowIndex: 176,
              startColumnIndex: 0,
              endColumnIndex: 20,
            },
          },
        },
      },
    ])
  })

  test("creates the observed Delivery dated destination and retains every existing surface", () => {
    const sheets = deliveryLifecycleSheets().map((sheet) =>
      sheet.sheetId === 1072762955
        ? { ...sheet, basicFilter: { ...sheet.basicFilter!, endRowIndex: 176 } }
        : sheet
    )
    const spec = deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: "2026-07-16",
      sheets,
    })
    const targetSheetId = deliveryRpsTargetSheetId("2026-07-16")

    expect(deliveryRpsDatedTabTitle("2026-07-16")).toBe("16 Jul 2026")
    expect(spec).toMatchObject({
      id: "delivery_rps_dated_rollover_20260716",
      artifactKey: "delivery_roles_rps",
      expectedBefore: {
        raw: { sheetId: 1072762955, basicFilter: { endRowIndex: 176, endColumnIndex: 20 } },
        clean: { sheetId: 1598905318 },
        datedTemplate: { sheetId: 2061940582, sheetTitle: "09 Jul 2026", sheetIndex: 3 },
        targetSheetAbsent: { sheetId: targetSheetId, sheetTitle: "16 Jul 2026" },
      },
      expectedAfter: {
        raw: { sheetId: 1072762955, basicFilter: { endColumnIndex: 20 } },
        datedTemplate: { sheetId: 2061940582, sheetTitle: "09 Jul 2026", sheetIndex: 4 },
        datedOutput: {
          sheetId: targetSheetId,
          sheetTitle: "16 Jul 2026",
          insertedAtIndex: 0,
          duplicatedFromSheetId: 2061940582,
        },
      },
    })
    expect(planStagingStructuralNormalization(spec, spec.expectedBefore).status).toBe("planned")
    expect(spec.forwardRequests[0]).toEqual({
      setBasicFilter: {
        filter: {
          range: {
            sheetId: 1072762955,
            startRowIndex: 0,
            startColumnIndex: 0,
            endColumnIndex: 20,
          },
        },
      },
    })
    expect(requestWith(spec.forwardRequests, "duplicateSheet")).toEqual([
      {
        duplicateSheet: {
          sourceSheetId: 2061940582,
          newSheetId: targetSheetId,
          newSheetName: "16 Jul 2026",
          insertSheetIndex: 0,
        },
      },
    ])
    expect(requestWith(spec.forwardRequests, "repeatCell")).toEqual([
      {
        repeatCell: {
          range: {
            sheetId: targetSheetId,
            startRowIndex: 4,
            endRowIndex: 1000,
            startColumnIndex: 0,
            endColumnIndex: 14,
          },
          cell: { userEnteredValue: null },
          fields: "userEnteredValue",
        },
      },
    ])
    expect(spec.rollbackRequests).toEqual([
      { deleteSheet: { sheetId: targetSheetId } },
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId: 1072762955,
              startRowIndex: 0,
              endRowIndex: 176,
              startColumnIndex: 0,
              endColumnIndex: 20,
            },
          },
        },
      },
    ])
    expect(spec.forwardRequests.some((request) => "deleteSheet" in request)).toBe(false)
    expect(requestWith(spec.forwardRequests, "setBasicFilter")).toHaveLength(1)
  })

  test("recognizes a hydrated Delivery destination, crosses a year, and rejects ambiguous ownership", () => {
    const currentId = deliveryRpsTargetSheetId("2026-07-16")
    const current = deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: "2026-07-16",
      sheets: [
        deliveryDatedSheet(currentId, "16 Jul 2026", 0),
        ...deliveryLifecycleSheets().map((sheet) => ({ ...sheet, sheetIndex: sheet.sheetIndex + 1 })),
      ],
    })
    expect(current.expectedAfter.datedOutput).not.toHaveProperty("clearedSummaryRange")
    expect(planStagingStructuralNormalization(current, current.expectedAfter)).toMatchObject({
      status: "already_normalized",
      requests: [],
    })

    const yearBoundary = deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: "2027-01-07",
      sheets: [
        ...deliveryBaseSheets(),
        deliveryDatedSheet(2061940582, "31 Dec 2026", 3),
      ],
    })
    expect(yearBoundary).toMatchObject({
      id: "delivery_rps_dated_rollover_20270107",
      expectedBefore: { targetSheetAbsent: { sheetTitle: "07 Jan 2027" } },
      expectedAfter: { datedOutput: { sheetTitle: "07 Jan 2027" } },
    })

    expect(() => deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: "2026-07-16",
      sheets: [
        ...deliveryLifecycleSheets(),
        deliveryDatedSheet(2061940583, "09 Jul 2026", 4),
      ],
    })).toThrow("ownership is ambiguous")
    const backfill = deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: "2026-07-13",
      sheets: [
        ...deliveryLifecycleSheets(),
        deliveryDatedSheet(2061940583, "16 Jul 2026", 0),
      ],
    })
    expect(backfill.expectedAfter).toMatchObject({
      datedOutput: { sheetTitle: "13 Jul 2026", insertedAtIndex: 1 },
    })
    expect(() => deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: "2026-07-16",
      sheets: deliveryLifecycleSheets().map((sheet) =>
        sheet.sheetId === 1072762955
          ? { ...sheet, basicFilter: { ...sheet.basicFilter!, endRowIndex: 175 } }
          : sheet
      ),
    })).toThrow("exact audited fixed or open A:T")

    for (const gridRowCount of [999, 1001]) {
      expect(() => deliveryRpsDatedRolloverNormalizationSpec({
        reportDate: "2026-07-16",
        sheets: deliveryLifecycleSheets().map((sheet) =>
          sheet.sheetTitle === "09 Jul 2026" ? { ...sheet, gridRowCount } : sheet
        ),
      })).toThrow("dated predecessor metadata is incomplete")
    }
  })

  test("duplicates missing current candidate tabs and appends the exact four job-summary templates", () => {
    const inputs = [
      {
        artifactKey: "pipeline_890" as const,
        reservedCandidateSheetId: 1900000001,
        expectedSpreadsheetId: "1ExampleDriveId00000000000000000000000000020",
        jobSheetId: 958156097,
        sourceRows: [717, 718],
        destinationRows: [718, 719],
        rollbackFormatSourceRows: [719, 720],
        endColumnIndex: 29,
      },
      {
        artifactKey: "pipeline_1026_1027" as const,
        reservedCandidateSheetId: 1900000002,
        expectedSpreadsheetId: "1ExampleDriveId00000000000000000000000000022",
        jobSheetId: 0,
        sourceRows: [1171, 1173],
        destinationRows: [1173, 1175],
        rollbackFormatSourceRows: [1175, 1177],
        endColumnIndex: 33,
      },
      {
        artifactKey: "pipeline_1118_1119" as const,
        reservedCandidateSheetId: 1900000003,
        expectedSpreadsheetId: "1ExampleDriveId00000000000000000000000000005",
        jobSheetId: 0,
        sourceRows: [1039, 1041],
        destinationRows: [1041, 1043],
        endColumnIndex: 32,
      },
    ]

    for (const input of inputs) {
      const spec = pipelineNormalizationSpec({
        artifactKey: input.artifactKey,
        currentCandidateTitle: "Candidate Level Data - 10 July",
        reservedCandidateSheetId: input.reservedCandidateSheetId,
      })
      expect(spec.spreadsheetId).toBe(input.expectedSpreadsheetId)
      expect(requestWith(spec.forwardRequests, "duplicateSheet")).toHaveLength(1)
      expect(requestWith(spec.forwardRequests, "copyPaste")).toEqual([
        {
          copyPaste: {
            source: {
              sheetId: input.jobSheetId,
              startRowIndex: input.sourceRows[0],
              endRowIndex: input.sourceRows[1],
              startColumnIndex: 0,
              endColumnIndex: input.endColumnIndex,
            },
            destination: {
              sheetId: input.jobSheetId,
              startRowIndex: input.destinationRows[0],
              endRowIndex: input.destinationRows[1],
              startColumnIndex: 0,
              endColumnIndex: input.endColumnIndex,
            },
            pasteType: "PASTE_FORMAT",
            pasteOrientation: "NORMAL",
          },
        },
      ])
      expect(requestWith(spec.rollbackRequests, "deleteSheet")).toEqual([
        { deleteSheet: { sheetId: input.reservedCandidateSheetId } },
      ])
      expect(requestWith(spec.rollbackRequests, "copyPaste")).toEqual(
        input.rollbackFormatSourceRows
          ? [
              {
                copyPaste: {
                  source: {
                    sheetId: input.jobSheetId,
                    startRowIndex: input.rollbackFormatSourceRows[0],
                    endRowIndex: input.rollbackFormatSourceRows[1],
                    startColumnIndex: 0,
                    endColumnIndex: input.endColumnIndex,
                  },
                  destination: {
                    sheetId: input.jobSheetId,
                    startRowIndex: input.destinationRows[0],
                    endRowIndex: input.destinationRows[1],
                    startColumnIndex: 0,
                    endColumnIndex: input.endColumnIndex,
                  },
                  pasteType: "PASTE_FORMAT",
                  pasteOrientation: "NORMAL",
                },
              },
            ]
          : []
      )
    }
  })

  test("treats the 907 current candidate tab as existing and opens its filter without duplicating it", () => {
    const spec = pipelineNormalizationSpec({
      artifactKey: "pipeline_907",
      currentCandidateTitle: "Candidate Level Data - 10 July",
    })

    expect(spec.spreadsheetId).toBe("1ExampleDriveId00000000000000000000000000009")
    expect(requestWith(spec.forwardRequests, "duplicateSheet")).toEqual([])
    expect(requestWith(spec.forwardRequests, "setBasicFilter")[0]).toEqual({
      setBasicFilter: {
        filter: {
          range: {
            sheetId: 156193952,
            startRowIndex: 0,
            startColumnIndex: 0,
            endColumnIndex: 14,
          },
        },
      },
    })
    expect(requestWith(spec.forwardRequests, "copyPaste")[0]).toMatchObject({
      copyPaste: {
        source: { sheetId: 0, startRowIndex: 630, endRowIndex: 631 },
        destination: { sheetId: 0, startRowIndex: 631, endRowIndex: 632 },
      },
    })
    expect(requestWith(spec.rollbackRequests, "deleteSheet")).toEqual([])
    expect(requestWith(spec.rollbackRequests, "setBasicFilter")).toHaveLength(2)
  })

  test("reports no structural work when the target tab exists with nothing left to carry", () => {
    // The state pipeline_907 was left in: a previous cycle created
    // `Candidate Level Data - 7 August` and then failed before writing values,
    // the predecessor carries no basic filter to copy forward, and no
    // job-summary block is supplied. There is genuinely nothing to normalize.
    //
    // Returning a request-less spec here trips the spec builder's own
    // "must define both forward and rollback requests" invariant, which the
    // recurring lifecycle reports as a structural block -- so the value phase
    // never runs and the tab stays empty forever. Null means already-normalized
    // and lets the values through.
    const targetSheetId = pipelineCandidateTargetSheetId("2026-07-31")
    expect(
      pipelineCandidateRolloverNormalizationSpec({
        artifactKey: "pipeline_907",
        reportingWeekFriday: "2026-07-31",
        sheets: [
          {
            sheetId: targetSheetId,
            sheetTitle: "Candidate Level Data - 7 August",
            sheetIndex: 1,
            gridRowCount: 1000,
            gridColumnCount: 16,
            basicFilter: null,
          },
          {
            sheetId: 456,
            sheetTitle: "Candidate Level Data - 24 July",
            sheetIndex: 2,
            gridRowCount: 1000,
            gridColumnCount: 16,
            basicFilter: null,
          },
        ],
      })
    ).toBeNull()
  })

  test.each([
    "pipeline_890",
    "pipeline_907",
    "pipeline_1026_1027",
    "pipeline_1118_1119",
  ] as const)("duplicates the exact predecessor for recurring %s candidate rollover", (artifactKey) => {
    const targetSheetId = pipelineCandidateTargetSheetId("2026-07-10")
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey,
      reportingWeekFriday: "2026-07-10",
      sheets: [
        {
          sheetId: 123,
          sheetTitle: "Candidate Level Data - 10 July",
          sheetIndex: 2,
          gridRowCount: 1000,
          gridColumnCount: artifactKey === "pipeline_890" ? 20 : 16,
          basicFilter: {
            sheetId: 123,
            startRowIndex: 0,
            endRowIndex: 1000,
            startColumnIndex: 0,
            endColumnIndex: artifactKey === "pipeline_890" ? 17 : 14,
          },
        },
        {
          sheetId: 456,
          sheetTitle: "Candidate Level Data - 03 July",
          sheetIndex: 3,
          gridRowCount: 1000,
          gridColumnCount: 16,
          basicFilter: null,
        },
      ],
    }))

    expect(spec).toMatchObject({
      artifactKey,
      id: `${artifactKey}_candidate_rollover_20260710`,
      expectedBefore: {
        pipelineCandidateRollover: {
          predecessor: { sheetId: 123, sheetIndex: 2 },
          targetSheetAbsent: {
            sheetId: targetSheetId,
            sheetTitle: "Candidate Level Data - 17 July",
          },
        },
      },
      expectedAfter: {
        pipelineCandidateRollover: {
          predecessor: { sheetId: 123, sheetIndex: 3 },
          targetSheet: {
            sheetId: targetSheetId,
            sheetTitle: "Candidate Level Data - 17 July",
            sheetIndex: 2,
            duplicatedFromSheetId: 123,
            dataRowsCleared: {
              sheetId: targetSheetId,
              startRowIndex: 1,
              endRowIndex: 1000,
              startColumnIndex: 0,
              endColumnIndex: artifactKey === "pipeline_890" ? 17 : 14,
            },
          },
        },
      },
    })
    expect(requestWith(spec.forwardRequests, "duplicateSheet")).toEqual([
      {
        duplicateSheet: {
          sourceSheetId: 123,
          newSheetId: targetSheetId,
          newSheetName: "Candidate Level Data - 17 July",
          insertSheetIndex: 2,
        },
      },
    ])
    expect(requestWith(spec.forwardRequests, "repeatCell")).toEqual([{
      repeatCell: {
        range: {
          sheetId: targetSheetId,
          startRowIndex: 1,
          endRowIndex: 1000,
          startColumnIndex: 0,
          endColumnIndex: artifactKey === "pipeline_890" ? 17 : 14,
        },
        cell: { userEnteredValue: null, note: null },
        fields: "userEnteredValue,note",
      },
    }])
    expect(spec.rollbackRequests).toEqual([{ deleteSheet: { sheetId: targetSheetId } }])
    expect(planStagingStructuralNormalization(spec, spec.expectedBefore).status).toBe("planned")
    expect(planStagingStructuralNormalization(spec, spec.expectedAfter).status).toBe("already_normalized")
  })

  test("uses the newest surviving predecessor when multiple weeks were skipped", () => {
    const predecessorTitle = candidateTabTitleForReportingWeek("2026-06-19")
    const targetSheetId = pipelineCandidateTargetSheetId("2026-07-10")
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-07-10",
      sheets: [
        {
          sheetId: 789,
          sheetTitle: predecessorTitle,
          sheetIndex: 4,
          gridRowCount: 1000,
          gridColumnCount: 16,
          basicFilter: {
            sheetId: 789,
            startRowIndex: 0,
            endRowIndex: 1000,
            startColumnIndex: 0,
            endColumnIndex: 14,
          },
        },
      ],
    }))

    expect(predecessorTitle).toBe("Candidate Level Data - 26 June")
    expect(spec.expectedBefore).toMatchObject({
      pipelineCandidateRollover: {
        predecessor: { sheetId: 789, sheetTitle: predecessorTitle, sheetIndex: 4 },
        targetSheetAbsent: {
          sheetId: targetSheetId,
          sheetTitle: "Candidate Level Data - 17 July",
        },
      },
    })
    expect(requestWith(spec.forwardRequests, "duplicateSheet")).toEqual([
      {
        duplicateSheet: {
          sourceSheetId: 789,
          newSheetId: targetSheetId,
          newSheetName: "Candidate Level Data - 17 July",
          insertSheetIndex: 4,
        },
      },
    ])
    expect(planStagingStructuralNormalization(spec, spec.expectedBefore).status).toBe("planned")
  })

  test("blocks with a clear reason when no candidate tab is older than the target week", () => {
    expect(() =>
      requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
        artifactKey: "pipeline_907",
        reportingWeekFriday: "2026-07-10",
        sheets: [],
      }))
    ).toThrow("requires at least one predecessor tab")
  })

  test("blocks as ambiguous when two tabs tie for the same candidate date", () => {
    const filter = (sheetId: number) => ({
      sheetId,
      startRowIndex: 0,
      endRowIndex: 1000,
      startColumnIndex: 0,
      endColumnIndex: 14,
    })
    expect(() =>
      requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
        artifactKey: "pipeline_907",
        reportingWeekFriday: "2026-07-10",
        sheets: [
          {
            sheetId: 111,
            sheetTitle: "Candidate Level Data - 10 July",
            sheetIndex: 1,
            gridRowCount: 1000,
            gridColumnCount: 16,
            basicFilter: filter(111),
          },
          {
            sheetId: 222,
            sheetTitle: "Candidate Level Data - 10 July",
            sheetIndex: 2,
            gridRowCount: 1000,
            gridColumnCount: 16,
            basicFilter: filter(222),
          },
        ],
      }))
    ).toThrow("ambiguous")
  })

  test("ignores an unparseable or copied predecessor title instead of crashing", () => {
    const targetSheetId = pipelineCandidateTargetSheetId("2026-07-10")
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-07-10",
      sheets: [
        {
          sheetId: 333,
          sheetTitle: "Copy of Candidate Level Data - 10 July",
          sheetIndex: 1,
          gridRowCount: 1000,
          gridColumnCount: 16,
          basicFilter: null,
        },
        {
          sheetId: 444,
          sheetTitle: "Candidate Level Data - 03 July",
          sheetIndex: 2,
          gridRowCount: 1000,
          gridColumnCount: 16,
          basicFilter: null,
        },
        {
          sheetId: 555,
          sheetTitle: "Candidate Level Data - 10 July",
          sheetIndex: 3,
          gridRowCount: 1000,
          gridColumnCount: 16,
          basicFilter: {
            sheetId: 555,
            startRowIndex: 0,
            endRowIndex: 1000,
            startColumnIndex: 0,
            endColumnIndex: 14,
          },
        },
      ],
    }))

    expect(spec.expectedBefore).toMatchObject({
      pipelineCandidateRollover: {
        predecessor: { sheetId: 555, sheetTitle: "Candidate Level Data - 10 July" },
        targetSheetAbsent: { sheetId: targetSheetId },
      },
    })
  })

  test("duplicates a retained pipeline tab that has no basic filter", () => {
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-07-10",
      sheets: [{
        sheetId: 444,
        sheetTitle: "Candidate Level Data - 10 July",
        sheetIndex: 2,
        gridRowCount: 1000,
        gridColumnCount: 14,
        basicFilter: null,
      }],
    }))

    expect(spec.expectedBefore).toMatchObject({
      pipelineCandidateRollover: { predecessor: { sheetId: 444, basicFilter: null } },
    })
    expect(requestWith(spec.forwardRequests, "setBasicFilter")).toEqual([])
  })

  test("recognizes an existing pipeline target as finished work and rejects identity collisions", () => {
    const targetSheetId = pipelineCandidateTargetSheetId("2026-12-25")
    const source = {
      sheetId: 123,
      sheetTitle: "Candidate Level Data - 25 December",
      sheetIndex: 2,
      gridRowCount: 1000,
      gridColumnCount: 14,
      basicFilter: { sheetId: 123, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 14 },
    }
    const target = {
      ...source,
      sheetId: targetSheetId,
      sheetTitle: "Candidate Level Data - 1 January",
      sheetIndex: 1,
      basicFilter: { ...source.basicFilter, sheetId: targetSheetId },
    }
    // The exact production shape that blocked pipeline_890 and
    // pipeline_1026_1027 every week: target created, its filter
    // already what the rollover wants, no job-summary work. The old builder
    // kept a no-op filter request alive, which stamped the desired filter into
    // BOTH expected states -- byte-identical states, guaranteed "ambiguously
    // matches both structural states" from the observer. Nothing left to do
    // must mean no spec at all, the same exit pipeline_907 already took.
    expect(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-12-25",
      sheets: [target, source],
    })).toBeNull()
    expect(() =>
      requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
        artifactKey: "pipeline_907",
        reportingWeekFriday: "2026-12-25",
        sheets: [{ ...source, sheetId: targetSheetId }],
      }))
    ).toThrow("collides with retained history")
  })

  test("plans exactly one filter repair when an existing target's filter drifted", () => {
    const targetSheetId = pipelineCandidateTargetSheetId("2026-12-25")
    const source = {
      sheetId: 123,
      sheetTitle: "Candidate Level Data - 25 December",
      sheetIndex: 2,
      gridRowCount: 1000,
      gridColumnCount: 14,
      basicFilter: { sheetId: 123, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 14 },
    }
    const target = {
      ...source,
      sheetId: targetSheetId,
      sheetTitle: "Candidate Level Data - 1 January",
      sheetIndex: 1,
      // A stale partial row extent (not the full grid, so the normalization
      // rule keeps it): the one filter drift that is repairable. Shape drift
      // (columns) is structurally forbidden by the duplicate-of-predecessor
      // check and fails closed -- locked in the observer tests.
      basicFilter: {
        sheetId: targetSheetId,
        startRowIndex: 0,
        startColumnIndex: 0,
        endColumnIndex: 14,
        endRowIndex: 622,
      },
    }
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-12-25",
      sheets: [target, source],
    }))

    // The observed filter is the before-state, the desired one the after-state:
    // the work is the discriminator, so the observer can classify both sides.
    expect(spec.expectedBefore).toMatchObject({
      pipelineCandidateRollover: {
        targetSheet: { basicFilter: { endRowIndex: 622 } },
      },
    })
    const afterFilter = (spec.expectedAfter.pipelineCandidateRollover as {
      targetSheet: { basicFilter: Record<string, number> }
    }).targetSheet.basicFilter
    expect(afterFilter.endRowIndex).toBeUndefined()
    expect(afterFilter.endColumnIndex).toBe(14)
    expect(
      (spec.expectedAfter.pipelineCandidateRollover as {
        targetSheet: Record<string, unknown>
      }).targetSheet
    ).not.toHaveProperty("dataRowsCleared")
    expect(spec.forwardRequests).toHaveLength(1)
    expect(requestWith(spec.forwardRequests, "setBasicFilter")).toHaveLength(1)
    expect(planStagingStructuralNormalization(spec, spec.expectedBefore)).toMatchObject({
      status: "planned",
    })
    expect(planStagingStructuralNormalization(spec, spec.expectedAfter)).toMatchObject({
      status: "already_normalized",
      requests: [],
    })
  })

  test("prepares another summary block when a pipeline target already exists", () => {
    const targetSheetId = pipelineCandidateTargetSheetId("2026-12-25")
    const predecessor = {
      sheetId: 123,
      sheetTitle: "Candidate Level Data - 25 December",
      sheetIndex: 2,
      gridRowCount: 1000,
      gridColumnCount: 16,
      basicFilter: { sheetId: 123, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 14 },
    }
    const target = {
      ...predecessor,
      sheetId: targetSheetId,
      sheetTitle: "Candidate Level Data - 1 January",
      sheetIndex: 1,
      basicFilter: { ...predecessor.basicFilter, sheetId: targetSheetId },
    }
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-12-25",
      sheets: [target, predecessor],
      jobSummary: {
        sheetId: 0,
        sheetTitle: "Job level pipeline",
        gridRowCount: 998,
        gridColumnCount: 29,
        basicFilter: {
          sheetId: 0,
          startRowIndex: 622,
          startColumnIndex: 0,
          endColumnIndex: 29,
        },
        templateStartRowIndex: 2,
        appendStartRowIndex: 3,
        blockRowCount: 1,
      },
    }))

    expect(spec.expectedBefore).toMatchObject({
      pipelineCandidateRollover: {
        predecessor: { sheetId: 123, sheetIndex: 2 },
        targetSheet: { sheetId: targetSheetId, sheetIndex: 1 },
        jobSummary: { appendDestination: { startRowIndex: 3, endRowIndex: 4 } },
      },
    })
    expect(spec.expectedAfter).toMatchObject({
      pipelineCandidateRollover: {
        predecessor: { sheetId: 123, sheetIndex: 2 },
        targetSheet: { sheetId: targetSheetId, sheetIndex: 1 },
        jobSummary: { appendedTemplate: { destination: { startRowIndex: 3, endRowIndex: 4 } } },
      },
    })
    expect(requestWith(spec.forwardRequests, "duplicateSheet")).toEqual([])
    expect(requestWith(spec.forwardRequests, "copyPaste")).toHaveLength(1)
    expect(requestWith(spec.rollbackRequests, "deleteSheet")).toEqual([])
    expect(requestWith(spec.rollbackRequests, "copyPaste")).toHaveLength(1)
    expect(planStagingStructuralNormalization(spec, spec.expectedBefore).status).toBe("planned")
    expect(planStagingStructuralNormalization(spec, spec.expectedAfter).status).toBe("already_normalized")
  })

  test("validates the existing legacy Q3 Final Offer form as a recurring no-op", () => {
    expect(finalOfferQuarterRolloverNormalizationSpec({
      quarterStart: "2026-07-01",
      sheets: finalOfferLegacyQ3(),
    })).toBeNull()
    expect(finalOfferQuarterRolloverNormalizationSpec({
      quarterStart: "2026-07-01",
      sheets: finalOfferLegacyQ3().filter((sheet) => sheet.sheetTitle !== "September Offer Data"),
    })).toBeNull()
  })

  test("plans a copy-only Q4 Final Offer quarter with year-qualified tabs and exact rollback", () => {
    const spec = finalOfferQuarterRolloverNormalizationSpec({
      quarterStart: "2026-10-01",
      sheets: finalOfferLegacyQ3(),
    })!

    expect(spec).toMatchObject({
      id: "final_offer_quarter_rollover_20261001",
      artifactKey: "final_offer",
      expectedBefore: {
        finalOfferQuarterRollover: {
          annualPolicy: "same_registered_copy_year_qualified_month_tabs",
          predecessor: { monthKey: "2026-09-01", offerData: { sheetIndex: 5 } },
        },
      },
      expectedAfter: {
        finalOfferQuarterRollover: {
          predecessor: { offerData: { sheetIndex: 14 } },
          finalMonthOrdering: ["2026-12-01", "2026-11-01", "2026-10-01"],
        },
      },
    })
    const targets = (spec.expectedAfter.finalOfferQuarterRollover as {
      targetMonths: Array<Record<string, Record<string, unknown>>>
    }).targetMonths
    expect(targets.map((target) => target.offerData.sheetTitle)).toEqual([
      "October 2026 Offer Data",
      "November 2026 Offer Data",
      "December 2026 Offer Data",
    ])
    expect(targets.map((target) => target.offerData.sheetIndex)).toEqual([11, 8, 5])
    expect(requestWith(spec.forwardRequests, "duplicateSheet")).toHaveLength(9)
    expect(requestWith(spec.forwardRequests, "repeatCell")).toHaveLength(3)
    expect(requestWith(spec.forwardRequests, "setBasicFilter")).toHaveLength(3)
    expect(requestWith(spec.forwardRequests, "updateCells")).toHaveLength(6)
    expect(spec.rollbackRequests).toHaveLength(9)
    expect(spec.rollbackRequests.every((request) => "deleteSheet" in request)).toBe(true)
    expect(planStagingStructuralNormalization(spec, spec.expectedBefore).status).toBe("planned")
  })

  test("recognizes a complete Q4 rerun, crosses the year, and blocks partial or colliding ownership", () => {
    const q4 = [
      ...finalOfferTriplet("2026-12-01", 5),
      ...finalOfferTriplet("2026-11-01", 8),
      ...finalOfferTriplet("2026-10-01", 11),
    ]
    const q3Shifted = finalOfferLegacyQ3(14)
    const rerun = finalOfferQuarterRolloverNormalizationSpec({
      quarterStart: "2026-10-01",
      sheets: [...q4, ...q3Shifted],
    })!
    expect(rerun.expectedAfter.finalOfferQuarterRollover).toMatchObject({
      predecessor: { offerData: { sheetIndex: 14 } },
    })
    expect(planStagingStructuralNormalization(rerun, rerun.expectedAfter)).toMatchObject({
      status: "already_normalized",
      requests: [],
    })

    const yearBoundary = finalOfferQuarterRolloverNormalizationSpec({
      quarterStart: "2027-01-01",
      sheets: [...q4, ...q3Shifted],
    })!
    const targetMonths = (yearBoundary.expectedAfter.finalOfferQuarterRollover as {
      targetMonths: Array<Record<string, Record<string, unknown>>>
    }).targetMonths
    expect(targetMonths.map((month) => month.offerData.sheetTitle)).toEqual([
      "January 2027 Offer Data",
      "February 2027 Offer Data",
      "March 2027 Offer Data",
    ])
    expect(new Set(targetMonths.flatMap((month) => [
      month.offerData.sheetId,
      month.recruiterPerformance.sheetId,
      month.sourcerPerformance.sheetId,
    ])).size).toBe(9)

    expect(() => finalOfferQuarterRolloverNormalizationSpec({
      quarterStart: "2026-10-01",
      sheets: [...finalOfferLegacyQ3(), finalOfferTriplet("2026-10-01", 2)[0]],
    })).toThrow("partial")
    const collisionId = finalOfferMonthSheetIds("2026-10-01").offerData
    expect(() => finalOfferQuarterRolloverNormalizationSpec({
      quarterStart: "2026-10-01",
      sheets: [
        ...finalOfferLegacyQ3(),
        {
          ...finalOfferLegacyQ3()[0],
          sheetId: collisionId,
          sheetTitle: "Unrelated retained history",
          sheetIndex: 30,
        },
      ],
    })).toThrow("collides with retained history")
  })

  test("recognizes the canonical 31-character-truncated Recruiter/Sourcer Performance titles as the retained Q3 predecessor", () => {
    // The legacy-Q3 quarterStart short-circuits before this discovery ever
    // runs (Q3 is retained, hand-created, and never re-planned), so the
    // alias table is only exercised once Q3 becomes the *predecessor* for a
    // later quarter's rollover — this is that path. Same recognition, same
    // no-op-equivalent outcome, as the full-title Q3-predecessor fixture
    // above. If a title resolved to the wrong month, the per-month sheet-id
    // assertion would throw "bound to an unexpected sheet id" instead of
    // matching the expected predecessor below.
    const q4 = [
      ...finalOfferTriplet("2026-12-01", 5),
      ...finalOfferTriplet("2026-11-01", 8),
      ...finalOfferTriplet("2026-10-01", 11),
    ]
    const q3Shifted = finalOfferLegacyQ3WithCanonicalTruncatedTitles(14)
    const rerun = finalOfferQuarterRolloverNormalizationSpec({
      quarterStart: "2026-10-01",
      sheets: [...q4, ...q3Shifted],
    })!
    expect(rerun.expectedAfter.finalOfferQuarterRollover).toMatchObject({
      predecessor: { offerData: { sheetIndex: 14 } },
    })
    expect(planStagingStructuralNormalization(rerun, rerun.expectedAfter)).toMatchObject({
      status: "already_normalized",
      requests: [],
    })
  })

  test("still fails closed on a Q4 rerun when a retained truncated title isn't in the alias table", () => {
    const q4 = [
      ...finalOfferTriplet("2026-12-01", 5),
      ...finalOfferTriplet("2026-11-01", 8),
      ...finalOfferTriplet("2026-10-01", 11),
    ]
    const q3Shifted = finalOfferLegacyQ3WithCanonicalTruncatedTitles(14).map((sheet) =>
      sheet.sheetTitle === "Recruiter Performance Table_Sep"
        ? { ...sheet, sheetTitle: "Recruiter Performance Table_Se" }
        : sheet
    )
    expect(() => finalOfferQuarterRolloverNormalizationSpec({
      quarterStart: "2026-10-01",
      sheets: [...q4, ...q3Shifted],
    })).toThrow("triplet ownership is partial")
  })

  test("preserves Q2, reserves nine Q3 sheets, opens all six existing pivots, and can reverse every change", () => {
    const q3SheetIds: FinalOfferQ3SheetIds = {
      July: { offerData: 2100000001, recruiterPerformance: 2100000002, sourcerPerformance: 2100000003 },
      August: { offerData: 2100000004, recruiterPerformance: 2100000005, sourcerPerformance: 2100000006 },
      September: { offerData: 2100000007, recruiterPerformance: 2100000008, sourcerPerformance: 2100000009 },
    }
    const spec = finalOfferNormalizationSpec({ q3SheetIds })

    expect(spec).toMatchObject({
      artifactKey: "final_offer",
      spreadsheetId: "1ExampleDriveId00000000000000000000000000003",
      expectedAfter: { q3FinalOrdering: ["September", "August", "July"] },
    })
    expect((spec.expectedBefore.preservedQ2Sheets as Array<Record<string, unknown>>).slice(0, 3)).toMatchObject([
      { sheetId: 310815017, sheetTitle: "June Offer Data" },
      { sheetId: 2099603454, sheetTitle: "May Offer Data" },
      { sheetId: 356344017, sheetTitle: "April Offer Data" },
    ])
    expect(requestWith(spec.forwardRequests, "duplicateSheet")).toHaveLength(9)
    expect(requestWith(spec.forwardRequests, "updateCells").filter((request) => {
      const update = request.updateCells as { fields?: string }
      return update.fields === "pivotTable.source"
    })).toHaveLength(12)
    expect(requestWith(spec.rollbackRequests, "deleteSheet")).toHaveLength(9)
    expect(requestWith(spec.rollbackRequests, "updateCells")).toHaveLength(6)
    expect(spec.forwardRequests).toContainEqual({
      updateCells: {
        range: {
          sheetId: 2100000002,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 1,
        },
        rows: [
          {
            values: [
              {
                pivotTable: {
                  source: {
                    sheetId: 2100000001,
                    startRowIndex: 0,
                    startColumnIndex: 0,
                    endColumnIndex: 31,
                  },
                },
              },
            ],
          },
        ],
        fields: "pivotTable.source",
      },
    })
  })

  test("opens Delivery Raw A:T and duplicates the audited dated static layout", () => {
    const spec = deliveryRpsNormalizationSpec({
      newDatedSheetId: 2200000001,
      newDatedSheetIndex: 4,
      newDatedSheetTitle: "10 Jul 2026",
      newDatedTitleValue: "Recruiter Role Report - 10 Jul 2026",
    })

    expect(spec).toMatchObject({
      artifactKey: "delivery_roles_rps",
      spreadsheetId: "1ExampleDriveId00000000000000000000000000013",
      expectedBefore: {
        raw: { basicFilter: { sheetId: 1072762955, endRowIndex: 176, endColumnIndex: 20 } },
        datedTemplate: {
          sheetId: 2061940582,
          grid: { rowCount: 1000, columnCount: 26 },
          staticLayout: { mergedRange: "A1:N1", headerRange: "A4:H4", valuesStartCell: "A5" },
        },
      },
      expectedAfter: {
        raw: { basicFilter: { sheetId: 1072762955, endColumnIndex: 20 } },
        datedOutput: {
          sheetId: 2200000001,
          sheetTitle: "10 Jul 2026",
          staticLayout: {
            titleValue: "Recruiter Role Report - 10 Jul 2026",
            headers: ["Team", "Total RPS", "Match", "Mismatch", "Strong Yes", "Yes", "No", "Other"],
          },
        },
      },
    })
    expect((spec.expectedAfter.raw as { basicFilter: Record<string, unknown> }).basicFilter).not.toHaveProperty(
      "endRowIndex"
    )
    expect(requestWith(spec.forwardRequests, "duplicateSheet")).toEqual([
      {
        duplicateSheet: {
          sourceSheetId: 2061940582,
          newSheetId: 2200000001,
          newSheetName: "10 Jul 2026",
          insertSheetIndex: 4,
        },
      },
    ])
    expect(spec.forwardRequests).toContainEqual({
      repeatCell: {
        range: {
          sheetId: 2200000001,
          startRowIndex: 4,
          endRowIndex: 1000,
          startColumnIndex: 0,
          endColumnIndex: 8,
        },
        cell: { userEnteredValue: null, note: null },
        fields: "userEnteredValue,note",
      },
    })
    expect(spec.rollbackRequests).toEqual([
      { deleteSheet: { sheetId: 2200000001 } },
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId: 1072762955,
              startRowIndex: 0,
              endRowIndex: 176,
              startColumnIndex: 0,
              endColumnIndex: 20,
            },
          },
        },
      },
    ])
  })

  test("preserves harmless Delivery grid columns beyond the owned A:T ledgers", () => {
    const spec = deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: "2026-07-16",
      sheets: deliveryLifecycleSheets({ rawColumnCount: 23, cleanColumnCount: 26 }),
    })
    const targetSheetId = deliveryRpsTargetSheetId("2026-07-16")

    expect(spec.expectedBefore).toMatchObject({
      raw: { grid: { columnCount: 23 } },
      clean: { grid: { columnCount: 26 } },
    })
    expect(spec.forwardRequests).toHaveLength(4)
    expect(requestWith(spec.forwardRequests, "updateSheetProperties")).toEqual([
      {
        updateSheetProperties: {
          properties: { sheetId: targetSheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
    ])
  })

  test("rejects missing/colliding reserved ids before producing request data", () => {
    expect(() =>
      pipelineNormalizationSpec({
        artifactKey: "pipeline_890",
        currentCandidateTitle: "Candidate Level Data - 10 July",
      })
    ).toThrow("reservedCandidateSheetId")
    expect(() =>
      finalOfferNormalizationSpec({
        q3SheetIds: {
          July: { offerData: 1, recruiterPerformance: 2, sourcerPerformance: 3 },
          August: { offerData: 4, recruiterPerformance: 5, sourcerPerformance: 6 },
          September: { offerData: 7, recruiterPerformance: 8, sourcerPerformance: 1 },
        },
      })
    ).toThrow("unique")
  })
})
