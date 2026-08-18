import { createPayloadFingerprint, stableSerialize } from "../checksums"
import {
  planStagingStructuralNormalization,
  type StagingStructuralNormalizationPlan,
  type StagingStructuralNormalizationSpec,
} from "./staging-structural-normalization"
import {
  WEEKLY_RECRUITMENT_ROW_WIDTH,
  weeklyRecruitmentRowFormFingerprint,
  weeklyRecruitmentRowForms,
  weeklyRecruitmentRowValueFingerprint,
  weeklyRecruitmentRowValues,
} from "./weekly-recruitment-row-lifecycle-shared"

type UnknownRecord = Record<string, unknown>

/** Minimal structural type for a Sheets API v4 `Spreadsheet` response. */
export interface SheetsApiSpreadsheetSnapshot extends UnknownRecord {
  spreadsheetId?: string | null
  properties?: UnknownRecord | null
  sheets?: readonly SheetsApiSheetSnapshot[] | null
}

export interface SheetsApiSheetSnapshot extends UnknownRecord {
  properties?: UnknownRecord | null
  data?: readonly UnknownRecord[] | null
  basicFilter?: UnknownRecord | null
  merges?: readonly UnknownRecord[] | null
}

export interface StagingStructuralLiteralObservationRange {
  purpose: "header" | "static_layout" | "blank_destination"
  sheetTitle: string
  gridRange: {
    sheetId: number
    startRowIndex: number
    endRowIndex: number
    startColumnIndex: number
    endColumnIndex: number
  }
}

export interface StructuralNormalizationAfterVerification {
  artifactKey: StagingStructuralNormalizationSpec["artifactKey"]
  spreadsheetId: string
  normalizationId: string
  beforePlan: StagingStructuralNormalizationPlan
  afterPlan: StagingStructuralNormalizationPlan
  afterStateVerified: true
  nonApprovedStructureUnchanged: true
  beforeStructureFingerprint: string
  afterStructureFingerprint: string
}

/**
 * Binds every `setBasicFilter` request to the complete live filter preimage.
 *
 * The Sheets API replaces a basic filter as a whole; sending only its range can
 * silently discard criteria, sort specs, or other filter-owned state. The
 * static normalization specs intentionally describe only the sanctioned range
 * transition. Immediately before authorization, this helper carries the rest
 * of the exact observed filter object into both the forward and rollback
 * requests while changing only the requested range.
 *
 * A filter on a newly duplicated sheet is sourced from that request's audited
 * template sheet and rebound to the deterministic new sheet id. No filter
 * values are logged or persisted; only the resulting request fingerprint is
 * retained by the runner.
 */
export function bindStagingStructuralFilterPreimages(
  spec: StagingStructuralNormalizationSpec,
  snapshot: SheetsApiSpreadsheetSnapshot
): StagingStructuralNormalizationSpec {
  if (snapshot.spreadsheetId !== spec.spreadsheetId) {
    throw new Error("Structural filter binding snapshot is not the registered staging copy.")
  }

  const duplicatedFrom = new Map<number, number>()
  for (const request of spec.forwardRequests) {
    const duplicate = recordOrNull(request.duplicateSheet)
    if (!duplicate) continue
    duplicatedFrom.set(
      numberField(duplicate, "newSheetId"),
      numberField(duplicate, "sourceSheetId")
    )
  }

  const bind = (
    requests: readonly Readonly<Record<string, unknown>>[]
  ): readonly Readonly<Record<string, unknown>>[] =>
    requests.map((request) => {
      const setBasicFilter = recordOrNull(request.setBasicFilter)
      if (!setBasicFilter) return request
      const requestedFilter = record(setBasicFilter.filter)
      const requestedRange = record(requestedFilter.range)
      const targetSheetId = numberField(requestedRange, "sheetId")
      const sourceSheetId = duplicatedFrom.get(targetSheetId) ?? targetSheetId
      const sourceSheet = findSheetById(snapshot, sourceSheetId)
      if (!sourceSheet || !isRecord(sourceSheet.basicFilter)) {
        throw new Error(
          `Structural filter binding requires a live basic-filter preimage for sheet ${sourceSheetId}.`
        )
      }
      const liveFilter = cloneRecord(sourceSheet.basicFilter)
      liveFilter.range = cloneRecord(requestedRange)
      return { setBasicFilter: { filter: liveFilter } }
    })

  return {
    ...spec,
    forwardRequests: bind(spec.forwardRequests),
    rollbackRequests: bind(spec.rollbackRequests),
  }
}

/**
 * Returns only the literal cells that an exact structural before/after proof
 * actually consumes. Full-workbook form reads deliberately exclude literal
 * ExtendedValue members; this allowlist is the sole bridge for headers, static
 * layout labels, and ranges that a spec requires to be empty.
 */
export function stagingStructuralNormalizationLiteralRanges(
  spec: StagingStructuralNormalizationSpec
): readonly StagingStructuralLiteralObservationRange[] {
  const ranges = [
    ...literalRangesForState(spec.expectedBefore),
    ...literalRangesForState(spec.expectedAfter),
  ]
  const byRange = new Map<string, StagingStructuralLiteralObservationRange>()
  for (const range of ranges) {
    const key = stableSerialize(range.gridRange)
    const existing = byRange.get(key)
    if (existing && existing.sheetTitle !== range.sheetTitle) {
      throw new Error("Structural literal range changed sheet title across expected states.")
    }
    if (!existing) byRange.set(key, range)
  }
  return [...byRange.values()].sort(
    (left, right) =>
      left.gridRange.sheetId - right.gridRange.sheetId ||
      left.gridRange.startRowIndex - right.gridRange.startRowIndex ||
      left.gridRange.startColumnIndex - right.gridRange.startColumnIndex ||
      left.gridRange.endRowIndex - right.gridRange.endRowIndex ||
      left.gridRange.endColumnIndex - right.gridRange.endColumnIndex
  )
}

/**
 * Projects a Sheets API snapshot into the exact state object consumed by the
 * structural planner. Partial, mixed, or ambiguous states fail closed.
 */
export function projectStagingStructuralNormalizationState(
  snapshot: SheetsApiSpreadsheetSnapshot,
  spec: StagingStructuralNormalizationSpec
): Readonly<Record<string, unknown>> {
  if (snapshot.spreadsheetId !== spec.spreadsheetId) {
    throw new Error(
      `${spec.id} snapshot is not the registered staging spreadsheet ${spec.spreadsheetId}`
    )
  }

  const beforeErrors = validateSnapshotState(snapshot, spec.expectedBefore, "before")
  const afterErrors = validateSnapshotState(snapshot, spec.expectedAfter, "after")
  const beforeMatches = beforeErrors.length === 0
  const afterMatches = afterErrors.length === 0

  if (beforeMatches === afterMatches) {
    const reason = beforeMatches
      ? "snapshot ambiguously matches both structural states"
      : `snapshot matches neither exact state; before: ${beforeErrors.slice(0, 4).join("; ")}; after: ${afterErrors
          .slice(0, 4)
          .join("; ")}`
    throw new Error(`${spec.id} ${reason}`)
  }
  return beforeMatches ? spec.expectedBefore : spec.expectedAfter
}

/**
 * Verifies a completed one-time normalization. Besides recognizing the exact
 * after-state, it compares a full structural projection with only the spec's
 * sanctioned transformations normalized away.
 */
export function verifyStagingStructuralNormalizationAfter(input: {
  spec: StagingStructuralNormalizationSpec
  beforeSnapshot: SheetsApiSpreadsheetSnapshot
  afterSnapshot: SheetsApiSpreadsheetSnapshot
}): StructuralNormalizationAfterVerification {
  const beforeState = projectStagingStructuralNormalizationState(input.beforeSnapshot, input.spec)
  if (stableSerialize(beforeState) !== stableSerialize(input.spec.expectedBefore)) {
    throw new Error(`${input.spec.id} verification requires the exact audited before-state`)
  }

  const afterState = projectStagingStructuralNormalizationState(input.afterSnapshot, input.spec)
  if (stableSerialize(afterState) !== stableSerialize(input.spec.expectedAfter)) {
    throw new Error(`${input.spec.id} did not reach the exact normalized after-state`)
  }

  const allowlist = normalizationAllowlist(input.spec)
  const beforeStructure = canonicalStructure(input.beforeSnapshot, allowlist, "before")
  const afterStructure = canonicalStructure(input.afterSnapshot, allowlist, "after")
  const beforeFingerprint = createPayloadFingerprint(beforeStructure)
  const afterFingerprint = createPayloadFingerprint(afterStructure)
  if (beforeFingerprint !== afterFingerprint) {
    throw new Error(
      `${input.spec.id} non-approved structure drifted ` +
        `(before ${beforeFingerprint}, after ${afterFingerprint}); refusing verification.`
    )
  }

  const beforePlan = planStagingStructuralNormalization(input.spec, beforeState)
  const afterPlan = planStagingStructuralNormalization(input.spec, afterState)
  if (beforePlan.status !== "planned" || afterPlan.status !== "already_normalized") {
    throw new Error(`${input.spec.id} planner did not prove planned -> already_normalized transition`)
  }

  return {
    artifactKey: input.spec.artifactKey,
    spreadsheetId: input.spec.spreadsheetId,
    normalizationId: input.spec.id,
    beforePlan,
    afterPlan,
    afterStateVerified: true,
    nonApprovedStructureUnchanged: true,
    beforeStructureFingerprint: beforeFingerprint,
    afterStructureFingerprint: afterFingerprint,
  }
}

function validateSnapshotState(
  snapshot: SheetsApiSpreadsheetSnapshot,
  state: Readonly<Record<string, unknown>>,
  phase: "before" | "after"
): string[] {
  if (isRecord(state.weeklyRecruitmentRows)) {
    return validateWeeklyRecruitmentRows(snapshot, state.weeklyRecruitmentRows)
  }
  if (isRecord(state.weeklyRecruitmentRollover)) {
    return validateWeeklyRecruitmentRollover(
      snapshot,
      state.weeklyRecruitmentRollover,
      phase
    )
  }
  if (Array.isArray(state.sheets)) return validateWeeklyProgress(snapshot, state)
  if (isRecord(state.rpsTrackingLifecycle)) {
    return validateRpsTrackingLifecycle(snapshot, state.rpsTrackingLifecycle)
  }
  if (isRecord(state.pivot)) return validateSinglePivot(snapshot, state.pivot)
  if (isRecord(state.filter)) return validateSingleFilter(snapshot, state.filter)
  if (isRecord(state.pipelineCandidateRollover)) {
    return validatePipelineCandidateRollover(
      snapshot,
      state.pipelineCandidateRollover,
      phase
    )
  }
  if (isRecord(state.candidate) && isRecord(state.jobSummary)) {
    return validatePipeline(snapshot, state.candidate, state.jobSummary, phase)
  }
  if (isRecord(state.finalOfferQuarterRollover)) {
    return validateFinalOfferQuarterRollover(
      snapshot,
      state.finalOfferQuarterRollover,
      phase
    )
  }
  if (Array.isArray(state.preservedQ2Sheets)) return validateFinalOffer(snapshot, state, phase)
  if (isRecord(state.raw) && (isRecord(state.datedTemplate) || isRecord(state.datedOutput))) {
    return validateDeliveryRps(snapshot, state, phase)
  }
  return ["unsupported structural state schema"]
}

