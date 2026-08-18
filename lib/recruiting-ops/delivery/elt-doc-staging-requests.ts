import { isSupportedFingerprint } from "../checksums"
import {
  ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
  ELT_DOC_HIRE_TABLE_BODY_FONT_PT,
  ELT_DOC_HIRE_TABLE_BORDER_RGB,
  ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT,
  ELT_DOC_HIRE_TABLE_CONTENT_ALIGNMENT,
  ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT,
  ELT_DOC_HIRE_TABLE_HEADERS,
  ELT_DOC_HIRE_TABLE_PADDING_PT,
  ELT_DOC_HIRE_TABLE_ROW_HEIGHT_PT,
  ELT_DOC_HIRE_TABLE_STRIPE_RGB,
  ELT_DOC_TOP_WEEK_FACTS_RANGE_ID,
  type EltDocDryRunPrivatePlan,
  type EltDocWeekPrefacePlan,
} from "./elt-doc-dry-run"
import type { EltDocParagraph } from "./elt-doc-renderer"
import { P1_ELT_DOC_TARGET } from "./p1-artifacts"

export interface EltDocRequestRange {
  tabId: string
  startIndex: number
  endIndex: number
}

export interface EltDocBatchUpdateRequest {
  deleteContentRange?: { range: EltDocRequestRange }
  insertText?: {
    location?: { tabId?: string; index?: number }
    text?: string
  }
  insertTable?: {
    rows?: number
    columns?: number
    location?: { tabId?: string; index?: number }
  }
  insertDate?: {
    location?: { tabId?: string; index?: number }
    dateElementProperties?: {
      timestamp?: string
      locale?: string
      dateFormat?: string
      timeFormat?: string
    }
  }
  updateParagraphStyle?: unknown
  updateTextStyle?: unknown
  updateTableRowStyle?: unknown
  updateTableColumnProperties?: unknown
  updateTableCellStyle?: unknown
}

interface EltDocDimension {
  magnitude: number
  unit: "PT"
}

interface EltDocOptionalColor {
  color: { rgbColor: { red: number; green: number; blue: number } }
}

interface EltDocTableCellBorder {
  color: EltDocOptionalColor
  width: EltDocDimension
  dashStyle: "SOLID"
}

interface EltDocTableCellStyle {
  paddingLeft: EltDocDimension
  paddingRight: EltDocDimension
  paddingTop: EltDocDimension
  paddingBottom: EltDocDimension
}

interface EltDocTableRange {
  tableCellLocation: {
    tableStartLocation: { tabId: string; index: number }
    rowIndex: number
    columnIndex: number
  }
  rowSpan: number
  columnSpan: number
}

const DOCS_STRIPPED_CHARACTER_PATTERN = /[\u0000-\u0008\u000B-\u001F\uE000-\uF8FF]/u
const PT = "PT"

/**
 * Purely compiles an approved private ELT plan to the exact tab-scoped Docs
 * requests. The actual Google mutation remains confined to the staging client.
 */
export function buildEltDocBatchUpdateRequests(
  plan: EltDocDryRunPrivatePlan
): readonly EltDocBatchUpdateRequest[] {
  assertEltDocPrivatePlan(plan)
  if (plan.action === "no_op") return []
  const requests: EltDocBatchUpdateRequest[] = []
  if (plan.deleteRange) {
    requests.push({ deleteContentRange: { range: { ...plan.deleteRange } } })
  }
  if (plan.action === "insert_top_week") {
    appendFactTableRequests(requests, plan.tabId, plan.factTable, plan.insertAt!.index)
  } else {
    appendHireTableRequests(requests, plan.tabId, plan.factTable, plan.insertAt!.index)
  }
  return requests
}

