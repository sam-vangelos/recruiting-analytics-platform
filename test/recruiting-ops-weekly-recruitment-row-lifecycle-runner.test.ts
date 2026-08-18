import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("../lib/recruiting-ops/delivery/google-workspace-staging-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/recruiting-ops/delivery/google-workspace-staging-client")>()
  return {
    ...actual,
    normalizeStagingSheetStructure: vi.fn(),
    readStagingDriveMetadata: vi.fn(),
    readStagingSpreadsheet: vi.fn(),
    readStagingStructuralNormalizationSnapshot: vi.fn(),
  }
})

import {
  normalizeStagingSheetStructure,
  readStagingDriveMetadata,
  readStagingSpreadsheet,
  readStagingStructuralNormalizationSnapshot,
  type GoogleSpreadsheet,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { getStagingArtifact } from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import { runWeeklyRecruitmentRowLifecycle } from "../lib/recruiting-ops/delivery/weekly-recruitment-row-lifecycle-runner"
import { weeklyRecruitmentCycle } from "../lib/recruiting-ops/delivery/weekly-recruitment-rollover"

const REPORTING_WEEK = "2026-07-10"
const NOW = Date.parse("2026-07-14T17:00:00.000Z")
const cycle = weeklyRecruitmentCycle(REPORTING_WEEK)
const spreadsheetId = getStagingArtifact("weekly_recruitment").artifactId

describe("Weekly Recruitment row lifecycle runner", () => {
  beforeEach(() => {
    process.env.RECOPS_PII_FINGERPRINT_SALT = "weekly-row-lifecycle-test-salt"
    vi.mocked(normalizeStagingSheetStructure).mockReset()
    vi.mocked(readStagingDriveMetadata).mockReset()
    vi.mocked(readStagingSpreadsheet).mockReset()
    vi.mocked(readStagingStructuralNormalizationSnapshot).mockReset()
    const spreadsheet = fixtureSpreadsheet()
    vi.mocked(readStagingSpreadsheet).mockResolvedValue(spreadsheet)
    vi.mocked(readStagingDriveMetadata).mockResolvedValue({
      id: spreadsheetId,
      mimeType: "application/vnd.google-apps.spreadsheet",
      version: "44",
      trashed: false,
      capabilities: { canEdit: true, canModifyContent: true },
    })
    vi.mocked(readStagingStructuralNormalizationSnapshot).mockImplementation(async () => ({
      spreadsheet: spreadsheet as never,
      structure: { structureHash: "sha256:fixture-structure" } as never,
      literalRanges: [],
      literalCellUpperBound: 104,
    }))
  })

  afterEach(() => {
    delete process.env.RECOPS_PII_FINGERPRINT_SALT
  })

  test("produces a copy-only, reversible dry-run without touching the writer", async () => {
    const outcome = await runWeeklyRecruitmentRowLifecycle({
      clients: {} as never,
      reportingWeekFriday: REPORTING_WEEK,
      mode: "dry_run",
      nowMs: NOW,
    })

    expect(outcome).toMatchObject({
      mode: "dry_run",
      reportingWeekFriday: REPORTING_WEEK,
      copyOnly: false,
      canonicalWriteAuthorized: true,
      outcomes: [{
        artifactKey: "weekly_recruitment",
        status: "dry_run",
        plan: {
          status: "planned",
          movedRowCount: 3,
          formatNormalizedRowCount: 1,
          driveVersion: "44",
          structureFingerprint: "sha256:fixture-structure",
          copyOnly: false,
          canonicalWriteAuthorized: true,
        },
      }],
    })
    expect(readStagingSpreadsheet).toHaveBeenCalledWith(
      "weekly_recruitment",
      expect.anything(),
      expect.objectContaining({ includeGridData: true })
    )
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("does not expose a private discovery error in its returned outcome", async () => {
    const privateMarker = "candidate_private_marker_Jane_Doe"
    vi.mocked(readStagingSpreadsheet).mockRejectedValueOnce(
      new Error(`Discovery failed for ${privateMarker}`)
    )

    const result = await runWeeklyRecruitmentRowLifecycle({
      clients: {} as never,
      reportingWeekFriday: REPORTING_WEEK,
      mode: "dry_run",
      nowMs: NOW,
    })

    expect(result.outcomes[0].reason).toBe("Weekly Recruitment row lifecycle failed.")
    expect(JSON.stringify(result)).not.toContain(privateMarker)
  })
})

function fixtureSpreadsheet(): GoogleSpreadsheet {
  return {
    spreadsheetId,
    sheets: [{
      properties: {
        sheetId: cycle.targetSheetId,
        title: cycle.targetSheetTitle,
        index: 0,
        gridProperties: { rowCount: 1_000, columnCount: 26 },
      },
      data: [{
        startRow: 0,
        startColumn: 0,
        rowData: [
          { values: rowCells(["Job", "Status", "Req ID"], true) },
          { values: dataRow("100", "open", true) },
          { values: rowCells([], true) },
          { values: rowCells(["Closed Jobs"], true) },
          { values: dataRow("200", "open", false) },
        ],
      }],
    }],
  }
}

function dataRow(reqId: string, status: string, legacy: boolean): Record<string, unknown>[] {
  const values: unknown[] = Array(26).fill(null)
  const url = `https://example.test/jobs/${reqId}`
  values[0] = `Job ${reqId}`
  values[1] = status
  values[2] = reqId
  values[24] = url
  return values.map((value, column) => ({
    ...(value === null ? {} : { userEnteredValue: { stringValue: value } }),
    userEnteredFormat: legacy
      ? legacyFormat(column === 0 || column === 24 ? url : undefined)
      : { textFormat: { fontFamily: "Arial" } },
    ...(legacy && (column === 9 || column === 10)
      ? { dataValidation: { condition: { type: "ONE_OF_LIST" } } }
      : {}),
  }))
}

function rowCells(values: readonly unknown[], legacy: boolean): Record<string, unknown>[] {
  return Array.from({ length: 26 }, (_, column) => ({
    ...(values[column] === undefined
      ? {}
      : { userEnteredValue: { stringValue: values[column] } }),
    ...(legacy ? { userEnteredFormat: legacyFormat() } : {}),
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
