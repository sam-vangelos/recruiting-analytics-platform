import { describe, expect, test } from "vitest"

import type { GoogleSpreadsheet } from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { getStagingArtifact } from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import {
  projectStagingStructuralNormalizationState,
  verifyStagingStructuralNormalizationAfter,
  type SheetsApiSpreadsheetSnapshot,
} from "../lib/recruiting-ops/delivery/staging-structural-normalization-observer"
import { buildWeeklyRecruitmentRowLifecycle } from "../lib/recruiting-ops/delivery/weekly-recruitment-row-lifecycle"
import { weeklyRecruitmentCycle } from "../lib/recruiting-ops/delivery/weekly-recruitment-rollover"

const REPORTING_WEEK = "2026-07-10"
const cycle = weeklyRecruitmentCycle(REPORTING_WEEK)
const spreadsheetId = getStagingArtifact("weekly_recruitment").artifactId
type UnknownRecord = Record<string, unknown>

describe("Weekly Recruitment row lifecycle", () => {
  test("moves whole rows, restores the legacy form, and proves only approved structure changed", () => {
    const before = fixtureSpreadsheet()
    const build = buildWeeklyRecruitmentRowLifecycle({
      spreadsheet: before,
      reportingWeekFriday: REPORTING_WEEK,
      dataProvenance: "fixture",
      maximumRows: 20,
    })
    expect(build.status).toBe("planned")
    if (build.status !== "planned") throw new Error("expected a planned lifecycle")
    expect(build.summary).toMatchObject({
      dataRowCount: 4,
      openRowCount: 2,
      nonOpenRowCount: 2,
      movedRowCount: 3,
      formatNormalizedRowCount: 1,
      copyOnly: false,
      canonicalWriteAuthorized: true,
    })
    for (const request of build.spec.forwardRequests) {
      const update = recordOrNull(request.updateCells)
      if (!update) continue
      expect(update.fields).toBe("userEnteredFormat,dataValidation")
      const updateRows = arrayField(update, "rows")
      for (const form of arrayField(record(updateRows[0]), "values").map(record)) {
        expect(form.userEnteredValue).toBeUndefined()
      }
    }

    const after = applyRequests(before, build.spec.forwardRequests)
    expect(bodyReqIds(after)).toEqual(["100", "400", null, null, "200", "300"])
    expect(cell(after, 2, 3).userEnteredValue).toEqual({ stringValue: "manual-400" })
    expect(cell(after, 2, 9).dataValidation).toBeDefined()
    expect(
      record(record(record(cell(after, 2, 0).userEnteredFormat).textFormat).link).uri
    ).toBe("https://example.test/jobs/400")

    expect(
      projectStagingStructuralNormalizationState(
        before as SheetsApiSpreadsheetSnapshot,
        build.spec
      )
    ).toEqual(build.spec.expectedBefore)
    expect(
      projectStagingStructuralNormalizationState(
        after as SheetsApiSpreadsheetSnapshot,
        build.spec
      )
    ).toEqual(build.spec.expectedAfter)
    expect(
      verifyStagingStructuralNormalizationAfter({
        spec: build.spec,
        beforeSnapshot: before as SheetsApiSpreadsheetSnapshot,
        afterSnapshot: after as SheetsApiSpreadsheetSnapshot,
      }).nonApprovedStructureUnchanged
    ).toBe(true)

    expect(
      buildWeeklyRecruitmentRowLifecycle({
        spreadsheet: after,
        reportingWeekFriday: REPORTING_WEEK,
        dataProvenance: "fixture",
        maximumRows: 20,
      }).status
    ).toBe("already_normalized")
  })
})

function fixtureSpreadsheet(): GoogleSpreadsheet {
  return {
    spreadsheetId,
    properties: { title: "Weekly Recruitment fixture", locale: "en_US", timeZone: "Etc/UTC" },
    sheets: [
      {
        properties: {
          sheetId: cycle.targetSheetId,
          title: cycle.targetSheetTitle,
          index: 0,
          sheetType: "GRID",
          gridProperties: { rowCount: 20, columnCount: 26 },
        },
        basicFilter: {
          range: {
            sheetId: cycle.targetSheetId,
            startRowIndex: 0,
            endRowIndex: 20,
            startColumnIndex: 0,
            endColumnIndex: 26,
          },
        },
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowData: [
              { values: rowCells(["Job", "Status", "Req ID"]) },
              { values: dataRow("100", "open", "manual-100", true) },
              { values: dataRow("200", "closed", "manual-200", true) },
              { values: rowCells([]) },
              { values: rowCells(["Closed Jobs"]) },
              { values: dataRow("300", "closed", "manual-300", true) },
              { values: dataRow("400", "open", "manual-400", false) },
            ],
            rowMetadata: Array.from({ length: 7 }, (_, index) => ({ pixelSize: 20 + index })),
          },
        ],
      },
    ],
  }
}