export function buildEltDocRollbackRequests(
  plan: EltDocDryRunPrivatePlan,
  currentFactRange: EltDocRequestRange
): readonly EltDocBatchUpdateRequest[] {
  assertEltDocPrivatePlan(plan)
  if (plan.action === "no_op") throw new Error("ELT no-op has no rollback requests.")
  assertRange(currentFactRange, plan.tabId)
  // For an insert the rollback deletes the block that appeared at the planned
  // insertion point; at the top of the archive that index is 1, which is what
  // this used to hard-code.
  const expectedStart =
    plan.action === "insert_top_week"
      ? plan.insertAt!.index
      : plan.contentGuardRange.startIndex
  if (
    currentFactRange.startIndex !== expectedStart ||
    currentFactRange.endIndex <= expectedStart
  ) {
    throw new Error("ELT rollback range must be the exact top fact-table block.")
  }
  const requests: EltDocBatchUpdateRequest[] = [
    { deleteContentRange: { range: { ...currentFactRange } } },
  ]
  if (plan.rollbackFactTable) {
    appendHireTableRequests(
      requests,
      plan.tabId,
      plan.rollbackFactTable,
      currentFactRange.startIndex
    )
  }
  return requests
}

function appendFactTableRequests(
  requests: EltDocBatchUpdateRequest[],
  tabId: string,
  preface: EltDocWeekPrefacePlan,
  insertionIndex: number
): void {
  const rows = [ELT_DOC_HIRE_TABLE_HEADERS, ...preface.hireRows]
  const tableStartIndex = insertionIndex + 9

  // Build the heading inside the already-observed top paragraph before
  // inserting the table. This removes the compiler's dependency on the
  // paragraph Docs creates ahead of an inserted table while preserving the
  // final heading 1..9, interstitial newline 9..10, and table start at 10.
  requests.push({
    insertText: { location: { tabId, index: insertionIndex }, text: "\n" },
  })
  requests.push({
    insertDate: {
      location: { tabId, index: insertionIndex },
      dateElementProperties: dateProperties(preface.startTimestamp),
    },
  })
  requests.push({
    insertText: { location: { tabId, index: insertionIndex + 1 }, text: " - " },
  })
  requests.push({
    insertDate: {
      location: { tabId, index: insertionIndex + 4 },
      dateElementProperties: dateProperties(preface.endTimestamp),
    },
  })
  requests.push({
    insertText: { location: { tabId, index: insertionIndex + 5 }, text: "  " },
  })
  requests.push({
    insertTable: {
      rows: rows.length,
      columns: ELT_DOC_HIRE_TABLE_HEADERS.length,
      location: { tabId, index: insertionIndex + 8 },
    },
  })
  // Insertion-relative like every other request in this stream: the inserted
  // heading occupies [p, p+8) and its interstitial newline [p+8, p+9). At the
  // top of the archive (p = 1) these are the historical {1,9}/{9,10} bytes; at
  // a mid-archive boundary, absolute ranges would style the pushed-down
  // block's heading instead of the one just inserted.
  requests.push({
    updateParagraphStyle: {
      range: { tabId, startIndex: insertionIndex, endIndex: insertionIndex + 8 },
      paragraphStyle: { namedStyleType: "HEADING_2" },
      fields: "namedStyleType",
    },
  })
  requests.push({
    updateParagraphStyle: {
      range: { tabId, startIndex: insertionIndex + 8, endIndex: insertionIndex + 9 },
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      fields: "namedStyleType",
    },
  })

  appendNarrativeRequests(
    requests,
    tabId,
    preface.narrativeParagraphs,
    emptyTableExtentEndIndex(tableStartIndex, rows.length)
  )
  appendHireTableContentAndStyleRequests(requests, tabId, rows, tableStartIndex)
}

function appendHireTableRequests(
  requests: EltDocBatchUpdateRequest[],
  tabId: string,
  preface: EltDocWeekPrefacePlan,
  insertionIndex: number
): void {
  const rows = [ELT_DOC_HIRE_TABLE_HEADERS, ...preface.hireRows]
  const tableStartIndex = insertionIndex + 1
  requests.push({
    insertTable: {
      rows: rows.length,
      columns: ELT_DOC_HIRE_TABLE_HEADERS.length,
      location: { tabId, index: insertionIndex },
    },
  })
  requests.push({
    updateParagraphStyle: {
      range: {
        tabId,
        startIndex: insertionIndex,
        endIndex: tableStartIndex,
      },
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      fields: "namedStyleType",
    },
  })
  appendNarrativeRequests(
    requests,
    tabId,
    preface.narrativeParagraphs,
    emptyTableExtentEndIndex(tableStartIndex, rows.length)
  )
  appendHireTableContentAndStyleRequests(requests, tabId, rows, tableStartIndex)
}

