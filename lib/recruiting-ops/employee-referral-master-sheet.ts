import { google } from "googleapis"

import { readEnv } from "../env"
import {
  EMPLOYEE_REFERRAL_REPORT_TIME_ZONE,
  type EmployeeReferralReport,
  type EmployeeReferralReportRow,
} from "./employee-referral-report"

const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,}$/
const COLUMN_COUNT = 28
const MANUAL_COLUMN_INDEXES = [3, 4, 5, 6] as const

export const EMPLOYEE_REFERRAL_MASTER_SHEET_HEADERS = [
  "Preliminary Eligibility",
  "Eligibility Reason",
  "Estimated 90-Day Date",
  "Final Eligibility Override",
  "Decision Notes",
  "Payout Status",
  "Paid Date",
  "Record Type",
  "Candidate Name",
  "Offer Accepted Date",
  "Planned Start Date",
  "Application Status",
  "Offer Status",
  "Referring Employee",
  "Hiring Manager",
  "Offer Job Title",
  "Function",
  "Current Application Job",
  "Policy Function Band",
  "Hiring Location",
  "Country",
  "Reference Bonus Amount",
  "Currency",
  "Bonus Resolution Owner",
  "Mapping Review",
  "Greenhouse Application ID",
  "Greenhouse Offer ID / Version",
  "Greenhouse Record Key",
] as const

export interface EmployeeReferralMasterSheetClient {
  listSheets(spreadsheetId: string): Promise<readonly { sheetId: number; title: string }[]>
  addSheet(spreadsheetId: string, title: string): Promise<number>
  getValues(spreadsheetId: string, range: string): Promise<readonly (readonly unknown[])[]>
  updateValues(
    spreadsheetId: string,
    range: string,
    values: readonly (readonly unknown[])[]
  ): Promise<void>
  formatNewSheet(spreadsheetId: string, sheetId: number): Promise<void>
}

export interface EmployeeReferralMasterSheetWriteResult {
  spreadsheetId: string
  spreadsheetUrl: string
  updatedTabs: string[]
  currentCohortRowCount: number
}

export function readEmployeeReferralMasterSpreadsheetId(
  env: (name: string) => string | undefined = readEnv,
  options: { required?: boolean } = {}
): string | null {
  const value = env("EMPLOYEE_REFERRAL_MASTER_SPREADSHEET_ID")?.trim() ?? ""
  if (!value && options.required === false) return null
  if (!SPREADSHEET_ID.test(value)) {
    throw new Error("Employee referral master spreadsheet id is missing or invalid")
  }
  return value
}

export async function writeEmployeeReferralMasterSheet(
  report: EmployeeReferralReport,
  options: {
    env?: (name: string) => string | undefined
    client?: EmployeeReferralMasterSheetClient
  } = {}
): Promise<EmployeeReferralMasterSheetWriteResult> {
  const spreadsheetId = readEmployeeReferralMasterSpreadsheetId(
    options.env ?? readEnv
  )!
  const client = options.client ?? createEmployeeReferralMasterSheetClient()
  const groupedRows = groupCurrentRowsByOfferMonth(report.rows)
  const rowsByTab = new Map(
    [...groupedRows].sort(([left], [right]) => left.localeCompare(right))
  )
  const sheets = new Map(
    (await client.listSheets(spreadsheetId)).map((sheet) => [
      sheet.title,
      sheet.sheetId,
    ])
  )

  for (const [tab, reportRows] of rowsByTab) {
    let sheetId = sheets.get(tab)
    let created = false
    if (sheetId === undefined) {
      sheetId = await client.addSheet(spreadsheetId, tab)
      sheets.set(tab, sheetId)
      created = true
    }
    const range = `${quoteSheet(tab)}!A:AB`
    const existing = await client.getValues(spreadsheetId, range)
    const values = mergeEmployeeReferralMasterSheetRows(existing, reportRows)
    await client.updateValues(
      spreadsheetId,
      `${quoteSheet(tab)}!A1:AB${values.length}`,
      values
    )
    if (created) await client.formatNewSheet(spreadsheetId, sheetId)
  }

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    updatedTabs: [...rowsByTab.keys()],
    currentCohortRowCount: [...rowsByTab.values()].reduce(
      (total, rows) => total + rows.length,
      0
    ),
  }
}

export function mergeEmployeeReferralMasterSheetRows(
  existingValues: readonly (readonly unknown[])[],
  reportRows: readonly EmployeeReferralReportRow[]
): (string | number)[][] {
  if (
    existingValues.length > 0 &&
    existingValues[0].some((value) => value !== null && value !== undefined && value !== "")
  ) {
    const existingHeader = normalizeRow(existingValues[0])
    if (
      existingHeader.length !== COLUMN_COUNT ||
      existingHeader.some(
        (value, index) => value !== EMPLOYEE_REFERRAL_MASTER_SHEET_HEADERS[index]
      )
    ) {
      throw new Error("Employee referral master sheet header does not match")
    }
  }

  const rowsByKey = new Map<string, (string | number)[]>()
  for (const raw of existingValues.slice(1)) {
    const row = normalizeRow(raw)
    const key = String(row[COLUMN_COUNT - 1] ?? "").trim()
    if (!key) continue
    if (rowsByKey.has(key)) {
      throw new Error("Employee referral master sheet contains a duplicate record key")
    }
    rowsByKey.set(key, row)
  }

  for (const reportRow of reportRows) {
    const next = masterSheetRow(reportRow)
    const key = String(next[COLUMN_COUNT - 1])
    const existing = rowsByKey.get(key)
    if (existing) {
      for (const index of MANUAL_COLUMN_INDEXES) next[index] = existing[index] ?? ""
    }
    rowsByKey.set(key, next)
  }

  const rows = [...rowsByKey.values()].sort(
    (left, right) =>
      String(left[9]).localeCompare(String(right[9])) ||
      String(left[8]).localeCompare(String(right[8]), "en", {
        sensitivity: "base",
      })
  )
  return [[...EMPLOYEE_REFERRAL_MASTER_SHEET_HEADERS], ...rows]
}

