import { createPayloadFingerprint, type PiiFingerprintProvenance } from "../checksums"
import type { GoogleSheet, GoogleSpreadsheet } from "./google-workspace-staging-client"
import { getStagingArtifact } from "./staging-artifact-registry"
import type {
  GoogleSheetsRequestData,
  StagingStructuralNormalizationSpec,
} from "./staging-structural-normalization"
import { weeklyRecruitmentCycle } from "./weekly-recruitment-rollover"
import {
  WEEKLY_RECRUITMENT_ROW_WIDTH,
  weeklyRecruitmentPrimitiveText,
  weeklyRecruitmentRowFormFingerprint,
  weeklyRecruitmentRowForms,
  weeklyRecruitmentRowValueFingerprint,
  weeklyRecruitmentRowValues,
  type WeeklyRecruitmentCellForm,
} from "./weekly-recruitment-row-lifecycle-shared"

const FIRST_BODY_ROW_INDEX = 1
const DIVIDER_LABEL = "Closed Jobs"
const STATUS_COLUMN_INDEX = 1
const REQ_ID_COLUMN_INDEX = 2
const FIRST_MANUAL_VALIDATION_COLUMN_INDEX = 9
const SECOND_MANUAL_VALIDATION_COLUMN_INDEX = 10
const JOB_URL_COLUMN_INDEX = 24
const LINKED_COLUMN_INDEXES = [0, JOB_URL_COLUMN_INDEX] as const

type RowKind = "data" | "spacer" | "divider"
type UnknownRecord = Record<string, unknown>

interface LifecycleRowMaterial {
  originalRowIndex: number
  kind: RowKind
  status: string | null
  reqId: string | null
  values: readonly unknown[]
  originalForms: readonly WeeklyRecruitmentCellForm[]
  desiredForms: readonly WeeklyRecruitmentCellForm[]
  valueFingerprint: string
  rowToken: string
}

export interface WeeklyRecruitmentLifecycleExpectedRow {
  rowToken: string
  valueFingerprint: string
  formFingerprint: string
}

export interface WeeklyRecruitmentLifecycleExpectedState {
  readonly [key: string]: unknown
  artifactKey: "weekly_recruitment"
  spreadsheetId: string
  weeklyRecruitmentRows: {
    reportingWeekFriday: string
    sheetId: number
    sheetTitle: string
    startRowIndex: number
    endRowIndex: number
    columnCount: typeof WEEKLY_RECRUITMENT_ROW_WIDTH
    dataProvenance: PiiFingerprintProvenance
    rows: readonly WeeklyRecruitmentLifecycleExpectedRow[]
    formatNormalizedRowTokens: readonly string[]
  }
}

export interface WeeklyRecruitmentRowLifecycleSummary {
  artifactKey: "weekly_recruitment"
  reportingWeekFriday: string
  sheetId: number
  sheetTitle: string
  status: "planned" | "already_normalized"
  dataRowCount: number
  openRowCount: number
  nonOpenRowCount: number
  movedRowCount: number
  formatNormalizedRowCount: number
  forwardRequestCount: number
  rollbackRequestCount: number
  observedStateFingerprint: string
  copyOnly: false
  canonicalWriteAuthorized: true
}

export type WeeklyRecruitmentRowLifecycleBuild =
  | {
      status: "already_normalized"
      summary: WeeklyRecruitmentRowLifecycleSummary
    }
  | {
      status: "planned"
      summary: WeeklyRecruitmentRowLifecycleSummary
      spec: StagingStructuralNormalizationSpec
    }

/**
 * Builds a reversible whole-row lifecycle plan for one copied weekly tab.
 * Values are represented only by HMAC fingerprints in the returned contract;
 * the only literal payloads in requests are non-PII row formatting and the
 * existing job links used by columns A and Y.
 */