function validatePipelineCandidateRollover(
  snapshot: SheetsApiSpreadsheetSnapshot,
  rollover: UnknownRecord,
  phase: "before" | "after"
): string[] {
  const errors: string[] = []
  const predecessor = record(rollover.predecessor)
  const predecessorSheet = exactSheet(
    snapshot,
    numberField(predecessor, "sheetId"),
    stringField(predecessor, "sheetTitle"),
    errors
  )
  if (predecessorSheet) {
    compareSheetIndex(predecessorSheet, predecessor, errors)
    compareSheetGrid(predecessorSheet, predecessor, errors)
    compareRange(
      basicFilterRange(predecessorSheet),
      record(predecessor.basicFilter),
      "pipeline predecessor basic filter",
      errors
    )
  }

  if (phase === "before" && !isRecord(rollover.targetSheet)) {
    const absent = record(rollover.targetSheetAbsent)
    assertSheetAbsent(
      snapshot,
      numberField(absent, "sheetId"),
      stringField(absent, "sheetTitle"),
      errors
    )
    if (isRecord(rollover.jobSummary)) {
      errors.push(...validatePipelineJobSummary(snapshot, rollover.jobSummary, phase, true))
    }
    return errors
  }

  const target = record(rollover.targetSheet)
  const targetSheet = exactSheet(
    snapshot,
    numberField(target, "sheetId"),
    stringField(target, "sheetTitle"),
    errors
  )
  if (!targetSheet) return errors
  compareSheetIndex(targetSheet, target, errors)
  compareSheetGrid(targetSheet, target, errors)
  compareRange(
    basicFilterRange(targetSheet),
    record(target.basicFilter),
    "pipeline target basic filter",
    errors
  )
  if (numberField(target, "duplicatedFromSheetId") !== numberField(predecessor, "sheetId")) {
    errors.push("Pipeline candidate target has an unexpected predecessor binding")
  }
  if (
    predecessorSheet &&
    stableSerialize(canonicalPipelineCandidateForm(targetSheet)) !==
      stableSerialize(canonicalPipelineCandidateForm(predecessorSheet))
  ) {
    errors.push("Pipeline candidate target is not a structural duplicate of its predecessor")
  }
  if (isRecord(target.dataRowsCleared)) {
    assertRangeHasNoEnteredValues(
      targetSheet,
      target.dataRowsCleared,
      "pipeline candidate target cleared rows",
      errors
    )
  }
  if (isRecord(rollover.jobSummary)) {
    errors.push(...validatePipelineJobSummary(snapshot, rollover.jobSummary, phase, true))
  }
  return errors
}

function validateWeeklyRecruitmentRows(
  snapshot: SheetsApiSpreadsheetSnapshot,
  expected: UnknownRecord
): string[] {
  const errors: string[] = []
  const sheetIdValue = numberField(expected, "sheetId")
  const sheet = exactSheet(
    snapshot,
    sheetIdValue,
    stringField(expected, "sheetTitle"),
    errors
  )
  if (!sheet) return errors
  const startRowIndex = numberField(expected, "startRowIndex")
  const endRowIndex = numberField(expected, "endRowIndex")
  const columnCount = numberField(expected, "columnCount")
  const dataProvenance = stringField(expected, "dataProvenance")
  const rows = arrayField(expected, "rows").map(record)
  if (
    !Number.isInteger(startRowIndex) ||
    !Number.isInteger(endRowIndex) ||
    startRowIndex < 0 ||
    endRowIndex <= startRowIndex ||
    columnCount !== WEEKLY_RECRUITMENT_ROW_WIDTH ||
    rows.length !== endRowIndex - startRowIndex ||
    (dataProvenance !== "fixture" && dataProvenance !== "live")
  ) {
    return ["Weekly Recruitment row lifecycle expected state is malformed"]
  }
  rows.forEach((expectedRow, offset) => {
    const rowIndex = startRowIndex + offset
    const cells = Array.from(
      { length: WEEKLY_RECRUITMENT_ROW_WIDTH },
      (_, columnIndex) => cellAt(sheet, rowIndex, columnIndex)
    )
    const valueFingerprint = weeklyRecruitmentRowValueFingerprint(
      weeklyRecruitmentRowValues(cells),
      dataProvenance
    )
    const formFingerprint = weeklyRecruitmentRowFormFingerprint(
      weeklyRecruitmentRowForms(cells)
    )
    if (valueFingerprint !== stringField(expectedRow, "valueFingerprint")) {
      errors.push(`Weekly Recruitment row ${rowIndex + 1} value fingerprint drifted`)
    }
    if (formFingerprint !== stringField(expectedRow, "formFingerprint")) {
      errors.push(`Weekly Recruitment row ${rowIndex + 1} form fingerprint drifted`)
    }
  })
  return errors
}

function validateWeeklyRecruitmentRollover(
  snapshot: SheetsApiSpreadsheetSnapshot,
  rollover: UnknownRecord,
  phase: "before" | "after"
): string[] {
  const errors: string[] = []
  const predecessor = record(rollover.predecessor)
  const predecessorSheet = exactSheet(
    snapshot,
    numberField(predecessor, "sheetId"),
    stringField(predecessor, "sheetTitle"),
    errors
  )
  if (predecessorSheet) compareSheetIndex(predecessorSheet, predecessor, errors)

  if (phase === "before") {
    const absent = record(rollover.targetSheetAbsent)
    assertSheetAbsent(
      snapshot,
      numberField(absent, "sheetId"),
      stringField(absent, "sheetTitle"),
      errors
    )
    return errors
  }

  const target = record(rollover.targetSheet)
  const targetSheet = exactSheet(
    snapshot,
    numberField(target, "sheetId"),
    stringField(target, "sheetTitle"),
    errors
  )
  if (!targetSheet) return errors
  compareSheetIndex(targetSheet, target, errors)
  if (numberField(target, "duplicatedFromSheetId") !== numberField(predecessor, "sheetId")) {
    errors.push("Weekly Recruitment target has an unexpected predecessor binding")
  }
  if (
    predecessorSheet &&
    stableSerialize(canonicalDuplicatedSheetForm(targetSheet)) !==
      stableSerialize(canonicalDuplicatedSheetForm(predecessorSheet))
  ) {
    errors.push("Weekly Recruitment target is not an exact structural duplicate of its predecessor")
  }
  return errors
}

function validateSingleFilter(
  snapshot: SheetsApiSpreadsheetSnapshot,
  expectedFilter: UnknownRecord
): string[] {
  const errors: string[] = []
  const sheet = exactSheet(
    snapshot,
    numberField(expectedFilter, "sheetId"),
    stringField(expectedFilter, "sheetTitle"),
    errors
  )
  if (sheet) {
    compareRange(
      basicFilterRange(sheet),
      record(expectedFilter.basicFilter),
      "basic filter",
      errors
    )
  }
  return errors
}

function validateWeeklyProgress(
  snapshot: SheetsApiSpreadsheetSnapshot,
  state: Readonly<Record<string, unknown>>
): string[] {
  const errors: string[] = []
  for (const value of state.sheets as readonly unknown[]) {
    const expected = record(value)
    const sheetId = numberField(expected, "sheetId")
    const sheet = exactSheet(snapshot, sheetId, stringField(expected, "sheetTitle"), errors)
    if (!sheet) continue
    const qtd = record(expected.qtd)
    const qtdColumn = columnIndex(stringField(qtd, "column"))
    expectCellString(sheet, 0, qtdColumn, "QTD", `${sheetId} QTD header`, errors)
    const formulas = arrayField(qtd, "formulas").map(String)
    formulas.forEach((formula, index) => {
      const actual = formulaAt(sheet, index + 1, qtdColumn)
      if (actual !== formula) errors.push(`${sheetId} QTD formula row ${index + 2} expected ${formula}, got ${actual}`)
    })
    if (isRecord(expected.currentWeek)) {
      const currentWeek = expected.currentWeek
      expectCellString(
        sheet,
        0,
        numberField(currentWeek, "columnIndex"),
        stringField(currentWeek, "header"),
        `${sheetId} current-week header`,
        errors
      )
    }
  }
  return errors
}

function validateSinglePivot(
  snapshot: SheetsApiSpreadsheetSnapshot,
  expectedPivot: UnknownRecord
): string[] {
  const errors: string[] = []
  const sheetId = numberField(expectedPivot, "pivotSheetId")
  const sheet = exactSheet(snapshot, sheetId, stringField(expectedPivot, "pivotSheetTitle"), errors)
  if (!sheet) return errors
  const source = pivotSourceAt(snapshot, sheet, 0, 0)
  compareRange(source, record(expectedPivot.source), `${sheetId} pivot source`, errors)
  return errors
}

function validateRpsTrackingLifecycle(
  snapshot: SheetsApiSpreadsheetSnapshot,
  expected: UnknownRecord
): string[] {
  const errors: string[] = []
  const data = record(expected.dataSheet)
  const dataSheet = exactSheet(
    snapshot,
    numberField(data, "sheetId"),
    stringField(data, "sheetTitle"),
    errors
  )
  if (dataSheet) compareSheetGrid(dataSheet, data, errors)

  const pivot = record(expected.pivot)
  const pivotSheet = exactSheet(
    snapshot,
    numberField(pivot, "pivotSheetId"),
    stringField(pivot, "pivotSheetTitle"),
    errors
  )
  if (pivotSheet) {
    compareRange(
      pivotSourceAt(snapshot, pivotSheet, 0, 0),
      record(pivot.source),
      "RPS Tracking pivot source",
      errors
    )
  }
  return errors
}

