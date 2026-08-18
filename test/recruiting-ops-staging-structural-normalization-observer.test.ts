import { describe, expect, test } from "vitest"

import {
  bindStagingStructuralFilterPreimages,
  projectStagingStructuralNormalizationState,
  stagingStructuralNormalizationLiteralRanges,
  verifyStagingStructuralNormalizationAfter,
  type SheetsApiSheetSnapshot,
  type SheetsApiSpreadsheetSnapshot,
} from "../lib/recruiting-ops/delivery/staging-structural-normalization-observer"
import {
  allHiresNormalizationSpec,
  deliveryRpsDatedRolloverNormalizationSpec,
  deliveryRpsRawFilterNormalizationSpec,
  deliveryRpsNormalizationSpec,
  finalOfferMonthSheetIds,
  finalOfferMonthTabTitles,
  finalOfferNormalizationSpec,
  finalOfferQuarterRolloverNormalizationSpec,
  pipelineCandidateRolloverNormalizationSpec,
  pipelineCandidateTargetSheetId,
  pipelineNormalizationSpec,
  planWeeklyProgressRolloverNormalization,
  rpsTrackingCapacityNormalizationSpec,
  rpsTrackingNormalizationSpec,
  weeklyProgressNormalizationSpec,
  type StagingStructuralNormalizationSpec,
  type FinalOfferLifecycleSheet,
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


type Obj = Record<string, unknown>
type CellFixture = { row: number; column: number; cell: Obj }

const q3Ids = {
  July: { offerData: 2100000001, recruiterPerformance: 2100000002, sourcerPerformance: 2100000003 },
  August: { offerData: 2100000004, recruiterPerformance: 2100000005, sourcerPerformance: 2100000006 },
  September: { offerData: 2100000007, recruiterPerformance: 2100000008, sourcerPerformance: 2100000009 },
} as const

describe("staging structural normalization snapshot bridge", () => {
  test("projects and fully verifies the audited before/after snapshots for every structural spec", () => {
    const cases: Array<{
      spec: StagingStructuralNormalizationSpec
      snapshots: { before: SheetsApiSpreadsheetSnapshot; after: SheetsApiSpreadsheetSnapshot }
    }> = []

    const weekly = weeklyProgressNormalizationSpec({ currentWeekHeader: "03 Jul - 09 Jul" })
    cases.push({ spec: weekly, snapshots: weeklySnapshots(weekly) })

    const allHires = allHiresNormalizationSpec()
    cases.push({ spec: allHires, snapshots: singlePivotSnapshots(allHires) })

    const rps = rpsTrackingNormalizationSpec()
    cases.push({ spec: rps, snapshots: singlePivotSnapshots(rps) })

    const rpsCapacity = rpsTrackingCapacityNormalizationSpec({
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
    cases.push({ spec: rpsCapacity, snapshots: rpsLifecycleSnapshots(rpsCapacity) })

    const deliveryFilter = deliveryRpsRawFilterNormalizationSpec()
    cases.push({ spec: deliveryFilter, snapshots: singleFilterSnapshots(deliveryFilter) })

    for (const spec of [
      pipelineNormalizationSpec({
        artifactKey: "pipeline_890",
        currentCandidateTitle: "Candidate Level Data - 10 July",
        reservedCandidateSheetId: 1900000001,
      }),
      pipelineNormalizationSpec({
        artifactKey: "pipeline_907",
        currentCandidateTitle: "Candidate Level Data - 10 July",
      }),
      pipelineNormalizationSpec({
        artifactKey: "pipeline_1026_1027",
        currentCandidateTitle: "Candidate Level Data - 10 July",
        reservedCandidateSheetId: 1900000002,
      }),
      pipelineNormalizationSpec({
        artifactKey: "pipeline_1118_1119",
        currentCandidateTitle: "Candidate Level Data - 10 July",
        reservedCandidateSheetId: 1900000003,
      }),
    ]) {
      cases.push({ spec, snapshots: pipelineSnapshots(spec) })
    }

    const pipelineRollover = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-07-10",
      sheets: [
        {
          sheetId: 156193952,
          sheetTitle: "Candidate Level Data - 10 July",
          sheetIndex: 1,
          gridRowCount: 998,
          gridColumnCount: 14,
          basicFilter: {
            sheetId: 156193952,
            startRowIndex: 0,
            startColumnIndex: 0,
            endColumnIndex: 14,
          },
        },
      ],
    }))
    cases.push({ spec: pipelineRollover, snapshots: pipelineRolloverSnapshots(pipelineRollover) })

    const finalOffer = finalOfferNormalizationSpec({ q3SheetIds: q3Ids })
    cases.push({ spec: finalOffer, snapshots: finalOfferSnapshots(finalOffer) })

    const finalOfferRollover = finalOfferQuarterRolloverNormalizationSpec({
      quarterStart: "2026-10-01",
      sheets: finalOfferLegacyQ3Descriptors(),
    })!
    cases.push({
      spec: finalOfferRollover,
      snapshots: finalOfferQuarterRolloverSnapshots(finalOfferRollover),
    })

    const delivery = deliveryRpsNormalizationSpec({
      newDatedSheetId: 2200000001,
      newDatedSheetIndex: 4,
      newDatedSheetTitle: "10 Jul 2026",
      newDatedTitleValue: "Recruiter Role Report - 10 Jul 2026",
    })
    cases.push({ spec: delivery, snapshots: deliverySnapshots(delivery) })

    const deliveryRollover = deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: "2026-07-16",
      sheets: deliveryLifecycleDescriptors(176),
    })
    cases.push({ spec: deliveryRollover, snapshots: deliverySnapshots(deliveryRollover) })

    expect(cases).toHaveLength(14)
    for (const { spec, snapshots } of cases) {
      expect(projectStagingStructuralNormalizationState(snapshots.before, spec)).toBe(spec.expectedBefore)
      expect(projectStagingStructuralNormalizationState(snapshots.after, spec)).toBe(spec.expectedAfter)
      expect(
        verifyStagingStructuralNormalizationAfter({
          spec,
          beforeSnapshot: snapshots.before,
          afterSnapshot: snapshots.after,
        })
      ).toMatchObject({
        artifactKey: spec.artifactKey,
        spreadsheetId: spec.spreadsheetId,
        normalizationId: spec.id,
        afterStateVerified: true,
        nonApprovedStructureUnchanged: true,
        beforePlan: { status: "planned" },
        afterPlan: { status: "already_normalized", requests: [] },
      })
    }
  })

  test("fails projection for a mixed/partial normalization and for the wrong staging spreadsheet", () => {
    const spec = allHiresNormalizationSpec()
    const { before, after } = singlePivotSnapshots(spec)
    const partial = structuredClone(after)
    pivotCell(sheetById(partial, 461163475)).pivotTable = {
      source: { sheetId: 1324142221, startRowIndex: 0, endRowIndex: 37, startColumnIndex: 0, endColumnIndex: 9 },
    }

    expect(() => projectStagingStructuralNormalizationState(partial, spec)).toThrow("matches neither exact state")
    expect(() =>
      projectStagingStructuralNormalizationState({ ...before, spreadsheetId: "canonical-production-id" }, spec)
    ).toThrow("not the registered staging spreadsheet")
  })

  test("allows only Sheets' format-only append side effect in newly approved RPS rows", () => {
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
    const snapshots = rpsLifecycleSnapshots(spec)
    const appended = sheetById(snapshots.after, 1092300150)
    appended.data = [
      ...(appended.data ?? []),
      {
        startRow: 4_251,
        startColumn: 0,
        rowMetadata: [{ pixelSize: 21 }, { pixelSize: 21 }],
        rowData: Array.from({ length: 2 }, () => ({
          values: Array.from({ length: 18 }, () => ({
            userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } },
          })),
        })),
      },
    ]

    expect(verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: snapshots.after,
    })).toMatchObject({ afterStateVerified: true, nonApprovedStructureUnchanged: true })

    const formulaInAppendedRow = structuredClone(snapshots.after)
    gridCell(sheetById(formulaInAppendedRow, 1092300150), 4_251, 0).userEnteredValue = {
      formulaValue: "=1",
    }
    expect(() => verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: formulaInAppendedRow,
    })).toThrow("non-approved structure drifted")

    const formatInExistingRow = structuredClone(snapshots.after)
    sheetById(formatInExistingRow, 1092300150).data = [
      ...(sheetById(formatInExistingRow, 1092300150).data ?? []),
      {
        startRow: 4_250,
        startColumn: 0,
        rowData: [{ values: [{ userEnteredFormat: { backgroundColor: { red: 0.5 } } }] }],
      },
    ]
    expect(() => verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: formatInExistingRow,
    })).toThrow("non-approved structure drifted")
  })

  test("normalizes an omitted protobuf sheetId to sheet zero", () => {
    const spec = pipelineNormalizationSpec({
      artifactKey: "pipeline_907",
      currentCandidateTitle: "Candidate Level Data - 10 July",
    })
    const snapshots = pipelineSnapshots(spec)
    delete rec(rec(sheetById(snapshots.before, 0).basicFilter).range).sheetId
    delete rec(rec(sheetById(snapshots.after, 0).basicFilter).range).sheetId

    expect(projectStagingStructuralNormalizationState(snapshots.before, spec)).toBe(spec.expectedBefore)
    expect(projectStagingStructuralNormalizationState(snapshots.after, spec)).toBe(spec.expectedAfter)
  })

  test("rejects pipeline rollover target form drift while retaining old tabs", () => {
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-07-10",
      sheets: [
        {
          sheetId: 156193952,
          sheetTitle: "Candidate Level Data - 10 July",
          sheetIndex: 1,
          gridRowCount: 998,
          gridColumnCount: 14,
          basicFilter: { sheetId: 156193952, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 14 },
        },
      ],
    }))
    const snapshots = pipelineRolloverSnapshots(spec)
    const target = rec(spec.expectedAfter.pipelineCandidateRollover).targetSheet as Obj
    const drifted = structuredClone(snapshots.after)
    gridCell(sheetById(drifted, Number(target.sheetId)), 0, 5).userEnteredValue = {
      formulaValue: "=99",
    }
    expect(() => projectStagingStructuralNormalizationState(drifted, spec)).toThrow(
      "matches neither exact state"
    )
    expect(snapshots.after.sheets?.some((sheet) => properties(sheet).title === "Retained history")).toBe(true)
  })

  test("certifies a structural-only pipeline target as blank without erasing copied form", () => {
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-07-10",
      sheets: [{
        sheetId: 156193952,
        sheetTitle: "Candidate Level Data - 10 July",
        sheetIndex: 1,
        gridRowCount: 998,
        gridColumnCount: 16,
        basicFilter: {
          sheetId: 156193952,
          startRowIndex: 0,
          startColumnIndex: 0,
          endColumnIndex: 14,
        },
      }],
    }))
    const snapshots = pipelineRolloverSnapshots(spec)
    const before = rec(spec.expectedBefore.pipelineCandidateRollover)
    const after = rec(spec.expectedAfter.pipelineCandidateRollover)
    const predecessorId = Number(rec(before.predecessor).sheetId)
    const targetId = Number(rec(after.targetSheet).sheetId)
    const predecessor = sheetById(snapshots.before, predecessorId)
    const afterPredecessor = sheetById(snapshots.after, predecessorId)
    const target = sheetById(snapshots.after, targetId)
    gridCell(predecessor, 1, 0).userEnteredValue = { stringValue: "old candidate" }
    gridCell(afterPredecessor, 1, 0).userEnteredValue = { stringValue: "old candidate" }
    const retainedFormula = {
      startRow: 1,
      startColumn: 15,
      rowData: [{ values: [{ userEnteredValue: { formulaValue: "=ROW()" } }] }],
    }
    predecessor.data = [...(predecessor.data ?? []), structuredClone(retainedFormula)]
    afterPredecessor.data = [...(afterPredecessor.data ?? []), structuredClone(retainedFormula)]
    target.data = [...(target.data ?? []), structuredClone(retainedFormula)]

    expect(projectStagingStructuralNormalizationState(snapshots.after, spec)).toBe(spec.expectedAfter)
    expect(stagingStructuralNormalizationLiteralRanges(spec)).toContainEqual({
      purpose: "blank_destination",
      sheetTitle: "Candidate Level Data - 17 July",
      gridRange: {
        sheetId: targetId,
        startRowIndex: 1,
        endRowIndex: 998,
        startColumnIndex: 0,
        endColumnIndex: 14,
      },
    })
    expect(gridCell(target, 1, 0).userEnteredValue).toBeUndefined()
    expect(gridCell(target, 1, 0).userEnteredFormat).toEqual({
      backgroundColor: { red: 0.2 },
    })
    expect(gridCell(target, 1, 15).userEnteredValue).toEqual({ formulaValue: "=ROW()" })
    expect(gridCell(afterPredecessor, 1, 0).userEnteredValue).toEqual({
      stringValue: "old candidate",
    })
    expect(verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: snapshots.after,
    })).toMatchObject({
      afterStateVerified: true,
      nonApprovedStructureUnchanged: true,
    })

    const predecessorPopulated = structuredClone(snapshots.after)
    gridCell(sheetById(predecessorPopulated, targetId), 1, 0).userEnteredValue = {
      stringValue: "old candidate",
    }
    expect(() => projectStagingStructuralNormalizationState(predecessorPopulated, spec)).toThrow(
      "matches neither exact state"
    )
  })

  test("certifies recurring pipeline summary format prep and treats a hydrated rerun as a no-op", () => {
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-12-25",
      sheets: [{
        sheetId: 156193952,
        sheetTitle: "Candidate Level Data - 25 December",
        sheetIndex: 1,
        gridRowCount: 998,
        gridColumnCount: 14,
        basicFilter: {
          sheetId: 156193952,
          startRowIndex: 0,
          startColumnIndex: 0,
          endColumnIndex: 14,
        },
      }],
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
    const snapshots = pipelineRolloverSnapshots(spec)
    const hydrated = structuredClone(snapshots.after)
    const job = sheetById(hydrated, 0)
    gridCell(job, 3, 0).userEnteredValue = { numberValue: 54 }
    gridCell(job, 3, 1).userEnteredValue = { stringValue: "Dec 25 - Dec 31" }
    gridCell(job, 3, 2).userEnteredValue = { stringValue: "907" }

    expect(projectStagingStructuralNormalizationState(snapshots.before, spec)).toBe(spec.expectedBefore)
    expect(projectStagingStructuralNormalizationState(hydrated, spec)).toBe(spec.expectedAfter)
    expect(stagingStructuralNormalizationLiteralRanges(spec)).toEqual([
      {
        purpose: "blank_destination",
        sheetTitle: "Job level pipeline",
        gridRange: {
          sheetId: 0,
          startRowIndex: 3,
          endRowIndex: 4,
          startColumnIndex: 0,
          endColumnIndex: 29,
        },
      },
      {
        purpose: "blank_destination",
        sheetTitle: "Candidate Level Data - 1 January",
        gridRange: {
          sheetId: pipelineCandidateTargetSheetId("2026-12-25"),
          startRowIndex: 1,
          endRowIndex: 998,
          startColumnIndex: 0,
          endColumnIndex: 14,
        },
      },
    ])
    expect(verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: hydrated,
    })).toMatchObject({
      afterPlan: { status: "already_normalized", requests: [] },
      afterStateVerified: true,
      nonApprovedStructureUnchanged: true,
    })
  })

  test("certifies summary-only recurrence on an existing pipeline target", () => {
    const targetSheetId = pipelineCandidateTargetSheetId("2026-12-25")
    const predecessor = {
      sheetId: 156193952,
      sheetTitle: "Candidate Level Data - 25 December",
      sheetIndex: 2,
      gridRowCount: 998,
      gridColumnCount: 16,
      basicFilter: {
        sheetId: 156193952,
        startRowIndex: 0,
        startColumnIndex: 0,
        endColumnIndex: 14,
      },
    }
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-12-25",
      sheets: [
        {
          ...predecessor,
          sheetId: targetSheetId,
          sheetTitle: "Candidate Level Data - 1 January",
          sheetIndex: 1,
          basicFilter: { ...predecessor.basicFilter, sheetId: targetSheetId },
        },
        predecessor,
      ],
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
    const snapshots = pipelineRolloverSnapshots(spec)

    expect(projectStagingStructuralNormalizationState(snapshots.before, spec)).toBe(spec.expectedBefore)
    expect(projectStagingStructuralNormalizationState(snapshots.after, spec)).toBe(spec.expectedAfter)
    expect(verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: snapshots.after,
    })).toMatchObject({
      afterPlan: { status: "already_normalized", requests: [] },
      afterStateVerified: true,
      nonApprovedStructureUnchanged: true,
    })
  })

  test("classifies a drifted-filter target repair on both sides instead of throwing ambiguous", () => {
    // The neighbor case: the target tab exists but a human narrowed its
    // filter. The observed filter is the before-state and the desired one the
    // after-state, so the observer discriminates instead of finding two
    // byte-identical states. (The equal-filter case builds no spec at all --
    // locked in the normalization plan tests.)
    const targetSheetId = pipelineCandidateTargetSheetId("2026-12-25")
    const predecessor = {
      sheetId: 156193952,
      sheetTitle: "Candidate Level Data - 25 December",
      sheetIndex: 2,
      gridRowCount: 998,
      gridColumnCount: 16,
      basicFilter: {
        sheetId: 156193952,
        startRowIndex: 0,
        startColumnIndex: 0,
        endColumnIndex: 14,
      },
    }
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-12-25",
      sheets: [
        {
          ...predecessor,
          sheetId: targetSheetId,
          sheetTitle: "Candidate Level Data - 1 January",
          sheetIndex: 1,
          basicFilter: {
            sheetId: targetSheetId,
            startRowIndex: 0,
            startColumnIndex: 0,
            endColumnIndex: 14,
            endRowIndex: 622,
          },
        },
        predecessor,
      ],
    }))
    const snapshots = pipelineRolloverSnapshots(spec)

    expect(projectStagingStructuralNormalizationState(snapshots.before, spec)).toBe(spec.expectedBefore)
    expect(projectStagingStructuralNormalizationState(snapshots.after, spec)).toBe(spec.expectedAfter)
    expect(verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: snapshots.after,
    })).toMatchObject({
      afterPlan: { status: "already_normalized", requests: [] },
      afterStateVerified: true,
      nonApprovedStructureUnchanged: true,
    })
  })

  test("still fails closed on a target whose filter SHAPE drifted from its predecessor", () => {
    // Column drift is not repairable structure -- the duplicate-of-predecessor
    // check masks only the row extent. This must stay a refusal, and its
    // message must be the diagnosable "matches neither", not the ambiguous one.
    const targetSheetId = pipelineCandidateTargetSheetId("2026-12-25")
    const predecessor = {
      sheetId: 156193952,
      sheetTitle: "Candidate Level Data - 25 December",
      sheetIndex: 2,
      gridRowCount: 998,
      gridColumnCount: 16,
      basicFilter: {
        sheetId: 156193952,
        startRowIndex: 0,
        startColumnIndex: 0,
        endColumnIndex: 14,
      },
    }
    const shapeDrifted = {
      ...predecessor,
      sheetId: targetSheetId,
      sheetTitle: "Candidate Level Data - 1 January",
      sheetIndex: 1,
      basicFilter: {
        sheetId: targetSheetId,
        startRowIndex: 0,
        startColumnIndex: 0,
        endColumnIndex: 9,
      },
    }
    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-12-25",
      sheets: [shapeDrifted, predecessor],
    }))
    const snapshots = pipelineRolloverSnapshots(spec)
    expect(() => projectStagingStructuralNormalizationState(snapshots.before, spec))
      .toThrow("matches neither exact state")
  })

  test("preserves complete live filter state while changing only approved ranges", () => {
    const spec = pipelineNormalizationSpec({
      artifactKey: "pipeline_1026_1027",
      currentCandidateTitle: "Candidate Level Data - 10 July",
      reservedCandidateSheetId: 1900000002,
    })
    const snapshot = pipelineSnapshots(spec).before
    const candidateTemplate = sheetById(snapshot, 757546275)
    candidateTemplate.basicFilter = {
      ...rec(candidateTemplate.basicFilter),
      criteria: { 7: { hiddenValues: ["fixture-hidden-stage"] } },
      sortSpecs: [{ dimensionIndex: 1, sortOrder: "DESCENDING" }],
    }
    const job = sheetById(snapshot, 0)
    job.basicFilter = {
      ...rec(job.basicFilter),
      criteria: { 2: { condition: { type: "NUMBER_GREATER", values: [{ userEnteredValue: "1000" }] } } },
      sortSpecs: [{ dimensionIndex: 0, sortOrder: "ASCENDING" }],
    }

    const bound = bindStagingStructuralFilterPreimages(spec, snapshot)
    const forwardFilters = bound.forwardRequests
      .map((request) => rec(request.setBasicFilter))
      .filter((request) => Object.keys(request).length > 0)
      .map((request) => rec(request.filter))
    const rollbackFilters = bound.rollbackRequests
      .map((request) => rec(request.setBasicFilter))
      .filter((request) => Object.keys(request).length > 0)
      .map((request) => rec(request.filter))

    expect(forwardFilters).toHaveLength(2)
    expect(forwardFilters[0]).toMatchObject({
      range: { sheetId: 1900000002, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 14 },
      criteria: { 7: { hiddenValues: ["fixture-hidden-stage"] } },
      sortSpecs: [{ dimensionIndex: 1, sortOrder: "DESCENDING" }],
    })
    expect(forwardFilters[1]).toMatchObject({
      range: { sheetId: 0, startRowIndex: 1166, startColumnIndex: 0, endColumnIndex: 33 },
      criteria: job.basicFilter?.criteria,
      sortSpecs: job.basicFilter?.sortSpecs,
    })
    expect(rollbackFilters).toEqual([job.basicFilter])
    expect(spec.forwardRequests.some((request) =>
      rec(rec(request.setBasicFilter).filter).criteria !== undefined
    )).toBe(false)
  })

  test("allowlists only exact literal headers, layouts, and blank destinations", () => {
    const weekly = stagingStructuralNormalizationLiteralRanges(
      weeklyProgressNormalizationSpec({ currentWeekHeader: "03 Jul - 09 Jul" })
    )
    expect(weekly).toEqual([
      {
        purpose: "header",
        sheetTitle: "FDL (Code + RL)",
        gridRange: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 25, endColumnIndex: 26 },
      },
      {
        purpose: "header",
        sheetTitle: "FDL (Code + RL)",
        gridRange: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 26, endColumnIndex: 27 },
      },
      {
        purpose: "header",
        sheetTitle: "FDL (Brazil + Colombia)",
        gridRange: { sheetId: 1450892249, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 16, endColumnIndex: 17 },
      },
      {
        purpose: "header",
        sheetTitle: "FDL (Brazil + Colombia)",
        gridRange: { sheetId: 1450892249, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 17, endColumnIndex: 18 },
      },
    ])

    const pipeline = stagingStructuralNormalizationLiteralRanges(
      pipelineNormalizationSpec({
        artifactKey: "pipeline_907",
        currentCandidateTitle: "Candidate Level Data - 10 July",
      })
    )
    expect(pipeline).toEqual([
      {
        purpose: "blank_destination",
        sheetTitle: "Job level pipeline",
        gridRange: { sheetId: 0, startRowIndex: 631, endRowIndex: 632, startColumnIndex: 0, endColumnIndex: 29 },
      },
    ])

    const delivery = stagingStructuralNormalizationLiteralRanges(
      deliveryRpsNormalizationSpec({
        newDatedSheetId: 2200000001,
        newDatedSheetIndex: 4,
        newDatedSheetTitle: "10 Jul 2026",
        newDatedTitleValue: "Recruiter Role Report - 10 Jul 2026",
      })
    )
    expect(delivery).toHaveLength(7)
    expect(delivery.every((entry) => entry.gridRange.endRowIndex > entry.gridRange.startRowIndex)).toBe(true)
    expect(stagingStructuralNormalizationLiteralRanges(deliveryRpsRawFilterNormalizationSpec())).toEqual([])
  })

  test("verifies only the planned Weekly Progress QTD formula correction", () => {
    const contracts = [
      [0, "FDL (Code + RL)", 7],
      [242118538, "FDE/PE", 6],
      [1450892249, "FDL (Brazil + Colombia)", 7],
    ] as const
    const result = planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: "2026-07-10",
      quarterOpeningOffsets: [
        { sheetId: 0, rowOffsets: [0, 0, 0, 0, 0, 0, 0] },
        { sheetId: 242118538, rowOffsets: [0, 0, 0, 0, 0, 2] },
        { sheetId: 1450892249, rowOffsets: [0, 0, 0, 0, 0, 0, 0] },
      ],
      sheets: contracts.map(([sheetId, sheetTitle, formulaCount]) => ({
        sheetId,
        sheetTitle,
        headers: ["Stage", "Jul 3 - Jul 9", "10 Jul - 16 Jul", "QTD"],
        qtdFormulas: Array.from({ length: formulaCount }, (_, row) => `=SUM(A${row + 2}:A${row + 2})`),
      })),
    })
    if (result.status !== "planned") throw new Error("Expected a Weekly Progress correction")
    const snapshots = weeklySnapshots(result.spec)

    expect(verifyStagingStructuralNormalizationAfter({
      spec: result.spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: snapshots.after,
    })).toMatchObject({ afterStateVerified: true, nonApprovedStructureUnchanged: true })

    const drifted = structuredClone(snapshots.after)
    gridCell(sheetById(drifted, 0), 1, 3).userEnteredFormat = {
      backgroundColor: { red: 0.5 },
    }
    expect(() => verifyStagingStructuralNormalizationAfter({
      spec: result.spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: drifted,
    })).toThrow("non-approved structure drifted")
  })

  test("rejects a literal range whose sheet title changes across expected states", () => {
    const spec = pipelineNormalizationSpec({
      artifactKey: "pipeline_907",
      currentCandidateTitle: "Candidate Level Data - 10 July",
    })
    const malformed = {
      ...spec,
      expectedAfter: {
        ...spec.expectedAfter,
        jobSummary: {
          ...(spec.expectedAfter.jobSummary as Obj),
          sheetTitle: "Unexpected job summary title",
        },
      },
    } as StagingStructuralNormalizationSpec

    expect(() => stagingStructuralNormalizationLiteralRanges(malformed)).toThrow(
      "changed sheet title across expected states"
    )
  })

  test("binds a value-blank pipeline destination to its exact background-format rollback source", () => {
    const spec = pipelineNormalizationSpec({
      artifactKey: "pipeline_890",
      currentCandidateTitle: "Candidate Level Data - 10 July",
      reservedCandidateSheetId: 1900000001,
    })
    const snapshots = pipelineSnapshots(spec)
    expect(projectStagingStructuralNormalizationState(snapshots.before, spec)).toBe(spec.expectedBefore)

    const formatDrift = structuredClone(snapshots.before)
    gridCell(sheetById(formatDrift, 958156097), 718, 0).userEnteredFormat = {
      backgroundColor: { red: 0.4 },
    }
    expect(() => projectStagingStructuralNormalizationState(formatDrift, spec)).toThrow(
      "matches neither exact state"
    )

    const contentDrift = structuredClone(snapshots.before)
    gridCell(sheetById(contentDrift, 958156097), 718, 0).userEnteredValue = {
      stringValue: "occupied",
    }
    expect(() => projectStagingStructuralNormalizationState(contentDrift, spec)).toThrow(
      "matches neither exact state"
    )
  })

  test("rejects unrelated tab, formula, filter, pivot, and merge drift", () => {
    const spec = allHiresNormalizationSpec()
    const snapshots = singlePivotSnapshots(spec)
    const mutations: Array<(snapshot: SheetsApiSpreadsheetSnapshot) => void> = [
      (snapshot) => {
        properties(sheetById(snapshot, 900000001)).title = "Renamed unrelated tab"
      },
      (snapshot) => {
        formulaCell(sheetById(snapshot, 900000001)).userEnteredValue = { formulaValue: "=2+2" }
      },
      (snapshot) => {
        const filter = rec(sheetById(snapshot, 900000001).basicFilter)
        rec(filter.range).endColumnIndex = 9
      },
      (snapshot) => {
        rec(rec(gridCell(sheetById(snapshot, 900000001), 0, 3).pivotTable).source).endColumnIndex = 5
      },
      (snapshot) => {
        rec((sheetById(snapshot, 900000001).merges as Obj[])[0]).endColumnIndex = 3
      },
    ]

    for (const [index, mutate] of mutations.entries()) {
      const driftedAfter = structuredClone(snapshots.after)
      mutate(driftedAfter)
      expect(() =>
        verifyStagingStructuralNormalizationAfter({
          spec,
          beforeSnapshot: snapshots.before,
          afterSnapshot: driftedAfter,
        })
      , `unrelated drift mutation ${index}`).toThrow("non-approved structure drifted")
    }
  })

  test("keeps every pre-existing dated Delivery tab in the full safety comparison", () => {
    const spec = deliveryRpsNormalizationSpec({
      newDatedSheetId: 2200000001,
      newDatedSheetIndex: 4,
      newDatedSheetTitle: "10 Jul 2026",
      newDatedTitleValue: "Recruiter Role Report - 10 Jul 2026",
    })
    const snapshots = deliverySnapshots(spec)
    const driftedAfter = structuredClone(snapshots.after)
    formulaCell(sheetById(driftedAfter, 2061940581)).userEnteredValue = { formulaValue: "=99" }

    expect(() =>
      verifyStagingStructuralNormalizationAfter({
        spec,
        beforeSnapshot: snapshots.before,
        afterSnapshot: driftedAfter,
      })
    ).toThrow("non-approved structure drifted")
  })

  test("allows value-owned Delivery formulas and formatting while retaining manual notes", () => {
    const spec = deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: "2026-07-16",
      sheets: deliveryLifecycleDescriptors(176),
    })
    const snapshots = deliverySnapshots(spec)
    const templateId = Number(rec(spec.expectedBefore.datedTemplate).sheetId)
    const outputId = Number(rec(spec.expectedAfter.datedOutput).sheetId)
    const retainedForm = {
      userEnteredValue: { formulaValue: "=IF(I5=\"\",\"\",I5)" },
      userEnteredFormat: { backgroundColor: { red: 0.2 } },
      note: "human-owned retained note",
    }
    sheetById(snapshots.before, templateId).data = [
      ...(sheetById(snapshots.before, templateId).data ?? []),
      { startRow: 4, startColumn: 8, rowData: [{ values: [structuredClone(retainedForm)] }] },
    ]
    sheetById(snapshots.after, templateId).data = [
      ...(sheetById(snapshots.after, templateId).data ?? []),
      { startRow: 4, startColumn: 8, rowData: [{ values: [structuredClone(retainedForm)] }] },
    ]
    sheetById(snapshots.after, outputId).data = [
      ...(sheetById(snapshots.after, outputId).data ?? []),
      {
        startRow: 4,
        startColumn: 8,
        rowData: [{ values: [{
          userEnteredFormat: structuredClone(retainedForm.userEnteredFormat),
          note: retainedForm.note,
        }] }],
      },
    ]

    expect(verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: snapshots.after,
    }).nonApprovedStructureUnchanged).toBe(true)

    const formatChanged = structuredClone(snapshots.after)
    gridCell(sheetById(formatChanged, outputId), 4, 8).userEnteredFormat = { backgroundColor: { red: 0.9 } }
    expect(verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: formatChanged,
    }).nonApprovedStructureUnchanged).toBe(true)

    const noteLost = structuredClone(snapshots.after)
    delete gridCell(sheetById(noteLost, outputId), 4, 8).note
    expect(() => verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: noteLost,
    })).toThrow("not a structural duplicate")
  })

  test("recognizes populated Delivery summary values as value-owned on an identical rerun", () => {
    const targetSheetId = 1980009693
    const spec = deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: "2026-07-16",
      sheets: [
        {
          sheetId: targetSheetId,
          sheetTitle: "16 Jul 2026",
          sheetIndex: 0,
          gridRowCount: 1000,
          gridColumnCount: 26,
          basicFilter: null,
        },
        ...deliveryLifecycleDescriptors().map((sheet) => ({ ...sheet, sheetIndex: sheet.sheetIndex + 1 })),
      ],
    })
    const snapshots = deliverySnapshots(spec)
    sheetById(snapshots.after, targetSheetId).data = [
      ...(sheetById(snapshots.after, targetSheetId).data ?? []),
      {
        startRow: 4,
        startColumn: 0,
        rowData: [{ values: [{ userEnteredValue: { stringValue: "Retained Team" } }] }],
      },
    ]

    expect(projectStagingStructuralNormalizationState(snapshots.after, spec)).toBe(spec.expectedAfter)
    expect(verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: snapshots.before,
      afterSnapshot: snapshots.after,
    })).toMatchObject({ afterStateVerified: true, nonApprovedStructureUnchanged: true })
  })

  test("plans the Delivery dated rollover when the live predecessor has drifted to no frozen row, and still enforces it on the newly created tab", () => {
    const spec = deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: "2026-07-16",
      sheets: deliveryLifecycleDescriptors(176),
    })
    // The predecessor role no longer names a frozenRowCount at all (the gate
    // this fix removes); the output role still requires exactly 1 (the gate
    // it keeps, now satisfied by the forced updateSheetProperties request).
    expect(rec(rec(spec.expectedBefore.datedTemplate).staticLayout)).not.toHaveProperty("frozenRowCount")
    expect(rec(rec(spec.expectedAfter.datedOutput).staticLayout).frozenRowCount).toBe(1)

    const snapshots = deliverySnapshots(spec)
    const predecessorId = Number(rec(spec.expectedBefore.datedTemplate).sheetId)
    const outputId = Number(rec(spec.expectedAfter.datedOutput).sheetId)
    // Mirrors the live drift this fix was written for: the predecessor tab
    // simply has no frozen row.
    expect(rec(properties(sheetById(snapshots.before, predecessorId)).gridProperties)).not.toHaveProperty(
      "frozenRowCount"
    )

    expect(projectStagingStructuralNormalizationState(snapshots.before, spec)).toBe(spec.expectedBefore)
    expect(
      verifyStagingStructuralNormalizationAfter({
        spec,
        beforeSnapshot: snapshots.before,
        afterSnapshot: snapshots.after,
      })
    ).toMatchObject({ afterStateVerified: true, nonApprovedStructureUnchanged: true })

    // If the forced frozen-row request (or its check on the output role) were
    // ever dropped, a newly created tab that simply inherited the
    // predecessor's missing frozen row would go undetected. Prove it still
    // isn't.
    const unfrozenOutput = structuredClone(snapshots.after)
    properties(sheetById(unfrozenOutput, outputId)).gridProperties = { rowCount: 1000, columnCount: 26 }
    expect(() =>
      verifyStagingStructuralNormalizationAfter({
        spec,
        beforeSnapshot: snapshots.before,
        afterSnapshot: unfrozenOutput,
      })
    ).toThrow("dated output frozen row count drifted")
  })
})

