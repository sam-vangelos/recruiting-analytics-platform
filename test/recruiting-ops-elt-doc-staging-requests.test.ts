import { describe, expect, test } from "vitest"

import {
  ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
  ELT_DOC_HIRE_TABLE_BODY_FONT_PT,
  ELT_DOC_HIRE_TABLE_BORDER_RGB,
  ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT,
  ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT,
  ELT_DOC_TOP_WEEK_FACTS_RANGE_ID,
  ELT_DOC_HIRE_TABLE_HEADERS,
  ELT_DOC_HIRE_TABLE_PADDING_PT,
  ELT_DOC_HIRE_TABLE_ROW_HEIGHT_PT,
  ELT_DOC_HIRE_TABLE_STRIPE_RGB,
  type EltDocDryRunPrivatePlan,
} from "../lib/recruiting-ops/delivery/elt-doc-dry-run"
import {
  buildEltDocBatchUpdateRequests,
  buildEltDocRollbackRequests,
} from "../lib/recruiting-ops/delivery/elt-doc-staging-requests"
import { P1_ELT_DOC_TARGET } from "../lib/recruiting-ops/delivery/p1-artifacts"

const fingerprint = (letter: string) => `hmac-sha256:${letter.repeat(64)}`

/** `updateParagraphStyle`/`updateTextStyle` are `unknown` on the wire type; narrow for range-based filtering. */
function rangeStartIndex(value: unknown): number | undefined {
  return (value as { range?: { startIndex?: number } } | undefined)?.range?.startIndex
}

// Narrative text is deliberately short/synthetic (not renderer-realistic prose)
// so every index below can be hand-derived from `emptyTableExtentEndIndex` and
// the per-paragraph `text.length + 1` rule, not pasted from program output.
const narrativeParagraphs = [
  { kind: "section_heading", text: "Heading", namedStyleType: "HEADING_2", bold: true, tone: "ink" },
  { kind: "body", text: "Body line", namedStyleType: "NORMAL_TEXT", bold: false, tone: "ink" },
] as const

const factTable = {
  weekLabel: "Jul 10, 2026 - Jul 16, 2026",
  startDisplayText: "Jul 10, 2026",
  endDisplayText: "Jul 16, 2026",
  startTimestamp: "2026-07-10T12:00:00.000Z",
  endTimestamp: "2026-07-16T12:00:00.000Z",
  hireRows: [
    ["Research Engineer", "Frontier Data", "P1", "Amina Vega", "2026-07-20"],
    ["Product Engineer", "", "P2", "Theo Park", "TBD"],
  ],
  narrativeParagraphs,
} as const
const rollbackFactTable = {
  ...factTable,
  hireRows: [["Old Role", "Old Dept", "P2", "Old Candidate", "2026-07-13"]],
  narrativeParagraphs: [
    { kind: "body", text: "Old line", namedStyleType: "NORMAL_TEXT", bold: false, tone: "ink" },
  ],
} as const

function plan(overrides: Partial<EltDocDryRunPrivatePlan> = {}): EltDocDryRunPrivatePlan {
  return {
    runId: "e01_live_20260711120000000",
    sourceGeneratedAt: "2026-07-11T12:00:00.000Z",
    dataProvenance: "live",
    documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
    tabId: P1_ELT_DOC_TARGET.tabId,
    requiredRevisionId: "revision-before",
    payloadFingerprint: fingerprint("a"),
    preimageFingerprint: fingerprint("b"),
    preimageDocumentFingerprint: fingerprint("c"),
    outsideContentFingerprint: fingerprint("d"),
    approvedRangeIds: [ELT_DOC_TOP_WEEK_FACTS_RANGE_ID],
    mutationScope: "weekly_fact_table",
    action: "replace_top_week",
    archiveBlockRange: { tabId: P1_ELT_DOC_TARGET.tabId, startIndex: 1, endIndex: 200 },
    contentGuardRange: { tabId: P1_ELT_DOC_TARGET.tabId, startIndex: 9, endIndex: 80 },
    deleteRange: { tabId: P1_ELT_DOC_TARGET.tabId, startIndex: 9, endIndex: 80 },
    insertAt: { tabId: P1_ELT_DOC_TARGET.tabId, index: 9 },
    factTable,
    rollbackFactTable,
    ...overrides,
  }
}