function validatePipeline(
  snapshot: SheetsApiSpreadsheetSnapshot,
  candidate: UnknownRecord,
  jobSummary: UnknownRecord,
  phase: "before" | "after"
): string[] {
  const errors: string[] = []
  if (candidate.mode === "missing_current_tab") {
    const absent = record(candidate.targetSheetAbsent)
    assertSheetAbsent(snapshot, numberField(absent, "sheetId"), stringField(absent, "sheetTitle"), errors)
    const template = record(candidate.template)
    const templateSheet = exactSheet(
      snapshot,
      numberField(template, "sheetId"),
      stringField(template, "sheetTitle"),
      errors
    )
    if (templateSheet) {
      compareRange(
        basicFilterRange(templateSheet),
        record(template.basicFilter),
        "candidate template basic filter",
        errors
      )
      compareSheetGrid(templateSheet, template, errors)
      compareSheetIndex(templateSheet, template, errors)
    }
  } else {
    const sheet = exactSheet(
      snapshot,
      numberField(candidate, "sheetId"),
      stringField(candidate, "sheetTitle"),
      errors
    )
    if (sheet) {
      compareRange(basicFilterRange(sheet), record(candidate.basicFilter), "candidate basic filter", errors)
      compareSheetIndex(sheet, candidate, errors)
      if (isRecord(candidate.dataRowsCleared)) {
        assertRangeHasNoEnteredValues(sheet, candidate.dataRowsCleared, "candidate cleared rows", errors)
      }
    }
  }

  errors.push(...validatePipelineJobSummary(snapshot, jobSummary, phase, false))
  return errors
}

function validatePipelineJobSummary(
  snapshot: SheetsApiSpreadsheetSnapshot,
  jobSummary: UnknownRecord,
  phase: "before" | "after",
  valuesOwnedByBoundedWriter: boolean
): string[] {
  const errors: string[] = []
  const jobSheetId = numberField(jobSummary, "sheetId")
  const jobSheet = exactSheet(snapshot, jobSheetId, stringField(jobSummary, "sheetTitle"), errors)
  if (!jobSheet) return errors
  compareRange(basicFilterRange(jobSheet), record(jobSummary.basicFilter), "job-summary basic filter", errors)

  if (phase === "before") {
    const destination = record(jobSummary.appendDestination)
    assertRangeInsideGrid(jobSheet, record(jobSummary.lastWeekTemplate), "job template", errors)
    assertRangeInsideGrid(jobSheet, destination, "job append destination", errors)
    if (jobSummary.appendDestinationBlankAndUnformatted === true) {
      assertRangeBlankAndUnformatted(jobSheet, destination, "job append destination", errors)
    } else if (jobSummary.appendDestinationBlankExceptBackgroundFormat === true) {
      assertRangeBlankExceptUserEnteredFormat(
        jobSheet,
        destination,
        "job append destination",
        errors
      )
      const preimage = record(jobSummary.backgroundFormatPreimage)
      const source = record(preimage.source)
      const preimageDestination = record(preimage.destination)
      compareRange(
        preimageDestination,
        destination,
        "job background-format rollback destination",
        errors
      )
      if (preimage.pasteType !== "PASTE_FORMAT") {
        errors.push("job background-format rollback must use PASTE_FORMAT")
      }
      assertRangeInsideGrid(jobSheet, source, "job background-format rollback source", errors)
      compareFormatMatrices(
        jobSheet,
        source,
        destination,
        "job append background and rollback source",
        errors
      )
    }
  } else {
    const appended = record(jobSummary.appendedTemplate)
    const source = record(appended.source)
    const destination = record(appended.destination)
    assertRangeInsideGrid(jobSheet, source, "job template", errors)
    assertRangeInsideGrid(jobSheet, destination, "job append destination", errors)
    if (valuesOwnedByBoundedWriter && appended.valuesOwnedByBoundedWriter !== true) {
      errors.push("recurring job appended template must delegate values to the bounded writer")
    }
    if (!valuesOwnedByBoundedWriter) {
      assertRangeHasNoEnteredValues(jobSheet, destination, "job appended template", errors)
    }
    compareFormatMatrices(
      jobSheet,
      source,
      destination,
      "job appended template and last-week template",
      errors
    )
  }
  return errors
}

function validateFinalOffer(
  snapshot: SheetsApiSpreadsheetSnapshot,
  state: Readonly<Record<string, unknown>>,
  phase: "before" | "after"
): string[] {
  const errors: string[] = []
  for (const value of arrayField(state, "preservedQ2Sheets")) {
    const expected = record(value)
    exactSheet(snapshot, numberField(expected, "sheetId"), stringField(expected, "sheetTitle"), errors)
  }
  for (const value of arrayField(state, "existingPivotSources")) {
    const expected = record(value)
    const sheet = exactSheet(
      snapshot,
      numberField(expected, "pivotSheetId"),
      stringField(expected, "pivotSheetTitle"),
      errors
    )
    if (sheet) compareRange(pivotSourceAt(snapshot, sheet, 0, 0), record(expected.source), "existing pivot source", errors)
  }

  if (phase === "before") {
    for (const value of arrayField(state, "q3SheetsAbsent")) {
      const absent = record(value)
      assertSheetAbsent(snapshot, numberField(absent, "sheetId"), stringField(absent, "sheetTitle"), errors)
    }
    return errors
  }

  const q3Sheets = arrayField(state, "q3Sheets").map(record)
  for (const expected of q3Sheets) {
    const sheet = exactSheet(
      snapshot,
      numberField(expected, "sheetId"),
      stringField(expected, "sheetTitle"),
      errors
    )
    if (!sheet) continue
    compareSheetIndex(sheet, expected, errors)
    if (expected.kind === "offer_data") {
      compareRange(basicFilterRange(sheet), record(expected.basicFilter), "Q3 data basic filter", errors)
      const rows = record(expected.rowsCleared)
      assertRangeHasNoEnteredValues(
        sheet,
        {
          sheetId: numberField(expected, "sheetId"),
          startRowIndex: numberField(rows, "startRowIndex"),
          endRowIndex: numberField(rows, "endRowIndex"),
          startColumnIndex: 0,
          endColumnIndex: 31,
        },
        "Q3 cleared data",
        errors
      )
    } else {
      compareRange(pivotSourceAt(snapshot, sheet, 0, 0), record(expected.pivotSource), "Q3 pivot source", errors)
    }
  }
  const expectedOrder = arrayField(state, "q3FinalOrdering").map(String)
  const observedOrder = q3Sheets
    .map((expected) => {
      const sheet = findSheetById(snapshot, numberField(expected, "sheetId"))
      return { title: stringField(expected, "sheetTitle"), index: sheetIndex(sheet) }
    })
    .sort((a, b) => a.index - b.index)
    .map(({ title }) => expectedOrder.find((month) => title.includes(month)))
    .filter((month, index, months) => month && month !== months[index - 1])
  if (stableSerialize(observedOrder) !== stableSerialize(expectedOrder)) {
    errors.push(`Q3 sheet ordering expected ${expectedOrder.join(",")}, got ${observedOrder.join(",")}`)
  }
  return errors
}

function validateFinalOfferQuarterRollover(
  snapshot: SheetsApiSpreadsheetSnapshot,
  rollover: UnknownRecord,
  phase: "before" | "after"
): string[] {
  const errors: string[] = []
  const predecessor = record(rollover.predecessor)
  const predecessorSheets = validateFinalOfferTripletState(snapshot, predecessor, errors)
  if (phase === "before") {
    for (const value of arrayField(rollover, "targetSheetsAbsent")) {
      const absent = record(value)
      assertSheetAbsent(
        snapshot,
        numberField(absent, "sheetId"),
        stringField(absent, "sheetTitle"),
        errors
      )
    }
    return errors
  }

  const targetMonths = arrayField(rollover, "targetMonths").map(record)
  for (const target of targetMonths) {
    const targetSheets = validateFinalOfferTripletState(snapshot, target, errors)
    for (const role of ["offerData", "recruiterPerformance", "sourcerPerformance"] as const) {
      const expected = record(target[role])
      const template = record(predecessor[role])
      if (numberField(expected, "duplicatedFromSheetId") !== numberField(template, "sheetId")) {
        errors.push(`Final Offer ${role} target has an unexpected predecessor binding`)
      }
      const targetSheet = targetSheets[role]
      const templateSheet = predecessorSheets[role]
      if (!targetSheet || !templateSheet) continue
      const targetForm = role === "offerData"
        ? canonicalFinalOfferOfferDataForm(targetSheet)
        : canonicalFinalOfferPivotForm(targetSheet)
      const templateForm = role === "offerData"
        ? canonicalFinalOfferOfferDataForm(templateSheet)
        : canonicalFinalOfferPivotForm(templateSheet)
      if (stableSerialize(targetForm) !== stableSerialize(templateForm)) {
        errors.push(`Final Offer ${role} target is not a structural duplicate of its predecessor`)
      }
    }
  }

  const expectedOrder = arrayField(rollover, "finalMonthOrdering").map(String)
  const observedOrder = targetMonths
    .map((target) => ({
      monthKey: stringField(target, "monthKey"),
      index: sheetIndex(findSheetById(snapshot, numberField(record(target.offerData), "sheetId"))),
    }))
    .sort((left, right) => left.index - right.index)
    .map(({ monthKey }) => monthKey)
  if (stableSerialize(observedOrder) !== stableSerialize(expectedOrder)) {
    errors.push(`Final Offer quarter ordering expected ${expectedOrder.join(",")}, got ${observedOrder.join(",")}`)
  }
  return errors
}

function validateFinalOfferTripletState(
  snapshot: SheetsApiSpreadsheetSnapshot,
  expected: UnknownRecord,
  errors: string[]
): Record<"offerData" | "recruiterPerformance" | "sourcerPerformance", SheetsApiSheetSnapshot | undefined> {
  const offer = record(expected.offerData)
  const recruiter = record(expected.recruiterPerformance)
  const sourcer = record(expected.sourcerPerformance)
  const offerSheet = exactSheet(
    snapshot,
    numberField(offer, "sheetId"),
    stringField(offer, "sheetTitle"),
    errors
  )
  if (offerSheet) {
    compareSheetIndex(offerSheet, offer, errors)
    compareSheetGrid(offerSheet, offer, errors)
    compareRange(
      basicFilterRange(offerSheet),
      record(offer.basicFilter),
      "Final Offer data basic filter",
      errors
    )
    if (isRecord(offer.rowsCleared)) {
      assertRangeHasNoEnteredValues(offerSheet, offer.rowsCleared, "Final Offer cleared data", errors)
    }
  }

  const recruiterSheet = exactSheet(
    snapshot,
    numberField(recruiter, "sheetId"),
    stringField(recruiter, "sheetTitle"),
    errors
  )
  if (recruiterSheet) {
    compareSheetIndex(recruiterSheet, recruiter, errors)
    compareSheetGrid(recruiterSheet, recruiter, errors)
    compareRange(
      pivotSourceAt(snapshot, recruiterSheet, 0, 0),
      record(recruiter.pivotSource),
      "Final Offer recruiter pivot source",
      errors
    )
  }

  const sourcerSheet = exactSheet(
    snapshot,
    numberField(sourcer, "sheetId"),
    stringField(sourcer, "sheetTitle"),
    errors
  )
  if (sourcerSheet) {
    compareSheetIndex(sourcerSheet, sourcer, errors)
    compareSheetGrid(sourcerSheet, sourcer, errors)
    compareRange(
      pivotSourceAt(snapshot, sourcerSheet, 0, 0),
      record(sourcer.pivotSource),
      "Final Offer sourcer pivot source",
      errors
    )
  }
  return {
    offerData: offerSheet,
    recruiterPerformance: recruiterSheet,
    sourcerPerformance: sourcerSheet,
  }
}