function weeklySnapshots(spec: StagingStructuralNormalizationSpec) {
  const beforeSheets = spec.expectedBefore.sheets as Obj[]
  const afterSheets = spec.expectedAfter.sheets as Obj[]
  const includesFde = beforeSheets.some((sheet) => Number(sheet.sheetId) === 242118538)
  const sheetIndex = (index: number) => includesFde ? index : index === 0 ? 0 : 2
  const before = beforeSheets.map((expected, index) => weeklySheet(expected, sheetIndex(index)))
  const after = afterSheets.map((expected, index) => weeklySheet(expected, sheetIndex(index)))
  if (!includesFde) {
    const unchanged = makeSheet({ id: 242118538, title: "FDE/PE", index: 1, rowCount: 100, columnCount: 20 })
    before.splice(1, 0, unchanged)
    after.splice(1, 0, structuredClone(unchanged))
  }
  return workbooks(spec, before, after)
}

function weeklySheet(expected: Obj, index: number): SheetsApiSheetSnapshot {
  const qtd = rec(expected.qtd)
  const qtdColumn = a1ColumnIndex(String(qtd.column))
  const cells: CellFixture[] = [stringFixture(0, qtdColumn, "QTD")]
  ;(qtd.formulas as string[]).forEach((formula, row) => cells.push(formulaFixture(row + 1, qtdColumn, formula)))
  if (Object.keys(rec(expected.currentWeek)).length > 0) {
    const current = rec(expected.currentWeek)
    cells.push(stringFixture(0, Number(current.columnIndex), String(current.header)))
  }
  return makeSheet({
    id: Number(expected.sheetId),
    title: String(expected.sheetTitle),
    index,
    rowCount: 100,
    columnCount: qtdColumn + 1,
    cells,
  })
}

