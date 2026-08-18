import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { PII_FINGERPRINT_SALT_ENV } from "../lib/recruiting-ops/checksums"
import {
  ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
  ELT_DOC_HIRE_TABLE_BODY_FONT_PT,
  ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT,
  ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT,
  ELT_DOC_HIRE_TABLE_HEADERS,
  ELT_DOC_HIRE_TABLE_STRIPE_RGB,
  planEltDocDryRun,
  type GoogleDocsDocumentSnapshot,
  type GoogleDocsStructuralElement,
} from "../lib/recruiting-ops/delivery/elt-doc-dry-run"
import { P1_ELT_DOC_TARGET } from "../lib/recruiting-ops/delivery/p1-artifacts"
import {
  renderEltDocBlock,
  renderEltDocRoleProgressParagraphs,
  type EltDocParagraph,
} from "../lib/recruiting-ops/delivery/elt-doc-renderer"
import type { ExecSnapshotRow } from "../lib/recruiting-ops/exec-snapshot-store"
import type { ExecEltFacts } from "../lib/recruiting-ops/modules/exec-state-of-play"
import golden from "./fixtures/recruiting-ops/elt-doc-render-golden.json"

const originalSalt = process.env[PII_FINGERPRINT_SALT_ENV]

beforeEach(() => {
  process.env[PII_FINGERPRINT_SALT_ENV] = "elt-doc-plan-test-only-salt"
})

afterEach(() => {
  if (originalSalt === undefined) delete process.env[PII_FINGERPRINT_SALT_ENV]
  else process.env[PII_FINGERPRINT_SALT_ENV] = originalSalt
})

const facts: ExecEltFacts = {
  generatedAt: "2026-07-11T01:45:00.000Z",
  weekLabel: "Jul 3, 2026 - Jul 9, 2026",
  weekShort: "Jul 3 - Jul 9",
  hires: [
    {
      candidate: "Amina Vega",
      role: "Research Engineer",
      reqId: 1118,
      startsOn: "2026-07-20",
      department: "Frontier Data",
      priority: "P1",
      location: "Brazil",
    },
    {
      candidate: "Theo Park",
      role: "Product Engineer",
      reqId: 907,
      startsOn: null,
      department: null,
      priority: "P2",
      location: null,
    },
  ],
  hiresNote:
    "Org-wide accepted offers, Jul 3 - Jul 9. Interviews conducted are truthed by submitted scorecards.",
  sections: [
    {
      title: "FDE + PE",
      subs: ["PE", "FDE"],
      qtdOffers: {
        total: 2,
        subs: [
          { label: "PE", count: 1 },
          { label: "FDE", count: 1 },
        ],
        names: ["Amina Vega", "Theo Park"],
      },
      stages: [
        {
          label: "RPS",
          conducted: 0,
          passed: 0,
          subs: [
            { label: "PE", conducted: 0, passed: 0 },
            { label: "FDE", conducted: 0, passed: 0 },
          ],
        },
        {
          label: "HM Review",
          conducted: 1,
          passed: 1,
          subs: [
            { label: "PE", conducted: 1, passed: 1 },
            { label: "FDE", conducted: 0, passed: 0 },
          ],
        },
        {
          label: "Manager/Tech Screen",
          conducted: 2,
          passed: 1,
          subs: [
            { label: "PE", conducted: 1, passed: 1 },
            { label: "FDE", conducted: 1, passed: 0 },
          ],
        },
        {
          label: "Assessment",
          conducted: 0,
          passed: 0,
          subs: [
            { label: "PE", conducted: 0, passed: 0 },
            { label: "FDE", conducted: 0, passed: 0 },
          ],
        },
        {
          label: "Onsite Interviews",
          conducted: 3,
          passed: 2,
          subs: [
            { label: "PE", conducted: 2, passed: 1 },
            { label: "FDE", conducted: 1, passed: 1 },
          ],
        },
      ],
      weekOffers: {
        total: 1,
        subs: [
          { label: "PE", count: 0 },
          { label: "FDE", count: 1 },
        ],
        names: ["Theo Park"],
      },
    },
  ],
}

function makeSnapshot(
  eltFacts: ExecEltFacts = facts,
  overrides: Partial<ExecSnapshotRow> = {}
): ExecSnapshotRow {
  return {
    run_id: "e01_fixture_20260711015000000",
    workflow_id: "E01",
    mode: "shadow",
    generated_at: "2026-07-11T01:50:00.000Z",
    org_rollup: {
      as_of: "2026-07-11T01:45:00.000Z",
      reporting_week_friday: "2026-07-10",
      open_roles: 0,
      pools_campaigns_templates: 0,
      red: 0,
      amber: 0,
      green: 0,
      seats: 0,
      unowned_roles: 0,
      offers_accepted_12wk: 0,
      momentum: {},
      tiers: { in_play: 0, gone_quiet: 0, filled_not_closed: 0, no_search: 0 },
      attention_count: 0,
      positions_in_play: 0,
      offers_out: { count: 0, waiting_14d_plus: 0 },
      off_scope_scorecards: 0,
      conducted_unattributed_stage: 0,
      truncation_suspected_pulls: 0,
    },
    req_rows: [],
    hires: [],
    elt_facts: eltFacts,
    ...overrides,
  }
}

function paragraph(startIndex: number, endIndex: number, text: string): GoogleDocsStructuralElement {
  return {
    startIndex,
    endIndex,
    paragraph: {
      elements: [{ textRun: { content: text } }],
    },
  }
}

function makeArchiveDoc(
  topWeek = facts.weekLabel,
  secondWeek = "Jun 26, 2026 - Jul 2, 2026",
  topStartIndex = 1
): GoogleDocsDocumentSnapshot {
  return {
    documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
    title: P1_ELT_DOC_TARGET.expectedTitle,
    revisionId: "revision-fixture-7",
    tabs: [
      {
        tabProperties: { tabId: P1_ELT_DOC_TARGET.tabId, title: "ELT update" },
        documentTab: {
          body: {
            content: [
              { startIndex: 0, endIndex: 1, sectionBreak: {} },
              paragraph(topStartIndex, 50, `${topWeek}\n`),
              paragraph(50, 90, `Hires: (Offer Accepted b/w ${shortWeek(topWeek)})\n`),
              paragraph(90, 1562, "Legacy current block body.\n"),
              paragraph(1562, 1600, `${secondWeek}\n`),
              paragraph(1600, 1640, `Hires: (Offer Accepted b/w ${shortWeek(secondWeek)})\n`),
              paragraph(1640, 1700, "Older archive body.\n"),
            ],
          },
        },
      },
    ],
  }
}