/**
 * The empty table's own extent (rows*columns of freshly-inserted blank
 * cells, before any cell text exists) is deterministic from its row count:
 * each cell consumes 2 index units (its own boundary + placeholder newline),
 * each row consumes 1 more for its own boundary, and the table itself consumes
 * one at each end — an opening boundary before the first row and a closing
 * boundary after the last. This returns the first index *outside* the table,
 * which is where the narrative tail is inserted.
 *
 * Both trailing units are load-bearing. Counting only the opening one aims the
 * narrative at the closing boundary instead: a position inside the table, past
 * the last row and inside no cell, which Docs rejects with HTTP 400 — failing
 * the whole atomic batch and writing nothing. The live-calibrated Docs fixtures
 * in recruiting-ops-google-workspace-elt-doc-writer.test.ts and
 * recruiting-ops-staging-elt-doc-hydration-runner.test.ts encode the same
 * geometry as `startIndex + 2 + rows.length * 11 + textLength`, with the last
 * row ending at `endIndex - 1`; keep this in lockstep with them.
 */
function emptyTableExtentEndIndex(tableStartIndex: number, rowCount: number): number {
  return tableStartIndex + 2 + rowCount * (ELT_DOC_HIRE_TABLE_HEADERS.length * 2 + 1)
}

/**
 * Narrative sits at the highest position of the whole compiled block (after
 * the table), so it is inserted before any cell fill: once its text exists,
 * every still-lower table-cell position computed from the empty-table
 * arithmetic remains valid, since Docs only shifts indices at-or-after an
 * insertion point.
 */
function appendNarrativeRequests(
  requests: EltDocBatchUpdateRequest[],
  tabId: string,
  narrativeParagraphs: readonly EltDocParagraph[],
  narrativeStartIndex: number
): void {
  if (narrativeParagraphs.length === 0) return
  const text = `${narrativeParagraphs.map((paragraph) => paragraph.text).join("\n")}\n`
  requests.push({
    insertText: { location: { tabId, index: narrativeStartIndex }, text },
  })
  let cursor = narrativeStartIndex
  for (const paragraph of narrativeParagraphs) {
    const endIndex = cursor + paragraph.text.length + 1
    const range = { tabId, startIndex: cursor, endIndex }
    requests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle: { namedStyleType: paragraph.namedStyleType },
        fields: "namedStyleType",
      },
    })
    requests.push({
      updateTextStyle: {
        range: { ...range },
        textStyle: { bold: paragraph.bold },
        fields: "bold",
      },
    })
    cursor = endIndex
  }
}

function appendHireTableContentAndStyleRequests(
  requests: EltDocBatchUpdateRequest[],
  tabId: string,
  rows: readonly (readonly string[])[],
  tableStartIndex: number
): void {
  appendHireTableStyleRequests(requests, tabId, rows.length, tableStartIndex)
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    for (let columnIndex = ELT_DOC_HIRE_TABLE_HEADERS.length - 1; columnIndex >= 0; columnIndex -= 1) {
      const text = rows[rowIndex][columnIndex]
      const startIndex = emptyTableCellInsertionIndex(
        tableStartIndex,
        rowIndex,
        columnIndex
      )
      const range = {
        tabId,
        startIndex,
        endIndex: startIndex + text.length + 1,
      }
      if (text.length > 0) {
        requests.push({
          insertText: { location: { tabId, index: startIndex }, text },
        })
      }
      requests.push({
        updateParagraphStyle: {
          range,
          paragraphStyle: { namedStyleType: "NORMAL_TEXT", alignment: "CENTER" },
          fields: "namedStyleType,alignment",
        },
      })
      requests.push({
        updateTextStyle: {
          range: { ...range },
          textStyle:
            rowIndex === 0
              ? { bold: true }
              : {
                  bold: false,
                  fontSize: dimension(ELT_DOC_HIRE_TABLE_BODY_FONT_PT),
                },
          fields: rowIndex === 0 ? "bold" : "bold,fontSize",
        },
      })
    }
  }
}