function singlePivotSnapshots(spec: StagingStructuralNormalizationSpec) {
  const beforePivot = rec(spec.expectedBefore.pivot)
  const afterPivot = rec(spec.expectedAfter.pivot)
  const sourceSheetId = Number(rec(beforePivot.source).sheetId)
  const sourceTitle = String(beforePivot.sourceSheetTitle)
  const source = makeSheet({ id: sourceSheetId, title: sourceTitle, index: 0, rowCount: 5000, columnCount: 20 })
  const beforePivotSheet = pivotSheet(beforePivot, 1)
  const afterPivotSheet = pivotSheet(afterPivot, 1)
  return workbooks(
    spec,
    [source, beforePivotSheet, sentinelSheet(2)],
    [structuredClone(source), afterPivotSheet, sentinelSheet(2)]
  )
}

function rpsLifecycleSnapshots(spec: StagingStructuralNormalizationSpec) {
  const before = rec(spec.expectedBefore.rpsTrackingLifecycle)
  const after = rec(spec.expectedAfter.rpsTrackingLifecycle)
  const beforeData = rec(before.dataSheet)
  const afterData = rec(after.dataSheet)
  const beforePivot = rec(before.pivot)
  const afterPivot = rec(after.pivot)
  return workbooks(
    spec,
    [
      makeSheet({
        id: Number(beforeData.sheetId),
        title: String(beforeData.sheetTitle),
        index: 0,
        rowCount: Number(beforeData.gridRowCount),
        columnCount: Number(beforeData.gridColumnCount),
      }),
      pivotSheet(beforePivot, 1),
      sentinelSheet(2),
    ],
    [
      makeSheet({
        id: Number(afterData.sheetId),
        title: String(afterData.sheetTitle),
        index: 0,
        rowCount: Number(afterData.gridRowCount),
        columnCount: Number(afterData.gridColumnCount),
      }),
      pivotSheet(afterPivot, 1),
      sentinelSheet(2),
    ]
  )
}

