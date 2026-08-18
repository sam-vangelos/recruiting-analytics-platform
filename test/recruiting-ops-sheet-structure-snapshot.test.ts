import { describe, expect, test } from "vitest"

import {
  buildSheetStructureSnapshot,
  SHEET_STRUCTURE_FIELDS,
  SheetStructureSnapshotAccumulator,
  sheetStructureCellCoordinateKey,
} from "../lib/recruiting-ops/delivery/sheet-structure-snapshot"
import type { GoogleSpreadsheet } from "../lib/recruiting-ops/delivery/google-workspace-staging-client"

function spreadsheet(): GoogleSpreadsheet {
  return {
    spreadsheetId: "staging_fixture",
    properties: { title: "Staging fixture", locale: "en_US", timeZone: "UTC" },
    namedRanges: [{ namedRangeId: "nr1", name: "Data", range: { sheetId: 1, startRowIndex: 0 } }],
    sheets: [
      {
        properties: {
          sheetId: 1,
          title: "Data",
          index: 0,
          sheetType: "GRID",
          gridProperties: { rowCount: 100, columnCount: 12 },
        },
        merges: [{ sheetId: 1, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 }],
        conditionalFormats: [{ ranges: [{ sheetId: 1 }], booleanRule: { condition: { type: "NOT_BLANK" } } }],
        filterViews: [{ filterViewId: 7, title: "Current", range: { sheetId: 1 } }],
        protectedRanges: [{ protectedRangeId: 8, range: { sheetId: 1, startRowIndex: 0, endRowIndex: 1 } }],
        charts: [{ chartId: 9, spec: { title: "Pipeline" }, position: { overlayPosition: { anchorCell: { sheetId: 1 } } } }],
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowMetadata: [{ pixelSize: 22 }],
            columnMetadata: [{ pixelSize: 120 }],
            rowData: [
              {
                values: [
                  {
                    userEnteredValue: { formulaValue: "=SUM(A2:A3)", stringValue: "private@example.com" },
                    userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0" } },
                    textFormatRuns: [{ startIndex: 0, format: { bold: true } }],
                    dataValidation: { condition: { type: "ONE_OF_LIST", values: [{ userEnteredValue: "A" }] } },
                    pivotTable: { source: { sheetId: 1, startRowIndex: 1, endRowIndex: 20 } },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

describe("Google Sheet form snapshot", () => {
  test("ignores values while retaining structural controls", () => {
    const before = spreadsheet()
    const after = structuredClone(before)
    after.sheets![0].data![0].rowData![0].values!.push({ userEnteredValue: { stringValue: "new hydrated value" } })

    const beforeSnapshot = buildSheetStructureSnapshot(before)
    const afterSnapshot = buildSheetStructureSnapshot(after)
    expect(afterSnapshot.structureHash).toBe(beforeSnapshot.structureHash)
    expect(JSON.stringify(afterSnapshot)).not.toContain("new hydrated value")
    expect(JSON.stringify(beforeSnapshot)).not.toContain("private@example.com")
    expect(JSON.stringify(beforeSnapshot)).not.toContain("=SUM(A2:A3)")
    expect(beforeSnapshot.sheets[0].pivotTables.count).toBe(1)
    expect(beforeSnapshot.sheets[0].dataValidations.count).toBe(1)
    expect(beforeSnapshot.sheets[0].formulas.count).toBe(1)
  })

  test("requests formulas without requesting literal ExtendedValue members", () => {
    expect(SHEET_STRUCTURE_FIELDS).toContain("userEnteredValue(formulaValue)")
    expect(SHEET_STRUCTURE_FIELDS).not.toContain("stringValue")
    expect(SHEET_STRUCTURE_FIELDS).not.toContain("numberValue")
    expect(SHEET_STRUCTURE_FIELDS).not.toContain("boolValue")
  })

  test("keeps the returned snapshot bounded for a large repeated-format grid", () => {
    const large = spreadsheet()
    const formattedCell = {
      userEnteredFormat: {
        backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
        textFormat: { bold: true },
      },
    }
    large.sheets![0].data![0].rowData = Array.from({ length: 50_000 }, () => ({
      values: [formattedCell],
    }))

    const snapshot = buildSheetStructureSnapshot(large)

    expect(snapshot.sheets[0].cellFormats.count).toBe(50_000)
    expect(snapshot.sheets[0].cellFormats.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(JSON.stringify(snapshot).length).toBeLessThan(10_000)
  })

  test("produces the same full-form hash from bounded grid chunks", () => {
    const full = spreadsheet()
    full.sheets![0].properties!.gridProperties = { rowCount: 4, columnCount: 50_000 }
    const originalGrid = full.sheets![0].data![0]
    const extraRows = Array.from({ length: 3 }, () => ({
      values: [{ userEnteredFormat: { textFormat: { italic: true } } }],
    }))
    originalGrid.rowData = [...(originalGrid.rowData ?? []), ...extraRows]
    const expected = buildSheetStructureSnapshot(full)

    const metadata = structuredClone(full)
    metadata.sheets![0].data = []
    const accumulator = new SheetStructureSnapshotAccumulator(metadata)
    accumulator.addSheetGridData(1, [{
      startColumn: originalGrid.startColumn,
      columnMetadata: originalGrid.columnMetadata,
    }])
    accumulator.addSheetGridData(1, [{
      startRow: 0,
      startColumn: 0,
      rowMetadata: originalGrid.rowMetadata,
      rowData: originalGrid.rowData?.slice(0, 2),
    }])
    accumulator.addSheetGridData(1, [{
      startRow: 2,
      startColumn: 0,
      rowData: originalGrid.rowData?.slice(2),
    }])

    expect(accumulator.finish()).toEqual(expected)
  })

  test("projects out only a full-cell link URI at one exact coordinate", () => {
    const before = spreadsheet()
    const after = structuredClone(before)
    before.sheets![0].data![0].rowData![0].values![0].userEnteredFormat!.textFormat = {
      bold: true,
      link: { uri: "https://example.com/old" },
    }
    after.sheets![0].data![0].rowData![0].values![0].userEnteredFormat!.textFormat = {
      bold: true,
      link: { uri: "https://example.com/new" },
    }
    const options = {
      valueCoupledAutoLinkCoordinates: new Set([
        sheetStructureCellCoordinateKey(1, 0, 0),
      ]),
    }

    expect(buildSheetStructureSnapshot(after).structureHash).not.toBe(
      buildSheetStructureSnapshot(before).structureHash
    )
    expect(buildSheetStructureSnapshot(after, options).structureHash).toBe(
      buildSheetStructureSnapshot(before, options).structureHash
    )
    const otherCoordinate = {
      valueCoupledAutoLinkCoordinates: new Set([
        sheetStructureCellCoordinateKey(1, 0, 1),
      ]),
    }
    expect(buildSheetStructureSnapshot(after, otherCoordinate).structureHash).not.toBe(
      buildSheetStructureSnapshot(before, otherCoordinate).structureHash
    )
  })

  test("projects the exact Sheets default font materialized with a new URL link", () => {
    const before = spreadsheet()
    const after = structuredClone(before)
    delete before.sheets![0].data![0].rowData![0].values![0].userEnteredFormat
    after.sheets![0].data![0].rowData![0].values![0].userEnteredFormat = {
      textFormat: {
        fontFamily: "Arial",
        fontSize: 10,
        link: { uri: "https://example.com/new" },
      },
    }
    const options = {
      valueCoupledAutoLinkCoordinates: new Set([
        sheetStructureCellCoordinateKey(1, 0, 0),
      ]),
      valueCoupledAutoLinkMaterializedDefaultTextFormat: {
        fontFamily: "Arial",
        fontSize: 10,
      },
    }

    expect(buildSheetStructureSnapshot(after).structureHash).not.toBe(
      buildSheetStructureSnapshot(before).structureHash
    )
    expect(buildSheetStructureSnapshot(after, options).structureHash).toBe(
      buildSheetStructureSnapshot(before, options).structureHash
    )

    after.sheets![0].data![0].rowData![0].values![0].userEnteredFormat!.textFormat!.bold = true
    expect(buildSheetStructureSnapshot(after, options).structureHash).not.toBe(
      buildSheetStructureSnapshot(before, options).structureHash
    )
  })

  test("retains every non-link format field at an auto-link coordinate", () => {
    const before = spreadsheet()
    const after = structuredClone(before)
    before.sheets![0].data![0].rowData![0].values![0].userEnteredFormat!.textFormat = {
      bold: true,
      link: { uri: "https://example.com/old" },
    }
    after.sheets![0].data![0].rowData![0].values![0].userEnteredFormat!.textFormat = {
      bold: false,
      link: { uri: "https://example.com/new" },
    }
    const options = {
      valueCoupledAutoLinkCoordinates: new Set([
        sheetStructureCellCoordinateKey(1, 0, 0),
      ]),
    }

    expect(buildSheetStructureSnapshot(after, options).structureHash).not.toBe(
      buildSheetStructureSnapshot(before, options).structureHash
    )
  })

  test("projects only cell format inside an exact value-owned report range", () => {
    const before = spreadsheet()
    const after = structuredClone(before)
    after.sheets![0].data![0].rowData![0].values![0].userEnteredFormat = {
      backgroundColor: { green: 0.9 },
      textFormat: { bold: true },
    }
    const options = {
      valueOwnedFormatRanges: [{
        sheetId: 1,
        startRowIndex: 0,
        endRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: 1,
      }],
    }

    expect(buildSheetStructureSnapshot(after).structureHash).not.toBe(
      buildSheetStructureSnapshot(before).structureHash
    )
    expect(buildSheetStructureSnapshot(after, options).structureHash).toBe(
      buildSheetStructureSnapshot(before, options).structureHash
    )

    after.sheets![0].data![0].rowData![0].values![0].dataValidation!.strict = true
    expect(buildSheetStructureSnapshot(after, options).structureHash).not.toBe(
      buildSheetStructureSnapshot(before, options).structureHash
    )
  })

  test.each([
    ["grid size", (value: GoogleSpreadsheet) => (value.sheets![0].properties!.gridProperties!.rowCount = 101)],
    ["tab title", (value: GoogleSpreadsheet) => (value.sheets![0].properties!.title = "Changed")],
    ["pivot source", (value: GoogleSpreadsheet) => {
      value.sheets![0].data![0].rowData![0].values![0].pivotTable!.source!.endRowIndex = 30
    }],
    ["data validation", (value: GoogleSpreadsheet) => {
      value.sheets![0].data![0].rowData![0].values![0].dataValidation!.strict = true
    }],
    ["formula", (value: GoogleSpreadsheet) => {
      value.sheets![0].data![0].rowData![0].values![0].userEnteredValue = { formulaValue: "=SUM(A2:A4)" }
    }],
    ["cell format", (value: GoogleSpreadsheet) => {
      value.sheets![0].data![0].rowData![0].values![0].userEnteredFormat!.numberFormat!.pattern = "0.00"
    }],
    ["dimension metadata", (value: GoogleSpreadsheet) => {
      value.sheets![0].data![0].rowMetadata![0].pixelSize = 30
    }],
    ["chart", (value: GoogleSpreadsheet) => (value.sheets![0].charts![0].spec!.title = "Changed")],
  ])("detects a %s change", (_name, mutate) => {
    const before = spreadsheet()
    const after = structuredClone(before)
    mutate(after)
    expect(buildSheetStructureSnapshot(after).structureHash).not.toBe(
      buildSheetStructureSnapshot(before).structureHash
    )
  })
})