function shortWeek(label: string): string {
  return label.replace(/, \d{4}/g, "")
}

function dateChipHeading(
  startIndex: number,
  endIndex: number,
  startDisplay: string,
  endDisplay: string
): GoogleDocsStructuralElement {
  return {
    startIndex,
    endIndex,
    paragraph: {
      paragraphStyle: { namedStyleType: "HEADING_2" },
      elements: [
        {
          dateElement: {
            dateElementProperties: {
              displayText: startDisplay,
              timestamp: new Date(`${startDisplay} 12:00:00 UTC`).toISOString(),
              locale: "en",
              dateFormat: "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
              timeFormat: "TIME_FORMAT_DISABLED",
            },
          },
        },
        { textRun: { content: " - " } },
        {
          dateElement: {
            dateElementProperties: {
              displayText: endDisplay,
              timestamp: new Date(`${endDisplay} 12:00:00 UTC`).toISOString(),
              locale: "en",
              dateFormat: "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
              timeFormat: "TIME_FORMAT_DISABLED",
            },
          },
        },
        { textRun: { content: "  \n" } },
      ],
    },
  }
}

function blankParagraph(startIndex: number): GoogleDocsStructuralElement {
  return {
    startIndex,
    endIndex: startIndex + 1,
    paragraph: {
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      elements: [{ textRun: { content: "\n" } }],
    },
  }
}

function observedHireTable(
  startIndex: number,
  endIndex: number,
  hireRows: readonly (readonly [string, string, string, string, string])[],
  bodyBackgrounds: readonly ("white" | "stripe")[] = []
): GoogleDocsStructuralElement {
  const rows = [ELT_DOC_HIRE_TABLE_HEADERS, ...hireRows]
  const dimension = (magnitude: number) => ({ magnitude, unit: "PT" })
  const gray = { color: { rgbColor: { red: 0.8, green: 0.8, blue: 0.8 } } }
  const border = (width: number, withColor: boolean) => ({
    ...(withColor ? { color: gray } : {}),
    width: dimension(width),
    dashStyle: "SOLID",
  })
  return {
    startIndex,
    endIndex,
    table: {
      rows: rows.length,
      columns: 5,
      tableStyle: {
        tableColumnProperties: ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT.map((width) => ({
          widthType: "FIXED_WIDTH",
          width: dimension(width),
        })),
      },
      tableRows: rows.map((row, rowIndex) => ({
        tableRowStyle: { minRowHeight: dimension(27) },
        tableCells: row.map((text) => ({
          tableCellStyle: {
            ...(rowIndex > 0
              ? {
                  backgroundColor: {
                    color: {
                      rgbColor:
                        (bodyBackgrounds[rowIndex - 1] ??
                          (rowIndex % 2 === 1 ? "white" : "stripe")) === "white"
                          ? { red: 1, green: 1, blue: 1 }
                          : ELT_DOC_HIRE_TABLE_STRIPE_RGB,
                    },
                  },
                }
              : {}),
            borderLeft: border(
              rowIndex === 0
                ? ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT
                : ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
              rowIndex === 0
            ),
            borderRight: border(
              rowIndex === 0
                ? ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT
                : ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
              rowIndex === 0
            ),
            borderTop: border(
              rowIndex === 0
                ? ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT
                : ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
              true
            ),
            borderBottom: border(
              ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
              true
            ),
            paddingLeft: dimension(2),
            paddingRight: dimension(2),
            paddingTop: dimension(2),
            paddingBottom: dimension(2),
            contentAlignment: "MIDDLE",
          },
          content: [
            {
              paragraph: {
                paragraphStyle: {
                  namedStyleType: "NORMAL_TEXT",
                  alignment: "CENTER",
                },
                elements: [
                  {
                    textRun: {
                      content: `${text}\n`,
                      textStyle:
                        rowIndex === 0
                          ? { bold: true }
                          : { bold: false, fontSize: dimension(ELT_DOC_HIRE_TABLE_BODY_FONT_PT) },
                    },
                  },
                ],
              },
            },
          ],
        })),
      })),
    },
  }
}

function liveSmartChipArchiveDoc(
  bodyBackgrounds: readonly ("white" | "stripe")[] = ["white"],
  topWeekLabel = facts.weekLabel,
  previousWeekLabel = "Jun 26, 2026 - Jul 2, 2026"
): GoogleDocsDocumentSnapshot {
  const [topStartDisplay, topEndDisplay] = topWeekLabel.split(" - ")
  const [previousStartDisplay, previousEndDisplay] = previousWeekLabel.split(" - ")
  const hireRows = bodyBackgrounds.map((_, index) => [
    `Role ${index + 1}`,
    `Department ${index + 1}`,
    "P1",
    `Candidate ${index + 1}`,
    "2026-07-20",
  ] as const)
  return {
    documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
    title: P1_ELT_DOC_TARGET.expectedTitle,
    revisionId: "revision-smart-chip-copy",
    tabs: [
      {
        tabProperties: { tabId: P1_ELT_DOC_TARGET.tabId, title: "Tab 1" },
        documentTab: {
          body: {
            content: [
              { startIndex: 0, endIndex: 1, sectionBreak: {} },
              dateChipHeading(1, 9, topStartDisplay, topEndDisplay),
              blankParagraph(9),
              observedHireTable(10, 464, hireRows, bodyBackgrounds),
              paragraph(464, 510, `Hires: (Offer Accepted b/w ${shortWeek(topWeekLabel)})\n`),
              paragraph(510, 1562, "Current narrative body.\n"),
              dateChipHeading(1562, 1570, previousStartDisplay, previousEndDisplay),
              blankParagraph(1570),
              { startIndex: 1571, endIndex: 1734, table: { tableRows: [] } },
              paragraph(1734, 1780, `Hires: (Offer Accepted b/w ${shortWeek(previousWeekLabel)})\n`),
              paragraph(1780, 1900, "Older narrative body.\n"),
            ],
          },
        },
      },
    ],
  }
}

function plan(document = makeArchiveDoc(), snapshot = makeSnapshot()) {
  return planEltDocDryRun({
    snapshot,
    document,
    evaluatedAt: "2026-07-11T02:50:00.000Z",
    dataProvenance: "live",
  })
}

/** Structured paragraph matching exactly what the compiler/certifier expect: explicit namedStyleType + bold. */
function narrativeParagraphElement(
  startIndex: number,
  para: EltDocParagraph
): GoogleDocsStructuralElement {
  return {
    startIndex,
    endIndex: startIndex + para.text.length + 1,
    paragraph: {
      paragraphStyle: { namedStyleType: para.namedStyleType },
      elements: [
        { textRun: { content: `${para.text}\n`, textStyle: { bold: para.bold } } },
      ],
    },
  }
}