function singleFilterSnapshots(spec: StagingStructuralNormalizationSpec) {
  const beforeFilter = rec(spec.expectedBefore.filter)
  const afterFilter = rec(spec.expectedAfter.filter)
  const beforeSheet = makeSheet({
    id: Number(beforeFilter.sheetId),
    title: String(beforeFilter.sheetTitle),
    index: 0,
    rowCount: 1000,
    columnCount: 20,
    basicFilter: rec(beforeFilter.basicFilter),
  })
  const afterSheet = structuredClone(beforeSheet)
  afterSheet.basicFilter = {
    range: { ...structuredClone(rec(afterFilter.basicFilter)), endRowIndex: 1000 },
    criteria: {},
  }
  return workbooks(
    spec,
    [beforeSheet, sentinelSheet(1)],
    [afterSheet, sentinelSheet(1)]
  )
}

function pivotSheet(expected: Obj, index: number): SheetsApiSheetSnapshot {
  return makeSheet({
    id: Number(expected.pivotSheetId),
    title: String(expected.pivotSheetTitle),
    index,
    rowCount: 100,
    columnCount: 20,
    cells: [{ row: 0, column: 0, cell: { pivotTable: { source: structuredClone(expected.source) } } }],
  })
}

function pipelineSnapshots(spec: StagingStructuralNormalizationSpec) {
  const beforeCandidate = rec(spec.expectedBefore.candidate)
  const afterCandidate = rec(spec.expectedAfter.candidate)
  const beforeJob = rec(spec.expectedBefore.jobSummary)
  const afterJob = rec(spec.expectedAfter.jobSummary)
  const beforeSheets: SheetsApiSheetSnapshot[] = []
  const afterSheets: SheetsApiSheetSnapshot[] = []

  if (beforeCandidate.mode === "missing_current_tab") {
    const template = rec(beforeCandidate.template)
    const templateSheet = makeSheet({
      id: Number(template.sheetId),
      title: String(template.sheetTitle),
      index: Number(template.sheetIndex),
      rowCount: Number(template.gridRowCount),
      columnCount: Number(rec(template.basicFilter).endColumnIndex),
      basicFilter: rec(template.basicFilter),
    })
    beforeSheets.push(templateSheet)
    const shiftedTemplate = structuredClone(templateSheet)
    properties(shiftedTemplate).index = Number(template.sheetIndex) + 1
    afterSheets.push(shiftedTemplate)
    afterSheets.push(
      makeSheet({
        id: Number(afterCandidate.sheetId),
        title: String(afterCandidate.sheetTitle),
        index: Number(afterCandidate.insertedAtIndex),
        rowCount: Number(rec(afterCandidate.dataRowsCleared).endRowIndex),
        columnCount: Number(rec(afterCandidate.basicFilter).endColumnIndex),
        basicFilter: rec(afterCandidate.basicFilter),
      })
    )
  } else {
    const beforeSheet = makeSheet({
      id: Number(beforeCandidate.sheetId),
      title: String(beforeCandidate.sheetTitle),
      index: 1,
      rowCount: 998,
      columnCount: Number(rec(beforeCandidate.basicFilter).endColumnIndex),
      basicFilter: rec(beforeCandidate.basicFilter),
    })
    beforeSheets.push(beforeSheet)
    const afterSheet = structuredClone(beforeSheet)
    afterSheet.basicFilter = { range: structuredClone(afterCandidate.basicFilter), criteria: {} }
    afterSheets.push(afterSheet)
  }

  beforeSheets.push(jobSheet(beforeJob, 0))
  afterSheets.push(jobSheet(afterJob, 0, rec(beforeJob.backgroundFormatPreimage)))
  const sentinelIndex = 10
  beforeSheets.push(sentinelSheet(sentinelIndex))
  afterSheets.push(sentinelSheet(sentinelIndex))
  return workbooks(spec, beforeSheets, afterSheets)
}