function dataRow(
  reqId: string,
  status: string,
  manualValue: string,
  legacyForm: boolean
): Record<string, unknown>[] {
  const url = `https://example.test/jobs/${reqId}`
  const values: unknown[] = Array(26).fill(null)
  values[0] = `Job ${reqId}`
  values[1] = status
  values[2] = reqId
  values[3] = manualValue
  values[24] = url
  return values.map((value, column) => ({
    ...(value === null ? {} : { userEnteredValue: { stringValue: value } }),
    userEnteredFormat: legacyForm
      ? legacyFormat(column === 0 || column === 24 ? url : undefined)
      : { textFormat: { fontFamily: "Arial" } },
    ...(
      legacyForm && (column === 9 || column === 10)
        ? { dataValidation: { condition: { type: "ONE_OF_LIST", values: [{ userEnteredValue: "Yes" }] } } }
        : {}
    ),
  }))
}

function rowCells(values: readonly unknown[]): Record<string, unknown>[] {
  return Array.from({ length: 26 }, (_, column) => ({
    ...(values[column] === undefined
      ? {}
      : { userEnteredValue: { stringValue: values[column] } }),
    userEnteredFormat: legacyFormat(),
  }))
}

function legacyFormat(link?: string): Record<string, unknown> {
  return {
    textFormat: {
      fontFamily: "Poppins",
      ...(link ? { link: { uri: link } } : {}),
    },
    borders: { bottom: { style: "SOLID" } },
  }
}

function applyRequests(
  spreadsheet: GoogleSpreadsheet,
  requests: readonly Readonly<Record<string, unknown>>[]
): GoogleSpreadsheet {
  const after = structuredClone(spreadsheet)
  const sheet = after.sheets?.[0]
  const grid = sheet?.data?.[0]
  const rows = grid?.rowData
  const rowMetadata = grid?.rowMetadata
  if (!rows || !rowMetadata) throw new Error("fixture rows missing")
  for (const request of requests) {
    const move = recordOrNull(request.moveDimension)
    if (move) {
      const source = record(move.source)
      const currentIndex = numberField(source, "startIndex")
      const destinationIndex = numberField(move, "destinationIndex")
      const finalIndex = destinationIndex > currentIndex ? destinationIndex - 1 : destinationIndex
      const [movedRow] = rows.splice(currentIndex, 1)
      rows.splice(finalIndex, 0, movedRow)
      const [movedMetadata] = rowMetadata.splice(currentIndex, 1)
      rowMetadata.splice(finalIndex, 0, movedMetadata)
      continue
    }
    const update = recordOrNull(request.updateCells)
    if (!update) continue
    const rowIndex = numberField(record(update.range), "startRowIndex")
    const updateRows = arrayField(update, "rows")
    const forms = arrayField(record(updateRows[0]), "values").map(record)
    const targetCells = rows[rowIndex].values ?? []
    forms.forEach((form, column) => {
      const target = targetCells[column] ?? {}
      delete target.userEnteredFormat
      delete target.dataValidation
      Object.assign(target, structuredClone(form))
      targetCells[column] = target
    })
    rows[rowIndex].values = targetCells
  }
  return after
}

function bodyReqIds(spreadsheet: GoogleSpreadsheet): Array<string | null> {
  return Array.from({ length: 6 }, (_, offset) => {
    const value = cell(spreadsheet, offset + 1, 2).userEnteredValue as
      | { stringValue?: string }
      | undefined
    return value?.stringValue ?? null
  })
}

function cell(
  spreadsheet: GoogleSpreadsheet,
  rowIndex: number,
  columnIndex: number
): UnknownRecord {
  return record(
    spreadsheet.sheets?.[0].data?.[0].rowData?.[rowIndex].values?.[columnIndex]
  )
}

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {}
}

function recordOrNull(value: unknown): UnknownRecord | null {
  const result = record(value)
  return Object.keys(result).length > 0 ? result : null
}

function arrayField(value: unknown, key: string): readonly unknown[] {
  const field = record(value)[key]
  return Array.isArray(field) ? field : []
}

function numberField(value: unknown, key: string): number {
  const field = record(value)[key]
  if (typeof field !== "number") throw new Error(`fixture field ${key} is not numeric`)
  return field
}