function appendHireTableStyleRequests(
  requests: EltDocBatchUpdateRequest[],
  tabId: string,
  rowCount: number,
  tableStartIndex: number
): void {
  const tableStartLocation = { tabId, index: tableStartIndex }
  requests.push({
    updateTableRowStyle: {
      tableStartLocation,
      rowIndices: Array.from({ length: rowCount }, (_, index) => index),
      tableRowStyle: { minRowHeight: dimension(ELT_DOC_HIRE_TABLE_ROW_HEIGHT_PT) },
      fields: "minRowHeight",
    },
  })
  ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT.forEach((width, columnIndex) => {
    requests.push({
      updateTableColumnProperties: {
        tableStartLocation,
        columnIndices: [columnIndex],
        tableColumnProperties: { widthType: "FIXED_WIDTH", width: dimension(width) },
        fields: "widthType,width",
      },
    })
  })
  requests.push({
    updateTableCellStyle: {
      tableRange: tableRange(tabId, tableStartIndex, 0, 1),
      tableCellStyle: {
        ...cellPadding(),
        contentAlignment: ELT_DOC_HIRE_TABLE_CONTENT_ALIGNMENT,
        borderLeft: border(ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT, true),
        borderRight: border(ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT, true),
        borderTop: border(ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT, true),
        borderBottom: border(ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT, true),
      },
      fields:
        "paddingLeft,paddingRight,paddingTop,paddingBottom,contentAlignment,borderLeft,borderRight,borderTop,borderBottom",
    },
  })
  for (let rowIndex = 1; rowIndex < rowCount; rowIndex += 1) {
    requests.push({
      updateTableCellStyle: {
        tableRange: tableRange(tabId, tableStartIndex, rowIndex, 1),
        tableCellStyle: {
          ...cellPadding(),
          contentAlignment: ELT_DOC_HIRE_TABLE_CONTENT_ALIGNMENT,
          backgroundColor: color(
            rowIndex % 2 === 1 ? { red: 1, green: 1, blue: 1 } : ELT_DOC_HIRE_TABLE_STRIPE_RGB
          ),
          borderLeft: border(ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, false),
          borderRight: border(ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, false),
          borderTop: border(ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, true),
          borderBottom: border(ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, true),
        },
        fields:
          "backgroundColor,paddingLeft,paddingRight,paddingTop,paddingBottom,contentAlignment," +
          "borderLeft,borderRight,borderTop,borderBottom",
      },
    })
  }
}

function emptyTableCellInsertionIndex(
  tableStartIndex: number,
  rowIndex: number,
  columnIndex: number
): number {
  return (
    tableStartIndex +
    3 +
    rowIndex * (ELT_DOC_HIRE_TABLE_HEADERS.length * 2 + 1) +
    columnIndex * 2
  )
}

function dateProperties(timestamp: string) {
  return {
    timestamp,
    locale: "en",
    dateFormat: "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
    timeFormat: "TIME_FORMAT_DISABLED",
  }
}

function dimension(magnitude: number): EltDocDimension {
  return { magnitude, unit: PT }
}

function color(rgbColor: { red: number; green: number; blue: number }): EltDocOptionalColor {
  return { color: { rgbColor: { ...rgbColor } } }
}

function border(width: number, gray: boolean): EltDocTableCellBorder {
  return {
    // OptionalColor without `color` is transparent, which Docs rejects for a
    // table border. Body side borders are the observed opaque-black default.
    color: color({
      red: gray ? ELT_DOC_HIRE_TABLE_BORDER_RGB : 0,
      green: gray ? ELT_DOC_HIRE_TABLE_BORDER_RGB : 0,
      blue: gray ? ELT_DOC_HIRE_TABLE_BORDER_RGB : 0,
    }),
    width: dimension(width),
    dashStyle: "SOLID",
  }
}

function cellPadding(): Pick<
  EltDocTableCellStyle,
  "paddingLeft" | "paddingRight" | "paddingTop" | "paddingBottom"
> {
  return {
    paddingLeft: dimension(ELT_DOC_HIRE_TABLE_PADDING_PT),
    paddingRight: dimension(ELT_DOC_HIRE_TABLE_PADDING_PT),
    paddingTop: dimension(ELT_DOC_HIRE_TABLE_PADDING_PT),
    paddingBottom: dimension(ELT_DOC_HIRE_TABLE_PADDING_PT),
  }
}