function validateDeliveryRps(
  snapshot: SheetsApiSpreadsheetSnapshot,
  state: Readonly<Record<string, unknown>>,
  phase: "before" | "after"
): string[] {
  const errors: string[] = []
  const raw = record(state.raw)
  const rawSheet = exactSheet(snapshot, numberField(raw, "sheetId"), stringField(raw, "sheetTitle"), errors)
  if (rawSheet) {
    compareRange(basicFilterRange(rawSheet), record(raw.basicFilter), "Delivery Raw filter", errors)
    if (isRecord(raw.grid)) compareDeliveryRpsGrid(rawSheet, raw.grid, "Raw", errors)
  }

  if (isRecord(state.clean)) {
    const clean = state.clean
    const cleanSheet = exactSheet(
      snapshot,
      numberField(clean, "sheetId"),
      stringField(clean, "sheetTitle"),
      errors
    )
    if (cleanSheet && isRecord(clean.grid)) {
      compareDeliveryRpsGrid(cleanSheet, clean.grid, "Clean", errors)
    }
  }

  const template = isRecord(state.datedTemplate) ? state.datedTemplate : null
  const templateSheet = template
    ? exactSheet(
        snapshot,
        numberField(template, "sheetId"),
        stringField(template, "sheetTitle"),
        errors
      )
    : undefined
  if (template && templateSheet) {
    compareSheetIndex(templateSheet, template, errors)
    validateDatedLayout(templateSheet, record(template.staticLayout), record(template.grid), errors)
  }

  if (phase === "before") {
    const absent = record(state.targetSheetAbsent)
    assertSheetAbsent(snapshot, numberField(absent, "sheetId"), stringField(absent, "sheetTitle"), errors)
  } else {
    const output = record(state.datedOutput)
    const sheet = exactSheet(
      snapshot,
      numberField(output, "sheetId"),
      stringField(output, "sheetTitle"),
      errors
    )
    if (sheet) {
      compareSheetIndex(sheet, output, errors)
      validateDatedLayout(sheet, record(output.staticLayout), record(output.grid), errors)
      if (isRecord(output.clearedSummaryRange)) {
        assertRangeHasNoEnteredValues(sheet, output.clearedSummaryRange, "dated summary clear", errors)
      }
      if (
        template &&
        templateSheet &&
        numberField(output, "duplicatedFromSheetId") !== numberField(template, "sheetId")
      ) {
        errors.push("Delivery RPS dated target has an unexpected predecessor binding")
      }
      if (
        templateSheet &&
        stableSerialize(canonicalDeliveryRpsDuplicatedSheetForm(
          sheet,
          record(output.valueOwnedRange)
        )) !==
          stableSerialize(canonicalDeliveryRpsDuplicatedSheetForm(
            templateSheet,
            record(output.valueOwnedRange)
          ))
      ) {
        errors.push("Delivery RPS dated target is not a structural duplicate of its predecessor")
      }
    }
  }
  return errors
}

function compareDeliveryRpsGrid(
  sheet: SheetsApiSheetSnapshot,
  expected: UnknownRecord,
  role: string,
  errors: string[]
): void {
  const grid = record(record(sheet.properties).gridProperties)
  if (grid.rowCount !== expected.rowCount || grid.columnCount !== expected.columnCount) {
    errors.push(`Delivery RPS ${role} grid dimensions drifted`)
  }
}

function validateDatedLayout(
  sheet: SheetsApiSheetSnapshot,
  layout: UnknownRecord,
  grid: UnknownRecord,
  errors: string[]
): void {
  const properties = record(sheet.properties)
  const gridProperties = record(properties.gridProperties)
  if (gridProperties.rowCount !== grid.rowCount || gridProperties.columnCount !== grid.columnCount) {
    errors.push("dated output grid dimensions drifted")
  }
  // Only enforced when the expected state names a frozenRowCount: the
  // predecessor's frozen row is historical, hand-applied formatting this
  // write never touches, so its expected layout omits the field on purpose.
  if (
    layout.frozenRowCount !== undefined &&
    gridProperties.frozenRowCount !== layout.frozenRowCount
  ) {
    errors.push("dated output frozen row count drifted")
  }
  expectCellString(sheet, 0, 0, stringField(layout, "titleValue"), "dated title", errors)
  const section = record(layout.sectionLabel)
  expectCellString(sheet, 2, 0, stringField(section, "value"), "dated section label", errors)
  const headers = arrayField(layout, "headers").map(String)
  headers.forEach((header, column) => expectCellString(sheet, 3, column, header, "dated header", errors))
  const expectedMerge = { sheetId: sheetId(sheet), startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 14 }
  if (!sheetMerges(sheet).some((merge) => stableSerialize(canonicalRange(merge)) === stableSerialize(expectedMerge))) {
    errors.push("dated A1:N1 merge missing")
  }
}

interface NormalizationAllowlist {
  addedSheetIds: ReadonlySet<number>
  openFilterSheetIds: ReadonlySet<number>
  openPivotSheetIds: ReadonlySet<number>
  weeklyInsertedColumns: ReadonlyMap<number, number>
  weeklyQtdFormulaChanges: ReadonlyMap<number, {
    beforeColumnIndex: number
    afterColumnIndex: number
    startRowIndex: number
    endRowIndex: number
  }>
  expandedRowCounts: ReadonlyMap<number, number>
  appendFormatRanges: ReadonlyMap<number, readonly UnknownRecord[]>
  weeklyMovedRows?: {
    sheetId: number
    startRowIndex: number
    endRowIndex: number
    afterToBefore: ReadonlyMap<number, number>
    normalizedBeforeRows: ReadonlySet<number>
  }
}

function normalizationAllowlist(spec: StagingStructuralNormalizationSpec): NormalizationAllowlist {
  const addedSheetIds = new Set<number>()
  const openFilterSheetIds = new Set<number>()
  const openPivotSheetIds = new Set<number>()
  const weeklyInsertedColumns = new Map<number, number>()
  const weeklyQtdFormulaChanges = new Map<number, {
    beforeColumnIndex: number
    afterColumnIndex: number
    startRowIndex: number
    endRowIndex: number
  }>()
  const expandedRowCounts = new Map<number, number>()
  const appendFormatRanges = new Map<number, UnknownRecord[]>()
  const after = spec.expectedAfter
  let weeklyMovedRows: NormalizationAllowlist["weeklyMovedRows"]

  if (
    isRecord(after.weeklyRecruitmentRows) &&
    isRecord(spec.expectedBefore.weeklyRecruitmentRows)
  ) {
    const beforeRows = spec.expectedBefore.weeklyRecruitmentRows
    const afterRows = after.weeklyRecruitmentRows
    const sheetIdValue = numberField(afterRows, "sheetId")
    const startRowIndex = numberField(afterRows, "startRowIndex")
    const endRowIndex = numberField(afterRows, "endRowIndex")
    const beforeTokens = arrayField(beforeRows, "rows").map((row) =>
      stringField(record(row), "rowToken")
    )
    const afterTokens = arrayField(afterRows, "rows").map((row) =>
      stringField(record(row), "rowToken")
    )
    if (
      numberField(beforeRows, "sheetId") !== sheetIdValue ||
      numberField(beforeRows, "startRowIndex") !== startRowIndex ||
      numberField(beforeRows, "endRowIndex") !== endRowIndex ||
      beforeTokens.length !== afterTokens.length ||
      new Set(beforeTokens).size !== beforeTokens.length ||
      new Set(afterTokens).size !== afterTokens.length ||
      beforeTokens.some((token) => !afterTokens.includes(token))
    ) {
      throw new Error("Weekly Recruitment row lifecycle allowlist is not one exact permutation.")
    }
    const beforeByToken = new Map(
      beforeTokens.map((token, offset) => [token, startRowIndex + offset] as const)
    )
    const afterToBefore = new Map(
      afterTokens.map((token, offset) => [
        startRowIndex + offset,
        beforeByToken.get(token) as number,
      ] as const)
    )
    const normalizedTokens = arrayField(afterRows, "formatNormalizedRowTokens").map(String)
    if (normalizedTokens.some((token) => !beforeByToken.has(token))) {
      throw new Error("Weekly Recruitment format allowlist references an unknown row token.")
    }
    weeklyMovedRows = {
      sheetId: sheetIdValue,
      startRowIndex,
      endRowIndex,
      afterToBefore,
      normalizedBeforeRows: new Set(
        normalizedTokens.map((token) => beforeByToken.get(token) as number)
      ),
    }
  } else if (isRecord(after.weeklyRecruitmentRollover)) {
    addedSheetIds.add(
      numberField(record(after.weeklyRecruitmentRollover.targetSheet), "sheetId")
    )
  } else if (Array.isArray(after.sheets)) {
    const beforeSheets = Array.isArray(spec.expectedBefore.sheets)
      ? new Map(spec.expectedBefore.sheets.map((value) => {
          const sheet = record(value)
          return [numberField(sheet, "sheetId"), sheet] as const
        }))
      : new Map<number, UnknownRecord>()
    for (const value of after.sheets) {
      const sheet = record(value)
      const sheetIdValue = numberField(sheet, "sheetId")
      if (
        "currentWeekColumnInserted" in sheet &&
        typeof sheet.currentWeekColumnInserted !== "boolean"
      ) {
        throw new Error("Weekly Progress insertion marker must be boolean.")
      }
      if (sheet.currentWeekColumnInserted !== false) {
        weeklyInsertedColumns.set(
          sheetIdValue,
          numberField(record(sheet.currentWeek), "columnIndex")
        )
      }
      const beforeSheet = beforeSheets.get(sheetIdValue)
      if (!beforeSheet) throw new Error("Weekly Progress allowlist is missing its before-state sheet.")
      const beforeQtd = record(beforeSheet.qtd)
      const afterQtd = record(sheet.qtd)
      const beforeFormulas = arrayField(beforeQtd, "formulas").map(String)
      const afterFormulas = arrayField(afterQtd, "formulas").map(String)
      if (stableSerialize(beforeFormulas) !== stableSerialize(afterFormulas)) {
        if (beforeFormulas.length !== afterFormulas.length) {
          throw new Error("Weekly Progress QTD formula correction changed row count.")
        }
        weeklyQtdFormulaChanges.set(sheetIdValue, {
          beforeColumnIndex: columnIndex(stringField(beforeQtd, "column")),
          afterColumnIndex: columnIndex(stringField(afterQtd, "column")),
          startRowIndex: 1,
          endRowIndex: beforeFormulas.length + 1,
        })
      }
    }
  } else if (
    isRecord(after.rpsTrackingLifecycle) &&
    isRecord(spec.expectedBefore.rpsTrackingLifecycle)
  ) {
    const beforeData = record(spec.expectedBefore.rpsTrackingLifecycle.dataSheet)
    const afterData = record(after.rpsTrackingLifecycle.dataSheet)
    const sheetIdValue = numberField(afterData, "sheetId")
    const addedRows = numberField(afterData, "gridRowCount") - numberField(beforeData, "gridRowCount")
    if (addedRows < 0) throw new Error("RPS Tracking lifecycle may not remove retained rows.")
    if (addedRows > 0) expandedRowCounts.set(sheetIdValue, addedRows)
    openPivotSheetIds.add(numberField(record(after.rpsTrackingLifecycle.pivot), "pivotSheetId"))
  } else if (isRecord(after.pivot)) {
    openPivotSheetIds.add(numberField(after.pivot, "pivotSheetId"))
  } else if (isRecord(after.filter)) {
    openFilterSheetIds.add(numberField(after.filter, "sheetId"))
  } else if (isRecord(after.pipelineCandidateRollover)) {
    const target = record(after.pipelineCandidateRollover.targetSheet)
    const beforeRollover = record(spec.expectedBefore.pipelineCandidateRollover)
    if (isRecord(beforeRollover.targetSheetAbsent)) {
      addedSheetIds.add(numberField(target, "sheetId"))
    }
    // A planned filter repair on an existing target (the states carry the
    // observed and desired filters respectively) is the spec's own approved
    // change; without this the whole-workbook comparison reads it as
    // non-approved drift. Same treatment the one-time pipeline spec gives an
    // existing candidate tab above.
    const beforeTarget = recordOrNull(beforeRollover.targetSheet)
    if (
      beforeTarget &&
      stableSerialize(recordOrNull(beforeTarget.basicFilter)) !==
        stableSerialize(recordOrNull(target.basicFilter))
    ) {
      openFilterSheetIds.add(numberField(target, "sheetId"))
    }
    const jobSummary = recordOrNull(after.pipelineCandidateRollover.jobSummary)
    const appended = recordOrNull(jobSummary?.appendedTemplate)
    if (appended) {
      const range = record(appended.destination)
      const ranges = appendFormatRanges.get(numberField(range, "sheetId")) ?? []
      ranges.push(range)
      appendFormatRanges.set(numberField(range, "sheetId"), ranges)
    }
  } else if (isRecord(after.candidate) && isRecord(after.jobSummary)) {
    const beforeCandidate = record(spec.expectedBefore.candidate)
    const afterCandidate = after.candidate
    const candidateSheetId = numberField(afterCandidate, "sheetId")
    if (beforeCandidate.mode === "missing_current_tab") addedSheetIds.add(candidateSheetId)
    else openFilterSheetIds.add(candidateSheetId)
    openFilterSheetIds.add(numberField(after.jobSummary, "sheetId"))
    const appended = record(after.jobSummary.appendedTemplate)
    const range = record(appended.destination)
    const ranges = appendFormatRanges.get(numberField(range, "sheetId")) ?? []
    ranges.push(range)
    appendFormatRanges.set(numberField(range, "sheetId"), ranges)
  } else if (isRecord(after.finalOfferQuarterRollover)) {
    for (const value of arrayField(after.finalOfferQuarterRollover, "targetMonths")) {
      const month = record(value)
      for (const role of ["offerData", "recruiterPerformance", "sourcerPerformance"]) {
        addedSheetIds.add(numberField(record(month[role]), "sheetId"))
      }
    }
  } else if (Array.isArray(after.preservedQ2Sheets)) {
    for (const value of arrayField(after, "q3Sheets")) addedSheetIds.add(numberField(record(value), "sheetId"))
    for (const value of arrayField(after, "existingPivotSources")) {
      openPivotSheetIds.add(numberField(record(value), "pivotSheetId"))
    }
  } else if (isRecord(after.raw) && isRecord(after.datedOutput)) {
    openFilterSheetIds.add(numberField(after.raw, "sheetId"))
    addedSheetIds.add(numberField(after.datedOutput, "sheetId"))
  }

  return {
    addedSheetIds,
    openFilterSheetIds,
    openPivotSheetIds,
    weeklyInsertedColumns,
    weeklyQtdFormulaChanges,
    expandedRowCounts,
    appendFormatRanges,
    ...(weeklyMovedRows ? { weeklyMovedRows } : {}),
  }
}

