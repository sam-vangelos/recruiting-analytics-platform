import { describe, expect, test, vi } from "vitest"

import {
  RECRUITING_OPS_GOOGLE_TARGET_SCOPES,
  RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT,
  STAGING_STRUCTURAL_LITERAL_CELL_FIELDS,
  createGoogleWorkspaceStagingClientsFromAccessToken,
  readStagingDocument,
  readStagingDriveMetadata,
  readStagingSheetNumberFormatRanges,
  readStagingSheetStructureSnapshot,
  readStagingStructuralNormalizationSnapshot,
  readStagingSpreadsheet,
  resolveGoogleWriterServiceAccount,
  waitForStagingDriveVersionAdvance,
  type GoogleWorkspaceStagingClients,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { getStagingArtifact } from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import {
  SHEET_STRUCTURE_CELL_FIELDS,
  SHEET_STRUCTURE_COLUMN_METADATA_FIELDS,
} from "../lib/recruiting-ops/delivery/sheet-structure-snapshot"
import { pipelineNormalizationSpec } from "../lib/recruiting-ops/delivery/staging-structural-normalization"
import { projectStagingStructuralNormalizationState } from "../lib/recruiting-ops/delivery/staging-structural-normalization-observer"

function clients() {
  return {
    drive: { files: { get: vi.fn(async () => ({ data: { id: "fixture" } })) } },
    sheets: { spreadsheets: { get: vi.fn(async () => ({ data: { spreadsheetId: "fixture" } })) } },
    docs: { documents: { get: vi.fn(async () => ({ data: { documentId: "fixture" } })) } },
  }
}

describe("Google Workspace staging read boundary", () => {
  test("uses Drive metadata read-only with no full Drive or permission-write scope", () => {
    const driveScopes = RECRUITING_OPS_GOOGLE_TARGET_SCOPES.filter((scope) =>
      scope.startsWith("https://www.googleapis.com/auth/drive")
    )
    expect(driveScopes).toEqual([
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ])
    expect(RECRUITING_OPS_GOOGLE_TARGET_SCOPES).not.toContain(
      "https://www.googleapis.com/auth/drive"
    )
    expect(RECRUITING_OPS_GOOGLE_TARGET_SCOPES).not.toContain(
      "https://www.googleapis.com/auth/drive.file"
    )
  })

  test("adapts only a non-empty short-lived access token", () => {
    expect(() => createGoogleWorkspaceStagingClientsFromAccessToken("  ")).toThrow("access token is required")
    const adapted = createGoogleWorkspaceStagingClientsFromAccessToken("short-lived-fixture-token")
    expect(adapted).toMatchObject({
      sheets: expect.any(Object),
      docs: expect.any(Object),
      drive: expect.any(Object),
    })
  })

  test("pins the writer identity and rejects any override", () => {
    expect(resolveGoogleWriterServiceAccount({})).toBe(RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT)
    expect(
      resolveGoogleWriterServiceAccount({
        RECOPS_GOOGLE_WRITER_SERVICE_ACCOUNT: RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT,
      })
    ).toBe(RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT)
    expect(() =>
      resolveGoogleWriterServiceAccount({
        RECOPS_GOOGLE_WRITER_SERVICE_ACCOUNT: "another-writer@example.com",
      })
    ).toThrow("not the approved")
  })

  test("reads only registry-resolved staging ids", async () => {
    const fake = clients()
    await readStagingDriveMetadata("all_hires", fake as unknown as GoogleWorkspaceStagingClients)
    await readStagingSpreadsheet("weekly_progress", fake as unknown as GoogleWorkspaceStagingClients)
    await readStagingDocument("elt_doc", fake as unknown as GoogleWorkspaceStagingClients)

    expect(fake.drive.files.get).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: getStagingArtifact("all_hires").artifactId })
    )
    expect(fake.sheets.spreadsheets.get).toHaveBeenCalledWith(
      expect.objectContaining({ spreadsheetId: getStagingArtifact("weekly_progress").artifactId })
    )
    expect(fake.docs.documents.get).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: getStagingArtifact("elt_doc").artifactId })
    )
  })

  test("waits for a later Drive publication from the registered staging copy", async () => {
    vi.useFakeTimers()
    try {
      const artifact = getStagingArtifact("weekly_progress")
      const get = vi.fn()
        .mockResolvedValueOnce({
          data: {
            id: artifact.artifactId,
            mimeType: "application/vnd.google-apps.spreadsheet",
            version: "44",
            capabilities: { canEdit: true, canModifyContent: true },
          },
        })
        .mockResolvedValueOnce({
          data: {
            id: artifact.artifactId,
            mimeType: "application/vnd.google-apps.spreadsheet",
            version: "45",
            capabilities: { canEdit: true, canModifyContent: true },
          },
        })
      const fake = {
        drive: { files: { get } },
        sheets: {},
        docs: {},
      } as unknown as GoogleWorkspaceStagingClients

      const publication = waitForStagingDriveVersionAdvance({
        artifactKey: "weekly_progress",
        clients: fake,
        minimumDriveVersionExclusive: "44",
      })
      await vi.advanceTimersByTimeAsync(100)

      await expect(publication).resolves.toBe("45")
      expect(get).toHaveBeenCalledTimes(2)
      expect(get).toHaveBeenCalledWith(expect.objectContaining({
        fileId: artifact.artifactId,
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  test("refuses cross-kind reads", async () => {
    const fake = clients() as unknown as GoogleWorkspaceStagingClients
    await expect(readStagingSpreadsheet("elt_doc", fake)).rejects.toThrow("not a registered staging spreadsheet")
    await expect(readStagingDocument("all_hires", fake)).rejects.toThrow("not a registered staging document")
  })

  test("reads only number formats for explicit registry-bound ranges", async () => {
    const artifact = getStagingArtifact("delivery_roles_rps")
    const get = vi.fn(async (request: { fields: string }) => {
      if (!request.fields) throw new Error("fixture requires an explicit field mask")
      return { data: { spreadsheetId: artifact.artifactId, sheets: [] } }
    })
    const fake = {
      drive: {},
      docs: {},
      sheets: { spreadsheets: { get } },
    } as unknown as GoogleWorkspaceStagingClients

    await readStagingSheetNumberFormatRanges(
      "delivery_roles_rps",
      ["'Raw_Daily_RPS'!K62:K90", "'Cleaned_RPS'!I62:J90"],
      fake
    )

    expect(get).toHaveBeenCalledWith(expect.objectContaining({
      spreadsheetId: artifact.artifactId,
      ranges: ["'Raw_Daily_RPS'!K62:K90", "'Cleaned_RPS'!I62:J90"],
      includeGridData: true,
    }))
    const fields = get.mock.calls[0][0].fields
    expect(fields).toContain("userEnteredFormat.numberFormat")
    expect(fields).not.toContain("userEnteredValue")
    expect(fields).not.toContain("effectiveValue")
  })

  test("streams full form through bounded numeric grid filters", async () => {
    const artifact = getStagingArtifact("weekly_recruitment")
    const sheetId = 1994864183
    const get = vi.fn(async () => ({
      data: {
        spreadsheetId: artifact.artifactId,
        properties: { title: "Copy", locale: "en_US", timeZone: "UTC" },
        sheets: [{
          properties: {
            sheetId,
            title: "A tab title ending in 2026.",
            index: 0,
            sheetType: "GRID",
            gridProperties: { rowCount: 4_001, columnCount: 50 },
          },
        }],
      },
    }))
    const getByDataFilter = vi.fn(async (request: {
      requestBody: { dataFilters: Array<{ gridRange: { startRowIndex?: number; startColumnIndex?: number } }> }
      ranges?: never
    }) => ({
      data: {
        sheets: [{
          properties: { sheetId },
          data: request.requestBody.dataFilters.map((filter) => ({
            startRow: filter.gridRange.startRowIndex ?? 0,
            startColumn: filter.gridRange.startColumnIndex ?? 0,
          })),
        }],
      },
    }))
    const fake = {
      drive: {},
      docs: {},
      sheets: { spreadsheets: { get, getByDataFilter } },
    } as unknown as GoogleWorkspaceStagingClients

    const snapshot = await readStagingSheetStructureSnapshot("weekly_recruitment", fake)

    expect(snapshot.structureHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(get).toHaveBeenCalledTimes(1)
    expect(getByDataFilter).toHaveBeenCalledTimes(4)
    for (const [request] of getByDataFilter.mock.calls) {
      expect(request).not.toHaveProperty("ranges")
      expect(request.requestBody.dataFilters).not.toHaveLength(0)
      for (const filter of request.requestBody.dataFilters) {
        expect(filter).toHaveProperty("gridRange.sheetId", sheetId)
      }
    }
  })

  test("rejects a structure response that identifies any spreadsheet other than the registered copy", async () => {
    const artifact = getStagingArtifact("weekly_recruitment")
    const getByDataFilter = vi.fn()
    const fake = {
      drive: {},
      docs: {},
      sheets: {
        spreadsheets: {
          get: vi.fn(async () => ({
            data: { spreadsheetId: `${artifact.artifactId}-unexpected` },
          })),
          getByDataFilter,
        },
      },
    } as unknown as GoogleWorkspaceStagingClients

    await expect(readStagingSheetStructureSnapshot("weekly_recruitment", fake)).rejects.toThrow(
      "not the registered staging spreadsheet"
    )
    expect(getByDataFilter).not.toHaveBeenCalled()
  })

  test("overlays only spec-sanctioned literals onto the full non-literal form", async () => {
    const spec = pipelineNormalizationSpec({
      artifactKey: "pipeline_907",
      currentCandidateTitle: "Candidate Level Data - 10 July",
    })
    const metadata = {
      spreadsheetId: spec.spreadsheetId,
      properties: { title: "Copy", locale: "en_US", timeZone: "UTC" },
      sheets: [
        {
          properties: {
            sheetId: 0,
            title: "Job level pipeline",
            index: 0,
            sheetType: "GRID",
            gridProperties: { rowCount: 807, columnCount: 35 },
          },
          basicFilter: {
            range: {
              sheetId: 0,
              startRowIndex: 622,
              endRowIndex: 626,
              startColumnIndex: 0,
              endColumnIndex: 29,
            },
          },
          // A mock that ignores field masks would leak this unless the adapter
          // explicitly strips metadata grid data before retaining the snapshot.
          data: [{ startRow: 100, rowData: [{ values: [{ userEnteredValue: { stringValue: "SECRET OUTSIDE SPEC" } }] }] }],
        },
        {
          properties: {
            sheetId: 156193952,
            title: "Candidate Level Data - 10 July",
            index: 1,
            sheetType: "GRID",
            gridProperties: { rowCount: 998, columnCount: 14 },
          },
          basicFilter: {
            range: {
              sheetId: 156193952,
              startRowIndex: 0,
              endRowIndex: 64,
              startColumnIndex: 0,
              endColumnIndex: 14,
            },
          },
        },
      ],
    }
    const get = vi.fn(async () => ({ data: metadata }))
    const getByDataFilter = vi.fn(async (request: {
      fields?: string
      requestBody: { dataFilters: Array<{ gridRange: Record<string, number> }> }
    }) => ({
      data: {
        sheets: request.fields === STAGING_STRUCTURAL_LITERAL_CELL_FIELDS
          ? [{ properties: { sheetId: 0 }, data: [] }]
          : metadata.sheets.map((sheet) => ({ properties: { sheetId: sheet.properties.sheetId }, data: [] })),
      },
    }))
    const fake = {
      drive: {},
      docs: {},
      sheets: { spreadsheets: { get, getByDataFilter } },
    } as unknown as GoogleWorkspaceStagingClients

    const observed = await readStagingStructuralNormalizationSnapshot(spec, fake)
    expect(projectStagingStructuralNormalizationState(observed.spreadsheet, spec)).toBe(spec.expectedBefore)
    expect(observed.literalCellUpperBound).toBe(29)
    expect(observed.literalRanges).toEqual([
      {
        purpose: "blank_destination",
        sheetTitle: "Job level pipeline",
        gridRange: {
          sheetId: 0,
          startRowIndex: 631,
          endRowIndex: 632,
          startColumnIndex: 0,
          endColumnIndex: 29,
        },
      },
    ])
    expect(JSON.stringify(observed.spreadsheet)).not.toContain("SECRET OUTSIDE SPEC")

    const calls = getByDataFilter.mock.calls.map(([request]) => request)
    expect(calls.some((request) => request.fields === SHEET_STRUCTURE_COLUMN_METADATA_FIELDS)).toBe(true)
    expect(calls.some((request) => request.fields === SHEET_STRUCTURE_CELL_FIELDS)).toBe(true)
    const literalCall = calls.find((request) => request.fields === STAGING_STRUCTURAL_LITERAL_CELL_FIELDS)
    expect(literalCall?.requestBody.dataFilters).toEqual([
      {
        gridRange: {
          sheetId: 0,
          startRowIndex: 631,
          endRowIndex: 632,
          startColumnIndex: 0,
          endColumnIndex: 29,
        },
      },
    ])
    expect(STAGING_STRUCTURAL_LITERAL_CELL_FIELDS).not.toContain("formulaValue")
  })

  test("makes a nonblank sanctioned destination visible to the fail-closed observer", async () => {
    const spec = pipelineNormalizationSpec({
      artifactKey: "pipeline_907",
      currentCandidateTitle: "Candidate Level Data - 10 July",
    })
    const metadata = {
      spreadsheetId: spec.spreadsheetId,
      properties: { title: "Copy", locale: "en_US", timeZone: "UTC" },
      sheets: [
        {
          properties: {
            sheetId: 0,
            title: "Job level pipeline",
            index: 0,
            sheetType: "GRID",
            gridProperties: { rowCount: 807, columnCount: 35 },
          },
          basicFilter: { range: spec.expectedBefore.jobSummary && (spec.expectedBefore.jobSummary as Record<string, unknown>).basicFilter },
        },
        {
          properties: {
            sheetId: 156193952,
            title: "Candidate Level Data - 10 July",
            index: 1,
            sheetType: "GRID",
            gridProperties: { rowCount: 998, columnCount: 14 },
          },
          basicFilter: { range: spec.expectedBefore.candidate && (spec.expectedBefore.candidate as Record<string, unknown>).basicFilter },
        },
      ],
    }
    const fake = {
      drive: {},
      docs: {},
      sheets: {
        spreadsheets: {
          get: vi.fn(async () => ({ data: metadata })),
          getByDataFilter: vi.fn(async (request: { fields?: string }) => ({
            data: {
              sheets: request.fields === STAGING_STRUCTURAL_LITERAL_CELL_FIELDS
                ? [{
                    properties: { sheetId: 0 },
                    data: [{
                      startRow: 631,
                      startColumn: 0,
                      rowData: [{ values: [{ userEnteredValue: { stringValue: "occupied" } }] }],
                    }],
                  }]
                : metadata.sheets.map((sheet) => ({ properties: { sheetId: sheet.properties.sheetId }, data: [] })),
            },
          })),
        },
      },
    } as unknown as GoogleWorkspaceStagingClients

    const observed = await readStagingStructuralNormalizationSnapshot(spec, fake)
    expect(() => projectStagingStructuralNormalizationState(observed.spreadsheet, spec)).toThrow(
      "matches neither exact state"
    )
  })

  test("rejects literal data leaked into the structure-only response", async () => {
    const spec = pipelineNormalizationSpec({
      artifactKey: "pipeline_907",
      currentCandidateTitle: "Candidate Level Data - 10 July",
    })
    const metadata = {
      spreadsheetId: spec.spreadsheetId,
      properties: { title: "Copy", locale: "en_US", timeZone: "UTC" },
      sheets: [
        {
          properties: {
            sheetId: 0,
            title: "Job level pipeline",
            index: 0,
            sheetType: "GRID",
            gridProperties: { rowCount: 807, columnCount: 35 },
          },
        },
        {
          properties: {
            sheetId: 156193952,
            title: "Candidate Level Data - 10 July",
            index: 1,
            sheetType: "GRID",
            gridProperties: { rowCount: 998, columnCount: 14 },
          },
        },
      ],
    }
    const fake = {
      drive: {},
      docs: {},
      sheets: {
        spreadsheets: {
          get: vi.fn(async () => ({ data: metadata })),
          getByDataFilter: vi.fn(async (request: { fields?: string }) => ({
            data: {
              sheets: request.fields === SHEET_STRUCTURE_CELL_FIELDS
                ? [{
                    properties: { sheetId: 0 },
                    data: [{
                      startRow: 100,
                      startColumn: 0,
                      rowData: [{ values: [{ userEnteredValue: { stringValue: "unexpected" } }] }],
                    }],
                  }]
                : metadata.sheets.map((sheet) => ({
                    properties: { sheetId: sheet.properties.sheetId },
                    data: [],
                  })),
            },
          })),
        },
      },
    } as unknown as GoogleWorkspaceStagingClients

    await expect(readStagingStructuralNormalizationSnapshot(spec, fake)).rejects.toThrow(
      "unapproved literal cell data"
    )
  })
})