describe("ELT fact-table-and-narrative request compiler", () => {
  test("replaces a table from its owned delimiter while preserving the table start", () => {
    const replace = plan({
      contentGuardRange: { tabId: "t.0", startIndex: 9, endIndex: 80 },
      deleteRange: { tabId: "t.0", startIndex: 9, endIndex: 80 },
      insertAt: { tabId: "t.0", index: 9 },
    })
    const requests = buildEltDocBatchUpdateRequests(replace)

    expect(requests.find((request) => request.insertTable)?.insertTable).toMatchObject({
      location: { tabId: "t.0", index: 9 },
    })
    expect(
      requests.find((request) => request.updateTableRowStyle)?.updateTableRowStyle
    ).toMatchObject({
      tableStartLocation: { tabId: "t.0", index: 10 },
    })

    const rollback = buildEltDocRollbackRequests(
      replace,
      { tabId: "t.0", startIndex: 9, endIndex: 90 }
    )
    expect(rollback.find((request) => request.insertTable)?.insertTable).toMatchObject({
      location: { tabId: "t.0", index: 9 },
    })
    expect(
      rollback.find((request) => request.updateTableRowStyle)?.updateTableRowStyle
    ).toMatchObject({
      tableStartLocation: { tabId: "t.0", index: 10 },
    })
  })

  test("compiles the date chips, five-column hire table, and Role Progress narrative tail", () => {
    const requests = buildEltDocBatchUpdateRequests(plan())
    const rows = [ELT_DOC_HIRE_TABLE_HEADERS, ...factTable.hireRows]
    const allowedRequestTypes = [
      "deleteContentRange",
      "insertTable",
      "insertText",
      "insertDate",
      "updateParagraphStyle",
      "updateTextStyle",
      "updateTableRowStyle",
      "updateTableColumnProperties",
      "updateTableCellStyle",
    ]
    requests.forEach((request) => {
      expect(Object.keys(request)).toHaveLength(1)
      expect(allowedRequestTypes).toContain(Object.keys(request)[0])
    })

    expect(requests.filter((request) => request.deleteContentRange)).toEqual([
      {
        deleteContentRange: { range: { tabId: "t.0", startIndex: 9, endIndex: 80 } },
      },
    ])
    expect(requests.filter((request) => request.insertTable)).toEqual([
      {
        insertTable: {
          rows: 3,
          columns: 5,
          location: { tabId: "t.0", index: 9 },
        },
      },
    ])

    // Narrative insertion point: emptyTableExtentEndIndex(tableStartIndex=10, rows=3)
    // = 10 + 2 + 3 * (5 * 2 + 1) = 10 + 2 + 33 = 45, the first index outside the
    // empty table. Paragraph 0 ("Heading", 7 chars) occupies [45, 53);
    // paragraph 1 ("Body line", 9 chars) occupies [53, 63).
    const narrativeStart = 45
    const narrativeText = "Heading\nBody line\n"
    const heading = { tabId: "t.0", startIndex: 45, endIndex: 53 }
    const body = { tabId: "t.0", startIndex: 53, endIndex: 63 }

    const expectedCellInsertions: unknown[] = []
    const expectedCellParagraphs: unknown[] = []
    const expectedCellTextStyles: unknown[] = []
    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
      for (let columnIndex = 4; columnIndex >= 0; columnIndex -= 1) {
        const text = rows[rowIndex][columnIndex]
        const startIndex = 13 + rowIndex * 11 + columnIndex * 2
        const range = { tabId: "t.0", startIndex, endIndex: startIndex + text.length + 1 }
        if (text.length > 0) {
          expectedCellInsertions.push({
            insertText: { location: { tabId: "t.0", index: startIndex }, text },
          })
        }
        expectedCellParagraphs.push({
          updateParagraphStyle: {
            range,
            paragraphStyle: { namedStyleType: "NORMAL_TEXT", alignment: "CENTER" },
            fields: "namedStyleType,alignment",
          },
        })
        expectedCellTextStyles.push({
          updateTextStyle: {
            range,
            textStyle:
              rowIndex === 0
                ? { bold: true }
                : {
                    bold: false,
                    fontSize: { magnitude: ELT_DOC_HIRE_TABLE_BODY_FONT_PT, unit: "PT" },
                  },
            fields: rowIndex === 0 ? "bold" : "bold,fontSize",
          },
        })
      }
    }

    // Narrative is emitted before any cell fill: one joined insertText at the
    // empty table's end, ahead of the (reverse-order) per-cell insertions.
    expect(requests.filter((request) => request.insertText)).toEqual([
      { insertText: { location: { tabId: "t.0", index: narrativeStart }, text: narrativeText } },
      ...expectedCellInsertions,
    ])
    expect(requests.filter((request) => request.insertDate)).toEqual([])
    expect(requests.filter((request) => request.updateParagraphStyle)).toEqual([
      {
        updateParagraphStyle: {
          range: { tabId: "t.0", startIndex: 9, endIndex: 10 },
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          fields: "namedStyleType",
        },
      },
      {
        updateParagraphStyle: {
          range: heading,
          paragraphStyle: { namedStyleType: "HEADING_2" },
          fields: "namedStyleType",
        },
      },
      {
        updateParagraphStyle: {
          range: body,
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          fields: "namedStyleType",
        },
      },
      ...expectedCellParagraphs,
    ])
    const serialized = JSON.stringify(requests)
    for (const copyOnlyField of [
      "lineSpacing",
      "spacingMode",
      "spaceAbove",
      "spaceBelow",
    ]) {
      expect(serialized).not.toContain(copyOnlyField)
    }
    expect(requests.filter((request) => request.updateTextStyle)).toEqual([
      { updateTextStyle: { range: heading, textStyle: { bold: true }, fields: "bold" } },
      { updateTextStyle: { range: body, textStyle: { bold: false }, fields: "bold" } },
      ...expectedCellTextStyles,
    ])
    expect(requests.filter((request) => request.updateTableRowStyle)).toEqual([
      {
        updateTableRowStyle: {
          tableStartLocation: { tabId: "t.0", index: 10 },
          rowIndices: [0, 1, 2],
          tableRowStyle: {
            minRowHeight: { magnitude: ELT_DOC_HIRE_TABLE_ROW_HEIGHT_PT, unit: "PT" },
          },
          fields: "minRowHeight",
        },
      },
    ])
    expect(requests.filter((request) => request.updateTableColumnProperties)).toEqual(
      ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT.map((width, columnIndex) => ({
        updateTableColumnProperties: {
          tableStartLocation: { tabId: "t.0", index: 10 },
          columnIndices: [columnIndex],
          tableColumnProperties: {
            widthType: "FIXED_WIDTH",
            width: { magnitude: width, unit: "PT" },
          },
          fields: "widthType,width",
        },
      }))
    )
    const dimension = (magnitude: number) => ({ magnitude, unit: "PT" })
    const gray = {
      color: {
        rgbColor: {
          red: ELT_DOC_HIRE_TABLE_BORDER_RGB,
          green: ELT_DOC_HIRE_TABLE_BORDER_RGB,
          blue: ELT_DOC_HIRE_TABLE_BORDER_RGB,
        },
      },
    }
    const border = (width: number, withGrayColor: boolean) => ({
      color: withGrayColor
        ? gray
        : { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
      width: dimension(width),
      dashStyle: "SOLID",
    })
    const padding = {
      paddingLeft: dimension(ELT_DOC_HIRE_TABLE_PADDING_PT),
      paddingRight: dimension(ELT_DOC_HIRE_TABLE_PADDING_PT),
      paddingTop: dimension(ELT_DOC_HIRE_TABLE_PADDING_PT),
      paddingBottom: dimension(ELT_DOC_HIRE_TABLE_PADDING_PT),
    }
    expect(requests.filter((request) => request.updateTableCellStyle)).toEqual([
      {
        updateTableCellStyle: {
          tableRange: {
            tableCellLocation: {
              tableStartLocation: { tabId: "t.0", index: 10 },
              rowIndex: 0,
              columnIndex: 0,
            },
            rowSpan: 1,
            columnSpan: 5,
          },
          tableCellStyle: {
            ...padding,
            contentAlignment: "MIDDLE",
            borderLeft: border(ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT, true),
            borderRight: border(ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT, true),
            borderTop: border(ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT, true),
            borderBottom: border(ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT, true),
          },
          fields:
            "paddingLeft,paddingRight,paddingTop,paddingBottom,contentAlignment," +
            "borderLeft,borderRight,borderTop,borderBottom",
        },
      },
      ...[1, 2].map((rowIndex) => ({
        updateTableCellStyle: {
          tableRange: {
            tableCellLocation: {
              tableStartLocation: { tabId: "t.0", index: 10 },
              rowIndex,
              columnIndex: 0,
            },
            rowSpan: 1,
            columnSpan: 5,
          },
          tableCellStyle: {
            ...padding,
            contentAlignment: "MIDDLE",
            backgroundColor: {
              color: {
                rgbColor:
                  rowIndex % 2 === 1
                    ? { red: 1, green: 1, blue: 1 }
                    : ELT_DOC_HIRE_TABLE_STRIPE_RGB,
              },
            },
            borderLeft: border(ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, false),
            borderRight: border(ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, false),
            borderTop: border(ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, true),
            borderBottom: border(ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, true),
          },
          fields:
            "backgroundColor,paddingLeft,paddingRight,paddingTop,paddingBottom," +
            "contentAlignment,borderLeft,borderRight,borderTop,borderBottom",
        },
      })),
    ])
  })

  test("omits narrative requests entirely when the plan carries no narrative paragraphs", () => {
    const requests = buildEltDocBatchUpdateRequests(
      plan({ factTable: { ...factTable, narrativeParagraphs: [] } })
    )
    // With zero narrative paragraphs the only insertText calls are the (non-empty)
    // hire-table cell fills — no bare joined-text insertText at the table's end.
    const insertTexts = requests.flatMap((request) => request.insertText?.text ?? [])
    expect(insertTexts).not.toContain("")
    expect(
      requests.filter((request) => request.insertText?.location?.index === 45)
    ).toEqual([])
  })

  test("prepares an exact fact-and-narrative rollback and leaves no-op replay mutation-free", () => {
    const rollback = buildEltDocRollbackRequests(
      plan(),
      { tabId: "t.0", startIndex: 9, endIndex: 90 }
    )
    expect(rollback.filter((request) => request.deleteContentRange)).toEqual([
      {
        deleteContentRange: { range: { tabId: "t.0", startIndex: 9, endIndex: 90 } },
      },
    ])
    rollback.forEach((request) => expect(Object.keys(request)).toHaveLength(1))
    expect(rollback.filter((request) => request.insertDate)).toEqual([])

    // Rollback table start is 10 (currentFactRange.startIndex 9, +1), one hire row
    // (rows.length = 2): emptyTableExtentEndIndex(10, 2) = 10 + 2 + 2 * 11 = 34.
    // The single rollback narrative paragraph ("Old line", 8 chars) occupies [34, 43).
    const rollbackInsertedText = rollback.flatMap((request) =>
      request.insertText?.text === undefined
        ? []
        : [{ index: request.insertText.location?.index, text: request.insertText.text }]
    )
    expect(rollbackInsertedText).toEqual([
      { index: 34, text: "Old line\n" },
      { index: 32, text: "2026-07-13" },
      { index: 30, text: "Old Candidate" },
      { index: 28, text: "P2" },
      { index: 26, text: "Old Dept" },
      { index: 24, text: "Old Role" },
      { index: 21, text: "Start Date" },
      { index: 19, text: "Candidate Name" },
      { index: 17, text: "Priority" },
      { index: 15, text: "Dept." },
      { index: 13, text: "Role" },
    ])
    expect(
      rollback.filter((request) => rangeStartIndex(request.updateParagraphStyle) === 34)
    ).toEqual([
      {
        updateParagraphStyle: {
          range: { tabId: "t.0", startIndex: 34, endIndex: 43 },
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          fields: "namedStyleType",
        },
      },
    ])
    expect(
      rollback.filter((request) => rangeStartIndex(request.updateTextStyle) === 34)
    ).toEqual([
      {
        updateTextStyle: {
          range: { tabId: "t.0", startIndex: 34, endIndex: 43 },
          textStyle: { bold: false },
          fields: "bold",
        },
      },
    ])
    expect(
      rollback
        .flatMap((request) =>
          (request as {
            updateTableCellStyle?: { tableCellStyle: { contentAlignment?: string } }
          }).updateTableCellStyle?.tableCellStyle.contentAlignment ?? []
        )
    ).toEqual(["MIDDLE", "MIDDLE"])
    for (const request of rollback) {
      const value = (
        request.updateTableRowStyle ??
        request.updateTableColumnProperties ??
        (request.updateTableCellStyle as {
          tableRange?: { tableCellLocation?: { tableStartLocation?: { index?: number } } }
        } | undefined)?.tableRange?.tableCellLocation
      ) as
        | { tableStartLocation?: { index?: number } }
        | undefined
      if (value?.tableStartLocation) {
        expect(value.tableStartLocation.index).toBe(10)
      }
    }
    expect(buildEltDocBatchUpdateRequests(plan({
      action: "no_op",
      contentGuardRange: { tabId: "t.0", startIndex: 10, endIndex: 80 },
      deleteRange: null,
      insertAt: null,
    }))).toEqual([])
  })

  // Docs models a freshly-inserted empty C-column table as: the table's own
  // opening boundary, then one boundary per row plus two units per empty cell,
  // then a closing boundary. So the first index OUTSIDE the table -- the only
  // place text may be inserted after it -- is `start + 2 + rows*(C*2+1)`.
  //
  // This mirrors, deliberately, the live-calibrated Google Docs API fixtures in
  // recruiting-ops-google-workspace-elt-doc-writer.test.ts and
  // recruiting-ops-staging-elt-doc-hydration-runner.test.ts, both of which put
  // the table's endIndex at `startIndex + 2 + rows.length * 11 + textLength` and
  // pin the LAST row's endIndex at `endIndex - 1`. The compiler once used
  // `+ 1` here, which aimed the narrative insert at that closing boundary --
  // inside the table, past the last row -- and Docs rejected the whole atomic
  // batch with HTTP 400. Nothing caught it because the fake Docs API in these
  // tests does not validate indices. Keep the two formulas in lockstep.
  function firstIndexAfterEmptyTable(tableStartIndex: number, rowCount: number): number {
    return tableStartIndex + 2 + rowCount * (ELT_DOC_HIRE_TABLE_HEADERS.length * 2 + 1)
  }

  test("aims the narrative tail outside the empty table, not at its closing boundary", () => {
    const inserted = plan({
      action: "insert_top_week",
      contentGuardRange: { tabId: "t.0", startIndex: 1, endIndex: 1 },
      deleteRange: null,
      insertAt: { tabId: "t.0", index: 1 },
      rollbackFactTable: null,
    })
    const requests = buildEltDocBatchUpdateRequests(inserted)

    // Heading occupies [1, 9), interstitial [9, 10), so the table starts at 10.
    const rowCount = 1 + factTable.hireRows.length
    const narrativeStart = firstIndexAfterEmptyTable(10, rowCount)
    expect(narrativeStart).toBe(45)

    const narrativeInsert = requests.find(
      (request) => request.insertText?.text === "Heading\nBody line\n"
    )
    expect(narrativeInsert).toEqual({
      insertText: { location: { tabId: "t.0", index: narrativeStart }, text: "Heading\nBody line\n" },
    })
    // The closing boundary is one below, and inserting there is what Docs refuses.
    expect(
      requests.filter((request) => request.insertText?.location?.index === narrativeStart - 1)
    ).toEqual([])
  })

  test("builds an absent-week heading, table, and narrative tail before an insertion", () => {
    const inserted = plan({
      action: "insert_top_week",
      contentGuardRange: { tabId: "t.0", startIndex: 1, endIndex: 1 },
      deleteRange: null,
      insertAt: { tabId: "t.0", index: 1 },
      rollbackFactTable: null,
    })
    const requests = buildEltDocBatchUpdateRequests(inserted)

    expect(requests.slice(0, 6)).toEqual([
      {
        insertText: { location: { tabId: "t.0", index: 1 }, text: "\n" },
      },
      {
        insertDate: {
          location: { tabId: "t.0", index: 1 },
          dateElementProperties: {
            timestamp: factTable.startTimestamp,
            locale: "en",
            dateFormat: "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
            timeFormat: "TIME_FORMAT_DISABLED",
          },
        },
      },
      {
        insertText: { location: { tabId: "t.0", index: 2 }, text: " - " },
      },
      {
        insertDate: {
          location: { tabId: "t.0", index: 5 },
          dateElementProperties: {
            timestamp: factTable.endTimestamp,
            locale: "en",
            dateFormat: "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
            timeFormat: "TIME_FORMAT_DISABLED",
          },
        },
      },
      {
        insertText: { location: { tabId: "t.0", index: 6 }, text: "  " },
      },
      {
        insertTable: {
          rows: 3,
          columns: 5,
          location: { tabId: "t.0", index: 9 },
        },
      },
    ])
    expect(
      requests.find((request) => request.updateTableRowStyle)?.updateTableRowStyle
    ).toMatchObject({
      tableStartLocation: { tabId: "t.0", index: 10 },
    })

    // Heading occupies index 1..9, table starts at 10 (insertionIndex + 9),
    // rows.length = 3: emptyTableExtentEndIndex(10, 3) = 45, same as the
    // replace-path test above — the table's own geometry does not depend on
    // whether it was inserted fresh or reused from a delimiter.
    expect(
      requests.filter((request) => request.insertText?.location?.index === 45)
    ).toEqual([
      { insertText: { location: { tabId: "t.0", index: 45 }, text: "Heading\nBody line\n" } },
    ])
    expect(
      requests.filter((request) => rangeStartIndex(request.updateParagraphStyle) === 45)
    ).toEqual([
      {
        updateParagraphStyle: {
          range: { tabId: "t.0", startIndex: 45, endIndex: 53 },
          paragraphStyle: { namedStyleType: "HEADING_2" },
          fields: "namedStyleType",
        },
      },
    ])
  })

  test("builds the same insert stream at a mid-archive boundary, shifted whole", () => {
    // The backfill shape: inserting a skipped week below the newest block. Every
    // request must be insertion-relative; the two heading styles were the only
    // absolute ranges left and would have styled the pushed-down block.
    const p = 137
    const inserted = plan({
      action: "insert_top_week",
      archiveBlockRange: { tabId: "t.0", startIndex: p, endIndex: p + 300 },
      contentGuardRange: { tabId: "t.0", startIndex: p, endIndex: p },
      deleteRange: null,
      insertAt: { tabId: "t.0", index: p },
      rollbackFactTable: null,
    })
    const requests = buildEltDocBatchUpdateRequests(inserted)

    expect(requests.slice(0, 6).map((request) =>
      request.insertText?.location?.index
      ?? request.insertDate?.location?.index
      ?? request.insertTable?.location?.index
    )).toEqual([p, p, p + 1, p + 4, p + 5, p + 8])

    const headingStyles = requests.filter(
      (request) => request.updateParagraphStyle
        && (rangeStartIndex(request.updateParagraphStyle) ?? Number.MAX_SAFE_INTEGER) < p + 9
    )
    expect(headingStyles).toEqual([
      {
        updateParagraphStyle: {
          range: { tabId: "t.0", startIndex: p, endIndex: p + 8 },
          paragraphStyle: { namedStyleType: "HEADING_2" },
          fields: "namedStyleType",
        },
      },
      {
        updateParagraphStyle: {
          range: { tabId: "t.0", startIndex: p + 8, endIndex: p + 9 },
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          fields: "namedStyleType",
        },
      },
    ])

    // Table starts at p+9; narrative lands one past the empty table's extent,
    // exactly as at the top of the archive.
    const rowCount = 1 + factTable.hireRows.length
    expect(
      requests.find((request) => request.updateTableRowStyle)?.updateTableRowStyle
    ).toMatchObject({ tableStartLocation: { tabId: "t.0", index: p + 9 } })
    const narrativeStart = firstIndexAfterEmptyTable(p + 9, rowCount)
    expect(
      requests.filter((request) => request.insertText?.location?.index === narrativeStart)
    ).toEqual([
      { insertText: { location: { tabId: "t.0", index: narrativeStart }, text: "Heading\nBody line\n" } },
    ])
  })

  test("a mid-archive rollback deletes the block at the planned insertion point", () => {
    const p = 137
    const inserted = plan({
      action: "insert_top_week",
      archiveBlockRange: { tabId: "t.0", startIndex: p, endIndex: p + 300 },
      contentGuardRange: { tabId: "t.0", startIndex: p, endIndex: p },
      deleteRange: null,
      insertAt: { tabId: "t.0", index: p },
      rollbackFactTable: null,
    })
    expect(buildEltDocRollbackRequests(
      inserted,
      { tabId: "t.0", startIndex: p, endIndex: p + 89 }
    )).toEqual([
      { deleteContentRange: { range: { tabId: "t.0", startIndex: p, endIndex: p + 89 } } },
    ])
    // A range that starts anywhere else is not the inserted block.
    expect(() => buildEltDocRollbackRequests(
      inserted,
      { tabId: "t.0", startIndex: 1, endIndex: 90 }
    )).toThrow("exact top fact-table block")
  })

  test("an absent-week rollback deletes only the inserted fact block", () => {
    const inserted = plan({
      action: "insert_top_week",
      contentGuardRange: { tabId: "t.0", startIndex: 1, endIndex: 1 },
      deleteRange: null,
      insertAt: { tabId: "t.0", index: 1 },
      rollbackFactTable: null,
    })
    expect(buildEltDocRollbackRequests(
      inserted,
      { tabId: "t.0", startIndex: 1, endIndex: 90 }
    )).toEqual([
      { deleteContentRange: { range: { tabId: "t.0", startIndex: 1, endIndex: 90 } } },
    ])
  })

  test.each([
    ["retired copy id", { documentId: P1_ELT_DOC_TARGET.deniedDocumentIds[0] }, "registered staging target"],
    ["wrong scope", { mutationScope: "other" as never }, "fact table"],
    ["non-top range", {
      contentGuardRange: { tabId: "t.0", startIndex: 2, endIndex: 80 },
      deleteRange: { tabId: "t.0", startIndex: 2, endIndex: 80 },
      insertAt: { tabId: "t.0", index: 2 },
    }, "table boundary"],
    ["insert whose insertion point is not the block start", {
      action: "insert_top_week" as const,
      archiveBlockRange: { tabId: "t.0", startIndex: 137, endIndex: 437 },
      contentGuardRange: { tabId: "t.0", startIndex: 137, endIndex: 137 },
      deleteRange: null,
      insertAt: { tabId: "t.0", index: 138 },
      rollbackFactTable: null,
    }, "archive-boundary preimage"],
    ["insert whose guard range is not collapsed at the insertion point", {
      action: "insert_top_week" as const,
      archiveBlockRange: { tabId: "t.0", startIndex: 137, endIndex: 437 },
      contentGuardRange: { tabId: "t.0", startIndex: 137, endIndex: 138 },
      deleteRange: null,
      insertAt: { tabId: "t.0", index: 137 },
      rollbackFactTable: null,
    }, "archive-boundary preimage"],
    ["replace below the top of the archive", {
      archiveBlockRange: { tabId: "t.0", startIndex: 137, endIndex: 437 },
      contentGuardRange: { tabId: "t.0", startIndex: 145, endIndex: 216 },
      deleteRange: { tabId: "t.0", startIndex: 145, endIndex: 216 },
      insertAt: { tabId: "t.0", index: 145 },
    }, "top boundary archive block"],
    ["unsafe cell", {
      factTable: { ...factTable, hireRows: [["Unsafe\nRole", "Dept", "P1", "Name", "TBD"]] },
    }, "unsafe text"],
    ["unsafe narrative text", {
      factTable: {
        ...factTable,
        narrativeParagraphs: [
          { kind: "body", text: "Unsafe\nline", namedStyleType: "NORMAL_TEXT", bold: false, tone: "ink" },
        ],
      },
    }, "unsafe text"],
    ["invalid narrative style", {
      factTable: {
        ...factTable,
        narrativeParagraphs: [
          { kind: "body", text: "Line", namedStyleType: "TITLE" as never, bold: false, tone: "ink" },
        ],
      },
    }, "style is invalid"],
  ] as const)("rejects %s before a Docs request exists", (_name, overrides, reason) => {
    expect(() => buildEltDocBatchUpdateRequests(plan(overrides))).toThrow(reason)
  })
})