function pipelineRolloverSnapshots(spec: StagingStructuralNormalizationSpec) {
  const beforeRollover = rec(spec.expectedBefore.pipelineCandidateRollover)
  const afterRollover = rec(spec.expectedAfter.pipelineCandidateRollover)
  const beforePredecessor = rec(beforeRollover.predecessor)
  const afterPredecessor = rec(afterRollover.predecessor)
  const target = rec(afterRollover.targetSheet)
  const predecessorForm: CellFixture[] = [
    formulaFixture(0, 5, "=ROW()"),
    { row: 1, column: 0, cell: { userEnteredFormat: { backgroundColor: { red: 0.2 } } } },
  ]
  const beforeSheet = makeSheet({
    id: Number(beforePredecessor.sheetId),
    title: String(beforePredecessor.sheetTitle),
    index: Number(beforePredecessor.sheetIndex),
    rowCount: Number(beforePredecessor.gridRowCount),
    columnCount: Number(beforePredecessor.gridColumnCount),
    basicFilter: rec(beforePredecessor.basicFilter),
    cells: predecessorForm,
  })
  const afterPredecessorSheet = makeSheet({
    id: Number(afterPredecessor.sheetId),
    title: String(afterPredecessor.sheetTitle),
    index: Number(afterPredecessor.sheetIndex),
    rowCount: Number(afterPredecessor.gridRowCount),
    columnCount: Number(afterPredecessor.gridColumnCount),
    basicFilter: rec(afterPredecessor.basicFilter),
    cells: predecessorForm,
  })
  const targetSheet = makeSheet({
    id: Number(target.sheetId),
    title: String(target.sheetTitle),
    index: Number(target.sheetIndex),
    rowCount: Number(target.gridRowCount),
    columnCount: Number(target.gridColumnCount),
    basicFilter: rec(target.basicFilter),
    cells: predecessorForm,
  })
  const retained = makeSheet({
    id: 444,
    title: "Retained history",
    index: 4,
    rowCount: 100,
    columnCount: 14,
    cells: [formulaFixture(0, 0, "=1")],
  })
  const beforeSheets = [beforeSheet, retained]
  const afterSheets = [targetSheet, afterPredecessorSheet, structuredClone(retained)]
  if (beforeRollover.targetSheet !== null && typeof beforeRollover.targetSheet === "object") {
    const beforeTarget = rec(beforeRollover.targetSheet)
    beforeSheets.unshift(
      makeSheet({
        id: Number(beforeTarget.sheetId),
        title: String(beforeTarget.sheetTitle),
        index: Number(beforeTarget.sheetIndex),
        rowCount: Number(beforeTarget.gridRowCount),
        columnCount: Number(beforeTarget.gridColumnCount),
        basicFilter: rec(beforeTarget.basicFilter),
        cells: predecessorForm,
      })
    )
  }
  if (
    beforeRollover.jobSummary !== null &&
    typeof beforeRollover.jobSummary === "object" &&
    afterRollover.jobSummary !== null &&
    typeof afterRollover.jobSummary === "object"
  ) {
    beforeSheets.unshift(jobSheet(rec(beforeRollover.jobSummary), 0))
    afterSheets.unshift(
      jobSheet(
        rec(afterRollover.jobSummary),
        0,
        rec(rec(beforeRollover.jobSummary).backgroundFormatPreimage)
      )
    )
  }
  return workbooks(
    spec,
    beforeSheets,
    afterSheets
  )
}