export function buildWeeklyRecruitmentRowLifecycle(input: {
  spreadsheet: GoogleSpreadsheet
  reportingWeekFriday: string
  dataProvenance: PiiFingerprintProvenance
  maximumRows: number
}): WeeklyRecruitmentRowLifecycleBuild {
  if (!Number.isInteger(input.maximumRows) || input.maximumRows < 3) {
    throw new Error("Weekly Recruitment row lifecycle requires a bounded row limit.")
  }
  const target = getStagingArtifact("weekly_recruitment")
  if (target.kind !== "google_sheet" || input.spreadsheet.spreadsheetId !== target.artifactId) {
    throw new Error("Weekly Recruitment row lifecycle is not bound to the registered copy.")
  }
  const cycle = weeklyRecruitmentCycle(input.reportingWeekFriday)
  const matchingSheets = (input.spreadsheet.sheets ?? []).filter((sheet) => {
    const properties = record(sheet.properties)
    return properties.sheetId === cycle.targetSheetId && properties.title === cycle.targetSheetTitle
  })
  if (matchingSheets.length !== 1) {
    throw new Error("Weekly Recruitment row lifecycle requires the exact current copied tab.")
  }
  const sheet = matchingSheets[0]
  const lastEnteredRowIndex = lastEnteredRow(sheet, input.maximumRows)
  if (lastEnteredRowIndex < FIRST_BODY_ROW_INDEX) {
    throw new Error("Weekly Recruitment current tab has no body rows.")
  }
  if (lastEnteredRowIndex >= input.maximumRows - 1) {
    throw new Error("Weekly Recruitment row lifecycle read reached its bounded row limit.")
  }

  const rows = Array.from(
    { length: lastEnteredRowIndex - FIRST_BODY_ROW_INDEX + 1 },
    (_, offset) =>
      rowMaterial(
        sheet,
        FIRST_BODY_ROW_INDEX + offset,
        input.dataProvenance
      )
  )
  const dividerRows = rows.filter((row) => row.kind === "divider")
  if (dividerRows.length !== 1) {
    throw new Error(
      `Weekly Recruitment row lifecycle requires exactly one ${DIVIDER_LABEL} divider.`
    )
  }
  const divider = dividerRows[0]
  const spacer = rows.find(
    (row) => row.originalRowIndex === divider.originalRowIndex - 1
  )
  if (spacer?.kind !== "spacer") {
    throw new Error("Weekly Recruitment divider must have one blank spacer immediately above it.")
  }
  const unexpectedBlankRows = rows.filter(
    (row) => row.kind === "spacer" && row.originalRowIndex !== spacer.originalRowIndex
  )
  if (unexpectedBlankRows.length > 0) {
    throw new Error("Weekly Recruitment body contains an unexpected blank row.")
  }

  const dataRows = rows.filter((row) => row.kind === "data")
  const openRows = dataRows.filter((row) => row.status === "open")
  const nonOpenRows = dataRows.filter((row) => row.status !== "open")
  const template = [...openRows]
    .reverse()
    .find(
      (row) =>
        row.originalRowIndex < spacer.originalRowIndex &&
        hasLegacyTemplateForm(row.originalForms)
    )
  if (!template) {
    throw new Error("Weekly Recruitment current tab has no valid legacy open-row format template.")
  }

  const formatTargets = dataRows.filter((row) =>
    needsLegacyFormRepair(row.originalForms, template.originalForms)
  )
  const formatTargetTokens = new Set(formatTargets.map((row) => row.rowToken))
  const repairedRows = rows.map((row) =>
    formatTargetTokens.has(row.rowToken)
      ? {
          ...row,
          desiredForms: legacyFormsForRow(template.originalForms, row.values),
        }
      : row
  )
  const repairedByToken = new Map(repairedRows.map((row) => [row.rowToken, row] as const))
  const desiredRows = [
    ...openRows.map((row) => repairedByToken.get(row.rowToken)!),
    repairedByToken.get(spacer.rowToken)!,
    repairedByToken.get(divider.rowToken)!,
    ...nonOpenRows.map((row) => repairedByToken.get(row.rowToken)!),
  ]
  if (desiredRows.some((row) => !row)) {
    throw new Error("Weekly Recruitment row lifecycle could not build a complete row permutation.")
  }

  const originalTokens = repairedRows.map((row) => row.rowToken)
  const desiredTokens = desiredRows.map((row) => row.rowToken)
  const forwardMoves = rowMoveRequests(
    cycle.targetSheetId,
    FIRST_BODY_ROW_INDEX,
    originalTokens,
    desiredTokens
  )
  const rollbackMoves = rowMoveRequests(
    cycle.targetSheetId,
    FIRST_BODY_ROW_INDEX,
    desiredTokens,
    originalTokens
  )
  const movedRowCount = originalTokens.filter(
    (token, index) => desiredTokens[index] !== token
  ).length
  const normalizedTokens = [...formatTargetTokens].sort()

  const expectedBefore = lifecycleState({
    spreadsheetId: target.artifactId,
    reportingWeekFriday: input.reportingWeekFriday,
    sheetId: cycle.targetSheetId,
    sheetTitle: cycle.targetSheetTitle,
    dataProvenance: input.dataProvenance,
    rows: repairedRows,
    form: "original",
    normalizedTokens,
  })
  const expectedAfter = lifecycleState({
    spreadsheetId: target.artifactId,
    reportingWeekFriday: input.reportingWeekFriday,
    sheetId: cycle.targetSheetId,
    sheetTitle: cycle.targetSheetTitle,
    dataProvenance: input.dataProvenance,
    rows: desiredRows,
    form: "desired",
    normalizedTokens,
  })
  const forwardFormatRequests = formatTargets.map((targetRow) => {
    const finalIndex = desiredRows.findIndex((row) => row.rowToken === targetRow.rowToken)
    if (finalIndex < 0) throw new Error("Weekly Recruitment format target is absent after row ordering.")
    return updateRowFormsRequest(
      cycle.targetSheetId,
      FIRST_BODY_ROW_INDEX + finalIndex,
      repairedByToken.get(targetRow.rowToken)!.desiredForms
    )
  })
  const rollbackFormatRequests = formatTargets.map((targetRow) =>
    updateRowFormsRequest(
      cycle.targetSheetId,
      targetRow.originalRowIndex,
      targetRow.originalForms
    )
  )
  const forwardRequests = [...forwardMoves, ...forwardFormatRequests]
  const rollbackRequests = [...rollbackMoves, ...rollbackFormatRequests]
  const alreadyNormalized = forwardRequests.length === 0
  const observedStateFingerprint = createPayloadFingerprint(expectedBefore)
  const summary: WeeklyRecruitmentRowLifecycleSummary = {
    artifactKey: "weekly_recruitment",
    reportingWeekFriday: input.reportingWeekFriday,
    sheetId: cycle.targetSheetId,
    sheetTitle: cycle.targetSheetTitle,
    status: alreadyNormalized ? "already_normalized" : "planned",
    dataRowCount: dataRows.length,
    openRowCount: openRows.length,
    nonOpenRowCount: nonOpenRows.length,
    movedRowCount,
    formatNormalizedRowCount: formatTargets.length,
    forwardRequestCount: forwardRequests.length,
    rollbackRequestCount: rollbackRequests.length,
    observedStateFingerprint,
    copyOnly: false,
    canonicalWriteAuthorized: true,
  }
  if (alreadyNormalized) return { status: "already_normalized", summary }

  return {
    status: "planned",
    summary,
    spec: {
      id: `weekly_recruitment_row_lifecycle_${input.reportingWeekFriday.replaceAll("-", "")}`,
      artifactKey: "weekly_recruitment",
      spreadsheetId: target.artifactId,
      expectedBefore,
      expectedAfter,
      forwardRequests,
      rollbackRequests,
    },
  }
}