export function employeeReferralMasterSheetRecordKey(
  row: Pick<
    EmployeeReferralReportRow,
    "greenhouseApplicationId" | "greenhouseOfferIdAndVersion"
  >
): string {
  const offerId = row.greenhouseOfferIdAndVersion.replace(/\s+v[^ ]+$/i, "")
  return `${row.greenhouseApplicationId}:${offerId}`
}

function groupCurrentRowsByOfferMonth(
  rows: readonly EmployeeReferralReportRow[]
): Map<string, EmployeeReferralReportRow[]> {
  const result = new Map<string, EmployeeReferralReportRow[]>()
  for (const row of rows) {
    if (row.recordType !== "CURRENT_ACCEPTED_COHORT" || !row.offerResolvedAt) continue
    const tab = offerMonth(row.offerResolvedAt)
    const grouped = result.get(tab) ?? []
    grouped.push(row)
    result.set(tab, grouped)
  }
  return new Map([...result].sort(([left], [right]) => left.localeCompare(right)))
}

function masterSheetRow(row: EmployeeReferralReportRow): (string | number)[] {
  return [
    row.preliminaryEligibility,
    row.eligibilityReason,
    row.estimatedNinetyDayDate ?? "",
    "",
    "",
    "",
    "",
    row.recordType,
    row.candidateName ?? "",
    localDate(row.offerResolvedAt),
    row.greenhousePlannedStartDate ?? "",
    row.currentApplicationStatus ?? "",
    row.currentOfferStatus ?? "",
    row.referringEmployeeName ?? "",
    row.hiringManagerNames.join(" | "),
    row.offerJobTitle ?? "",
    row.offerJobFunction ?? "",
    row.currentApplicationJob ?? "",
    row.policyFunctionBand ?? "",
    row.greenhouseHiringLocation ?? "",
    row.policyCountry ?? "",
    row.policyReferenceBonusAmount ?? "",
    row.policyReferenceCurrency ?? "",
    row.bonusResolutionStatus,
    row.mappingReviewStatusReason,
    row.greenhouseApplicationId,
    row.greenhouseOfferIdAndVersion,
    employeeReferralMasterSheetRecordKey(row),
  ]
}

function offerMonth(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error("Offer accepted date is invalid")
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EMPLOYEE_REFERRAL_REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}`
}

function localDate(value: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EMPLOYEE_REFERRAL_REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function normalizeRow(values: readonly unknown[]): (string | number)[] {
  return Array.from({ length: COLUMN_COUNT }, (_, index) => {
    const value = values[index]
    return typeof value === "number" ? value : value == null ? "" : String(value)
  })
}

function quoteSheet(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function createEmployeeReferralMasterSheetClient(): EmployeeReferralMasterSheetClient {
  const auth = new google.auth.GoogleAuth({ scopes: [GOOGLE_SHEETS_SCOPE] })
  const sheets = google.sheets({ version: "v4", auth })
  return {
    async listSheets(spreadsheetId) {
      const response = await sheets.spreadsheets.get({
        spreadsheetId,
        includeGridData: false,
        fields: "sheets(properties(sheetId,title))",
      })
      return (response.data.sheets ?? []).flatMap((sheet) => {
        const sheetId = sheet.properties?.sheetId
        const title = sheet.properties?.title
        return typeof sheetId === "number" && title ? [{ sheetId, title }] : []
      })
    },
    async addSheet(spreadsheetId, title) {
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      })
      const sheetId = response.data.replies?.[0]?.addSheet?.properties?.sheetId
      if (typeof sheetId !== "number") {
        throw new Error("Google Sheets did not return the new referral tab id")
      }
      return sheetId
    },
    async getValues(spreadsheetId, range) {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range })
      return response.data.values ?? []
    },
    async updateValues(spreadsheetId, range, values) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: { values: values.map((row) => [...row]) },
      })
    },
    async formatNewSheet(spreadsheetId, sheetId) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                fields: "gridProperties.frozenRowCount",
              },
            },
            {
              repeatCell: {
                range: {
                  sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: COLUMN_COUNT,
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: {
                      red: 0.078,
                      green: 0.42,
                      blue: 0.38,
                    },
                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                    wrapStrategy: "WRAP",
                  },
                },
                fields:
                  "userEnteredFormat(backgroundColor,textFormat,wrapStrategy)",
              },
            },
            {
              setBasicFilter: {
                filter: {
                  range: {
                    sheetId,
                    startRowIndex: 0,
                    startColumnIndex: 0,
                    endColumnIndex: COLUMN_COUNT,
                  },
                },
              },
            },
          ],
        },
      })
    },
  }
}