function canonicalPipelineCandidateForm(sheet: SheetsApiSheetSnapshot): UnknownRecord {
  const form = canonicalDuplicatedSheetForm(sheet)
  const filter = recordOrNull(form.basicFilter)
  const range = recordOrNull(filter?.range)
  if (range) delete range.endRowIndex
  return form
}

function canonicalFinalOfferOfferDataForm(sheet: SheetsApiSheetSnapshot): UnknownRecord {
  return canonicalPipelineCandidateForm(sheet)
}

function canonicalFinalOfferPivotForm(sheet: SheetsApiSheetSnapshot): UnknownRecord {
  return maskFinalOfferPivotSourceSheetIds(canonicalDuplicatedSheetForm(sheet)) as UnknownRecord
}

function maskFinalOfferPivotSourceSheetIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskFinalOfferPivotSourceSheetIds)
  if (!isRecord(value)) return value
  const result = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, maskFinalOfferPivotSourceSheetIds(entry)])
  )
  if (isRecord(value.pivotTable) && isRecord(value.pivotTable.source)) {
    const pivotTable = record(result.pivotTable)
    const source = record(pivotTable.source)
    source.sheetId = "__final_offer_month_data_sheet__"
    pivotTable.source = source
    result.pivotTable = pivotTable
  }
  return result
}

function literalRangesForState(
  state: Readonly<Record<string, unknown>>
): StagingStructuralLiteralObservationRange[] {
  const ranges: StagingStructuralLiteralObservationRange[] = []
  if (isRecord(state.weeklyRecruitmentRows)) {
    const weeklyRows = state.weeklyRecruitmentRows
    ranges.push({
      purpose: "static_layout",
      sheetTitle: stringField(weeklyRows, "sheetTitle"),
      gridRange: {
        sheetId: numberField(weeklyRows, "sheetId"),
        startRowIndex: numberField(weeklyRows, "startRowIndex"),
        endRowIndex: numberField(weeklyRows, "endRowIndex"),
        startColumnIndex: 0,
        endColumnIndex: numberField(weeklyRows, "columnCount"),
      },
    })
    return ranges
  }
  if (Array.isArray(state.sheets)) {
    for (const value of state.sheets) {
      const sheet = record(value)
      const sheetIdValue = numberField(sheet, "sheetId")
      const qtd = record(sheet.qtd)
      const sheetTitle = stringField(sheet, "sheetTitle")
      ranges.push(
        literalCellRange(
          sheetIdValue,
          sheetTitle,
          0,
          columnIndex(stringField(qtd, "column")),
          "header"
        )
      )
      if (isRecord(sheet.currentWeek)) {
        ranges.push(
          literalCellRange(
            sheetIdValue,
            sheetTitle,
            0,
            numberField(sheet.currentWeek, "columnIndex"),
            "header"
          )
        )
      }
    }
    return ranges
  }

  if (isRecord(state.pipelineCandidateRollover)) {
    const target = recordOrNull(state.pipelineCandidateRollover.targetSheet)
    if (isRecord(target?.dataRowsCleared)) {
      ranges.push(
        literalGridRange(
          target.dataRowsCleared,
          stringField(target, "sheetTitle"),
          "blank_destination"
        )
      )
    }
    const job = recordOrNull(state.pipelineCandidateRollover.jobSummary)
    if (isRecord(job?.appendDestination)) {
      ranges.push(
        literalGridRange(
          job.appendDestination,
          stringField(job, "sheetTitle"),
          "blank_destination"
        )
      )
    }
    return ranges
  }

  if (isRecord(state.candidate) && isRecord(state.jobSummary)) {
    const candidate = state.candidate
    if (isRecord(candidate.dataRowsCleared)) {
      ranges.push(
        literalGridRange(
          candidate.dataRowsCleared,
          stringField(candidate, "sheetTitle"),
          "blank_destination"
        )
      )
    }
    const job = state.jobSummary
    if (isRecord(job.appendDestination)) {
      ranges.push(
        literalGridRange(
          job.appendDestination,
          stringField(job, "sheetTitle"),
          "blank_destination"
        )
      )
    }
    if (isRecord(job.appendedTemplate)) {
      ranges.push(
        literalGridRange(
          record(job.appendedTemplate).destination,
          stringField(job, "sheetTitle"),
          "blank_destination"
        )
      )
    }
    return ranges
  }

  if (Array.isArray(state.preservedQ2Sheets)) {
    for (const value of arrayField(state, "q3Sheets")) {
      const sheet = record(value)
      if (sheet.kind !== "offer_data" || !isRecord(sheet.rowsCleared)) continue
      const rows = record(sheet.rowsCleared)
      ranges.push({
        purpose: "blank_destination",
        sheetTitle: stringField(sheet, "sheetTitle"),
        gridRange: {
          sheetId: numberField(sheet, "sheetId"),
          startRowIndex: numberField(rows, "startRowIndex"),
          endRowIndex: numberField(rows, "endRowIndex"),
          startColumnIndex: 0,
          endColumnIndex: 31,
        },
      })
    }
    return ranges
  }

  if (isRecord(state.finalOfferQuarterRollover)) {
    for (const value of arrayField(state.finalOfferQuarterRollover, "targetMonths")) {
      const offer = record(record(value).offerData)
      if (!isRecord(offer.rowsCleared)) continue
      ranges.push(
        literalGridRange(
          offer.rowsCleared,
          stringField(offer, "sheetTitle"),
          "blank_destination"
        )
      )
    }
    return ranges
  }

  if (isRecord(state.raw) && (isRecord(state.datedTemplate) || isRecord(state.datedOutput))) {
    const datedSheets = [state.datedTemplate, state.datedOutput].filter(isRecord)
    for (const dated of datedSheets) {
      const sheetIdValue = numberField(dated, "sheetId")
      ranges.push(
        literalCellRange(sheetIdValue, stringField(dated, "sheetTitle"), 0, 0, "static_layout"),
        literalCellRange(sheetIdValue, stringField(dated, "sheetTitle"), 2, 0, "static_layout"),
        {
          purpose: "static_layout",
          sheetTitle: stringField(dated, "sheetTitle"),
          gridRange: {
            sheetId: sheetIdValue,
            startRowIndex: 3,
            endRowIndex: 4,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
        }
      )
    }
    if (isRecord(state.datedOutput) && isRecord(state.datedOutput.clearedSummaryRange)) {
      ranges.push(
        literalGridRange(
          state.datedOutput.clearedSummaryRange,
          stringField(state.datedOutput, "sheetTitle"),
          "blank_destination"
        )
      )
    }
  }
  return ranges
}

function literalCellRange(
  sheetIdValue: number,
  sheetTitle: string,
  rowIndex: number,
  columnIndexValue: number,
  purpose: StagingStructuralLiteralObservationRange["purpose"]
): StagingStructuralLiteralObservationRange {
  return {
    purpose,
    sheetTitle,
    gridRange: {
      sheetId: sheetIdValue,
      startRowIndex: rowIndex,
      endRowIndex: rowIndex + 1,
      startColumnIndex: columnIndexValue,
      endColumnIndex: columnIndexValue + 1,
    },
  }
}

function literalGridRange(
  value: unknown,
  sheetTitle: string,
  purpose: StagingStructuralLiteralObservationRange["purpose"]
): StagingStructuralLiteralObservationRange {
  const range = record(value)
  return {
    purpose,
    sheetTitle,
    gridRange: {
      sheetId: numberField(range, "sheetId"),
      startRowIndex: numberField(range, "startRowIndex"),
      endRowIndex: numberField(range, "endRowIndex"),
      startColumnIndex: numberField(range, "startColumnIndex"),
      endColumnIndex: numberField(range, "endColumnIndex"),
    },
  }
}

function canonicalDuplicatedSheetForm(sheet: SheetsApiSheetSnapshot): UnknownRecord {
  const form = canonicalSheetStructure(
    sheet,
    {
      addedSheetIds: new Set<number>(),
      openFilterSheetIds: new Set<number>(),
      openPivotSheetIds: new Set<number>(),
      weeklyInsertedColumns: new Map<number, number>(),
      weeklyQtdFormulaChanges: new Map(),
      expandedRowCounts: new Map<number, number>(),
      appendFormatRanges: new Map<number, readonly UnknownRecord[]>(),
    },
    "before"
  )
  const properties = cloneRecord(form.properties)
  delete properties.sheetId
  delete properties.title
  delete properties.index
  form.properties = properties
  return normalizeDuplicatedSheetSelfReferences(form, sheetId(sheet)) as UnknownRecord
}

function canonicalDeliveryRpsDuplicatedSheetForm(
  sheet: SheetsApiSheetSnapshot,
  valueOwnedRange: UnknownRecord
): UnknownRecord {
  const form = canonicalDuplicatedSheetForm(sheet)
  // frozenRowCount is validated explicitly and exactly by validateDatedLayout
  // for the output role, and is deliberately forced independent of whatever
  // the predecessor currently has (predecessors have drifted to no frozen
  // row), so it's excluded here from the "exact structural duplicate of its
  // predecessor" comparison.
  const properties = cloneRecord(form.properties)
  const gridProperties = cloneRecord(properties.gridProperties)
  delete gridProperties.frozenRowCount
  properties.gridProperties = gridProperties
  form.properties = properties
  form.structuralCells = arrayField(form, "structuralCells")
    .map(record)
    .map((cell) => {
      const normalized = cloneRecord(cell)
      if (coordinateInRange(
        numberField(cell, "rowIndex"),
        numberField(cell, "columnIndex"),
        valueOwnedRange
      )) {
        delete normalized.userEnteredFormula
        delete normalized.userEnteredFormat
      }
      return normalized
    })
    .filter((cell) => Object.keys(cell).some((key) => !["rowIndex", "columnIndex"].includes(key)))
  return form
}

function normalizeDuplicatedSheetSelfReferences(value: unknown, ownSheetId: number): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeDuplicatedSheetSelfReferences(entry, ownSheetId))
  }
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            "filterViewId",
            "chartId",
            "protectedRangeId",
            "bandedRangeId",
            "slicerId",
            "metadataId",
            // Rich-text/chip runs are value-owned presentation. Bounded
            // hydration may legitimately refresh them after rollover; sheet
            // format, validation, filters, and formula structure remain exact.
            "textFormatRuns",
            "chipRuns",
          ].includes(key)
      )
      .map(([key, entry]) => [
        key,
        key === "sheetId" && entry === ownSheetId
          ? "__weekly_recruitment_self_sheet__"
          : normalizeDuplicatedSheetSelfReferences(entry, ownSheetId),
      ])
  )
}

