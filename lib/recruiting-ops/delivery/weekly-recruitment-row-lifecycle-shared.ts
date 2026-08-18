import {
  createPayloadFingerprint,
  createPiiFingerprint,
  type PiiFingerprintProvenance,
} from "../checksums"

export const WEEKLY_RECRUITMENT_ROW_WIDTH = 26
export const WEEKLY_RECRUITMENT_ROW_VALUE_CONTEXT =
  "weekly_recruitment_row_lifecycle_values_v1"

type UnknownRecord = Record<string, unknown>

export interface WeeklyRecruitmentCellForm {
  userEnteredFormat?: unknown
  dataValidation?: unknown
}

/**
 * Canonicalizes only the entered value. Effective/formatted values are
 * deliberately excluded so row identity does not change with recalculation or
 * locale rendering.
 */
export function weeklyRecruitmentCellValue(cellValue: unknown): unknown {
  const cell = record(cellValue)
  const entered = record(cell.userEnteredValue)
  const members = [
    typeof entered.formulaValue === "string",
    typeof entered.stringValue === "string",
    typeof entered.numberValue === "number",
    typeof entered.boolValue === "boolean",
  ].filter(Boolean).length
  if (members > 1 || entered.errorValue !== undefined) {
    throw new Error("Weekly Recruitment row contains an invalid entered-value shape.")
  }
  if (typeof entered.formulaValue === "string") {
    return { formulaValue: entered.formulaValue }
  }
  if (typeof entered.stringValue === "string") return entered.stringValue
  if (typeof entered.numberValue === "number") return entered.numberValue
  if (typeof entered.boolValue === "boolean") return entered.boolValue
  return null
}

export function weeklyRecruitmentCellForm(cellValue: unknown): WeeklyRecruitmentCellForm {
  const cell = record(cellValue)
  return {
    ...(cell.userEnteredFormat === undefined
      ? {}
      : { userEnteredFormat: jsonClone(cell.userEnteredFormat) }),
    ...(cell.dataValidation === undefined
      ? {}
      : { dataValidation: jsonClone(cell.dataValidation) }),
  }
}

export function weeklyRecruitmentRowValues(
  cells: readonly unknown[]
): readonly unknown[] {
  return Array.from(
    { length: WEEKLY_RECRUITMENT_ROW_WIDTH },
    (_, column) => weeklyRecruitmentCellValue(cells[column])
  )
}

export function weeklyRecruitmentRowForms(
  cells: readonly unknown[]
): readonly WeeklyRecruitmentCellForm[] {
  return Array.from(
    { length: WEEKLY_RECRUITMENT_ROW_WIDTH },
    (_, column) => weeklyRecruitmentCellForm(cells[column])
  )
}

export function weeklyRecruitmentRowValueFingerprint(
  values: readonly unknown[],
  dataProvenance: PiiFingerprintProvenance
): string {
  return createPiiFingerprint(values, {
    context: WEEKLY_RECRUITMENT_ROW_VALUE_CONTEXT,
    dataProvenance,
  })
}

export function weeklyRecruitmentRowFormFingerprint(
  forms: readonly WeeklyRecruitmentCellForm[]
): string {
  return createPayloadFingerprint(forms)
}

export function weeklyRecruitmentPrimitiveText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim()
    return text || null
  }
  return null
}

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {}
}

function jsonClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}