function insertedSmartChipDoc(
  eltFacts: ExecEltFacts,
  previousWeekLabel = facts.weekLabel
): GoogleDocsDocumentSnapshot {
  // The observed narrative tail matches exactly what A9's compiler writes:
  // the Role Progress paragraphs only (no separate "Hires:" text recap — the
  // table already carries that data).
  const narrativeParagraphs = renderEltDocRoleProgressParagraphs(eltFacts)
  const [startDisplay, endDisplay] = eltFacts.weekLabel.split(" - ")
  const [previousStartDisplay, previousEndDisplay] = previousWeekLabel.split(" - ")
  const content: GoogleDocsStructuralElement[] = [
    { startIndex: 0, endIndex: 1, sectionBreak: {} },
    dateChipHeading(1, 9, startDisplay, endDisplay),
    blankParagraph(9),
    observedHireTable(
      10,
      400,
      eltFacts.hires.map((hire) => [
        hire.role,
        hire.department ?? "",
        hire.priority ?? "",
        hire.candidate,
        hire.startsOn ?? "TBD",
      ])
    ),
  ]
  let index = 400
  for (const para of narrativeParagraphs) {
    const element = narrativeParagraphElement(index, para)
    content.push(element)
    index = element.endIndex!
  }
  content.push(dateChipHeading(index, index + 8, previousStartDisplay, previousEndDisplay))
  content.push(paragraph(index + 8, index + 50, "Older archive body.\n"))
  return {
    documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
    title: P1_ELT_DOC_TARGET.expectedTitle,
    revisionId: "revision-inserted-week",
    tabs: [
      {
        tabProperties: { tabId: P1_ELT_DOC_TARGET.tabId },
        documentTab: { body: { content } },
      },
    ],
  }
}

function withObservedOpaquePreface(
  document: GoogleDocsDocumentSnapshot,
  options: { copyOnlyBodyStyles?: boolean; headingMetadata?: boolean } = {}
): GoogleDocsDocumentSnapshot {
  const copy = structuredClone(document)
  const content = copy.tabs?.[0]?.documentTab?.body?.content
  const heading = content?.[1]
  const interstitial = content?.[2]
  const table = content?.[3]
  if (
    !content ||
    !heading?.paragraph ||
    !interstitial?.paragraph ||
    !table?.table ||
    interstitial.startIndex === undefined ||
    interstitial.endIndex === undefined
  ) {
    throw new Error("invalid opaque-preface fixture")
  }
  const text = "Human-owned weekly context.\n"
  const delta = text.length - (interstitial.endIndex - interstitial.startIndex)
  content[2] = {
    startIndex: interstitial.startIndex,
    endIndex: interstitial.startIndex + text.length,
    paragraph: {
      paragraphStyle: { namedStyleType: "NORMAL_TEXT", alignment: "START" },
      elements: [
        {
          textRun: {
            content: text,
            textStyle: { bold: true },
          },
        },
      ],
    },
  }
  for (const element of content.slice(3)) {
    if (element.startIndex !== undefined) element.startIndex += delta
    if (element.endIndex !== undefined) element.endIndex += delta
  }

  if (options.copyOnlyBodyStyles) {
    for (const row of table.table.tableRows?.slice(1) ?? []) {
      for (const cell of row.tableCells ?? []) {
        const style = cell.content?.[0]?.paragraph?.paragraphStyle
        if (!style) throw new Error("invalid copy-only paragraph-style fixture")
        Object.assign(style, {
          lineSpacing: 115,
          spacingMode: "COLLAPSE_LISTS",
          spaceAbove: { magnitude: 0, unit: "PT" },
          spaceBelow: { magnitude: 0, unit: "PT" },
        })
      }
    }
  }

  if (options.headingMetadata) {
    const foregroundColor = {
      color: { rgbColor: { red: 0.1, green: 0.2, blue: 0.3 } },
    }
    heading.paragraph.paragraphStyle!.headingId = "synthetic-heading-id"
    heading.paragraph.elements?.forEach((part, index) => {
      if (part.dateElement) {
        part.dateElement.dateId = `synthetic-date-${index}`
        part.dateElement.textStyle = { foregroundColor }
      }
      if (part.textRun) {
        part.textRun.textStyle = { foregroundColor }
      }
    })
  }
  return copy
}

function withLiveGoogleDocsApiDefaults(
  document: GoogleDocsDocumentSnapshot
): GoogleDocsDocumentSnapshot {
  const copy = structuredClone(document)
  const content = copy.tabs?.[0]?.documentTab?.body?.content
  const heading = content?.[1]
  const tableElement = content?.[3]
  const rows = tableElement?.table?.tableRows
  if (
    !heading?.paragraph?.paragraphStyle ||
    !tableElement?.table ||
    !rows ||
    tableElement.startIndex === undefined ||
    tableElement.endIndex === undefined
  ) {
    throw new Error("invalid live Google Docs API fixture")
  }

  heading.paragraph.paragraphStyle.direction = "LEFT_TO_RIGHT"
  heading.paragraph.elements?.forEach((part) => {
    if (part.dateElement) part.dateElement.textStyle = {}
    if (part.textRun) part.textRun.textStyle = {}
  })

  let rowStartIndex = tableElement.startIndex + 1
  rows.forEach((row, rowIndex) => {
    row.startIndex = rowStartIndex
    row.endIndex =
      rowIndex === rows.length - 1
        ? tableElement.endIndex! - 1
        : rowStartIndex + 10
    rowStartIndex = row.endIndex
    row.tableCells?.forEach((cell) => {
      const style = cell.tableCellStyle
      const paragraphStyle = cell.content?.[0]?.paragraph?.paragraphStyle
      const textStyle = cell.content?.[0]?.paragraph?.elements?.[0]?.textRun?.textStyle
      if (!style || !paragraphStyle || !textStyle) {
        throw new Error("invalid live Google Docs API cell fixture")
      }
      style.rowSpan = 1
      style.columnSpan = 1
      paragraphStyle.direction = "LEFT_TO_RIGHT"
      if (rowIndex === 0) {
        style.backgroundColor = {}
        paragraphStyle.lineSpacing = 100
      } else {
        style.borderLeft!.color = { color: { rgbColor: {} } }
        style.borderRight!.color = { color: { rgbColor: {} } }
        paragraphStyle.lineSpacing = 115
        paragraphStyle.spacingMode = "COLLAPSE_LISTS"
        paragraphStyle.spaceAbove = { unit: "PT" }
        paragraphStyle.spaceBelow = { unit: "PT" }
        delete textStyle.bold
      }
    })
  })
  return copy
}