function canonicalStructure(
  snapshot: SheetsApiSpreadsheetSnapshot,
  allowlist: NormalizationAllowlist,
  phase: "before" | "after"
): UnknownRecord {
  const topLevel = cloneRecord(snapshot)
  delete topLevel.sheets
  delete topLevel.spreadsheetUrl
  const normalizedTopLevel = normalizeMovedRowRanges(topLevel, allowlist, phase)

  const sheets = snapshotSheets(snapshot)
    .filter((sheet) => phase === "before" || !allowlist.addedSheetIds.has(sheetId(sheet)))
    .sort((a, b) => sheetIndex(a) - sheetIndex(b))
  const order = sheets.map(sheetId)

  return {
    topLevel: normalizedTopLevel,
    order,
    sheets: sheets.map((sheet) => canonicalSheetStructure(sheet, allowlist, phase)),
  }
}

function canonicalSheetStructure(
  sheet: SheetsApiSheetSnapshot,
  allowlist: NormalizationAllowlist,
  phase: "before" | "after"
): UnknownRecord {
  const id = sheetId(sheet)
  const expandedRowStart = phase === "after"
    ? expandedRowStartIndex(sheet, allowlist)
    : undefined
  const root = cloneRecord(sheet)
  delete root.data
  const properties = cloneRecord(root.properties)
  delete properties.index
  if (phase === "after" && allowlist.weeklyInsertedColumns.has(id)) {
    const grid = cloneRecord(properties.gridProperties)
    if (typeof grid.columnCount === "number") grid.columnCount -= 1
    properties.gridProperties = grid
  }
  if (phase === "after" && allowlist.expandedRowCounts.has(id)) {
    const grid = cloneRecord(properties.gridProperties)
    if (typeof grid.rowCount === "number") {
      grid.rowCount -= allowlist.expandedRowCounts.get(id) as number
    }
    properties.gridProperties = grid
  }
  root.properties = properties

  if (allowlist.openFilterSheetIds.has(id)) {
    const basicFilter = cloneRecord(root.basicFilter)
    const range = cloneRecord(basicFilter.range)
    range.endRowIndex = "__approved_open_end_row__"
    basicFilter.range = range
    root.basicFilter = basicFilter
  }

  const insertedColumn = allowlist.weeklyInsertedColumns.get(id)
  const normalizedRoot = record(
    phase === "after" && insertedColumn !== undefined
      ? reverseInsertedColumnRanges(root, id, insertedColumn)
      : root
  )
  const movedRoot = record(normalizeMovedRowRanges(normalizedRoot, allowlist, phase))
  const appendRanges = allowlist.appendFormatRanges.get(id) ?? []
  const dimensionData = structuralDimensionData(
    sheet,
    phase === "after" ? insertedColumn : undefined,
    allowlist,
    phase
  )
  const cells = structuralCells(sheet)
    .filter(
      (cell) =>
        !(
          phase === "after" &&
          insertedColumn !== undefined &&
          numberField(cell, "columnIndex") === insertedColumn
        )
    )
    .filter(
      (cell) =>
        expandedRowStart === undefined ||
        !isAutomaticExpandedRowFormat(cell, expandedRowStart)
    )
    .map((cell) => {
      const normalized = cloneRecord(cell)
      const rowIndex = numberField(cell, "rowIndex")
      const columnIndex = numberField(cell, "columnIndex")
      const canonicalRowIndex = canonicalMovedRowIndex(rowIndex, id, allowlist, phase)
      if (canonicalRowIndex !== rowIndex) normalized.rowIndex = canonicalRowIndex
      const qtdFormulaChange = allowlist.weeklyQtdFormulaChanges.get(id)
      if (
        qtdFormulaChange &&
        rowIndex >= qtdFormulaChange.startRowIndex &&
        rowIndex < qtdFormulaChange.endRowIndex &&
        columnIndex === (phase === "before"
          ? qtdFormulaChange.beforeColumnIndex
          : qtdFormulaChange.afterColumnIndex)
      ) {
        delete normalized.userEnteredFormula
      }
      if (phase === "after" && insertedColumn !== undefined && columnIndex > insertedColumn) {
        normalized.columnIndex = columnIndex - 1
      }
      if (allowlist.openPivotSheetIds.has(id) && rowIndex === 0 && columnIndex === 0) {
        maskPivotSourceEndRow(normalized)
      }
      if (appendRanges.some((range) => coordinateInRange(rowIndex, columnIndex, range))) {
        delete normalized.userEnteredFormat
      }
      if (
        allowlist.weeklyMovedRows?.sheetId === id &&
        allowlist.weeklyMovedRows.normalizedBeforeRows.has(canonicalRowIndex)
      ) {
        delete normalized.userEnteredFormat
        delete normalized.dataValidation
      }
      return record(normalizeMovedRowRanges(normalized, allowlist, phase))
    })
    .filter((cell) => Object.keys(cell).some((key) => !["rowIndex", "columnIndex"].includes(key)))
    .sort((a, b) => numberField(a, "rowIndex") - numberField(b, "rowIndex") || numberField(a, "columnIndex") - numberField(b, "columnIndex"))

  return { ...movedRoot, dimensionData, structuralCells: cells }
}

function structuralDimensionData(
  sheet: SheetsApiSheetSnapshot,
  insertedColumn: number | undefined,
  allowlist: NormalizationAllowlist,
  phase: "before" | "after"
): UnknownRecord[] {
  if (allowlist.weeklyMovedRows?.sheetId === sheetId(sheet)) {
    return structuralDimensionDataWithMovedRows(sheet, allowlist, phase)
  }
  const dimensions: UnknownRecord[] = []
  for (const gridValue of sheet.data ?? []) {
    const grid = record(gridValue)
    const startRow = typeof grid.startRow === "number" ? grid.startRow : 0
    let startColumn = typeof grid.startColumn === "number" ? grid.startColumn : 0
    let rowMetadata = Array.isArray(grid.rowMetadata) ? cloneArray(grid.rowMetadata) : undefined
    const columnMetadata = Array.isArray(grid.columnMetadata) ? cloneArray(grid.columnMetadata) : undefined
    const expandedRowStart = phase === "after"
      ? expandedRowStartIndex(sheet, allowlist)
      : undefined

    // appendDimension copies row metadata into the new rows. Those rows did
    // not exist in the audited preimage, so remove only their metadata from
    // the before/after equivalence projection.
    if (rowMetadata && expandedRowStart !== undefined) {
      rowMetadata.splice(Math.max(0, expandedRowStart - startRow))
      if (rowMetadata.length === 0) rowMetadata = undefined
    }

    if (insertedColumn !== undefined && columnMetadata) {
      const offset = insertedColumn - startColumn
      if (offset >= 0 && offset < columnMetadata.length) columnMetadata.splice(offset, 1)
      else if (startColumn > insertedColumn) startColumn -= 1
    } else if (insertedColumn !== undefined && startColumn > insertedColumn) {
      startColumn -= 1
    }

    if (rowMetadata || columnMetadata) {
      dimensions.push({
        startRow,
        startColumn,
        ...(rowMetadata ? { rowMetadata } : {}),
        ...(columnMetadata ? { columnMetadata } : {}),
      })
    }
  }
  return dimensions
}

