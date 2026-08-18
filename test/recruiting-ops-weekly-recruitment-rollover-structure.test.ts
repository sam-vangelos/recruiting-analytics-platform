import { describe, expect, test } from "vitest"

import {
  planStagingStructuralNormalization,
  weeklyRecruitmentRolloverNormalizationSpec,
} from "../lib/recruiting-ops/delivery/staging-structural-normalization"
import {
  projectStagingStructuralNormalizationState,
  stagingStructuralNormalizationLiteralRanges,
  verifyStagingStructuralNormalizationAfter,
  type SheetsApiSheetSnapshot,
  type SheetsApiSpreadsheetSnapshot,
} from "../lib/recruiting-ops/delivery/staging-structural-normalization-observer"
import { weeklyRecruitmentTargetSheetId } from "../lib/recruiting-ops/delivery/weekly-recruitment-rollover"

const CANONICAL_ID = "1ExampleDriveId00000000000000000000000000016"
const PREDECESSOR_ID = 1994864183
const PREDECESSOR_TITLE = "Weekly Working Report Sheet 02 Jul to 09 Jul 2026"

describe("Weekly Recruitment structural rollover", () => {
  test("plans one deterministic duplicate and one exact delete rollback", () => {
    const spec = specForCurrentWeek()
    const targetId = weeklyRecruitmentTargetSheetId("2026-07-10")

    expect(spec).toMatchObject({
      id: "weekly_recruitment_rollover_20260710",
      artifactKey: "weekly_recruitment",
      spreadsheetId: CANONICAL_ID,
      expectedBefore: {
        weeklyRecruitmentRollover: {
          predecessor: {
            sheetId: PREDECESSOR_ID,
            sheetTitle: PREDECESSOR_TITLE,
            sheetIndex: 0,
            reportingWeekThursday: "2026-07-09",
          },
          targetSheetAbsent: {
            sheetId: targetId,
            sheetTitle: "Weekly Working Report Sheet 10 Jul to 16 Jul 2026",
          },
        },
      },
      expectedAfter: {
        weeklyRecruitmentRollover: {
          predecessor: { sheetIndex: 1 },
          targetSheet: {
            sheetId: targetId,
            sheetIndex: 0,
            duplicatedFromSheetId: PREDECESSOR_ID,
          },
        },
      },
    })
    expect(spec.forwardRequests).toEqual([
      {
        duplicateSheet: {
          sourceSheetId: PREDECESSOR_ID,
          newSheetId: targetId,
          newSheetName: "Weekly Working Report Sheet 10 Jul to 16 Jul 2026",
          insertSheetIndex: 0,
        },
      },
    ])
    expect(spec.rollbackRequests).toEqual([{ deleteSheet: { sheetId: targetId } }])
    expect(planStagingStructuralNormalization(spec, spec.expectedBefore).status).toBe("planned")
    expect(planStagingStructuralNormalization(spec, spec.expectedAfter)).toMatchObject({
      status: "already_normalized",
      requests: [],
      rollback: { requests: [] },
    })
    expect(stagingStructuralNormalizationLiteralRanges(spec)).toEqual([])
  })

  test("proves the target is a structural duplicate and allowlists no other workbook change", () => {
    const spec = specForCurrentWeek()
    const { before, after } = rolloverSnapshots()

    expect(projectStagingStructuralNormalizationState(before, spec)).toBe(spec.expectedBefore)
    expect(projectStagingStructuralNormalizationState(after, spec)).toBe(spec.expectedAfter)
    expect(
      verifyStagingStructuralNormalizationAfter({
        spec,
        beforeSnapshot: before,
        afterSnapshot: after,
      })
    ).toMatchObject({
      artifactKey: "weekly_recruitment",
      normalizationId: "weekly_recruitment_rollover_20260710",
      afterStateVerified: true,
      nonApprovedStructureUnchanged: true,
      beforePlan: { status: "planned" },
      afterPlan: { status: "already_normalized" },
    })
  })

  test("fails closed on a target collision, malformed clone, or unrelated structural drift", () => {
    const spec = specForCurrentWeek()
    const { before, after } = rolloverSnapshots()
    const collision = structuredClone(before)
    collision.sheets = [
      ...(collision.sheets ?? []),
      {
        properties: {
          sheetId: weeklyRecruitmentTargetSheetId("2026-07-10"),
          title: "unrelated collision",
          index: 4,
        },
      },
    ]
    expect(() => projectStagingStructuralNormalizationState(collision, spec)).toThrow(
      "matches neither exact state"
    )

    const malformedClone = structuredClone(after)
    const target = sheetById(malformedClone, weeklyRecruitmentTargetSheetId("2026-07-10"))
    const filterViews = target.filterViews as Array<Record<string, unknown>>
    filterViews[0] = { ...filterViews[0], title: "drifted filter" }
    expect(() => projectStagingStructuralNormalizationState(malformedClone, spec)).toThrow(
      "not an exact structural duplicate"
    )

    const unrelatedDrift = structuredClone(after)
    const historical = sheetById(unrelatedDrift, 197029843)
    historical.properties = {
      ...historical.properties,
      hidden: true,
    }
    expect(() =>
      verifyStagingStructuralNormalizationAfter({
        spec,
        beforeSnapshot: before,
        afterSnapshot: unrelatedDrift,
      })
    ).toThrow("non-approved structure drifted")
  })

  test("plans normally against a predecessor older than the immediately prior week", () => {
    const spec = weeklyRecruitmentRolloverNormalizationSpec({
      reportingWeekFriday: "2026-07-10",
      predecessorSheetId: 197029843,
      predecessorSheetTitle: "Weekly Working Report Sheet 26 Jun to 02 Jul 2026",
    })
    const targetId = weeklyRecruitmentTargetSheetId("2026-07-10")

    expect(spec.expectedBefore).toMatchObject({
      weeklyRecruitmentRollover: {
        predecessor: {
          sheetId: 197029843,
          sheetTitle: "Weekly Working Report Sheet 26 Jun to 02 Jul 2026",
          reportingWeekThursday: "2026-07-02",
        },
        targetSheetAbsent: {
          sheetId: targetId,
          sheetTitle: "Weekly Working Report Sheet 10 Jul to 16 Jul 2026",
        },
      },
    })
    expect(spec.forwardRequests).toEqual([
      {
        duplicateSheet: {
          sourceSheetId: 197029843,
          newSheetId: targetId,
          newSheetName: "Weekly Working Report Sheet 10 Jul to 16 Jul 2026",
          insertSheetIndex: 0,
        },
      },
    ])
    expect(planStagingStructuralNormalization(spec, spec.expectedBefore).status).toBe("planned")
  })

  test("rejects a predecessor that does not end strictly before the target week", () => {
    expect(() =>
      weeklyRecruitmentRolloverNormalizationSpec({
        reportingWeekFriday: "2026-07-10",
        predecessorSheetId: PREDECESSOR_ID,
        predecessorSheetTitle: "Weekly Working Report Sheet 10 Jul to 16 Jul 2026",
      })
    ).toThrow("must end strictly before 2026-07-10")
  })

  test("rejects an unparseable predecessor title instead of crashing", () => {
    expect(() =>
      weeklyRecruitmentRolloverNormalizationSpec({
        reportingWeekFriday: "2026-07-10",
        predecessorSheetId: PREDECESSOR_ID,
        predecessorSheetTitle: "Copy of Weekly Working Report Sheet 02 Jul to 09 Jul 2026",
      })
    ).toThrow("must end strictly before 2026-07-10")
  })
})