describe("P1 ELT document renderer", () => {
  test("matches the strict legacy paragraph-intent golden", () => {
    expect(renderEltDocBlock(facts)).toEqual(golden)
  })

  test("preserves zero-hire wording and the blank note paragraph", () => {
    const rendered = renderEltDocBlock({ ...facts, hires: [], hiresNote: "" })
    expect(rendered.paragraphs.slice(2, 5).map((row) => [row.kind, row.text])).toEqual([
      ["lead", "We had no offers accepted this week."],
      ["note", "No offers accepted this week."],
      ["note", ""],
    ])
  })

  test("renders the passed clause even when conducted is zero (entry- vs exit-windowed counts)", () => {
    // Post-A6, `conducted` is entry-windowed and `passed` is exit-windowed, so a
    // stage can legitimately show 0 conducted / 1+ passed. A reverted display
    // fix (clamping/hiding the passed clause on conducted === 0) must fail this.
    const rendered = renderEltDocBlock({
      ...facts,
      sections: [
        {
          ...facts.sections[0],
          stages: [
            {
              label: "Onsite Interviews",
              conducted: 0,
              passed: 1,
              subs: [
                { label: "PE", conducted: 0, passed: 1 },
                { label: "FDE", conducted: 0, passed: 0 },
              ],
            },
          ],
        },
      ],
    })
    const stageLine = rendered.paragraphs.find((row) => row.text.startsWith("Onsite Interviews"))
    expect(stageLine?.text).toBe("Onsite Interviews Conducted - 0 (PE 0, FDE 0): 1 passed")
  })
})