function tableRange(
  tabId: string,
  tableStartIndex: number,
  rowIndex: number,
  rowSpan: number
): EltDocTableRange {
  return {
    tableCellLocation: {
      tableStartLocation: { tabId, index: tableStartIndex },
      rowIndex,
      columnIndex: 0,
    },
    rowSpan,
    columnSpan: ELT_DOC_HIRE_TABLE_HEADERS.length,
  }
}

export function eltDocPreMutationRange(plan: EltDocDryRunPrivatePlan): EltDocRequestRange {
  assertEltDocPrivatePlan(plan)
  return { ...plan.contentGuardRange }
}

function assertEltDocPrivatePlan(plan: EltDocDryRunPrivatePlan): void {
  if (plan.documentId !== P1_ELT_DOC_TARGET.stagingDocumentId) {
    throw new Error("ELT document plan is not bound to the exact registered staging target.")
  }
  if (plan.tabId !== P1_ELT_DOC_TARGET.tabId) {
    throw new Error("ELT document plan is not bound to the exact approved staging tab.")
  }
  if (!plan.runId.trim()) throw new Error("ELT document plan run id is required.")
  if (Number.isNaN(Date.parse(plan.sourceGeneratedAt))) {
    throw new Error("ELT document plan sourceGeneratedAt must be a valid timestamp.")
  }
  if (plan.dataProvenance !== "live") {
    throw new Error("ELT staging document writes require live fingerprint provenance.")
  }
  if (!plan.requiredRevisionId.trim()) {
    throw new Error("ELT document plan requires a Docs revision guard.")
  }
  if (
    !isSupportedFingerprint(plan.payloadFingerprint) ||
    !plan.payloadFingerprint.startsWith("hmac-sha256:") ||
    !isSupportedFingerprint(plan.preimageFingerprint) ||
    !plan.preimageFingerprint.startsWith("hmac-sha256:") ||
    !isSupportedFingerprint(plan.preimageDocumentFingerprint) ||
    !plan.preimageDocumentFingerprint.startsWith("hmac-sha256:") ||
    !isSupportedFingerprint(plan.outsideContentFingerprint) ||
    !plan.outsideContentFingerprint.startsWith("hmac-sha256:")
  ) {
    throw new Error("ELT document plan requires live HMAC payload and outside-content fingerprints.")
  }
  if (
    plan.approvedRangeIds.length !== 1 ||
    plan.approvedRangeIds[0] !== ELT_DOC_TOP_WEEK_FACTS_RANGE_ID ||
    plan.mutationScope !== "weekly_fact_table"
  ) {
    throw new Error("ELT document plan is not bound to the governed top-week fact table.")
  }
  assertFactTable(plan.factTable)
  assertRange(plan.archiveBlockRange, plan.tabId)
  assertRange(plan.contentGuardRange, plan.tabId)
  if (
    plan.contentGuardRange.startIndex < plan.archiveBlockRange.startIndex ||
    plan.contentGuardRange.endIndex > plan.archiveBlockRange.endIndex
  ) {
    throw new Error("ELT document fact table must stay inside the top boundary archive block.")
  }
  // Replace and no-op operate on an existing top-week block and remain pinned
  // to the top of the archive; only an insert may target a lower boundary.
  if (plan.action !== "insert_top_week" && plan.archiveBlockRange.startIndex !== 1) {
    throw new Error("ELT document fact table must stay inside the top boundary archive block.")
  }
  if (plan.action === "insert_top_week") {
    if (
      plan.deleteRange !== null ||
      plan.rollbackFactTable !== null ||
      !plan.insertAt ||
      plan.insertAt.index < 1 ||
      plan.insertAt.index !== plan.archiveBlockRange.startIndex ||
      plan.contentGuardRange.startIndex !== plan.insertAt.index ||
      plan.contentGuardRange.endIndex !== plan.insertAt.index ||
      plan.archiveBlockRange.endIndex <= plan.insertAt.index
    ) {
      throw new Error("ELT insertion plan is not bound to the exact archive-boundary preimage.")
    }
    assertLocation(plan.insertAt, plan.tabId)
    return
  }
  if (!plan.rollbackFactTable) throw new Error("ELT existing-week plan requires its exact rollback fact table.")
  assertFactTable(plan.rollbackFactTable)

  if (plan.action === "replace_top_week") {
    if (!plan.deleteRange || !plan.insertAt) {
      throw new Error("ELT replacement requires both an exact delete range and insertion point.")
    }
    assertRange(plan.deleteRange, plan.tabId)
    assertLocation(plan.insertAt, plan.tabId)
    if (plan.deleteRange.endIndex <= plan.deleteRange.startIndex) {
      throw new Error("ELT replacement delete range must be non-empty.")
    }
    if (
      plan.insertAt.index !== plan.deleteRange.startIndex ||
      plan.deleteRange.startIndex !== 9
    ) {
      throw new Error(
        "ELT replacement must stay at the owned top-week delimiter/table boundary."
      )
    }
    if (!sameRange(plan.contentGuardRange, plan.deleteRange)) {
      throw new Error("ELT replacement guard range must equal the deleted fact table.")
    }
    return
  }
  if (plan.action === "no_op") {
    if (plan.deleteRange || plan.insertAt) {
      throw new Error("ELT no-op plan must not contain a mutation range.")
    }
    if (plan.contentGuardRange.endIndex <= plan.contentGuardRange.startIndex) {
      throw new Error("ELT no-op content guard must cover the existing fact table.")
    }
    if (plan.contentGuardRange.startIndex < 10) {
      throw new Error(
        "ELT no-op content guard must exclude the human-authored interstitial text."
      )
    }
    return
  }
  throw new Error("ELT document plan contains an unsupported action.")
}

