import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { PII_FINGERPRINT_SALT_ENV } from "../lib/recruiting-ops/checksums"
import {
  ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
  ELT_DOC_HIRE_TABLE_BODY_FONT_PT,
  ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT,
  ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT,
  ELT_DOC_HIRE_TABLE_HEADERS,
  runEltDocDryRun,
  type GoogleDocsDocumentSnapshot,
  type RunEltDocDryRunInput,
} from "../lib/recruiting-ops/delivery/elt-doc-dry-run"
import { P1_ELT_DOC_TARGET } from "../lib/recruiting-ops/delivery/p1-artifacts"
import type { ExecSnapshotRow } from "../lib/recruiting-ops/exec-snapshot-store"
import type { ExecEltFacts } from "../lib/recruiting-ops/modules/exec-state-of-play"
import { assertPublicSafe } from "../lib/recruiting-ops/safe-public-output"

const originalSalt = process.env[PII_FINGERPRINT_SALT_ENV]

beforeEach(() => {
  process.env[PII_FINGERPRINT_SALT_ENV] = "elt-doc-dry-run-test-only-salt"
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalSalt === undefined) delete process.env[PII_FINGERPRINT_SALT_ENV]
  else process.env[PII_FINGERPRINT_SALT_ENV] = originalSalt
})

const facts: ExecEltFacts = {
  generatedAt: "2026-07-11T01:45:00.000Z",
  weekLabel: "Jul 3, 2026 - Jul 9, 2026",
  weekShort: "Jul 3 - Jul 9",
  hires: [
    {
      candidate: "Mira Solis",
      role: "Research Engineer",
      reqId: 907,
      startsOn: null,
      department: "Frontier Data",
      priority: "P1",
      location: null,
    },
  ],
  hiresNote: "Org-wide accepted offers, Jul 3 - Jul 9.",
  sections: [
    {
      title: "FDE + PE",
      subs: ["PE", "FDE"],
      qtdOffers: {
        total: 1,
        subs: [
          { label: "PE", count: 0 },
          { label: "FDE", count: 1 },
        ],
        names: ["Mira Solis"],
      },
      stages: [
        {
          label: "RPS",
          conducted: 1,
          passed: 1,
          subs: [
            { label: "PE", conducted: 0, passed: 0 },
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
        names: ["Mira Solis"],
      },
    },
  ],
}

function makeSnapshot(overrides: Partial<ExecSnapshotRow> = {}): ExecSnapshotRow {
  return {
    run_id: "e01_fixture_20260711015000000",
    workflow_id: "E01",
    mode: "shadow",
    generated_at: "2026-07-11T01:50:00.000Z",
    org_rollup: {
      as_of: "2026-07-11T01:45:00.000Z",
      reporting_week_friday: "2026-07-10",
      open_roles: 1,
      pools_campaigns_templates: 0,
      red: 0,
      amber: 0,
      green: 1,
      seats: 1,
      unowned_roles: 0,
      offers_accepted_12wk: 1,
      momentum: {},
      tiers: { in_play: 1, gone_quiet: 0, filled_not_closed: 0, no_search: 0 },
      attention_count: 0,
      positions_in_play: 1,
      offers_out: { count: 0, waiting_14d_plus: 0 },
      off_scope_scorecards: 0,
      conducted_unattributed_stage: 0,
      truncation_suspected_pulls: 0,
    },
    req_rows: [],
    hires: [],
    elt_facts: facts,
    ...overrides,
  }
}

function dateHeading(startIndex: number, start: string, end: string) {
  return {
    startIndex,
    endIndex: startIndex + 8,
    paragraph: {
      paragraphStyle: { namedStyleType: "HEADING_2" },
      elements: [
        { dateElement: { dateElementProperties: {
          displayText: start,
          timestamp: new Date(`${start} 12:00:00 UTC`).toISOString(),
          locale: "en",
          dateFormat: "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
          timeFormat: "TIME_FORMAT_DISABLED",
        } } },
        { textRun: { content: " - " } },
        { dateElement: { dateElementProperties: {
          displayText: end,
          timestamp: new Date(`${end} 12:00:00 UTC`).toISOString(),
          locale: "en",
          dateFormat: "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
          timeFormat: "TIME_FORMAT_DISABLED",
        } } },
        { textRun: { content: "  \n" } },
      ],
    },
  }
}

function hireTable(startIndex: number) {
  const rows = [
    ELT_DOC_HIRE_TABLE_HEADERS,
    ["Old Role", "Old Dept", "P2", "Old Candidate", "TBD"] as const,
  ]
  const dimension = (magnitude: number) => ({ magnitude, unit: "PT" })
  const gray = { color: { rgbColor: { red: 0.8, green: 0.8, blue: 0.8 } } }
  const border = (width: number, colored: boolean) => ({
    ...(colored ? { color: gray } : {}),
    width: dimension(width),
    dashStyle: "SOLID",
  })
  return {
    startIndex,
    endIndex: 220,
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
            ...(rowIndex > 0 ? { backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } } } : {}),
            borderLeft: border(rowIndex === 0 ? ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT : ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, rowIndex === 0),
            borderRight: border(rowIndex === 0 ? ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT : ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, rowIndex === 0),
            borderTop: border(rowIndex === 0 ? ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT : ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, true),
            borderBottom: border(ELT_DOC_HIRE_TABLE_BODY_BORDER_PT, true),
            paddingLeft: dimension(2),
            paddingRight: dimension(2),
            paddingTop: dimension(2),
            paddingBottom: dimension(2),
            contentAlignment: "MIDDLE",
          },
          content: [{ paragraph: {
            paragraphStyle: {
              namedStyleType: "NORMAL_TEXT",
              alignment: "CENTER",
            },
            elements: [{ textRun: {
              content: `${text}\n`,
              textStyle: rowIndex === 0
                ? { bold: true }
                : { bold: false, fontSize: dimension(ELT_DOC_HIRE_TABLE_BODY_FONT_PT) },
            } }],
          } }],
        })),
      })),
    },
  }
}