function expandedRowStartIndex(
  sheet: SheetsApiSheetSnapshot,
  allowlist: NormalizationAllowlist
): number | undefined {
  const addedRows = allowlist.expandedRowCounts.get(sheetId(sheet))
  const rowCount = record(record(sheet.properties).gridProperties).rowCount
  if (!addedRows || typeof rowCount !== "number") return undefined
  const start = rowCount - addedRows
  return Number.isInteger(start) && start >= 0 ? start : undefined
}

function isAutomaticExpandedRowFormat(cell: UnknownRecord, expandedRowStart: number): boolean {
  if (numberField(cell, "rowIndex") < expandedRowStart) return false
  const structuralKeys = Object.keys(cell).filter(
    (key) => !["rowIndex", "columnIndex"].includes(key)
  )
  // The live Sheets append produced exactly format-only cells. Any formula,
  // validation, pivot, or other form in the new range remains visible and
  // fails the full structural comparison.
  return structuralKeys.length === 1 && structuralKeys[0] === "userEnteredFormat"
}

function structuralDimensionDataWithMovedRows(
  sheet: SheetsApiSheetSnapshot,
  allowlist: NormalizationAllowlist,
  phase: "before" | "after"
): UnknownRecord[] {
  const rowMetadataByRow: UnknownRecord[] = []
  const columnDimensions: UnknownRecord[] = []
  for (const gridValue of sheet.data ?? []) {
    const grid = record(gridValue)
    const startRow = typeof grid.startRow === "number" ? grid.startRow : 0
    const startColumn = typeof grid.startColumn === "number" ? grid.startColumn : 0
    if (Array.isArray(grid.rowMetadata)) {
      grid.rowMetadata.forEach((metadata, offset) => {
        rowMetadataByRow.push({
          rowIndex: canonicalMovedRowIndex(
            startRow + offset,
            sheetId(sheet),
            allowlist,
            phase
          ),
          metadata: cloneRecord(metadata),
        })
      })
    }
    if (Array.isArray(grid.columnMetadata)) {
      columnDimensions.push({
        startColumn,
        columnMetadata: cloneArray(grid.columnMetadata),
      })
    }
  }
  rowMetadataByRow.sort(
    (left, right) => numberField(left, "rowIndex") - numberField(right, "rowIndex")
  )
  return [
    ...(rowMetadataByRow.length > 0 ? [{ rowMetadataByRow }] : []),
    ...columnDimensions,
  ]
}

function structuralCells(sheet: SheetsApiSheetSnapshot): UnknownRecord[] {
  const cells: UnknownRecord[] = []
  for (const gridValue of sheet.data ?? []) {
    const grid = record(gridValue)
    const startRow = typeof grid.startRow === "number" ? grid.startRow : 0
    const startColumn = typeof grid.startColumn === "number" ? grid.startColumn : 0
    const rows = Array.isArray(grid.rowData) ? grid.rowData : []
    rows.forEach((rowValue, rowOffset) => {
      const row = record(rowValue)
      const values = Array.isArray(row.values) ? row.values : []
      values.forEach((cellValue, columnOffset) => {
        const cell = record(cellValue)
        const structural = cloneRecord(cell)
        delete structural.effectiveValue
        delete structural.formattedValue
        delete structural.effectiveFormat
        const enteredValue = recordOrNull(structural.userEnteredValue)
        delete structural.userEnteredValue
        if (typeof enteredValue?.formulaValue === "string") {
          structural.userEnteredFormula = enteredValue.formulaValue
        }
        if (Object.keys(structural).length > 0) {
          cells.push({
            rowIndex: startRow + rowOffset,
            columnIndex: startColumn + columnOffset,
            ...structural,
          })
        }
      })
    })
  }
  return cells
}

function reverseInsertedColumnRanges(value: unknown, sheetIdValue: number, insertedColumn: number): unknown {
  if (Array.isArray(value)) return value.map((entry) => reverseInsertedColumnRanges(entry, sheetIdValue, insertedColumn))
  if (!isRecord(value)) return value
  const result: UnknownRecord = {}
  for (const [key, entry] of Object.entries(value)) {
    result[key] = reverseInsertedColumnRanges(entry, sheetIdValue, insertedColumn)
  }
  if (value.sheetId === sheetIdValue) {
    if (typeof value.startColumnIndex === "number" && value.startColumnIndex > insertedColumn) {
      result.startColumnIndex = value.startColumnIndex - 1
    }
    if (typeof value.endColumnIndex === "number" && value.endColumnIndex > insertedColumn) {
      result.endColumnIndex = value.endColumnIndex - 1
    }
  }
  return result
}

function canonicalMovedRowIndex(
  rowIndex: number,
  sheetIdValue: number,
  allowlist: NormalizationAllowlist,
  phase: "before" | "after"
): number {
  const moved = allowlist.weeklyMovedRows
  if (!moved || moved.sheetId !== sheetIdValue || phase === "before") return rowIndex
  return moved.afterToBefore.get(rowIndex) ?? rowIndex
}

/**
 * Row moves can make Google rewrite filters, protected ranges, named ranges,
 * pivots, and other nested row-bound GridRanges. Project intersecting ranges
 * to their logical pre-move row set so only the approved permutation is
 * ignored; every other structural member remains byte-for-byte comparable.
 */
function normalizeMovedRowRanges(
  value: unknown,
  allowlist: NormalizationAllowlist,
  phase: "before" | "after"
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeMovedRowRanges(entry, allowlist, phase))
  }
  if (!isRecord(value)) return value
  const result: UnknownRecord = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      normalizeMovedRowRanges(entry, allowlist, phase),
    ])
  )
  const moved = allowlist.weeklyMovedRows
  if (!moved || value.sheetId !== moved.sheetId) return result

  if (
    typeof value.startRowIndex === "number" &&
    typeof value.endRowIndex === "number" &&
    rangesIntersect(
      value.startRowIndex,
      value.endRowIndex,
      moved.startRowIndex,
      moved.endRowIndex
    )
  ) {
    result.__canonicalRowIndexes = canonicalRowSet(
      value.startRowIndex,
      value.endRowIndex,
      moved.sheetId,
      allowlist,
      phase
    )
    delete result.startRowIndex
    delete result.endRowIndex
  }
  if (
    value.dimension === "ROWS" &&
    typeof value.startIndex === "number" &&
    typeof value.endIndex === "number" &&
    rangesIntersect(
      value.startIndex,
      value.endIndex,
      moved.startRowIndex,
      moved.endRowIndex
    )
  ) {
    result.__canonicalRowIndexes = canonicalRowSet(
      value.startIndex,
      value.endIndex,
      moved.sheetId,
      allowlist,
      phase
    )
    delete result.startIndex
    delete result.endIndex
  }
  return result
}

function canonicalRowSet(
  startRowIndex: number,
  endRowIndex: number,
  sheetIdValue: number,
  allowlist: NormalizationAllowlist,
  phase: "before" | "after"
): number[] {
  return Array.from(
    { length: endRowIndex - startRowIndex },
    (_, offset) =>
      canonicalMovedRowIndex(
        startRowIndex + offset,
        sheetIdValue,
        allowlist,
        phase
      )
  ).sort((left, right) => left - right)
}

function rangesIntersect(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number
): boolean {
  return firstStart < secondEnd && secondStart < firstEnd
}

function maskPivotSourceEndRow(cell: UnknownRecord): void {
  const pivot = recordOrNull(cell.pivotTable)
  const source = recordOrNull(pivot?.source)
  if (!pivot || !source) return
  source.endRowIndex = "__approved_open_end_row__"
  pivot.source = source
  cell.pivotTable = pivot
}

function exactSheet(
  snapshot: SheetsApiSpreadsheetSnapshot,
  id: number,
  expectedTitle: string,
  errors: string[]
): SheetsApiSheetSnapshot | undefined {
  const sheet = findSheetById(snapshot, id)
  if (!sheet) {
    errors.push(`sheet ${id} (${expectedTitle}) missing`)
    return undefined
  }
  const actualTitle = record(sheet.properties).title
  if (actualTitle !== expectedTitle) errors.push(`sheet ${id} title expected ${expectedTitle}, got ${String(actualTitle)}`)
  return sheet
}

function assertSheetAbsent(
  snapshot: SheetsApiSpreadsheetSnapshot,
  id: number,
  title: string,
  errors: string[]
): void {
  if (findSheetById(snapshot, id)) errors.push(`sheet id ${id} must be absent`)
  if (snapshotSheets(snapshot).some((sheet) => record(sheet.properties).title === title)) {
    errors.push(`sheet title ${title} must be absent`)
  }
}

function findSheetById(
  snapshot: SheetsApiSpreadsheetSnapshot,
  id: number
): SheetsApiSheetSnapshot | undefined {
  return snapshotSheets(snapshot).find((sheet) => sheetId(sheet) === id)
}

function snapshotSheets(snapshot: SheetsApiSpreadsheetSnapshot): readonly SheetsApiSheetSnapshot[] {
  return snapshot.sheets ?? []
}

function sheetId(sheet: SheetsApiSheetSnapshot): number {
  return numberField(record(sheet.properties), "sheetId")
}

function sheetIndex(sheet: SheetsApiSheetSnapshot | undefined): number {
  if (!sheet) return Number.MAX_SAFE_INTEGER
  const index = record(sheet.properties).index
  return typeof index === "number" ? index : Number.MAX_SAFE_INTEGER
}

function compareSheetIndex(sheet: SheetsApiSheetSnapshot, expected: UnknownRecord, errors: string[]): void {
  if (typeof expected.sheetIndex === "number" && sheetIndex(sheet) !== expected.sheetIndex) {
    errors.push(`sheet ${sheetId(sheet)} index expected ${expected.sheetIndex}, got ${sheetIndex(sheet)}`)
  }
  if (typeof expected.insertedAtIndex === "number" && sheetIndex(sheet) !== expected.insertedAtIndex) {
    errors.push(`sheet ${sheetId(sheet)} index expected ${expected.insertedAtIndex}, got ${sheetIndex(sheet)}`)
  }
}

