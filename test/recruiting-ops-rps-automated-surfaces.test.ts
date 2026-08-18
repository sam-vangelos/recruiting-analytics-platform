import { describe, expect, test, vi } from "vitest"

import {
  createGoogleWorkspaceRpsAutomatedSurfaceAdapter,
  type GoogleWorkspaceStagingClients,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import {
  RPS_AUTOMATED_CLEAN_FORMULA,
  RPS_AUTOMATED_CLEAN_SHEET_ID,
  RPS_AUTOMATED_CLEAN_TITLE,
  RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
  RPS_AUTOMATED_SUMMARY_FORMULA,
  RPS_AUTOMATED_SUMMARY_SHEET_ID,
  RPS_AUTOMATED_SUMMARY_TITLE,
  RPS_DATA_DUMP_HEADERS,
  RPS_DATA_DUMP_SHEET_ID,
  reconcileRpsAutomatedSurfaceValues,
  rpsAutomatedSurfaceCreationRequests,
  rpsAutomatedSurfaceDeletionRequests,
  runRpsAutomatedSurfaceSetup,
  type RpsAutomatedSurfaceAdapter,
  type RpsAutomatedSurfaceSheet,
  type RpsAutomatedSurfaceValueRanges,
} from "../lib/recruiting-ops/delivery/rps-automated-surfaces"

const CANONICAL_ID = "1ExampleDriveId00000000000000000000000000008"

function dataRow(input: {
  candidate: string
  submitter: string
  team: string
  week: string
  weekOrder: number
}): unknown[] {
  const row = Array<unknown>(18).fill("")
  row[0] = input.candidate
  row[10] = input.submitter
  row[13] = input.team
  row[14] = input.week
  row[15] = input.weekOrder
  return row
}

const SOURCE_ROWS = [
  [...RPS_DATA_DUMP_HEADERS],
  dataRow({
    candidate: "Candidate A",
    submitter: "Submitter A",
    team: "Team A",
    week: "Jul 13 - Jul 19",
    weekOrder: 29,
  }),
  [],
  dataRow({
    candidate: "Candidate B",
    submitter: "Submitter A",
    team: "Team A",
    week: "Jul 13 - Jul 19",
    weekOrder: 29,
  }),
  dataRow({
    candidate: "Candidate C",
    submitter: "Submitter B",
    team: "Team B",
    week: "Jul 20 - Jul 26",
    weekOrder: 30,
  }),
]

const CLEAN_ROWS = [SOURCE_ROWS[0], SOURCE_ROWS[1], SOURCE_ROWS[3], SOURCE_ROWS[4]]
const SUMMARY_ROWS = [
  ["Week Order", "Week", "Submitter", "Team", "RPS Count"],
  [29, "Jul 13 - Jul 19", "Submitter A", "Team A", 2],
  [30, "Jul 20 - Jul 26", "Submitter B", "Team B", 1],
]

function dataDumpSheet(): RpsAutomatedSurfaceSheet {
  return {
    sheetId: RPS_DATA_DUMP_SHEET_ID,
    title: "Data Dump",
    rowCount: 4_612,
    columnCount: 18,
    frozenRowCount: 1,
  }
}

function automatedSheets(): RpsAutomatedSurfaceSheet[] {
  return [
    {
      sheetId: RPS_AUTOMATED_CLEAN_SHEET_ID,
      title: RPS_AUTOMATED_CLEAN_TITLE,
      rowCount: 10_000,
      columnCount: 18,
      frozenRowCount: 1,
    },
    {
      sheetId: RPS_AUTOMATED_SUMMARY_SHEET_ID,
      title: RPS_AUTOMATED_SUMMARY_TITLE,
      rowCount: 10_000,
      columnCount: 5,
      frozenRowCount: 1,
    },
  ]
}

function fixture(options: {
  present?: boolean
  partial?: boolean
  wrongRollbackIdentity?: boolean
  badValues?: boolean
  badPostWriteHeader?: boolean
  advanceVersionOnCreate?: boolean
  createThrowsAfterConcurrentSetup?: boolean
  advanceVersionOnEveryPostWriteRead?: boolean
  version?: string
} = {}) {
  let present = options.present ?? false
  let version = options.version ?? "10"
  const values = (): RpsAutomatedSurfaceValueRanges => ({
    dataDump:
      present && options.badPostWriteHeader
        ? [["drifted_header"], ...SOURCE_ROWS.slice(1)]
        : SOURCE_ROWS,
    clean: options.badValues ? CLEAN_ROWS.slice(0, -1) : CLEAN_ROWS,
    summary: SUMMARY_ROWS,
  })
  const createSurfaces = vi.fn(async () => {
    present = true
    if (options.advanceVersionOnCreate !== false) {
      version = String(Number(version) + 1)
    }
    if (options.createThrowsAfterConcurrentSetup) {
      throw new Error("concurrent exact setup won the race")
    }
  })
  const deleteSurfaces = vi.fn(async () => {
    present = false
    version = String(Number(version) + 1)
  })
  const adapter: RpsAutomatedSurfaceAdapter = {
    readDriveMetadata: vi.fn(async () => {
      if (present && options.advanceVersionOnEveryPostWriteRead) {
        version = String(Number(version) + 1)
      }
      return {
        id: RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
        version,
        mimeType: "application/vnd.google-apps.spreadsheet",
        trashed: false,
        capabilities: { canEdit: true, canModifyContent: true },
      }
    }),
    readSpreadsheet: vi.fn(async () => {
      const surfaces = present
        ? options.wrongRollbackIdentity
          ? [
              {
                ...automatedSheets()[0],
                title: "Unexpected reserved-id owner",
              },
              automatedSheets()[1],
            ]
          : options.partial
            ? [automatedSheets()[0]]
            : automatedSheets()
        : []
      return {
        spreadsheetId: RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
        sheets: [dataDumpSheet(), ...surfaces],
      }
    }),
    readDataDumpHeader: vi.fn(async () => RPS_DATA_DUMP_HEADERS),
    readFormulaAnchors: vi.fn(async () => ({
      clean: RPS_AUTOMATED_CLEAN_FORMULA,
      summary: RPS_AUTOMATED_SUMMARY_FORMULA,
    })),
    readValueRanges: vi.fn(async () => values()),
    createSurfaces,
    deleteSurfaces,
  }
  return { adapter, createSurfaces, deleteSurfaces }
}

describe("RPS automated surfaces", () => {
  test("binds only the fixed registered copy target", () => {
    expect(RPS_AUTOMATED_SURFACE_SPREADSHEET_ID).toBe(CANONICAL_ID)
  })

  test("builds one atomic two-tab and two-formula request set", () => {
    const requests = rpsAutomatedSurfaceCreationRequests(10_000)
    expect(requests).toHaveLength(4)
    expect(requests[0]).toEqual({
      addSheet: {
        properties: {
          sheetId: RPS_AUTOMATED_CLEAN_SHEET_ID,
          title: RPS_AUTOMATED_CLEAN_TITLE,
          gridProperties: { rowCount: 10_000, columnCount: 18, frozenRowCount: 1 },
        },
      },
    })
    expect(requests[1]).toEqual({
      addSheet: {
        properties: {
          sheetId: RPS_AUTOMATED_SUMMARY_SHEET_ID,
          title: RPS_AUTOMATED_SUMMARY_TITLE,
          gridProperties: { rowCount: 10_000, columnCount: 5, frozenRowCount: 1 },
        },
      },
    })
    expect(requests[2]).toEqual({
      updateCells: {
        range: {
          sheetId: RPS_AUTOMATED_CLEAN_SHEET_ID,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 1,
        },
        rows: [{
          values: [{
            userEnteredValue: { formulaValue: RPS_AUTOMATED_CLEAN_FORMULA },
          }],
        }],
        fields: "userEnteredValue",
      },
    })
    expect(requests[3]).toEqual({
      updateCells: {
        range: {
          sheetId: RPS_AUTOMATED_SUMMARY_SHEET_ID,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 1,
        },
        rows: [{
          values: [{
            userEnteredValue: { formulaValue: RPS_AUTOMATED_SUMMARY_FORMULA },
          }],
        }],
        fields: "userEnteredValue",
      },
    })
  })

  test("plans without mutating", async () => {
    const value = fixture()
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: value.adapter,
    })).resolves.toMatchObject({
      spreadsheetId: CANONICAL_ID,
      status: "planned",
      beforeDriveVersion: "10",
      afterDriveVersion: "10",
    })
    expect(value.createSurfaces).not.toHaveBeenCalled()
    expect(value.deleteSurfaces).not.toHaveBeenCalled()
  })

  test("applies once under the exact Drive fence and reconciles values", async () => {
    const value = fixture()
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: value.adapter,
      mode: "apply",
      expectedDriveVersion: "10",
    })).resolves.toMatchObject({
      status: "written",
      beforeDriveVersion: "10",
      afterDriveVersion: "11",
      cleanRows: 3,
      summaryRows: 2,
      summaryCount: 3,
    })
    expect(value.createSurfaces).toHaveBeenCalledExactlyOnceWith(10_000)
    expect(value.deleteSurfaces).not.toHaveBeenCalled()
  })

  test("returns no_change for the exact settled state", async () => {
    const value = fixture({ present: true, version: "20" })
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: value.adapter,
      mode: "apply",
    })).resolves.toMatchObject({
      status: "no_change",
      beforeDriveVersion: "20",
      afterDriveVersion: "20",
      cleanRows: 3,
      summaryRows: 2,
      summaryCount: 3,
    })
    expect(value.createSurfaces).not.toHaveBeenCalled()
    expect(value.deleteSurfaces).not.toHaveBeenCalled()
  })

  test("fails closed on a partial state or stale Drive fence", async () => {
    const partial = fixture({ present: true, partial: true })
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: partial.adapter,
    })).rejects.toThrow("partial state")
    expect(partial.createSurfaces).not.toHaveBeenCalled()

    const stale = fixture()
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: stale.adapter,
      mode: "apply",
      expectedDriveVersion: "9",
    })).rejects.toThrow("changed since the approved plan")
    expect(stale.createSurfaces).not.toHaveBeenCalled()
  })

  test("rolls back only the exact newly-created tabs when reconciliation fails", async () => {
    const value = fixture({ badValues: true })
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: value.adapter,
      mode: "apply",
      expectedDriveVersion: "10",
      sleep: async () => {},
    })).rejects.toThrow("rollback=deleted_new_tabs")
    expect(value.createSurfaces).toHaveBeenCalledOnce()
    expect(value.deleteSurfaces).toHaveBeenCalledExactlyOnceWith(
      [RPS_AUTOMATED_CLEAN_SHEET_ID, RPS_AUTOMATED_SUMMARY_SHEET_ID]
    )
  })

  test("refuses rollback when a reserved id has an unexpected title", async () => {
    const value = fixture({ badValues: true, wrongRollbackIdentity: true })
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: value.adapter,
      mode: "apply",
      expectedDriveVersion: "10",
      sleep: async () => {},
    })).rejects.toThrow("rollback=failed")
    expect(value.deleteSurfaces).not.toHaveBeenCalled()
  })

  test("does not roll back an exact concurrent setup when the create call loses the race", async () => {
    const value = fixture({ createThrowsAfterConcurrentSetup: true })
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: value.adapter,
      mode: "apply",
      expectedDriveVersion: "10",
    })).rejects.toThrow("rollback=not_owned")
    expect(value.deleteSurfaces).not.toHaveBeenCalled()
  })

  test("never deletes a lone reserved tab observed after atomic creation", async () => {
    const value = fixture({ partial: true })
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: value.adapter,
      mode: "apply",
      expectedDriveVersion: "10",
      sleep: async () => {},
    })).rejects.toThrow("rollback=failed")
    expect(value.deleteSurfaces).not.toHaveBeenCalled()
  })

  test("requires an advanced post-write Drive version", async () => {
    const value = fixture({ advanceVersionOnCreate: false })
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: value.adapter,
      mode: "apply",
      expectedDriveVersion: "10",
      sleep: async () => {},
    })).rejects.toThrow("did not advance")
    expect(value.deleteSurfaces).not.toHaveBeenCalled()
  })

  test("rejects a post-write snapshot not bracketed by one stable Drive version", async () => {
    const value = fixture({ advanceVersionOnEveryPostWriteRead: true })
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: value.adapter,
      mode: "apply",
      expectedDriveVersion: "10",
      sleep: async () => {},
    })).rejects.toThrow("changed during setup preflight")
    expect(value.deleteSurfaces).not.toHaveBeenCalled()
  })

  test("rejects post-write Data Dump header drift and rolls back owned tabs", async () => {
    const value = fixture({ badPostWriteHeader: true })
    await expect(runRpsAutomatedSurfaceSetup({
      adapter: value.adapter,
      mode: "apply",
      expectedDriveVersion: "10",
      sleep: async () => {},
    })).rejects.toThrow("rollback=deleted_new_tabs")
    expect(value.deleteSurfaces).toHaveBeenCalledOnce()
  })

  test("reconciliation rejects duplicate summary groups", () => {
    expect(() => reconcileRpsAutomatedSurfaceValues({
      dataDump: SOURCE_ROWS,
      clean: CLEAN_ROWS,
      summary: [...SUMMARY_ROWS, SUMMARY_ROWS[1]],
    })).toThrow("duplicate or invalid group")
  })

  test("reconciliation leaves QUERY ordering to the exact anchored formula", () => {
    expect(reconcileRpsAutomatedSurfaceValues({
      dataDump: SOURCE_ROWS,
      clean: CLEAN_ROWS,
      summary: [SUMMARY_ROWS[0], SUMMARY_ROWS[2], SUMMARY_ROWS[1]],
    })).toEqual({
      cleanRows: 3,
      summaryRows: 2,
      summaryCount: 3,
    })
  })

  test("reconciliation rejects wrong per-group counts even when the total matches", () => {
    expect(() => reconcileRpsAutomatedSurfaceValues({
      dataDump: SOURCE_ROWS,
      clean: CLEAN_ROWS,
      summary: [
        SUMMARY_ROWS[0],
        [29, "Jul 13 - Jul 19", "Submitter A", "Team A", 1],
        [30, "Jul 20 - Jul 26", "Submitter B", "Team B", 2],
      ],
    })).toThrow("values do not reconcile")
  })

  test("the Google adapter applies only fixed requests to the registered copy", async () => {
    const batchUpdate = vi.fn(async () => ({ data: {} }))
    const clients = {
      sheets: { spreadsheets: { batchUpdate } },
      drive: {},
      docs: {},
    } as unknown as GoogleWorkspaceStagingClients
    const adapter = createGoogleWorkspaceRpsAutomatedSurfaceAdapter(clients)
    await adapter.createSurfaces(10_000)
    expect(batchUpdate).toHaveBeenCalledOnce()
    expect(batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: CANONICAL_ID,
      requestBody: {
        includeSpreadsheetInResponse: false,
        requests: [...rpsAutomatedSurfaceCreationRequests(10_000)],
      },
    })
    expect(() =>
      rpsAutomatedSurfaceDeletionRequests([123])
    ).toThrow("exact reserved tab pair")
    expect(() =>
      rpsAutomatedSurfaceDeletionRequests([RPS_AUTOMATED_CLEAN_SHEET_ID])
    ).toThrow("exact reserved tab pair")
    await adapter.deleteSurfaces([
      RPS_AUTOMATED_CLEAN_SHEET_ID,
      RPS_AUTOMATED_SUMMARY_SHEET_ID,
    ])
    expect(batchUpdate).toHaveBeenNthCalledWith(2, {
      spreadsheetId: CANONICAL_ID,
      requestBody: {
        includeSpreadsheetInResponse: false,
        requests: [
          { deleteSheet: { sheetId: RPS_AUTOMATED_CLEAN_SHEET_ID } },
          { deleteSheet: { sheetId: RPS_AUTOMATED_SUMMARY_SHEET_ID } },
        ],
      },
    })
  })
})