function makeDocument(overrides: Partial<GoogleDocsDocumentSnapshot> = {}): GoogleDocsDocumentSnapshot {
  const [start, end] = facts.weekLabel.split(" - ")
  return {
    documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
    title: P1_ELT_DOC_TARGET.expectedTitle,
    revisionId: "revision-fixture-8",
    tabs: [
      {
        tabProperties: { tabId: P1_ELT_DOC_TARGET.tabId },
        documentTab: {
          body: {
            content: [
              { startIndex: 0, endIndex: 1, sectionBreak: {} },
              dateHeading(1, start, end),
              {
                startIndex: 9,
                endIndex: 10,
                paragraph: {
                  paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                  elements: [{ textRun: { content: "\n" } }],
                },
              },
              hireTable(10),
              {
                startIndex: 220,
                endIndex: 260,
                paragraph: { elements: [{ textRun: { content: "Manual current-week body.\n" } }] },
              },
              {
                startIndex: 260,
                endIndex: 300,
                paragraph: {
                  elements: [{ textRun: { content: "Jun 26, 2026 - Jul 2, 2026\n" } }],
                },
              },
              {
                startIndex: 300,
                endIndex: 340,
                paragraph: {
                  elements: [
                    { textRun: { content: "Hires: (Offer Accepted b/w Jun 26 - Jul 2)\n" } },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
    ...overrides,
  }
}

function baseInput(overrides: Partial<RunEltDocDryRunInput> = {}): RunEltDocDryRunInput {
  return {
    snapshot: makeSnapshot(),
    evaluatedAt: "2026-07-11T03:50:00.000Z",
    dataProvenance: "live",
    ...overrides,
  }
}

function fakeReader(document = makeDocument()) {
  return {
    getDocument: vi.fn(async () => document),
    batchUpdate: vi.fn(async () => {
      throw new Error("mutation must remain unreachable")
    }),
  }
}

describe("P1 ELT document dry-run boundary", () => {
  test("reads the exact staging document once and exposes no mutation path", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const reader = fakeReader()
    const result = await runEltDocDryRun(baseInput(), reader)

    expect(reader.getDocument).toHaveBeenCalledOnce()
    expect(reader.getDocument).toHaveBeenCalledWith({
      documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
      tabId: P1_ELT_DOC_TARGET.tabId,
    })
    expect(reader.batchUpdate).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.publicSummary).toMatchObject({
      status: "planned_for_internal_review",
      dryRunOnly: true,
      mutationReachable: false,
      mutationCallCount: 0,
      promotionEligible: false,
      mutationScope: "weekly_fact_table",
      action: "replace_top_week",
      snapshotAgeMinutes: 120,
    })
    expect(result.privatePlan?.factTable.hireRows).toEqual([
      ["Research Engineer", "Frontier Data", "P1", "Mira Solis", "TBD"],
    ])
    // A9: the observed narrative tail is captured into the private plan's
    // rollback fact table (needed to reconstruct it on rollback) — that is
    // expected and correct. It must never reach the public summary.
    expect(result.privatePlan?.rollbackFactTable?.narrativeParagraphs).toEqual([
      {
        kind: "body",
        text: "Manual current-week body.",
        namedStyleType: "NORMAL_TEXT",
        bold: false,
        tone: "ink",
      },
    ])
    expect(JSON.stringify(result.publicSummary)).not.toContain("Manual current-week body")
    expect(JSON.stringify(result.publicSummary)).not.toContain("Mira Solis")
    expect(() => assertPublicSafe(result.publicSummary)).not.toThrow()
  })

  test("rejects a legacy narrative-only archive because it has no bounded fact table", async () => {
    const document = makeDocument({
      tabs: [
        {
          tabProperties: { tabId: P1_ELT_DOC_TARGET.tabId },
          documentTab: {
            body: {
              content: [
                { startIndex: 0, endIndex: 1, sectionBreak: {} },
                {
                  startIndex: 1,
                  endIndex: 60,
                  paragraph: {
                    elements: [
                      { textRun: { content: "Hires: (Offer Accepted b/w Jul 3 - Jul 9)\n" } },
                    ],
                  },
                },
                {
                  startIndex: 60,
                  endIndex: 120,
                  paragraph: { elements: [{ textRun: { content: "Manual current-week body.\n" } }] },
                },
                {
                  startIndex: 120,
                  endIndex: 180,
                  paragraph: {
                    elements: [
                      { textRun: { content: "Hires: (Offer Accepted b/w Jun 26 - Jul 2)\n" } },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    })

    const result = await runEltDocDryRun(baseInput(), fakeReader(document))

    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain("fact-table boundary")
    expect(result.privatePlan).toBeNull()
  })

  test("passes at exactly 120 minutes and blocks at 120 minutes plus one millisecond", async () => {
    const atBoundary = fakeReader()
    const overBoundary = fakeReader()

    expect((await runEltDocDryRun(baseInput(), atBoundary)).publicSummary.status).toBe(
      "planned_for_internal_review"
    )
    const blocked = await runEltDocDryRun(
      baseInput({ evaluatedAt: "2026-07-11T03:50:00.001Z" }),
      overBoundary
    )

    expect(blocked.publicSummary.status).toBe("blocked")
    expect(blocked.publicSummary.blockingReasons.join(" ")).toContain("freshness limit")
    expect(overBoundary.getDocument).not.toHaveBeenCalled()
    expect(overBoundary.batchUpdate).not.toHaveBeenCalled()
  })

  test("rejects every non-canonical target before a document read, including the retired copy", async () => {
    const targets = [
      // Retired the operator-owned copy, denied since the 2026-08-06 canonical cutover.
      "1ExampleDriveId00000000000000000000000000007",
      "1ExampleDriveId00000000000000000000000000019",
      "unknown-document-id",
    ]

    for (const targetDocumentId of targets) {
      const reader = fakeReader()
      const result = await runEltDocDryRun(baseInput({ targetDocumentId }), reader)
      expect(result.publicSummary.status).toBe("blocked")
      expect(reader.getDocument).not.toHaveBeenCalled()
      expect(reader.batchUpdate).not.toHaveBeenCalled()
    }
  })

  test("fails snapshot gates before any document access", async () => {
    const cases: { name: string; input: RunEltDocDryRunInput; reason: string }[] = [
      {
        name: "wrong workflow",
        input: baseInput({ snapshot: makeSnapshot({ workflow_id: "T06" }) }),
        reason: "not E01",
      },
      {
        name: "wrong mode",
        input: baseInput({ snapshot: makeSnapshot({ mode: "local" }) }),
        reason: "mode is not approved",
      },
      {
        name: "invalid timestamp",
        input: baseInput({ snapshot: makeSnapshot({ generated_at: "not-a-date" }) }),
        reason: "timestamp is invalid",
      },
      {
        name: "future timestamp",
        input: baseInput({ evaluatedAt: "2026-07-11T01:49:59.999Z" }),
        reason: "in the future",
      },
      {
        name: "truncated pull",
        input: baseInput({
          snapshot: makeSnapshot({
            org_rollup: { ...makeSnapshot().org_rollup, truncation_suspected_pulls: 1 },
          }),
        }),
        reason: "truncated source pull",
      },
      {
        name: "missing elt facts",
        input: baseInput({ snapshot: makeSnapshot({ elt_facts: null }) }),
        reason: "missing or malformed",
      },
      {
        name: "reporting week mismatch",
        input: baseInput({
          snapshot: makeSnapshot({
            org_rollup: { ...makeSnapshot().org_rollup, reporting_week_friday: "2026-06-26" },
          }),
        }),
        reason: "reporting week",
      },
      {
        name: "fixture provenance on shadow data",
        input: baseInput({ dataProvenance: "fixture" }),
        reason: "Fixture fingerprint provenance",
      },
      {
        name: "live hydration configuration",
        input: baseInput({ liveFlagValue: "true" }),
        reason: "Live hydration flag is enabled",
      },
    ]

    for (const entry of cases) {
      const reader = fakeReader()
      const result = await runEltDocDryRun(entry.input, reader)
      expect(result.publicSummary.status, entry.name).toBe("blocked")
      expect(result.publicSummary.blockingReasons.join(" "), entry.name).toContain(entry.reason)
      expect(reader.getDocument, entry.name).not.toHaveBeenCalled()
      expect(reader.batchUpdate, entry.name).not.toHaveBeenCalled()
    }
  })

  test.each([
    {
      name: "wrong returned document id",
      document: makeDocument({ documentId: "unknown-returned-id" }),
      reason: "approved P1 staging copy",
    },
    {
      name: "wrong title",
      document: makeDocument({ title: "Unexpected title" }),
      reason: "Document title",
    },
    {
      name: "missing revision",
      document: makeDocument({ revisionId: undefined }),
      reason: "revision id",
    },
    {
      name: "missing tab",
      document: makeDocument({ tabs: [] }),
      reason: "document tab",
    },
  ])("blocks $name after the read and still performs zero mutations", async ({ document, reason }) => {
    const reader = fakeReader(document)
    const result = await runEltDocDryRun(baseInput(), reader)

    expect(reader.getDocument).toHaveBeenCalledOnce()
    expect(reader.batchUpdate).not.toHaveBeenCalled()
    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain(reason)
    expect(result.privatePlan).toBeNull()
  })

  test("requires the live PII fingerprint salt without logging private payload", async () => {
    delete process.env[PII_FINGERPRINT_SALT_ENV]
    const reader = fakeReader()
    const result = await runEltDocDryRun(baseInput(), reader)

    expect(result.publicSummary.status).toBe("blocked")
    expect(result.publicSummary.blockingReasons.join(" ")).toContain("fingerprint secret")
    expect(JSON.stringify(result.publicSummary)).not.toContain("Mira Solis")
    expect(result.privatePlan).toBeNull()
    expect(reader.batchUpdate).not.toHaveBeenCalled()
  })

  test("non-exact live flags cannot enable a write and fixture mode requires explicit provenance", async () => {
    const nonExactFlagReader = fakeReader()
    const nonExactFlag = await runEltDocDryRun(
      baseInput({ liveFlagValue: "TRUE" }),
      nonExactFlagReader
    )
    expect(nonExactFlag.publicSummary.status).toBe("planned_for_internal_review")
    expect(nonExactFlag.publicSummary.liveFlagEnabled).toBe(false)
    expect(nonExactFlagReader.batchUpdate).not.toHaveBeenCalled()

    delete process.env[PII_FINGERPRINT_SALT_ENV]
    const fixtureReader = fakeReader()
    const fixtureSnapshot = makeSnapshot({ mode: "fixture" })
    const fixture = await runEltDocDryRun(
      baseInput({
        snapshot: fixtureSnapshot,
        allowedSnapshotModes: ["fixture"],
        dataProvenance: "fixture",
      }),
      fixtureReader
    )
    expect(fixture.publicSummary.status).toBe("planned_for_internal_review")
    expect(fixture.publicSummary.payloadFingerprint).toMatch(/^hmac-sha256:/)
    expect(fixtureReader.batchUpdate).not.toHaveBeenCalled()
  })
})