function jobSheet(job: Obj, index: number, preservedBackground: Obj = {}): SheetsApiSheetSnapshot {
  const template = rec(job.lastWeekTemplate ?? rec(job.appendedTemplate).source)
  const destination = rec(job.appendDestination ?? rec(job.appendedTemplate).destination)
  const background = rec(job.backgroundFormatPreimage)
  const cells = [
    ...formatFixtures(template, "template"),
    ...(job.appendedTemplate ? formatFixtures(destination, "template") : []),
    ...(Object.keys(background).length > 0
      ? [
          ...formatFixtures(rec(background.source), "background"),
          ...formatFixtures(rec(background.destination), "background"),
        ]
      : []),
    ...(Object.keys(preservedBackground).length > 0
      ? formatFixtures(rec(preservedBackground.source), "background")
      : []),
  ]
  return makeSheet({
    id: Number(job.sheetId),
    title: String(job.sheetTitle),
    index,
    rowCount: Math.max(Number(template.endRowIndex), Number(destination.endRowIndex)) + 10,
    columnCount: Number(template.endColumnIndex),
    basicFilter: rec(job.basicFilter),
    cells,
  })
}

function formatFixtures(range: Obj, kind: "template" | "background"): CellFixture[] {
  const startRow = Number(range.startRowIndex)
  const endRow = Number(range.endRowIndex)
  const column = Number(range.startColumnIndex)
  return Array.from({ length: endRow - startRow }, (_, offset) => ({
    row: startRow + offset,
    column,
    cell: {
      userEnteredFormat: {
        backgroundColor: kind === "template" ? { red: 0.8 } : { red: 0.2 },
      },
    },
  }))
}