function specForCurrentWeek() {
  return weeklyRecruitmentRolloverNormalizationSpec({
    reportingWeekFriday: "2026-07-10",
    predecessorSheetId: PREDECESSOR_ID,
    predecessorSheetTitle: PREDECESSOR_TITLE,
  })
}

function rolloverSnapshots(): {
  before: SheetsApiSpreadsheetSnapshot
  after: SheetsApiSpreadsheetSnapshot
} {
  const predecessor = weeklySheet(PREDECESSOR_ID, PREDECESSOR_TITLE, 0, 7001)
  const historical = weeklySheet(
    197029843,
    "Weekly Working Report Sheet 26 Jun to 02 Jul 2026",
    1,
    7002
  )
  const before: SheetsApiSpreadsheetSnapshot = {
    spreadsheetId: CANONICAL_ID,
    properties: { title: "Copy of Weekly Recruitment", locale: "en_US" },
    sheets: [predecessor, historical],
  }

  const targetId = weeklyRecruitmentTargetSheetId("2026-07-10")
  const target = structuredClone(predecessor)
  target.properties = {
    ...target.properties,
    sheetId: targetId,
    title: "Weekly Working Report Sheet 10 Jul to 16 Jul 2026",
    index: 0,
  }
  target.filterViews = [
    {
      filterViewId: 9001,
      title: "Open roles",
      range: {
        sheetId: targetId,
        startRowIndex: 0,
        endRowIndex: 1000,
        startColumnIndex: 0,
        endColumnIndex: 26,
      },
    },
  ]
  const afterPredecessor = structuredClone(predecessor)
  afterPredecessor.properties = { ...afterPredecessor.properties, index: 1 }
  const afterHistorical = structuredClone(historical)
  afterHistorical.properties = { ...afterHistorical.properties, index: 2 }
  const after: SheetsApiSpreadsheetSnapshot = {
    ...structuredClone(before),
    sheets: [target, afterPredecessor, afterHistorical],
  }
  return { before, after }
}

function weeklySheet(
  sheetId: number,
  title: string,
  index: number,
  filterViewId: number
): SheetsApiSheetSnapshot {
  return {
    properties: {
      sheetId,
      title,
      index,
      gridProperties: {
        rowCount: 1000,
        columnCount: 26,
        frozenRowCount: 1,
        frozenColumnCount: 1,
      },
    },
    filterViews: [
      {
        filterViewId,
        title: "Open roles",
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1000,
          startColumnIndex: 0,
          endColumnIndex: 26,
        },
      },
    ],
    data: [
      {
        startRow: 0,
        startColumn: 0,
        columnMetadata: [{ pixelSize: 220 }, { pixelSize: 100 }],
        rowData: [
          {
            values: [
              { userEnteredFormat: { backgroundColor: { red: 0.8, green: 0.9, blue: 0.8 } } },
              { userEnteredValue: { formulaValue: "=A1" }, dataValidation: { condition: { type: "ONE_OF_LIST" } } },
            ],
          },
        ],
      },
    ],
  }
}

function sheetById(
  snapshot: SheetsApiSpreadsheetSnapshot,
  id: number
): SheetsApiSheetSnapshot & { filterViews?: unknown } {
  const sheet = snapshot.sheets?.find((candidate) => candidate.properties?.sheetId === id)
  if (!sheet) throw new Error(`fixture sheet ${id} missing`)
  return sheet
}