function rowMaterial(
  sheet: GoogleSheet,
  rowIndex: number,
  dataProvenance: PiiFingerprintProvenance
): LifecycleRowMaterial {
  const cells = rowCells(sheet, rowIndex)
  const values = weeklyRecruitmentRowValues(cells)
  const forms = weeklyRecruitmentRowForms(cells)
  const first = weeklyRecruitmentPrimitiveText(values[0])
  const blank = values.every(isBlankValue)
  const kind: RowKind = first === DIVIDER_LABEL ? "divider" : blank ? "spacer" : "data"
  const status = kind === "data"
    ? weeklyRecruitmentPrimitiveText(values[STATUS_COLUMN_INDEX])?.toLowerCase() ?? null
    : null
  const reqId = kind === "data"
    ? weeklyRecruitmentPrimitiveText(values[REQ_ID_COLUMN_INDEX])
    : null
  if (kind === "data" && (!status || !reqId)) {
    throw new Error(`Weekly Recruitment data row ${rowIndex + 1} lacks status or Req ID.`)
  }
  const valueFingerprint = weeklyRecruitmentRowValueFingerprint(values, dataProvenance)
  return {
    originalRowIndex: rowIndex,
    kind,
    status,
    reqId,
    values,
    originalForms: forms,
    desiredForms: forms,
    valueFingerprint,
    rowToken: createPayloadFingerprint({
      schemaVersion: 1,
      originalRowIndex: rowIndex,
      valueFingerprint,
    }),
  }
}