function assertFactTable(preface: EltDocWeekPrefacePlan): void {
  const start = Date.parse(preface.startTimestamp)
  const end = Date.parse(preface.endTimestamp)
  const displayedStart = Date.parse(`${preface.startDisplayText} 12:00:00 UTC`)
  const displayedEnd = Date.parse(`${preface.endDisplayText} 12:00:00 UTC`)
  if (
    preface.weekLabel !== `${preface.startDisplayText} - ${preface.endDisplayText}` ||
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start !== displayedStart ||
    end !== displayedEnd ||
    end - start !== 6 * 24 * 60 * 60 * 1_000 ||
    new Date(start).getUTCHours() !== 12
  ) {
    throw new Error("ELT fact-table date-chip plan is invalid.")
  }
  for (const row of preface.hireRows) {
    if (row.length !== ELT_DOC_HIRE_TABLE_HEADERS.length) {
      throw new Error("ELT fact-table row has an invalid column count.")
    }
    for (const value of row) {
      if (
        typeof value !== "string" ||
        value.includes("\n") ||
        value.includes("\r") ||
        DOCS_STRIPPED_CHARACTER_PATTERN.test(value)
      ) {
        throw new Error("ELT fact-table cell contains unsafe text.")
      }
    }
  }
  for (const paragraph of preface.narrativeParagraphs) {
    if (
      typeof paragraph.text !== "string" ||
      paragraph.text.includes("\n") ||
      paragraph.text.includes("\r") ||
      DOCS_STRIPPED_CHARACTER_PATTERN.test(paragraph.text)
    ) {
      throw new Error("ELT narrative paragraph contains unsafe text.")
    }
    if (
      paragraph.namedStyleType !== "HEADING_1" &&
      paragraph.namedStyleType !== "HEADING_2" &&
      paragraph.namedStyleType !== "NORMAL_TEXT"
    ) {
      throw new Error("ELT narrative paragraph style is invalid.")
    }
  }
}

function assertRange(range: EltDocRequestRange, tabId: string): void {
  assertLocation({ tabId: range.tabId, index: range.startIndex }, tabId)
  if (!Number.isInteger(range.endIndex) || range.endIndex < range.startIndex) {
    throw new Error("ELT document range end must be an integer at or after its start.")
  }
}

function assertLocation(location: { tabId: string; index: number }, tabId: string): void {
  if (location.tabId !== tabId || location.tabId !== P1_ELT_DOC_TARGET.tabId) {
    throw new Error("ELT document mutation range targets an unapproved tab.")
  }
  if (!Number.isInteger(location.index) || location.index < 1) {
    throw new Error("ELT document mutation index must be an integer within the document body.")
  }
}

function sameRange(left: EltDocRequestRange, right: EltDocRequestRange): boolean {
  return (
    left.tabId === right.tabId &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  )
}