function finalOfferLegacyQ3Descriptors(baseIndex = 5): FinalOfferLifecycleSheet[] {
  return [
    ...finalOfferLifecycleTripletDescriptors("2026-09-01", baseIndex),
    ...finalOfferLifecycleTripletDescriptors("2026-08-01", baseIndex + 3),
    ...finalOfferLifecycleTripletDescriptors("2026-07-01", baseIndex + 6),
  ]
}

function finalOfferLifecycleTripletDescriptors(
  monthKey: string,
  sheetIndex: number
): FinalOfferLifecycleSheet[] {
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

function finalOfferQuarterRolloverSnapshots(spec: StagingStructuralNormalizationSpec) {
  const before = rec(spec.expectedBefore.finalOfferQuarterRollover)
  const after = rec(spec.expectedAfter.finalOfferQuarterRollover)
  const beforePredecessor = rec(before.predecessor)
  const afterPredecessor = rec(after.predecessor)
  const beforeHistory = finalOfferLegacyQ3Descriptors()
    .slice(3)
    .map(finalOfferLifecycleSheetSnapshot)
  const afterHistory = finalOfferLegacyQ3Descriptors(14)
    .slice(3)
    .map(finalOfferLifecycleSheetSnapshot)
  const beforeSheets = [
    ...finalOfferExpectedTripletSnapshots(beforePredecessor),
    ...beforeHistory,
  ]
  const afterSheets = [
    ...(after.targetMonths as Obj[]).flatMap((month) =>
      finalOfferExpectedTripletSnapshots(month)
    ),
    ...finalOfferExpectedTripletSnapshots(afterPredecessor),
    ...afterHistory,
  ]
  return workbooks(spec, beforeSheets, afterSheets)
}

function finalOfferExpectedTripletSnapshots(expected: Obj): SheetsApiSheetSnapshot[] {
  return (["offerData", "recruiterPerformance", "sourcerPerformance"] as const).map((role) => {
    const sheet = rec(expected[role])
    const isOfferData = role === "offerData"
    const pivotSource = isOfferData ? null : rec(sheet.pivotSource)
    return makeSheet({
      id: Number(sheet.sheetId),
      title: String(sheet.sheetTitle),
      index: Number(sheet.sheetIndex),
      rowCount: Number(sheet.gridRowCount),
      columnCount: Number(sheet.gridColumnCount),
      basicFilter: isOfferData ? rec(sheet.basicFilter) : undefined,
      cells: isOfferData
        ? [{ row: 0, column: 0, cell: { userEnteredFormat: { backgroundColor: { red: 0.2 } } } }]
        : [{
            row: 0,
            column: 0,
            cell: {
              pivotTable: {
                source: structuredClone(pivotSource),
                rows: [{ sourceColumnOffset: 0, showTotals: true }],
              },
            },
          }],
    })
  })
}

function finalOfferLifecycleSheetSnapshot(sheet: FinalOfferLifecycleSheet): SheetsApiSheetSnapshot {
  return makeSheet({
    id: sheet.sheetId,
    title: sheet.sheetTitle,
    index: sheet.sheetIndex,
    rowCount: sheet.gridRowCount,
    columnCount: sheet.gridColumnCount,
    basicFilter: sheet.basicFilter ? { ...sheet.basicFilter } : undefined,
    cells: sheet.pivotSource
      ? [{
          row: 0,
          column: 0,
          cell: {
            pivotTable: {
              source: { ...sheet.pivotSource },
              rows: [{ sourceColumnOffset: 0, showTotals: true }],
            },
          },
        }]
      : [{ row: 0, column: 0, cell: { userEnteredFormat: { backgroundColor: { red: 0.2 } } } }],
  })
}

function finalOfferSnapshots(spec: StagingStructuralNormalizationSpec) {
  const beforeSources = new Map(
    (spec.expectedBefore.existingPivotSources as Obj[]).map((entry) => [Number(entry.pivotSheetId), rec(entry.source)])
  )
  const afterSources = new Map(
    (spec.expectedAfter.existingPivotSources as Obj[]).map((entry) => [Number(entry.pivotSheetId), rec(entry.source)])
  )
  const preserved = spec.expectedBefore.preservedQ2Sheets as Obj[]
  const beforeSheets = preserved.map((entry, index) =>
    makeSheet({
      id: Number(entry.sheetId),
      title: String(entry.sheetTitle),
      index: index + 2,
      rowCount: 997,
      columnCount: 31,
      cells: beforeSources.has(Number(entry.sheetId))
        ? [{ row: 0, column: 0, cell: { pivotTable: { source: structuredClone(beforeSources.get(Number(entry.sheetId))) } } }]
        : [],
    })
  )
  const afterSheets = preserved.map((entry, index) =>
    makeSheet({
      id: Number(entry.sheetId),
      title: String(entry.sheetTitle),
      index: index + 20,
      rowCount: 997,
      columnCount: 31,
      cells: afterSources.has(Number(entry.sheetId))
        ? [{ row: 0, column: 0, cell: { pivotTable: { source: structuredClone(afterSources.get(Number(entry.sheetId))) } } }]
        : [],
    })
  )
  const sourceData = makeSheet({
    id: 1083291166,
    title: "Performance Sheet data",
    index: 50,
    rowCount: 1000,
    columnCount: 31,
  })
  beforeSheets.push(sourceData)
  afterSheets.push(structuredClone(sourceData))

  const q3Sheets = spec.expectedAfter.q3Sheets as Obj[]
  for (const entry of q3Sheets) {
    const title = String(entry.sheetTitle)
    afterSheets.push(
      makeSheet({
        id: Number(entry.sheetId),
        title,
        index: Number(entry.insertedAtIndex),
        rowCount: 997,
        columnCount: 31,
        basicFilter: entry.kind === "offer_data" ? rec(entry.basicFilter) : undefined,
        cells:
          entry.kind === "offer_data"
            ? []
            : [{ row: 0, column: 0, cell: { pivotTable: { source: structuredClone(entry.pivotSource) } } }],
      })
    )
  }
  return workbooks(spec, beforeSheets, afterSheets)
}

function deliverySnapshots(spec: StagingStructuralNormalizationSpec) {
  const beforeRaw = rec(spec.expectedBefore.raw)
  const afterRaw = rec(spec.expectedAfter.raw)
  const beforeTemplateExpected = rec(spec.expectedBefore.datedTemplate)
  const afterTemplateExpected = spec.expectedAfter.datedTemplate
    ? rec(spec.expectedAfter.datedTemplate)
    : beforeTemplateExpected
  const output = rec(spec.expectedAfter.datedOutput)
  const beforeRawSheet = makeSheet({
    id: Number(beforeRaw.sheetId),
    title: String(beforeRaw.sheetTitle),
    index: 0,
    rowCount: 1000,
    columnCount: 20,
    basicFilter: rec(beforeRaw.basicFilter),
  })
  const afterRawSheet = structuredClone(beforeRawSheet)
  afterRawSheet.basicFilter = { range: structuredClone(afterRaw.basicFilter), criteria: {} }
  const targetIndex = Number(output.insertedAtIndex ?? 4)
  const beforeTemplateIndex = Number(beforeTemplateExpected.sheetIndex)
  const afterTemplateIndex = Number(afterTemplateExpected.sheetIndex)
  const insertedBeforeHistory =
    targetIndex === 0 && typeof output.clearedSummaryRange === "object" && output.clearedSummaryRange !== null
  const beforeTemplate = datedSheet(beforeTemplateExpected, beforeTemplateIndex)
  const afterTemplate = datedSheet(afterTemplateExpected, afterTemplateIndex)
  const beforeExistingDated = makeSheet({
    id: 2061940581,
    title: "08 Jul 2026",
    index: beforeTemplateIndex - 1,
    rowCount: 1000,
    columnCount: 26,
    merges: [{ sheetId: 2061940581, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 14 }],
    cells: [formulaFixture(5, 2, "=1")],
  })
  const afterExistingDated = structuredClone(beforeExistingDated)
  const beforeClean = makeSheet({
    id: 1598905318,
    title: "Cleaned_RPS",
    index: 1,
    rowCount: 1000,
    columnCount: 20,
  })
  const afterClean = structuredClone(beforeClean)
  if (insertedBeforeHistory) {
    properties(afterRawSheet).index = 1
    properties(afterClean).index = 2
    properties(afterExistingDated).index = 3
  }
  return workbooks(
    spec,
    [beforeRawSheet, beforeClean, beforeExistingDated, beforeTemplate],
    [
      afterRawSheet,
      afterClean,
      afterExistingDated,
      afterTemplate,
      datedSheet(output, targetIndex),
    ]
  )
}

function deliveryLifecycleDescriptors(rawFilterEndRowIndex?: number) {
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
        ...(rawFilterEndRowIndex === undefined ? {} : { endRowIndex: rawFilterEndRowIndex }),
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
    {
      sheetId: 2061940581,
      sheetTitle: "08 Jul 2026",
      sheetIndex: 2,
      gridRowCount: 1000,
      gridColumnCount: 26,
      basicFilter: null,
    },
    {
      sheetId: 2061940582,
      sheetTitle: "09 Jul 2026",
      sheetIndex: 3,
      gridRowCount: 1000,
      gridColumnCount: 26,
      basicFilter: null,
    },
  ]
}