function lifecycleState(input: {
  spreadsheetId: string
  reportingWeekFriday: string
  sheetId: number
  sheetTitle: string
  dataProvenance: PiiFingerprintProvenance
  rows: readonly LifecycleRowMaterial[]
  form: "original" | "desired"
  normalizedTokens: readonly string[]
}): WeeklyRecruitmentLifecycleExpectedState {
  return {
    artifactKey: "weekly_recruitment",
    spreadsheetId: input.spreadsheetId,
    weeklyRecruitmentRows: {
      reportingWeekFriday: input.reportingWeekFriday,
      sheetId: input.sheetId,
      sheetTitle: input.sheetTitle,
      startRowIndex: FIRST_BODY_ROW_INDEX,
      endRowIndex: FIRST_BODY_ROW_INDEX + input.rows.length,
      columnCount: WEEKLY_RECRUITMENT_ROW_WIDTH,
      dataProvenance: input.dataProvenance,
      rows: input.rows.map((row) => ({
        rowToken: row.rowToken,
        valueFingerprint: row.valueFingerprint,
        formFingerprint: weeklyRecruitmentRowFormFingerprint(
          input.form === "original" ? row.originalForms : row.desiredForms
        ),
      })),
      formatNormalizedRowTokens: input.normalizedTokens,
    },
  }
}

function rowMoveRequests(
  sheetId: number,
  startRowIndex: number,
  fromTokens: readonly string[],
  toTokens: readonly string[]
): GoogleSheetsRequestData[] {
  if (
    fromTokens.length !== toTokens.length ||
    new Set(fromTokens).size !== fromTokens.length ||
    new Set(toTokens).size !== toTokens.length ||
    fromTokens.some((token) => !toTokens.includes(token))
  ) {
    throw new Error("Weekly Recruitment row lifecycle requires one exact row permutation.")
  }
  const current = [...fromTokens]
  const requests: GoogleSheetsRequestData[] = []
  toTokens.forEach((targetToken, targetIndex) => {
    const currentIndex = current.indexOf(targetToken)
    if (currentIndex === targetIndex) return
    if (currentIndex < 0) {
      throw new Error("Weekly Recruitment row lifecycle lost a row token while planning.")
    }
    requests.push({
      moveDimension: {
        source: {
          sheetId,
          dimension: "ROWS",
          startIndex: startRowIndex + currentIndex,
          endIndex: startRowIndex + currentIndex + 1,
        },
        destinationIndex:
          startRowIndex + (currentIndex < targetIndex ? targetIndex + 1 : targetIndex),
      },
    })
    const [moved] = current.splice(currentIndex, 1)
    current.splice(targetIndex, 0, moved)
  })
  return requests
}

function updateRowFormsRequest(
  sheetId: number,
  rowIndex: number,
  forms: readonly WeeklyRecruitmentCellForm[]
): GoogleSheetsRequestData {
  if (forms.length !== WEEKLY_RECRUITMENT_ROW_WIDTH) {
    throw new Error("Weekly Recruitment row form update must cover A:Z exactly.")
  }
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: WEEKLY_RECRUITMENT_ROW_WIDTH,
      },
      rows: [{ values: forms.map((form) => jsonClone(form)) }],
      fields: "userEnteredFormat,dataValidation",
    },
  }
}