function compareSheetGrid(sheet: SheetsApiSheetSnapshot, expected: UnknownRecord, errors: string[]): void {
  const grid = record(record(sheet.properties).gridProperties)
  if (typeof expected.gridRowCount === "number" && grid.rowCount !== expected.gridRowCount) {
    errors.push(`sheet ${sheetId(sheet)} row count expected ${expected.gridRowCount}, got ${String(grid.rowCount)}`)
  }
  if (typeof expected.gridColumnCount === "number" && grid.columnCount !== expected.gridColumnCount) {
    errors.push(`sheet ${sheetId(sheet)} column count expected ${expected.gridColumnCount}, got ${String(grid.columnCount)}`)
  }
}

function basicFilterRange(sheet: SheetsApiSheetSnapshot): UnknownRecord {
  const range = canonicalRange(record(record(sheet.basicFilter).range))
  const rowCount = record(record(sheet.properties).gridProperties).rowCount
  // Sheets materializes an omitted filter end row as the current grid row
  // count. Treat that grid-bound representation as the same approved
  // open-through-the-sheet state; fixed historical filters end earlier.
  if (typeof rowCount === "number" && range.endRowIndex === rowCount) {
    delete range.endRowIndex
  }
  return range
}

function pivotSourceAt(
  snapshot: SheetsApiSpreadsheetSnapshot,
  sheet: SheetsApiSheetSnapshot,
  row: number,
  column: number
): UnknownRecord {
  const range = canonicalRange(record(record(cellAt(sheet, row, column).pivotTable).source))
  const sourceSheet = findSheetById(snapshot, numberField(range, "sheetId"))
  const sourceRowCount = sourceSheet
    ? record(record(sourceSheet.properties).gridProperties).rowCount
    : undefined
  // Pivot sources use the same protobuf representation as filters: an open
  // end row is commonly read back as the current source grid row count.
  if (typeof sourceRowCount === "number" && range.endRowIndex === sourceRowCount) {
    delete range.endRowIndex
  }
  return range
}

function compareRange(actual: unknown, expected: UnknownRecord, label: string, errors: string[]): void {
  const actualRange = canonicalRange(record(actual))
  const expectedRange = canonicalRange(expected)
  if (stableSerialize(actualRange) !== stableSerialize(expectedRange)) {
    errors.push(`${label} expected ${stableSerialize(expectedRange)}, got ${stableSerialize(actualRange)}`)
  }
}

function canonicalRange(range: UnknownRecord): UnknownRecord {
  // Sheets API v4 omits protobuf scalar defaults in JSON. A missing sheetId
  // therefore represents sheet 0, not an unbound range.
  const result: UnknownRecord = {
    sheetId: typeof range.sheetId === "number" ? range.sheetId : 0,
  }
  result.startRowIndex = typeof range.startRowIndex === "number" ? range.startRowIndex : 0
  if (typeof range.endRowIndex === "number") result.endRowIndex = range.endRowIndex
  result.startColumnIndex = typeof range.startColumnIndex === "number" ? range.startColumnIndex : 0
  if (typeof range.endColumnIndex === "number") result.endColumnIndex = range.endColumnIndex
  return result
}

function cellAt(sheet: SheetsApiSheetSnapshot, row: number, column: number): UnknownRecord {
  const merged: UnknownRecord = {}
  for (const gridValue of sheet.data ?? []) {
    const grid = record(gridValue)
    const startRow = typeof grid.startRow === "number" ? grid.startRow : 0
    const startColumn = typeof grid.startColumn === "number" ? grid.startColumn : 0
    const rowData = Array.isArray(grid.rowData) ? grid.rowData : []
    const rowOffset = row - startRow
    if (rowOffset < 0 || rowOffset >= rowData.length) continue
    const values = arrayField(record(rowData[rowOffset]), "values")
    const columnOffset = column - startColumn
    if (columnOffset < 0 || columnOffset >= values.length) continue
    Object.assign(merged, record(values[columnOffset]))
  }
  return merged
}

function cellString(sheet: SheetsApiSheetSnapshot, row: number, column: number): string | undefined {
  const cell = cellAt(sheet, row, column)
  const userEntered = recordOrNull(cell.userEnteredValue)
  if (typeof userEntered?.stringValue === "string") return userEntered.stringValue
  const effective = recordOrNull(cell.effectiveValue)
  if (typeof effective?.stringValue === "string") return effective.stringValue
  if (typeof cell.formattedValue === "string") return cell.formattedValue
  return undefined
}

function formulaAt(sheet: SheetsApiSheetSnapshot, row: number, column: number): string | undefined {
  const entered = recordOrNull(cellAt(sheet, row, column).userEnteredValue)
  return typeof entered?.formulaValue === "string" ? entered.formulaValue : undefined
}

function expectCellString(
  sheet: SheetsApiSheetSnapshot,
  row: number,
  column: number,
  expected: string,
  label: string,
  errors: string[]
): void {
  const actual = cellString(sheet, row, column)
  if (actual !== expected) errors.push(`${label} expected ${expected}, got ${String(actual)}`)
}

function assertRangeInsideGrid(
  sheet: SheetsApiSheetSnapshot,
  range: UnknownRecord,
  label: string,
  errors: string[]
): void {
  const grid = record(record(sheet.properties).gridProperties)
  if (
    typeof range.endRowIndex !== "number" ||
    typeof range.endColumnIndex !== "number" ||
    typeof grid.rowCount !== "number" ||
    typeof grid.columnCount !== "number" ||
    range.endRowIndex > grid.rowCount ||
    range.endColumnIndex > grid.columnCount
  ) {
    errors.push(`${label} is outside the audited sheet grid`)
  }
}

function assertRangeHasNoEnteredValues(
  sheet: SheetsApiSheetSnapshot,
  range: UnknownRecord,
  label: string,
  errors: string[]
): void {
  forEachCellInRange(sheet, range, (cell) => {
    if (isRecord(cell.userEnteredValue) && Object.keys(cell.userEnteredValue).length > 0) {
      errors.push(`${label} contains an entered value`)
    }
  })
}

function assertRangeBlankAndUnformatted(
  sheet: SheetsApiSheetSnapshot,
  range: UnknownRecord,
  label: string,
  errors: string[]
): void {
  forEachCellInRange(sheet, range, (cell) => {
    for (const key of ["userEnteredValue", "userEnteredFormat", "dataValidation", "note", "pivotTable"] as const) {
      if (cell[key] !== undefined && stableSerialize(cell[key]) !== "{}") errors.push(`${label} contains ${key}`)
    }
  })
}

function assertRangeBlankExceptUserEnteredFormat(
  sheet: SheetsApiSheetSnapshot,
  range: UnknownRecord,
  label: string,
  errors: string[]
): void {
  forEachCellInRange(sheet, range, (cell) => {
    for (const key of [
      "userEnteredValue",
      "dataValidation",
      "note",
      "pivotTable",
      "textFormatRuns",
    ] as const) {
      if (cell[key] !== undefined && stableSerialize(cell[key]) !== "{}") {
        errors.push(`${label} contains ${key}`)
      }
    }
  })
}

function compareFormatMatrices(
  sheet: SheetsApiSheetSnapshot,
  source: UnknownRecord,
  destination: UnknownRecord,
  label: string,
  errors: string[]
): void {
  const sourceRows = numberField(source, "endRowIndex") - numberField(source, "startRowIndex")
  const destinationRows = numberField(destination, "endRowIndex") - numberField(destination, "startRowIndex")
  const sourceColumns = numberField(source, "endColumnIndex") - numberField(source, "startColumnIndex")
  const destinationColumns = numberField(destination, "endColumnIndex") - numberField(destination, "startColumnIndex")
  if (sourceRows !== destinationRows || sourceColumns !== destinationColumns) {
    errors.push(`${label} dimensions do not match`)
    return
  }
  for (let row = 0; row < sourceRows; row += 1) {
    for (let column = 0; column < sourceColumns; column += 1) {
      const sourceFormat = cellAt(
        sheet,
        numberField(source, "startRowIndex") + row,
        numberField(source, "startColumnIndex") + column
      ).userEnteredFormat
      const destinationFormat = cellAt(
        sheet,
        numberField(destination, "startRowIndex") + row,
        numberField(destination, "startColumnIndex") + column
      ).userEnteredFormat
      if (stableSerialize(sourceFormat) !== stableSerialize(destinationFormat)) {
        errors.push(`${label} format matrices do not match`)
        return
      }
    }
  }
}

function forEachCellInRange(
  sheet: SheetsApiSheetSnapshot,
  range: UnknownRecord,
  visit: (cell: UnknownRecord) => void
): void {
  const startRow = typeof range.startRowIndex === "number" ? range.startRowIndex : 0
  const endRow = typeof range.endRowIndex === "number" ? range.endRowIndex : startRow
  const startColumn = typeof range.startColumnIndex === "number" ? range.startColumnIndex : 0
  const endColumn = typeof range.endColumnIndex === "number" ? range.endColumnIndex : startColumn
  for (let row = startRow; row < endRow; row += 1) {
    for (let column = startColumn; column < endColumn; column += 1) visit(cellAt(sheet, row, column))
  }
}

function coordinateInRange(row: number, column: number, range: UnknownRecord): boolean {
  const startRow = typeof range.startRowIndex === "number" ? range.startRowIndex : 0
  const endRow = typeof range.endRowIndex === "number" ? range.endRowIndex : Number.MAX_SAFE_INTEGER
  const startColumn = typeof range.startColumnIndex === "number" ? range.startColumnIndex : 0
  const endColumn = typeof range.endColumnIndex === "number" ? range.endColumnIndex : Number.MAX_SAFE_INTEGER
  return row >= startRow && row < endRow && column >= startColumn && column < endColumn
}

function sheetMerges(sheet: SheetsApiSheetSnapshot): readonly UnknownRecord[] {
  return (sheet.merges ?? []).map(record)
}

function columnIndex(a1Column: string): number {
  let result = 0
  for (const character of a1Column.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64
  return result - 1
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function recordOrNull(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null
}

function arrayField(value: unknown, key: string): readonly unknown[] {
  const field = record(value)[key]
  return Array.isArray(field) ? field : []
}

function stringField(value: unknown, key: string): string {
  const field = record(value)[key]
  return typeof field === "string" ? field : ""
}

function numberField(value: unknown, key: string): number {
  const field = record(value)[key]
  return typeof field === "number" ? field : Number.NaN
}

function cloneRecord(value: unknown): UnknownRecord {
  if (!isRecord(value)) return {}
  return JSON.parse(JSON.stringify(value)) as UnknownRecord
}

function cloneArray(value: readonly unknown[]): unknown[] {
  return JSON.parse(JSON.stringify(value)) as unknown[]
}