function datedSheet(expected: Obj, index: number): SheetsApiSheetSnapshot {
  const layout = rec(expected.staticLayout)
  const grid = rec(expected.grid)
  const cells: CellFixture[] = [
    stringFixture(0, 0, String(layout.titleValue)),
    stringFixture(2, 0, String(rec(layout.sectionLabel).value)),
    ...(layout.headers as string[]).map((header, column) => stringFixture(3, column, header)),
  ]
  return makeSheet({
    id: Number(expected.sheetId),
    title: String(expected.sheetTitle),
    index,
    rowCount: Number(grid.rowCount),
    columnCount: Number(grid.columnCount),
    // The predecessor role's expected staticLayout intentionally omits
    // frozenRowCount (that historical formatting isn't gated); mirror that
    // by leaving the fixture's gridProperties.frozenRowCount unset too,
    // rather than coercing "undefined" into a misleading NaN.
    frozenRowCount: layout.frozenRowCount === undefined ? undefined : Number(layout.frozenRowCount),
    merges: [
      {
        sheetId: Number(expected.sheetId),
        startRowIndex: 0,
        endRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: 14,
      },
    ],
    cells,
  })
}

function workbooks(
  spec: StagingStructuralNormalizationSpec,
  beforeSheets: SheetsApiSheetSnapshot[],
  afterSheets: SheetsApiSheetSnapshot[]
) {
  const common = {
    spreadsheetId: spec.spreadsheetId,
    properties: { title: `Staging ${spec.artifactKey}`, locale: "en_US", timeZone: "America/Los_Angeles" },
    namedRanges: [{ namedRangeId: "stable", name: "StableRange" }],
  }
  return {
    before: { ...structuredClone(common), sheets: beforeSheets },
    after: { ...structuredClone(common), sheets: afterSheets },
  }
}

function makeSheet(input: {
  id: number
  title: string
  index: number
  rowCount: number
  columnCount: number
  frozenRowCount?: number
  basicFilter?: Obj
  merges?: Obj[]
  cells?: CellFixture[]
}): SheetsApiSheetSnapshot {
  return {
    properties: {
      sheetId: input.id,
      title: input.title,
      index: input.index,
      sheetType: "GRID",
      gridProperties: {
        rowCount: input.rowCount,
        columnCount: input.columnCount,
        ...(input.frozenRowCount === undefined ? {} : { frozenRowCount: input.frozenRowCount }),
      },
    },
    ...(input.basicFilter ? { basicFilter: { range: structuredClone(input.basicFilter), criteria: {} } } : {}),
    ...(input.merges ? { merges: structuredClone(input.merges) } : {}),
    conditionalFormats: [],
    protectedRanges: [],
    charts: [],
    data: (input.cells ?? []).map(({ row, column, cell }) => ({
      startRow: row,
      startColumn: column,
      rowData: [{ values: [structuredClone(cell)] }],
    })),
  }
}

function sentinelSheet(index: number): SheetsApiSheetSnapshot {
  return makeSheet({
    id: 900000001,
    title: "Unrelated Safety Sentinel",
    index,
    rowCount: 100,
    columnCount: 10,
    basicFilter: { sheetId: 900000001, startRowIndex: 0, endRowIndex: 100, startColumnIndex: 0, endColumnIndex: 10 },
    merges: [{ sheetId: 900000001, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 }],
    cells: [
      formulaFixture(5, 2, "=1+1"),
      {
        row: 0,
        column: 3,
        cell: {
          pivotTable: {
            source: { sheetId: 900000001, startRowIndex: 10, endRowIndex: 20, startColumnIndex: 0, endColumnIndex: 4 },
            rows: [{ sourceColumnOffset: 0, showTotals: true }],
          },
        },
      },
    ],
  })
}

function stringFixture(row: number, column: number, value: string): CellFixture {
  return { row, column, cell: { userEnteredValue: { stringValue: value }, formattedValue: value } }
}

function formulaFixture(row: number, column: number, formula: string): CellFixture {
  return { row, column, cell: { userEnteredValue: { formulaValue: formula } } }
}

function sheetById(snapshot: SheetsApiSpreadsheetSnapshot, id: number): SheetsApiSheetSnapshot {
  const sheet = snapshot.sheets?.find((candidate) => properties(candidate).sheetId === id)
  if (!sheet) throw new Error(`missing fixture sheet ${id}`)
  return sheet
}

function properties(sheet: SheetsApiSheetSnapshot): Obj {
  return rec(sheet.properties)
}

function pivotCell(sheet: SheetsApiSheetSnapshot): Obj {
  return gridCell(sheet, 0, 0)
}

function formulaCell(sheet: SheetsApiSheetSnapshot): Obj {
  return gridCell(sheet, 5, 2)
}

function gridCell(sheet: SheetsApiSheetSnapshot, row: number, column: number): Obj {
  const data = (sheet.data ?? []).find(
    (grid) => rec(grid).startRow === row && rec(grid).startColumn === column
  )
  return firstGridCell(data)
}

function firstGridCell(grid: unknown): Obj {
  const rows = rec(grid).rowData
  if (!Array.isArray(rows) || rows.length === 0) return {}
  const values = rec(rows[0]).values
  if (!Array.isArray(values) || values.length === 0) return {}
  return rec(values[0])
}

function rec(value: unknown): Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : {}
}

function a1ColumnIndex(column: string): number {
  let result = 0
  for (const character of column) result = result * 26 + character.charCodeAt(0) - 64
  return result - 1
}