function hasLegacyTemplateForm(forms: readonly WeeklyRecruitmentCellForm[]): boolean {
  return Boolean(
    forms[FIRST_MANUAL_VALIDATION_COLUMN_INDEX]?.dataValidation &&
      forms[SECOND_MANUAL_VALIDATION_COLUMN_INDEX]?.dataValidation &&
      fontFamily(forms[0]) &&
      borders(forms[0])
  )
}

function needsLegacyFormRepair(
  forms: readonly WeeklyRecruitmentCellForm[],
  template: readonly WeeklyRecruitmentCellForm[]
): boolean {
  const missingBothValidations =
    Boolean(template[FIRST_MANUAL_VALIDATION_COLUMN_INDEX]?.dataValidation) &&
    Boolean(template[SECOND_MANUAL_VALIDATION_COLUMN_INDEX]?.dataValidation) &&
    !forms[FIRST_MANUAL_VALIDATION_COLUMN_INDEX]?.dataValidation &&
    !forms[SECOND_MANUAL_VALIDATION_COLUMN_INDEX]?.dataValidation
  if (!missingBothValidations) return false
  return fontFamily(forms[0]) !== fontFamily(template[0]) ||
    (Boolean(borders(template[0])) && !borders(forms[0]))
}

function legacyFormsForRow(
  template: readonly WeeklyRecruitmentCellForm[],
  values: readonly unknown[]
): readonly WeeklyRecruitmentCellForm[] {
  const result = template.map((form) => jsonClone(form) as WeeklyRecruitmentCellForm)
  const jobUrl = weeklyRecruitmentPrimitiveText(values[JOB_URL_COLUMN_INDEX])
  if (!jobUrl || !isHttpUrl(jobUrl)) {
    throw new Error("Weekly Recruitment format repair requires a valid existing job URL.")
  }
  for (const columnIndex of LINKED_COLUMN_INDEXES) {
    const form = record(result[columnIndex])
    const format = record(form.userEnteredFormat)
    const textFormat = record(format.textFormat)
    textFormat.link = { uri: jobUrl }
    format.textFormat = textFormat
    form.userEnteredFormat = format
    result[columnIndex] = form
  }
  return result
}

function lastEnteredRow(
  sheet: GoogleSheet,
  maximumRows: number
): number {
  for (let rowIndex = maximumRows - 1; rowIndex >= FIRST_BODY_ROW_INDEX; rowIndex -= 1) {
    if (weeklyRecruitmentRowValues(rowCells(sheet, rowIndex)).some((value) => !isBlankValue(value))) {
      return rowIndex
    }
  }
  return -1
}

function rowCells(
  sheet: GoogleSheet,
  rowIndex: number
): readonly unknown[] {
  return Array.from({ length: WEEKLY_RECRUITMENT_ROW_WIDTH }, (_, columnIndex) => {
    const merged: UnknownRecord = {}
    for (const gridValue of sheet.data ?? []) {
      const grid = record(gridValue)
      const startRow = typeof grid.startRow === "number" ? grid.startRow : 0
      const startColumn = typeof grid.startColumn === "number" ? grid.startColumn : 0
      const rows = Array.isArray(grid.rowData) ? grid.rowData : []
      const rowOffset = rowIndex - startRow
      if (rowOffset < 0 || rowOffset >= rows.length) continue
      const values = record(rows[rowOffset]).values
      if (!Array.isArray(values)) continue
      const columnOffset = columnIndex - startColumn
      if (columnOffset < 0 || columnOffset >= values.length) continue
      Object.assign(merged, record(values[columnOffset]))
    }
    return merged
  })
}

function fontFamily(form: WeeklyRecruitmentCellForm | undefined): string | null {
  const family = record(record(form?.userEnteredFormat).textFormat).fontFamily
  return typeof family === "string" ? family : null
}

function borders(form: WeeklyRecruitmentCellForm | undefined): UnknownRecord | null {
  const value = record(form?.userEnteredFormat).borders
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function isBlankValue(value: unknown): boolean {
  return value === null || value === ""
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {}
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