describe("P1 ELT document block planner", () => {
  test("locates only the deterministic fact table and leaves narrative outside", () => {
    const result = plan(liveSmartChipArchiveDoc())

    expect(result.publicSummary).toMatchObject({
      status: "planned_for_internal_review",
      action: "replace_top_week",
      mutationScope: "weekly_fact_table",
      targetStartIndex: 9,
      targetEndIndex: 1562,
      upsertKeyField: "elt_facts.weekShort",
      mutationReachable: false,
      mutationCallCount: 0,
      promotionEligible: false,
      containsPersonIdentifiers: true,
    })
    expect(result.privatePlan).toMatchObject({
      action: "replace_top_week",
      archiveBlockRange: { tabId: "t.0", startIndex: 1, endIndex: 1562 },
      mutationScope: "weekly_fact_table",
      contentGuardRange: { tabId: "t.0", startIndex: 9, endIndex: 1562 },
      deleteRange: { tabId: "t.0", startIndex: 9, endIndex: 1562 },
      insertAt: { tabId: "t.0", index: 9 },
      rollbackFactTable: expect.objectContaining({
        hireRows: [["Role 1", "Department 1", "P1", "Candidate 1", "2026-07-20"]],
      }),
    })
  })

  test.each([
    ["extra root tab", (document: GoogleDocsDocumentSnapshot) => {
      document.tabs!.push({
        tabProperties: { tabId: "t.1", title: "Unexpected" },
        documentTab: { body: { content: [paragraph(1, 2, "x\n")] } },
      })
    }],
    ["nested child tab", (document: GoogleDocsDocumentSnapshot) => {
      document.tabs![0].childTabs = [{
        tabProperties: { tabId: "t.1", title: "Unexpected" },
        documentTab: { body: { content: [paragraph(1, 2, "x\n")] } },
      }]
    }],
    ["duplicate target tab", (document: GoogleDocsDocumentSnapshot) => {
      document.tabs!.push(structuredClone(document.tabs![0]))
    }],
  ])("rejects %s outside the exact approved tab topology", (_name, mutate) => {
    const document = liveSmartChipArchiveDoc()
    mutate(document)
    const result = plan(document)
    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain("tab topology")
    expect(result.privatePlan).toBeNull()
  })

  test("plans the single missing current week from the observed top-week preface", () => {
    const newerFacts: ExecEltFacts = {
      ...facts,
      generatedAt: "2026-07-18T01:45:00.000Z",
      weekLabel: "Jul 10, 2026 - Jul 16, 2026",
      weekShort: "Jul 10 - Jul 16",
    }
    const snapshot = makeSnapshot(newerFacts, {
      generated_at: "2026-07-18T01:50:00.000Z",
      org_rollup: {
        ...makeSnapshot().org_rollup,
        reporting_week_friday: "2026-07-17",
      },
    })
    const result = planEltDocDryRun({
      snapshot,
      document: withLiveGoogleDocsApiDefaults(
        withObservedOpaquePreface(
          liveSmartChipArchiveDoc(["white", "stripe", "white", "stripe"]),
          { copyOnlyBodyStyles: true, headingMetadata: true }
        )
      ),
      evaluatedAt: "2026-07-18T02:50:00.000Z",
      dataProvenance: "live",
    })

    expect(result.publicSummary).toMatchObject({
      status: "planned_for_internal_review",
      action: "insert_top_week",
      targetStartIndex: 1,
      targetEndIndex: 1,
      hireCount: 2,
    })
    expect(result.privatePlan).toMatchObject({
      action: "insert_top_week",
      archiveBlockRange: { tabId: "t.0", startIndex: 1, endIndex: 1589 },
      contentGuardRange: { tabId: "t.0", startIndex: 1, endIndex: 1 },
      deleteRange: null,
      insertAt: { tabId: "t.0", index: 1 },
      rollbackFactTable: null,
      factTable: {
        weekLabel: "Jul 10, 2026 - Jul 16, 2026",
        startDisplayText: "Jul 10, 2026",
        endDisplayText: "Jul 16, 2026",
        startTimestamp: "2026-07-10T12:00:00.000Z",
        endTimestamp: "2026-07-16T12:00:00.000Z",
        hireRows: [
          ["Research Engineer", "Frontier Data", "P1", "Amina Vega", "2026-07-20"],
          ["Product Engineer", "", "P2", "Theo Park", "TBD"],
        ],
      },
    })
  })

  test("plans an insert across a multi-week gap without backfilling the unwritten weeks", () => {
    const gappedFacts: ExecEltFacts = {
      ...facts,
      generatedAt: "2026-07-25T01:45:00.000Z",
      weekLabel: "Jul 17, 2026 - Jul 23, 2026",
      weekShort: "Jul 17 - Jul 23",
    }
    const snapshot = makeSnapshot(gappedFacts, {
      generated_at: "2026-07-25T01:50:00.000Z",
      org_rollup: {
        ...makeSnapshot().org_rollup,
        reporting_week_friday: "2026-07-24",
      },
    })
    const result = planEltDocDryRun({
      snapshot,
      document: withLiveGoogleDocsApiDefaults(
        withObservedOpaquePreface(
          liveSmartChipArchiveDoc(["white", "stripe", "white", "stripe"]),
          { copyOnlyBodyStyles: true, headingMetadata: true }
        )
      ),
      evaluatedAt: "2026-07-25T02:50:00.000Z",
      dataProvenance: "live",
    })

    // Doc top week is Jul 3-9; Jul 10-16 was never written. The current week
    // still inserts at the top and the gap stays unwritten.
    expect(result.publicSummary).toMatchObject({
      status: "planned_for_internal_review",
      action: "insert_top_week",
      targetStartIndex: 1,
      targetEndIndex: 1,
    })
    expect(result.privatePlan).toMatchObject({
      action: "insert_top_week",
      insertAt: { tabId: "t.0", index: 1 },
      factTable: { weekLabel: "Jul 17, 2026 - Jul 23, 2026" },
    })
  })

  test.each([
    ["non-default span", (document: GoogleDocsDocumentSnapshot) => {
      const style =
        document.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[1]
          ?.tableCells?.[0]?.tableCellStyle
      if (!style) throw new Error("invalid live Google Docs API span fixture")
      style.rowSpan = 2
    }],
    ["right-to-left direction", (document: GoogleDocsDocumentSnapshot) => {
      const style = document.tabs?.[0]?.documentTab?.body?.content?.[1]?.paragraph?.paragraphStyle
      if (!style) throw new Error("invalid live Google Docs API direction fixture")
      style.direction = "RIGHT_TO_LEFT"
    }],
    ["noncontiguous row indexes", (document: GoogleDocsDocumentSnapshot) => {
      const row = document.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[1]
      if (row?.startIndex === undefined) {
        throw new Error("invalid live Google Docs API row-index fixture")
      }
      row.startIndex += 1
    }],
  ] as const)("rejects %s in an otherwise exact live API response", (_name, mutate) => {
    const changed = withLiveGoogleDocsApiDefaults(liveSmartChipArchiveDoc())
    mutate(changed)

    expect(plan(changed).publicSummary).toMatchObject({
      status: "blocked",
      action: null,
    })
  })

  test("a declared backfill week inserts at its date-ordered position below the newest block", () => {
    // The backfill shape: a machine-written newest block, a human-shaped
    // partial block below it (no interstitial, no table), an older block
    // below that. The declared week sits between the first two. The pushed-
    // down human block's internal shape is deliberately not validated - a
    // zero-width insert above it touches nothing inside it.
    const backfillFacts: ExecEltFacts = { ...facts, generatedAt: "2026-07-18T01:45:00.000Z" }
    const snapshot = makeSnapshot(backfillFacts, {
      generated_at: "2026-07-18T01:50:00.000Z",
      org_rollup: { ...makeSnapshot().org_rollup, reporting_week_friday: "2026-07-17" },
    })
    const document: GoogleDocsDocumentSnapshot = {
      documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
      title: P1_ELT_DOC_TARGET.expectedTitle,
      revisionId: "revision-fixture-7",
      tabs: [
        {
          tabProperties: { tabId: P1_ELT_DOC_TARGET.tabId, title: "ELT update" },
          documentTab: {
            body: {
              content: [
                { startIndex: 0, endIndex: 1, sectionBreak: {} },
                paragraph(1, 50, "Jul 10, 2026 - Jul 16, 2026\n"),
                paragraph(50, 90, "Machine block body.\n"),
                paragraph(90, 130, "Jun 26, 2026 - Jul 2, 2026\n"),
                paragraph(130, 170, "Human partial recap.\n"),
                paragraph(170, 210, "Jun 19, 2026 - Jun 25, 2026\n"),
                paragraph(210, 250, "Older archive body.\n"),
              ],
            },
          },
        },
      ],
    }
    const result = planEltDocDryRun({
      snapshot,
      document,
      evaluatedAt: "2026-07-18T02:50:00.000Z",
      dataProvenance: "live",
      eltBackfillWeekFriday: "2026-07-03",
    })

    expect(result.publicSummary).toMatchObject({
      status: "planned_for_internal_review",
      action: "insert_top_week",
      targetStartIndex: 90,
      targetEndIndex: 90,
    })
    expect(result.privatePlan).toMatchObject({
      action: "insert_top_week",
      insertAt: { tabId: "t.0", index: 90 },
      archiveBlockRange: { tabId: "t.0", startIndex: 90, endIndex: 170 },
      contentGuardRange: { tabId: "t.0", startIndex: 90, endIndex: 90 },
      factTable: { weekLabel: "Jul 3, 2026 - Jul 9, 2026" },
    })
  })

  test("a declared week newer than the top block still uses the top-insert path", () => {
    const backfillFacts: ExecEltFacts = { ...facts, generatedAt: "2026-07-18T01:45:00.000Z" }
    const snapshot = makeSnapshot(backfillFacts, {
      generated_at: "2026-07-18T01:50:00.000Z",
      org_rollup: { ...makeSnapshot().org_rollup, reporting_week_friday: "2026-07-17" },
    })
    const result = planEltDocDryRun({
      snapshot,
      document: withLiveGoogleDocsApiDefaults(
        withObservedOpaquePreface(
          liveSmartChipArchiveDoc(["white"], "Jun 26, 2026 - Jul 2, 2026", "Jun 19, 2026 - Jun 25, 2026"),
          { copyOnlyBodyStyles: true, headingMetadata: true }
        )
      ),
      evaluatedAt: "2026-07-18T02:50:00.000Z",
      dataProvenance: "live",
      eltBackfillWeekFriday: "2026-07-03",
    })
    expect(result.publicSummary).toMatchObject({
      status: "planned_for_internal_review",
      action: "insert_top_week",
      targetStartIndex: 1,
      targetEndIndex: 1,
    })
  })

  test("a declared week already present below the top refuses to rewrite history before any position logic", () => {
    const presentFacts: ExecEltFacts = {
      ...facts,
      generatedAt: "2026-07-18T01:45:00.000Z",
      weekLabel: "Jun 26, 2026 - Jul 2, 2026",
      weekShort: "Jun 26 - Jul 2",
    }
    const snapshot = makeSnapshot(presentFacts, {
      generated_at: "2026-07-18T01:50:00.000Z",
      org_rollup: { ...makeSnapshot().org_rollup, reporting_week_friday: "2026-07-17" },
    })
    const result = planEltDocDryRun({
      snapshot,
      document: makeArchiveDoc("Jul 10, 2026 - Jul 16, 2026"),
      evaluatedAt: "2026-07-18T02:50:00.000Z",
      dataProvenance: "live",
      eltBackfillWeekFriday: "2026-06-26",
    })
    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain("refusing to rewrite history")
  })

  test.each([
    [
      "an off-Friday declared week",
      "2026-07-04",
      facts,
      null,
      "not a valid Friday date",
    ],
    [
      "a declared week the honest clock already produces",
      "2026-07-10",
      facts,
      null,
      "not older than the governed current reporting week",
    ],
    [
      "labels that do not match the declared week",
      "2026-06-26",
      facts,
      null,
      "do not match the declared backfill week",
    ],
    [
      "a declared week older than every retained block",
      "2026-06-12",
      { ...facts, weekLabel: "Jun 12, 2026 - Jun 18, 2026", weekShort: "Jun 12 - Jun 18" },
      null,
      "no unique adjacent archive bracket",
    ],
    [
      "a declared week misaligned with its bracket",
      "2026-07-03",
      facts,
      "misaligned",
      "not week-aligned with its adjacent archive blocks",
    ],
    [
      "a bracket with no boundary below the pushed-down block",
      "2026-07-03",
      facts,
      "two-boundary",
      "A next archive boundary below the pushed-down block",
    ],
  ] as const)("refuses %s", (_name, declared, factsOverride, docCase, message) => {
    const backfillFacts: ExecEltFacts = { ...factsOverride, generatedAt: "2026-07-18T01:45:00.000Z" }
    const snapshot = makeSnapshot(backfillFacts, {
      generated_at: "2026-07-18T01:50:00.000Z",
      org_rollup: { ...makeSnapshot().org_rollup, reporting_week_friday: "2026-07-17" },
    })
    const midDoc = (weeks: readonly string[]): GoogleDocsDocumentSnapshot => ({
      documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
      title: P1_ELT_DOC_TARGET.expectedTitle,
      revisionId: "revision-fixture-7",
      tabs: [
        {
          tabProperties: { tabId: P1_ELT_DOC_TARGET.tabId, title: "ELT update" },
          documentTab: {
            body: {
              content: [
                { startIndex: 0, endIndex: 1, sectionBreak: {} },
                ...weeks.flatMap((week, index) => [
                  paragraph(1 + index * 80, 41 + index * 80, `${week}\n`),
                  paragraph(41 + index * 80, 81 + index * 80, "Block body.\n"),
                ]),
              ],
            },
          },
        },
      ],
    })
    const document =
      docCase === "misaligned"
        ? midDoc(["Jul 11, 2026 - Jul 17, 2026", "Jun 27, 2026 - Jul 3, 2026", "Jun 20, 2026 - Jun 26, 2026"])
        : docCase === "two-boundary"
          ? makeArchiveDoc("Jul 10, 2026 - Jul 16, 2026")
          : midDoc(["Jul 10, 2026 - Jul 16, 2026", "Jun 26, 2026 - Jul 2, 2026", "Jun 19, 2026 - Jun 25, 2026"])
    const result = planEltDocDryRun({
      snapshot,
      document,
      evaluatedAt: "2026-07-18T02:50:00.000Z",
      dataProvenance: "live",
      eltBackfillWeekFriday: declared,
    })
    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain(message)
  })

  test("inserts and recognizes the next weekly block across Dec to Jan", () => {
    const yearBoundaryFacts: ExecEltFacts = {
      ...facts,
      generatedAt: "2027-01-09T01:45:00.000Z",
      weekLabel: "Jan 1, 2027 - Jan 7, 2027",
      weekShort: "Jan 1 - Jan 7",
    }
    const snapshot = makeSnapshot(yearBoundaryFacts, {
      generated_at: "2027-01-09T01:50:00.000Z",
      org_rollup: {
        ...makeSnapshot().org_rollup,
        as_of: "2027-01-09T01:45:00.000Z",
        reporting_week_friday: "2027-01-08",
      },
    })
    const input = {
      snapshot,
      evaluatedAt: "2027-01-09T02:50:00.000Z",
      dataProvenance: "live" as const,
    }
    const previousWeek = "Dec 25, 2026 - Dec 31, 2026"

    const planned = planEltDocDryRun({
      ...input,
      document: liveSmartChipArchiveDoc(
        ["white"],
        previousWeek,
        "Dec 18, 2026 - Dec 24, 2026"
      ),
    })
    expect(planned.publicSummary).toMatchObject({
      status: "planned_for_internal_review",
      action: "insert_top_week",
    })
    expect(planned.privatePlan?.factTable).toMatchObject({
      weekLabel: "Jan 1, 2027 - Jan 7, 2027",
      startTimestamp: "2027-01-01T12:00:00.000Z",
      endTimestamp: "2027-01-07T12:00:00.000Z",
    })

    const rerun = planEltDocDryRun({
      ...input,
      document: insertedSmartChipDoc(yearBoundaryFacts, previousWeek),
    })
    expect(rerun.publicSummary).toMatchObject({ status: "no_change", action: "no_op" })
  })

  test("rejects mixed cell backgrounds inside an observed hire-table row", () => {
    const newerFacts: ExecEltFacts = {
      ...facts,
      generatedAt: "2026-07-18T01:45:00.000Z",
      weekLabel: "Jul 10, 2026 - Jul 16, 2026",
      weekShort: "Jul 10 - Jul 16",
    }
    const changed = liveSmartChipArchiveDoc(["white", "stripe", "stripe", "white"])
    const cell = changed.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[3]
      ?.tableCells?.[0]
    if (!cell?.tableCellStyle) throw new Error("invalid observed hire-table fixture")
    cell.tableCellStyle.backgroundColor = {
      color: { rgbColor: { red: 1, green: 1, blue: 1 } },
    }

    const result = planEltDocDryRun({
      snapshot: makeSnapshot(newerFacts, {
        generated_at: "2026-07-18T01:50:00.000Z",
        org_rollup: {
          ...makeSnapshot().org_rollup,
          reporting_week_friday: "2026-07-17",
        },
      }),
      document: changed,
      evaluatedAt: "2026-07-18T02:50:00.000Z",
      dataProvenance: "live",
    })

    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain("five-column hire-table template")
    expect(result.privatePlan).toBeNull()
  })

  test.each(["header italic", "header background", "body paragraph spacing"] as const)(
    "rejects unmodeled fact-table formatting: %s",
    (drift) => {
      const newerFacts: ExecEltFacts = {
        ...facts,
        generatedAt: "2026-07-18T01:45:00.000Z",
        weekLabel: "Jul 10, 2026 - Jul 16, 2026",
        weekShort: "Jul 10 - Jul 16",
      }
      const changed = liveSmartChipArchiveDoc(["white", "stripe", "white", "stripe"])
      const table = changed.tabs?.[0]?.documentTab?.body?.content?.[3]?.table
      const header = table?.tableRows?.[0]?.tableCells?.[0]
      const body = table?.tableRows?.[1]?.tableCells?.[0]
      if (!header?.tableCellStyle || !body) {
        throw new Error("invalid observed hire-table fixture")
      }
      if (drift === "header italic") {
        const textStyle =
          header.content?.[0]?.paragraph?.elements?.[0]?.textRun?.textStyle
        if (!textStyle) throw new Error("invalid observed hire-table typography fixture")
        textStyle.italic = true
      } else if (drift === "header background") {
        header.tableCellStyle.backgroundColor = {
          color: { rgbColor: { red: 1, green: 1, blue: 1 } },
        }
      } else {
        const paragraphStyle = body.content?.[0]?.paragraph?.paragraphStyle
        if (!paragraphStyle) throw new Error("invalid observed hire-table paragraph fixture")
        paragraphStyle.spaceAbove = { magnitude: 0, unit: "PT" }
      }

      const result = planEltDocDryRun({
        snapshot: makeSnapshot(newerFacts, {
          generated_at: "2026-07-18T01:50:00.000Z",
          org_rollup: {
            ...makeSnapshot().org_rollup,
            reporting_week_friday: "2026-07-17",
          },
        }),
        document: changed,
        evaluatedAt: "2026-07-18T02:50:00.000Z",
        dataProvenance: "live",
      })

      expect(result.publicSummary.status).toBe("blocked")
      expect(result.publicSummary.blockingReasons.join(" ")).toContain(
        "five-column hire-table template"
      )
      expect(result.privatePlan).toBeNull()
    }
  )

  test("blocks replacement of an imported shared edge that rollback would normalize", () => {
    const changed = liveSmartChipArchiveDoc()
    const headerCells =
      changed.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[0]
        ?.tableCells
    if (!headerCells) throw new Error("invalid imported-edge fixture")
    headerCells.forEach((cell) => {
      cell.tableCellStyle!.borderBottom!.width = {
        magnitude: ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT,
        unit: "PT",
      }
    })

    const result = plan(changed)

    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain(
      "not exactly reconstructible by the rollback renderer"
    )
    expect(result.privatePlan).toBeNull()
  })

  test("blocks value-changing replacement of observed copy-only body styles", () => {
    const changed = liveSmartChipArchiveDoc()
    const rows =
      changed.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows
    if (!rows) throw new Error("invalid copy-only body-style fixture")
    for (const row of rows.slice(1)) {
      for (const cell of row.tableCells ?? []) {
        const style = cell.content?.[0]?.paragraph?.paragraphStyle
        if (!style) throw new Error("invalid copy-only body-style fixture")
        Object.assign(style, {
          lineSpacing: 115,
          spacingMode: "COLLAPSE_LISTS",
          spaceAbove: { magnitude: 0, unit: "PT" },
          spaceBelow: { magnitude: 0, unit: "PT" },
        })
      }
    }

    const result = plan(changed)

    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain(
      "not exactly reconstructible by the rollback renderer"
    )
    expect(result.privatePlan).toBeNull()
  })

  test("blocks a value-changing replacement when the interstitial is human-authored", () => {
    const result = plan(withObservedOpaquePreface(liveSmartChipArchiveDoc()))

    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain(
      "interstitial context is human-authored"
    )
    expect(result.privatePlan).toBeNull()
  })

  test("blocks replacement without a trailing paragraph insertion anchor", () => {
    const document = liveSmartChipArchiveDoc()
    const content = document.tabs?.[0]?.documentTab?.body?.content
    const table = content?.[3]
    const following = content?.[4]
    if (
      !content ||
      table?.endIndex === undefined ||
      following?.startIndex !== table.endIndex ||
      following.endIndex === undefined
    ) {
      throw new Error("invalid replacement-anchor fixture")
    }
    content[4] = {
      startIndex: following.startIndex,
      endIndex: following.endIndex,
      sectionBreak: {},
    }

    const result = plan(document)

    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain(
      "deterministic fact-table boundary"
    )
    expect(result.privatePlan).toBeNull()
  })

  test("returns a deterministic no-op when the fact table matches regardless of narrative", () => {
    const result = plan(insertedSmartChipDoc(facts, "Jun 26, 2026 - Jul 2, 2026"))

    expect(result.publicSummary.status).toBe("no_change")
    expect(result.publicSummary.action).toBe("no_op")
    expect(result.privatePlan).toMatchObject({ action: "no_op", deleteRange: null, insertAt: null })
  })

  test("binds but never owns the observed nonblank preface and accepted heading metadata", () => {
    const document = withObservedOpaquePreface(
      insertedSmartChipDoc(facts, "Jun 26, 2026 - Jul 2, 2026"),
      { copyOnlyBodyStyles: true, headingMetadata: true }
    )
    const first = plan(document)
    const content = document.tabs?.[0]?.documentTab?.body?.content
    const table = content?.[3]
    // The mutation-owned range now runs through the Role Progress narrative
    // tail to the next archive boundary (the second date-chip heading),
    // not just the table.
    const nextBoundary = content?.[(content?.length ?? 0) - 2]

    expect(first.publicSummary).toMatchObject({
      status: "no_change",
      action: "no_op",
      targetStartIndex: table?.startIndex,
      targetEndIndex: nextBoundary?.startIndex,
    })
    expect(first.privatePlan?.contentGuardRange.startIndex).toBe(table?.startIndex)
    expect(first.privatePlan?.contentGuardRange.startIndex).not.toBe(1)

    const changed = structuredClone(document)
    changed.tabs![0].documentTab!.body!.content![2].paragraph!.elements![0].textRun!.content =
      "Human-owned weekly context!\n"
    const second = plan(changed)
    expect(second.publicSummary.status).toBe("no_change")
    expect(second.publicSummary.currentBlockFingerprint).toBe(
      first.publicSummary.currentBlockFingerprint
    )
    expect(second.publicSummary.outsideContentFingerprint).not.toBe(
      first.publicSummary.outsideContentFingerprint
    )
  })

  test("rejects unapproved heading metadata and a second interstitial element", () => {
    const metadataDrift = withObservedOpaquePreface(
      insertedSmartChipDoc(facts, "Jun 26, 2026 - Jul 2, 2026"),
      { headingMetadata: true }
    )
    Object.assign(
      metadataDrift.tabs?.[0]?.documentTab?.body?.content?.[1]?.paragraph?.paragraphStyle ?? {},
      { keepWithNext: true }
    )
    expect(plan(metadataDrift).publicSummary.status).toBe("blocked")

    const extraInterstitial = withObservedOpaquePreface(
      insertedSmartChipDoc(facts, "Jun 26, 2026 - Jul 2, 2026")
    )
    const content = extraInterstitial.tabs![0].documentTab!.body!.content!
    content.splice(3, 0, paragraph(content[3].startIndex!, content[3].startIndex! + 2, "x\n"))
    expect(plan(extraInterstitial).publicSummary.status).toBe("blocked")
  })

  test("leaves the uniform imported header edge unchanged on an exact no-op", () => {
    const newerFacts: ExecEltFacts = {
      ...facts,
      generatedAt: "2026-07-18T01:45:00.000Z",
      weekLabel: "Jul 10, 2026 - Jul 16, 2026",
      weekShort: "Jul 10 - Jul 16",
    }
    const apiNormalized = insertedSmartChipDoc(newerFacts)
    const headerCells =
      apiNormalized.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[0]
        ?.tableCells
    if (!headerCells) throw new Error("invalid inserted-week fixture")
    headerCells.forEach((cell) => {
      cell.tableCellStyle!.borderBottom!.width = {
        magnitude: ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT,
        unit: "PT",
      }
    })
    const result = planEltDocDryRun({
      snapshot: makeSnapshot(newerFacts, {
        generated_at: "2026-07-18T01:50:00.000Z",
        org_rollup: {
          ...makeSnapshot().org_rollup,
          reporting_week_friday: "2026-07-17",
        },
      }),
      document: apiNormalized,
      evaluatedAt: "2026-07-18T02:50:00.000Z",
      dataProvenance: "live",
    })

    expect(result.publicSummary).toMatchObject({ status: "no_change", action: "no_op" })
    expect(result.privatePlan).toMatchObject({
      action: "no_op",
      deleteRange: null,
      insertAt: null,
      factTable: expect.objectContaining({ weekLabel: newerFacts.weekLabel }),
      rollbackFactTable: expect.objectContaining({ weekLabel: newerFacts.weekLabel }),
    })
  })

  test("does not call a rerun a no-op when the current hire table differs", () => {
    const newerFacts: ExecEltFacts = {
      ...facts,
      generatedAt: "2026-07-18T01:45:00.000Z",
      weekLabel: "Jul 10, 2026 - Jul 16, 2026",
      weekShort: "Jul 10 - Jul 16",
    }
    const changed = insertedSmartChipDoc(newerFacts)
    const firstHeader =
      changed.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[0]
        ?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]?.textRun
    if (!firstHeader) throw new Error("invalid inserted-week fixture")
    firstHeader.content = "Wrong\n"
    const result = planEltDocDryRun({
      snapshot: makeSnapshot(newerFacts, {
        generated_at: "2026-07-18T01:50:00.000Z",
        org_rollup: {
          ...makeSnapshot().org_rollup,
          reporting_week_friday: "2026-07-17",
        },
      }),
      document: changed,
      evaluatedAt: "2026-07-18T02:50:00.000Z",
      dataProvenance: "live",
    })

    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain("fact-table boundary")
    expect(result.privatePlan).toBeNull()
  })

  test("keeps exact alternating stripes mandatory for a newly inserted week rerun", () => {
    const newerFacts: ExecEltFacts = {
      ...facts,
      generatedAt: "2026-07-18T01:45:00.000Z",
      weekLabel: "Jul 10, 2026 - Jul 16, 2026",
      weekShort: "Jul 10 - Jul 16",
    }
    const changed = insertedSmartChipDoc(newerFacts)
    const secondBodyRow = changed.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[2]
    if (!secondBodyRow) throw new Error("invalid inserted-week fixture")
    secondBodyRow.tableCells?.forEach((cell) => {
      cell.tableCellStyle!.backgroundColor = {
        color: { rgbColor: { red: 1, green: 1, blue: 1 } },
      }
    })

    const result = planEltDocDryRun({
      snapshot: makeSnapshot(newerFacts, {
        generated_at: "2026-07-18T01:50:00.000Z",
        org_rollup: {
          ...makeSnapshot().org_rollup,
          reporting_week_friday: "2026-07-17",
        },
      }),
      document: changed,
      evaluatedAt: "2026-07-18T02:50:00.000Z",
      dataProvenance: "live",
    })

    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain("fact-table boundary")
    expect(result.privatePlan).toBeNull()
  })

  test.each([
    {
      name: "next boundary missing",
      document: {
        ...makeArchiveDoc(),
        tabs: [
          {
            tabProperties: { tabId: "t.0" },
            documentTab: {
              body: {
                content: [
                  { startIndex: 0, endIndex: 1, sectionBreak: {} },
                  paragraph(1, 50, `${facts.weekLabel}\n`),
                  paragraph(50, 90, "Hires: (Offer Accepted b/w Jul 3 - Jul 9)\n"),
                  paragraph(90, 200, "Only block.\n"),
                ],
              },
            },
          },
        ],
      } satisfies GoogleDocsDocumentSnapshot,
      reason: "next archive boundary",
    },
    {
      name: "requested week below the top block",
      document: makeArchiveDoc("Jul 10, 2026 - Jul 16, 2026", facts.weekLabel),
      reason: "below the newest archive block",
    },
    {
      name: "duplicate weekly heading",
      document: makeArchiveDoc(facts.weekLabel, facts.weekLabel),
      reason: "appears more than once",
    },
  ])("fails closed when $name", ({ document, reason }) => {
    const result = plan(document)

    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain(reason)
    expect(result.privatePlan).toBeNull()
  })

  test("uses date chips as boundaries while excluding all narrative from mutation", () => {
    const result = plan(liveSmartChipArchiveDoc())

    expect(result.publicSummary).toMatchObject({
      status: "planned_for_internal_review",
      action: "replace_top_week",
      targetStartIndex: 9,
      targetEndIndex: 1562,
    })
    expect(result.privatePlan).toMatchObject({
      archiveBlockRange: { tabId: "t.0", startIndex: 1, endIndex: 1562 },
      contentGuardRange: { tabId: "t.0", startIndex: 9, endIndex: 1562 },
      deleteRange: { tabId: "t.0", startIndex: 9, endIndex: 1562 },
      insertAt: { tabId: "t.0", index: 9 },
    })
  })
})
