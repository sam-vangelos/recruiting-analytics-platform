import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import {
  createPiiFingerprint,
  PII_FINGERPRINT_SALT_ENV,
} from "../lib/recruiting-ops/checksums"
import {
  ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
  ELT_DOC_HIRE_TABLE_BODY_FONT_PT,
  ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT,
  ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT,
  ELT_DOC_HIRE_TABLE_HEADERS,
  ELT_DOC_HIRE_TABLE_STRIPE_RGB,
  ELT_DOC_TOP_WEEK_FACTS_RANGE_ID,
  fingerprintEltDocContentRange,
  fingerprintEltDocDocumentContent,
  fingerprintEltDocOutsideContent,
  type EltDocDryRunPrivatePlan,
  type GoogleDocsDocumentSnapshot,
  type GoogleDocsStructuralElement,
} from "../lib/recruiting-ops/delivery/elt-doc-dry-run"
import type { EltDocParagraph } from "../lib/recruiting-ops/delivery/elt-doc-renderer"
import {
  RECRUITING_OPS_ELT_DOC_OWNER,
  RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT,
  StagingEltDocWriteExecutionError,
  stagingEltDocWriteFailureStage,
  writeStagingEltDocument,
  type GoogleWorkspaceStagingClients,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { P1_ELT_DOC_TARGET } from "../lib/recruiting-ops/delivery/p1-artifacts"
import {
  getStagingArtifact,
  STAGING_HYDRATION_ENABLED_AT_ENV,
  STAGING_HYDRATION_EXPIRES_AT_ENV,
  STAGING_HYDRATION_GLOBAL_FLAG,
} from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import type { StagingWritePermit } from "../lib/recruiting-ops/delivery/staging-write-permit"

const originalSalt = process.env[PII_FINGERPRINT_SALT_ENV]

beforeEach(() => {
  process.env[PII_FINGERPRINT_SALT_ENV] = "elt-doc-writer-test-only-salt"
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalSalt === undefined) delete process.env[PII_FINGERPRINT_SALT_ENV]
  else process.env[PII_FINGERPRINT_SALT_ENV] = originalSalt
})

function paragraph(startIndex: number, text: string): GoogleDocsStructuralElement {
  return {
    startIndex,
    endIndex: startIndex + text.length,
    paragraph: { elements: [{ textRun: { content: text } }] },
  }
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

// A9: the Role Progress narrative tail is mutation-owned, so the writer's
// certification/rollback fixtures must exercise its real, structured shape
// (namedStyleType + explicit bold), not an opaque untouched blob.
const NARRATIVE_PARAGRAPHS: readonly EltDocParagraph[] = [
  {
    kind: "section_heading",
    text: "FDE + PE Role Progress b/w Jul 3 - Jul 9",
    namedStyleType: "HEADING_2",
    bold: true,
    tone: "ink",
  },
  {
    kind: "body",
    text: "QTD Offer Accepted - 0 (PE 0, FDE 0)",
    namedStyleType: "NORMAL_TEXT",
    bold: false,
    tone: "ink",
  },
]

function narrativeTotalLength(paragraphs: readonly EltDocParagraph[]): number {
  return paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length + 1, 0)
}

function narrativeElements(
  startIndex: number,
  paragraphs: readonly EltDocParagraph[]
): GoogleDocsStructuralElement[] {
  let cursor = startIndex
  return paragraphs.map((para) => {
    const endIndex = cursor + para.text.length + 1
    const element: GoogleDocsStructuralElement = {
      startIndex: cursor,
      endIndex,
      paragraph: {
        paragraphStyle: {
          namedStyleType: para.namedStyleType,
          // Docs stamps a headingId onto every heading paragraph; a narrative
          // section heading read back from the real API always carries one.
          // Omitting it here is what let the post-image certification demand a
          // key set no real document can produce.
          ...(para.namedStyleType === "HEADING_2" ? { headingId: `h.${cursor}narr` } : {}),
        },
        elements: [{
          textRun: {
            content: `${para.text}\n`,
            // Docs reports no `bold` property on an unbolded run, so the style
            // object comes back empty and the observed-defaults normalizer drops
            // it. Modelling it as always-present hid a contradiction between that
            // normalizer and the certification's key-set check.
            ...(para.bold ? { textStyle: { bold: true } } : {}),
          },
        }],
      },
    }
    cursor = endIndex
    return element
  })
}

function observedHireTable(
  startIndex: number,
  hireRows: readonly (readonly [string, string, string, string, string])[]
): GoogleDocsStructuralElement {
  const rows = [ELT_DOC_HIRE_TABLE_HEADERS, ...hireRows]
  const dimension = (magnitude: number) => ({ magnitude, unit: "PT" })
  const gray = { color: { rgbColor: { red: 0.8, green: 0.8, blue: 0.8 } } }
  const border = (width: number, withColor: boolean) => ({
    ...(withColor ? { color: gray } : {}),
    width: dimension(width),
    dashStyle: "SOLID",
  })
  const tableRows = rows.map((row, rowIndex) => ({
    tableRowStyle: { minRowHeight: dimension(27) },
    tableCells: row.map((text) => ({
      tableCellStyle: {
        ...(rowIndex > 0
          ? {
              backgroundColor: {
                color: {
                  rgbColor:
                    rowIndex % 2 === 1
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
  }))
  const textLength = rows.flat().reduce((sum, text) => sum + text.length, 0)
  return {
    startIndex,
    endIndex: startIndex + 2 + rows.length * 11 + textLength,
    table: {
      rows: rows.length,
      columns: 5,
      tableStyle: {
        tableColumnProperties: ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT.map((width) => ({
          widthType: "FIXED_WIDTH",
          width: dimension(width),
        })),
      },
      tableRows,
    },
  }
}

function withLiveGoogleDocsApiDefaults(
  input: GoogleDocsDocumentSnapshot
): GoogleDocsDocumentSnapshot {
  const document = structuredClone(input)
  const content = document.tabs?.[0]?.documentTab?.body?.content
  const heading = content?.[1]
  const interstitial = content?.[2]
  const tableElement = content?.[3]
  const rows = tableElement?.table?.tableRows
  if (
    !heading?.paragraph?.paragraphStyle ||
    !interstitial?.paragraph?.paragraphStyle ||
    !rows ||
    tableElement?.startIndex === undefined ||
    tableElement.endIndex === undefined
  ) {
    throw new Error("invalid live Google Docs API writer fixture")
  }
  heading.paragraph.paragraphStyle.direction = "LEFT_TO_RIGHT"
  heading.paragraph.elements?.forEach((part) => {
    if (part.dateElement) part.dateElement.textStyle = {}
    if (part.textRun) part.textRun.textStyle = {}
  })
  interstitial.paragraph.paragraphStyle.direction = "LEFT_TO_RIGHT"
  interstitial.paragraph.elements?.forEach((part) => {
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
        throw new Error("invalid live Google Docs API writer cell fixture")
      }
      style.rowSpan = 1
      style.columnSpan = 1
      paragraphStyle.direction = "LEFT_TO_RIGHT"
      paragraphStyle.lineSpacing = 100
      if (rowIndex === 0) {
        style.backgroundColor = {}
      } else {
        style.borderLeft!.color = { color: { rgbColor: {} } }
        style.borderRight!.color = { color: { rgbColor: {} } }
        delete textStyle.bold
      }
    })
  })
  return document
}

function document(
  revisionId: string,
  content: GoogleDocsStructuralElement[],
  overrides: Partial<GoogleDocsDocumentSnapshot> = {}
): GoogleDocsDocumentSnapshot {
  return {
    documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
    title: P1_ELT_DOC_TARGET.expectedTitle,
    revisionId,
    tabs: [
      {
        tabProperties: { tabId: P1_ELT_DOC_TARGET.tabId },
        documentTab: { body: { content } },
      },
    ],
    ...overrides,
  }
}

interface WriterFixtureOptions {
  before?: GoogleDocsDocumentSnapshot
  after?: GoogleDocsDocumentSnapshot
  noOp?: boolean
  env?: Record<string, string>
}

interface DocsBatchInput {
  documentId: string
  requestBody: {
    requests: Array<{ insertText?: { text?: string } }>
    writeControl: { requiredRevisionId: string }
  }
}

function approvedPermissionResponse() {
  return {
    data: {
      permissions: [
        {
          type: "user",
          role: "owner",
          emailAddress: RECRUITING_OPS_ELT_DOC_OWNER,
        },
        {
          type: "user",
          role: "writer",
          emailAddress: RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT,
        },
      ],
    },
  }
}

function editableEltDriveMetadata(version: string) {
  return {
    id: P1_ELT_DOC_TARGET.stagingDocumentId,
    mimeType: "application/vnd.google-apps.document",
    version,
    trashed: false,
    capabilities: { canEdit: true, canModifyContent: true },
  }
}

function fixture(options: WriterFixtureOptions = {}) {
  const rollbackFactTable: EltDocDryRunPrivatePlan["factTable"] = {
    weekLabel: "Jul 3, 2026 - Jul 9, 2026",
    startDisplayText: "Jul 3, 2026",
    endDisplayText: "Jul 9, 2026",
    startTimestamp: "2026-07-03T12:00:00.000Z",
    endTimestamp: "2026-07-09T12:00:00.000Z",
    hireRows: [["Old Role", "Old Dept", "P2", "Old Candidate", "TBD"]] as const,
    narrativeParagraphs: NARRATIVE_PARAGRAPHS,
  }
  const replacementFactTable: EltDocDryRunPrivatePlan["factTable"] = {
    ...rollbackFactTable,
    hireRows: [
      ["Research Engineer", "Frontier Data", "P1", "Amina Vega", "2026-07-20"],
      ["Product Engineer", "", "P2", "Theo Park", "TBD"],
    ] as const,
  }
  const factTable = options.noOp ? rollbackFactTable : replacementFactTable
  const beforeTable = observedHireTable(10, rollbackFactTable.hireRows)
  const afterTable = observedHireTable(10, factTable.hireRows)
  const narrativeLength = narrativeTotalLength(NARRATIVE_PARAGRAPHS)
  const beforeNarrativeStart = beforeTable.endIndex!
  const nextBoundaryStart = beforeNarrativeStart + narrativeLength
  const afterNarrativeStart = afterTable.endIndex!
  const afterNextBoundaryStart = afterNarrativeStart + narrativeLength
  const before =
    options.before ??
    document("revision-before", [
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      dateChipHeading(1, 9, "Jul 3, 2026", "Jul 9, 2026"),
      blankParagraph(9),
      beforeTable,
      ...narrativeElements(beforeNarrativeStart, NARRATIVE_PARAGRAPHS),
      dateChipHeading(nextBoundaryStart, nextBoundaryStart + 8, "Jun 26, 2026", "Jul 2, 2026"),
      paragraph(nextBoundaryStart + 8, "Keep\n"),
    ])
  const after =
    options.after ??
    (options.noOp
      ? before
      : document("revision-after", [
          { startIndex: 0, endIndex: 1, sectionBreak: {} },
          dateChipHeading(1, 9, "Jul 3, 2026", "Jul 9, 2026"),
          blankParagraph(9),
          afterTable,
          ...narrativeElements(afterNarrativeStart, NARRATIVE_PARAGRAPHS),
          dateChipHeading(
            afterNextBoundaryStart,
            afterNextBoundaryStart + 8,
            "Jun 26, 2026",
            "Jul 2, 2026"
          ),
          paragraph(afterNextBoundaryStart + 8, "Keep\n"),
        ]))
  const preimageRange = {
    tabId: P1_ELT_DOC_TARGET.tabId,
    startIndex: options.noOp ? 10 : 9,
    endIndex: nextBoundaryStart,
  }
  const plan: EltDocDryRunPrivatePlan = {
    runId: "e01_live_20260711120000000",
    sourceGeneratedAt: "2026-07-11T12:00:00.000Z",
    dataProvenance: "live",
    documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
    tabId: P1_ELT_DOC_TARGET.tabId,
    requiredRevisionId: "revision-before",
    payloadFingerprint: createPiiFingerprint(factTable, {
      context: "recops:p1:elt-doc:weekly-facts",
      dataProvenance: "live",
    }),
    preimageFingerprint: fingerprintEltDocContentRange({
      document: before,
      ...preimageRange,
      dataProvenance: "live",
    }),
    preimageDocumentFingerprint: fingerprintEltDocDocumentContent(
      before,
      P1_ELT_DOC_TARGET.tabId,
      "live"
    ),
    outsideContentFingerprint: fingerprintEltDocOutsideContent({
      document: before,
      ...preimageRange,
      dataProvenance: "live",
    }),
    approvedRangeIds: [ELT_DOC_TOP_WEEK_FACTS_RANGE_ID],
    mutationScope: "weekly_fact_table",
    action: options.noOp ? "no_op" : "replace_top_week",
    archiveBlockRange: {
      tabId: P1_ELT_DOC_TARGET.tabId,
      startIndex: 1,
      endIndex: nextBoundaryStart,
    },
    contentGuardRange: preimageRange,
    deleteRange: options.noOp ? null : preimageRange,
    insertAt: options.noOp ? null : { tabId: P1_ELT_DOC_TARGET.tabId, index: 9 },
    factTable,
    rollbackFactTable,
  }
  const artifact = getStagingArtifact("elt_doc")
  const env =
    options.env ??
    ({
      [STAGING_HYDRATION_GLOBAL_FLAG]: "true",
      [artifact.hydrationFlag]: "true",
      [STAGING_HYDRATION_ENABLED_AT_ENV]: "2026-07-11T12:00:00.000Z",
      [STAGING_HYDRATION_EXPIRES_AT_ENV]: "2026-07-11T12:10:00.000Z",
    } satisfies Record<string, string>)
  const permit: StagingWritePermit = {
    artifactKey: "elt_doc",
    artifactId: artifact.artifactId,
    kind: "google_doc",
    runId: plan.runId,
    issuedAt: "2026-07-11T12:00:10.000Z",
    expiresAt: "2026-07-11T12:10:10.000Z",
    sourceGeneratedAt: plan.sourceGeneratedAt,
    payloadFingerprint: plan.payloadFingerprint,
    structureHash: plan.outsideContentFingerprint,
    approvedRangeIds: plan.approvedRangeIds,
    killSwitchStoreReachable: true,
    killSwitchClear: true,
    canonicalOnly: true,
  }
  const get = vi.fn()
  const filesGet = vi.fn()
  const setStableStates = (
    ...states: readonly {
      document: GoogleDocsDocumentSnapshot
      driveVersion: string
    }[]
  ) => {
    get.mockReset()
    filesGet.mockReset()
    for (const state of states) {
      get
        .mockResolvedValueOnce({ data: state.document })
        .mockResolvedValueOnce({ data: state.document })
      const metadata = editableEltDriveMetadata(state.driveVersion)
      filesGet
        .mockResolvedValueOnce({ data: metadata })
        .mockResolvedValueOnce({ data: metadata })
    }
    const last = states.at(-1)
    if (last) {
      get.mockResolvedValue({ data: last.document })
      filesGet.mockResolvedValue({ data: editableEltDriveMetadata(last.driveVersion) })
    }
  }
  setStableStates(
    { document: before, driveVersion: "100" },
    { document: after, driveVersion: "101" }
  )
  const batchUpdate = vi.fn(async (request: DocsBatchInput) => {
    return {
      data: {
        writeControl: {
          requiredRevisionId:
            request.requestBody.writeControl.requiredRevisionId === plan.requiredRevisionId
              ? after.revisionId
              : "revision-recovered",
        },
      },
    }
  })
  const permissionsList = vi.fn(async () => approvedPermissionResponse())
  const clients = {
    docs: { documents: { get, batchUpdate } },
    drive: {
      files: { get: filesGet },
      permissions: { list: permissionsList },
    },
    sheets: {},
  } as unknown as GoogleWorkspaceStagingClients
  return {
    before,
    after,
    plan,
    permit,
    env,
    clients,
    get,
    batchUpdate,
    filesGet,
    permissionsList,
    setStableStates,
    beforeFactEnd: beforeTable.endIndex!,
    afterFactEnd: afterTable.endIndex!,
    nextBoundaryStart,
    afterNextBoundaryStart,
  }
}

function insertionFixture() {
  const value = fixture()
  const beforeContent = value.before.tabs?.[0]?.documentTab?.body?.content
  if (!beforeContent) throw new Error("invalid insertion writer fixture")
  const factTable = {
    weekLabel: "Jul 10, 2026 - Jul 16, 2026",
    startDisplayText: "Jul 10, 2026",
    endDisplayText: "Jul 16, 2026",
    startTimestamp: "2026-07-10T12:00:00.000Z",
    endTimestamp: "2026-07-16T12:00:00.000Z",
    hireRows: [
      ["Research Engineer", "Frontier Data", "P1", "Amina Vega", "2026-07-20"],
      ["Product Engineer", "", "P2", "Theo Park", "TBD"],
    ] as const,
    narrativeParagraphs: [] as const,
  }
  const emptyRange = { tabId: P1_ELT_DOC_TARGET.tabId, startIndex: 1, endIndex: 1 }
  const plan: EltDocDryRunPrivatePlan = {
    runId: "e01_live_20260718120000000",
    sourceGeneratedAt: "2026-07-18T12:00:00.000Z",
    dataProvenance: "live",
    documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
    tabId: P1_ELT_DOC_TARGET.tabId,
    requiredRevisionId: "revision-before",
    payloadFingerprint: createPiiFingerprint(factTable, {
      context: "recops:p1:elt-doc:weekly-facts",
      dataProvenance: "live",
    }),
    preimageFingerprint: fingerprintEltDocContentRange({
      document: value.before,
      ...emptyRange,
      dataProvenance: "live",
    }),
    preimageDocumentFingerprint: fingerprintEltDocDocumentContent(
      value.before,
      P1_ELT_DOC_TARGET.tabId,
      "live"
    ),
    outsideContentFingerprint: fingerprintEltDocOutsideContent({
      document: value.before,
      ...emptyRange,
      dataProvenance: "live",
    }),
    approvedRangeIds: [ELT_DOC_TOP_WEEK_FACTS_RANGE_ID],
    mutationScope: "weekly_fact_table",
    action: "insert_top_week",
    archiveBlockRange: {
      tabId: P1_ELT_DOC_TARGET.tabId,
      startIndex: 1,
      endIndex: value.nextBoundaryStart,
    },
    contentGuardRange: emptyRange,
    deleteRange: null,
    insertAt: { tabId: P1_ELT_DOC_TARGET.tabId, index: 1 },
    factTable,
    rollbackFactTable: null,
  }
  const table = observedHireTable(10, factTable.hireRows)
  const insertedFactEnd = table.endIndex!
  const shift = insertedFactEnd - 1
  const shiftedHistorical = beforeContent.slice(1).map((element) => ({
    ...structuredClone(element),
    startIndex: (element.startIndex ?? 0) + shift,
    endIndex: (element.endIndex ?? 0) + shift,
  }))
  const after = document("revision-after-insert", [
    structuredClone(beforeContent[0]),
    dateChipHeading(1, 9, factTable.startDisplayText, factTable.endDisplayText),
    blankParagraph(9),
    table,
    ...shiftedHistorical,
  ])
  const permit: StagingWritePermit = {
    ...value.permit,
    runId: plan.runId,
    issuedAt: "2026-07-18T12:00:10.000Z",
    expiresAt: "2026-07-18T12:10:10.000Z",
    sourceGeneratedAt: plan.sourceGeneratedAt,
    payloadFingerprint: plan.payloadFingerprint,
    structureHash: plan.outsideContentFingerprint,
  }
  value.setStableStates(
    { document: value.before, driveVersion: "100" },
    { document: after, driveVersion: "101" }
  )
  value.batchUpdate.mockImplementation(async (request: DocsBatchInput) => ({
    data: {
      writeControl: {
        requiredRevisionId:
          request.requestBody.writeControl.requiredRevisionId === plan.requiredRevisionId
            ? after.revisionId
            : "revision-recovered",
      },
    },
  }))
  return {
    ...value,
    plan,
    permit,
    env: {
      ...value.env,
      [STAGING_HYDRATION_ENABLED_AT_ENV]: "2026-07-18T12:00:00.000Z",
      [STAGING_HYDRATION_EXPIRES_AT_ENV]: "2026-07-18T12:10:00.000Z",
    },
    after,
    insertedFactEnd,
  }
}

function midInsertionFixture() {
  const value = fixture()
  const factTable = {
    weekLabel: "Jul 3, 2026 - Jul 9, 2026",
    startDisplayText: "Jul 3, 2026",
    endDisplayText: "Jul 9, 2026",
    startTimestamp: "2026-07-03T12:00:00.000Z",
    endTimestamp: "2026-07-09T12:00:00.000Z",
    hireRows: [
      ["Research Engineer", "Frontier Data", "P1", "Amina Vega", "2026-07-20"],
    ] as const,
    narrativeParagraphs: [] as const,
  }
  // The backfill shape: a machine-written newest block, a human-shaped partial
  // block below it (heading + prose, no interstitial or table), then older
  // blocks. The declared week inserts between the first two. Four boundaries
  // exist so a plan can name two non-adjacent ones and prove the adjacency
  // check is load-bearing.
  const topTable = observedHireTable(10, [["Top Role", "Top Dept", "P1", "Top Candidate", "TBD"]])
  const humanStart = topTable.endIndex!
  const humanText = "Weekly recap written by hand\n"
  const olderStart = humanStart + 8 + humanText.length
  const oldestStart = olderStart + 8 + "Keep\n".length
  const before = document("revision-before", [
    { startIndex: 0, endIndex: 1, sectionBreak: {} },
    dateChipHeading(1, 9, "Jul 10, 2026", "Jul 16, 2026"),
    blankParagraph(9),
    topTable,
    dateChipHeading(humanStart, humanStart + 8, "Jun 26, 2026", "Jul 2, 2026"),
    paragraph(humanStart + 8, humanText),
    dateChipHeading(olderStart, olderStart + 8, "Jun 19, 2026", "Jun 25, 2026"),
    paragraph(olderStart + 8, "Keep\n"),
    dateChipHeading(oldestStart, oldestStart + 8, "Jun 12, 2026", "Jun 18, 2026"),
    paragraph(oldestStart + 8, "Tail\n"),
  ])
  const emptyRange = { tabId: P1_ELT_DOC_TARGET.tabId, startIndex: humanStart, endIndex: humanStart }
  const plan: EltDocDryRunPrivatePlan = {
    runId: "e01_live_20260718120000000",
    sourceGeneratedAt: "2026-07-18T12:00:00.000Z",
    dataProvenance: "live",
    documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
    tabId: P1_ELT_DOC_TARGET.tabId,
    requiredRevisionId: "revision-before",
    payloadFingerprint: createPiiFingerprint(factTable, {
      context: "recops:p1:elt-doc:weekly-facts",
      dataProvenance: "live",
    }),
    preimageFingerprint: fingerprintEltDocContentRange({
      document: before,
      ...emptyRange,
      dataProvenance: "live",
    }),
    preimageDocumentFingerprint: fingerprintEltDocDocumentContent(
      before,
      P1_ELT_DOC_TARGET.tabId,
      "live"
    ),
    outsideContentFingerprint: fingerprintEltDocOutsideContent({
      document: before,
      ...emptyRange,
      dataProvenance: "live",
    }),
    approvedRangeIds: [ELT_DOC_TOP_WEEK_FACTS_RANGE_ID],
    mutationScope: "weekly_fact_table",
    action: "insert_top_week",
    archiveBlockRange: {
      tabId: P1_ELT_DOC_TARGET.tabId,
      startIndex: humanStart,
      endIndex: olderStart,
    },
    contentGuardRange: emptyRange,
    deleteRange: null,
    insertAt: { tabId: P1_ELT_DOC_TARGET.tabId, index: humanStart },
    factTable,
    rollbackFactTable: null,
  }
  const insertedTable = observedHireTable(humanStart + 9, factTable.hireRows)
  const insertedFactEnd = insertedTable.endIndex!
  const shift = insertedFactEnd - humanStart
  const beforeContent = before.tabs?.[0]?.documentTab?.body?.content
  if (!beforeContent) throw new Error("invalid mid-insertion writer fixture")
  const shiftedTail = beforeContent.slice(4).map((element) => ({
    ...structuredClone(element),
    startIndex: (element.startIndex ?? 0) + shift,
    endIndex: (element.endIndex ?? 0) + shift,
  }))
  const after = document("revision-after-mid", [
    structuredClone(beforeContent[0]),
    structuredClone(beforeContent[1]),
    structuredClone(beforeContent[2]),
    structuredClone(beforeContent[3]),
    dateChipHeading(humanStart, humanStart + 8, "Jul 3, 2026", "Jul 9, 2026"),
    blankParagraph(humanStart + 8),
    insertedTable,
    ...shiftedTail,
  ])
  const permit: StagingWritePermit = {
    ...value.permit,
    runId: plan.runId,
    issuedAt: "2026-07-18T12:00:10.000Z",
    expiresAt: "2026-07-18T12:10:10.000Z",
    sourceGeneratedAt: plan.sourceGeneratedAt,
    payloadFingerprint: plan.payloadFingerprint,
    structureHash: plan.outsideContentFingerprint,
  }
  value.setStableStates(
    { document: before, driveVersion: "100" },
    { document: after, driveVersion: "101" }
  )
  value.batchUpdate.mockImplementation(async (request: DocsBatchInput) => ({
    data: {
      writeControl: {
        requiredRevisionId:
          request.requestBody.writeControl.requiredRevisionId === plan.requiredRevisionId
            ? after.revisionId
            : "revision-recovered",
      },
    },
  }))
  return {
    ...value,
    before,
    after,
    plan,
    permit,
    env: {
      ...value.env,
      [STAGING_HYDRATION_ENABLED_AT_ENV]: "2026-07-18T12:00:00.000Z",
      [STAGING_HYDRATION_EXPIRES_AT_ENV]: "2026-07-18T12:10:00.000Z",
    },
    humanStart,
    olderStart,
    oldestStart,
    insertedFactEnd,
  }
}

async function write(
  value: ReturnType<typeof fixture>,
  options: {
    currentTimeMs?: () => number
    revalidateKillSwitchClear?: () => Promise<void>
  } = {}
) {
  const currentTime = Date.parse(value.plan.sourceGeneratedAt) + 60_000
  return writeStagingEltDocument({
    plan: value.plan,
    permit: value.permit,
    env: value.env,
    clients: value.clients,
    currentTimeMs: options.currentTimeMs ?? (() => currentTime),
    revalidateKillSwitchClear: options.revalidateKillSwitchClear ?? (async () => {}),
  })
}

describe("guarded copied ELT Google Doc fact-table writer", () => {
  test("creates only one missing date chip and five-column fact table", async () => {
    const value = insertionFixture()
    const summary = await write(value, {
      currentTimeMs: () => Date.parse("2026-07-18T12:01:00.000Z"),
    })

    expect(summary).toMatchObject({
      artifactKey: "elt_doc",
      status: "written",
      action: "insert_top_week",
      mutationCallCount: 1,
      beforeRevisionId: "revision-before",
      afterRevisionId: "revision-after-insert",
      preimageFingerprint: value.plan.preimageFingerprint,
      beforeOutsideContentFingerprint: value.plan.outsideContentFingerprint,
      afterOutsideContentFingerprint: value.plan.outsideContentFingerprint,
      rollbackAttempted: false,
    })
    expect(value.get).toHaveBeenCalledTimes(4)
    expect(value.permissionsList).toHaveBeenCalledTimes(4)
    expect(value.permissionsList).toHaveBeenCalledWith({
      fileId: P1_ELT_DOC_TARGET.stagingDocumentId,
      supportsAllDrives: true,
      pageSize: 100,
      fields: "nextPageToken,permissions(type,role,emailAddress,deleted,pendingOwner)",
    })
    expect(value.batchUpdate).toHaveBeenCalledOnce()
    const requestPrefix = value.batchUpdate.mock.calls[0]?.[0].requestBody.requests
      .slice(0, 6) as {
        insertText?: { location?: { index?: number } }
        insertDate?: { location?: { index?: number } }
        insertTable?: { location?: { index?: number } }
      }[]
    expect(
      requestPrefix.map((request) => [
          Object.keys(request)[0],
          request.insertText?.location?.index ??
            request.insertDate?.location?.index ??
            request.insertTable?.location?.index,
        ])
    ).toEqual([
      ["insertText", 1],
      ["insertDate", 1],
      ["insertText", 2],
      ["insertDate", 5],
      ["insertText", 6],
      ["insertTable", 9],
    ])
    expect(value.batchUpdate).toHaveBeenCalledWith({
      documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
      requestBody: {
        requests: expect.arrayContaining([
          {
            insertTable: {
              rows: 3,
              columns: 5,
              location: { tabId: P1_ELT_DOC_TARGET.tabId, index: 9 },
            },
          },
          {
            insertDate: {
              location: { tabId: P1_ELT_DOC_TARGET.tabId, index: 1 },
              dateElementProperties: {
                timestamp: "2026-07-10T12:00:00.000Z",
                locale: "en",
                dateFormat: "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
                timeFormat: "TIME_FORMAT_DISABLED",
              },
            },
          },
        ]),
        writeControl: { requiredRevisionId: "revision-before" },
      },
    })
    expect(
      fingerprintEltDocOutsideContent({
        document: value.after,
        tabId: P1_ELT_DOC_TARGET.tabId,
        startIndex: 1,
        endIndex: value.insertedFactEnd,
        dataProvenance: "live",
      })
    ).toBe(value.plan.outsideContentFingerprint)
    const insertedText = value.batchUpdate.mock.calls[0]?.[0].requestBody.requests
      .flatMap((request: { insertText?: { text?: string } }) => request.insertText?.text ?? [])
      .join("")
    expect(insertedText).not.toContain("Hires:")
    expect(insertedText).not.toContain("Body")
  })

  test("writes and certifies a mid-archive insertion between two retained blocks", async () => {
    const value = midInsertionFixture()
    const summary = await write(value, {
      currentTimeMs: () => Date.parse("2026-07-18T12:01:00.000Z"),
    })

    expect(summary).toMatchObject({
      artifactKey: "elt_doc",
      status: "written",
      action: "insert_top_week",
      mutationCallCount: 1,
      beforeRevisionId: "revision-before",
      afterRevisionId: "revision-after-mid",
      rollbackAttempted: false,
    })
    const p = value.humanStart
    const requests = value.batchUpdate.mock.calls[0]?.[0].requestBody.requests as {
      insertText?: { location?: { index?: number } }
      insertDate?: { location?: { index?: number } }
      insertTable?: { location?: { index?: number } }
      updateParagraphStyle?: { range?: { startIndex?: number; endIndex?: number } }
    }[]
    expect(
      requests.slice(0, 6).map((request) => [
        Object.keys(request)[0],
        request.insertText?.location?.index ??
          request.insertDate?.location?.index ??
          request.insertTable?.location?.index,
      ])
    ).toEqual([
      ["insertText", p],
      ["insertDate", p],
      ["insertText", p + 1],
      ["insertDate", p + 4],
      ["insertText", p + 5],
      ["insertTable", p + 8],
    ])
    // The inserted heading styles are insertion-relative; absolute {1,9}/{9,10}
    // ranges here would have restyled the top block instead.
    expect(
      requests
        .filter((request) =>
          (request.updateParagraphStyle?.range?.startIndex ?? Number.MAX_SAFE_INTEGER) < p + 9
        )
        .map((request) => request.updateParagraphStyle?.range)
    ).toEqual([
      { tabId: P1_ELT_DOC_TARGET.tabId, startIndex: p, endIndex: p + 8 },
      { tabId: P1_ELT_DOC_TARGET.tabId, startIndex: p + 8, endIndex: p + 9 },
    ])
    // Position-independence of the preservation proof: everything outside the
    // inserted block, above and below it, hashes to the planned fingerprint.
    expect(
      fingerprintEltDocOutsideContent({
        document: value.after,
        tabId: P1_ELT_DOC_TARGET.tabId,
        startIndex: p,
        endIndex: value.insertedFactEnd,
        dataProvenance: "live",
      })
    ).toBe(value.plan.outsideContentFingerprint)
  })

  test("rolls back a mid-archive insertion whose readback differs, deleting exactly the inserted block", async () => {
    const value = midInsertionFixture()
    const wrongAfter = structuredClone(value.after)
    const header =
      wrongAfter.tabs?.[0]?.documentTab?.body?.content?.[6]?.table?.tableRows?.[0]
        ?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]?.textRun
    if (!header) throw new Error("invalid mid-insertion post-state fixture")
    header.content = "Wrong\n"
    const recovered = structuredClone(value.before)
    recovered.revisionId = "revision-recovered"
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: wrongAfter, driveVersion: "101" },
      { document: recovered, driveVersion: "102" }
    )

    let failure: unknown
    try {
      await write(value, {
        currentTimeMs: () => Date.parse("2026-07-18T12:01:00.000Z"),
      })
    } catch (error) {
      failure = error
    }
    expect(stagingEltDocWriteFailureStage(failure)).toBe("postimage_validation")
    expect(failure).toBeInstanceOf(StagingEltDocWriteExecutionError)
    expect(failure).toMatchObject({
      mutationCallCount: 2,
      certificationStatus: "rollback_verified",
      rollbackAttempted: true,
      rollbackVerified: true,
    })
    expect(value.batchUpdate).toHaveBeenCalledTimes(2)
    expect(value.batchUpdate.mock.calls[1]?.[0].requestBody.writeControl).toEqual({
      requiredRevisionId: "revision-after-mid",
    })
    // The rollback deletes the block at the planned insertion point and
    // nothing else - the pushed-down human block starts exactly at the
    // inserted block's end.
    expect(value.batchUpdate.mock.calls[1]?.[0].requestBody.requests[0]).toEqual({
      deleteContentRange: {
        range: {
          tabId: P1_ELT_DOC_TARGET.tabId,
          startIndex: value.humanStart,
          endIndex: value.insertedFactEnd,
        },
      },
    })
  })

  test("refuses a mid-archive plan whose block range skips an intervening boundary", async () => {
    const value = midInsertionFixture()
    // Both endpoints are genuine week anchors, so the old endpoint-only proof
    // passed a range straddling a whole block; only adjacency catches it.
    const plan = {
      ...value.plan,
      archiveBlockRange: { ...value.plan.archiveBlockRange, endIndex: value.oldestStart },
    }
    let failure: unknown
    try {
      await write({ ...value, plan }, {
        currentTimeMs: () => Date.parse("2026-07-18T12:01:00.000Z"),
      })
    } catch (error) {
      failure = error
    }
    expect(stagingEltDocWriteFailureStage(failure)).toBe("preimage_validation")
    expect((failure as Error).message).toContain("archive boundary proof")
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("certifies Docs' harmless paragraph defaults and alternate shared-edge representation after an insert", async () => {
    const value = insertionFixture()
    const apiNormalized = withLiveGoogleDocsApiDefaults(value.after)
    const headerCells =
      apiNormalized.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[0]
        ?.tableCells
    if (!headerCells) throw new Error("invalid insertion post-state fixture")
    headerCells.forEach((cell) => {
      cell.tableCellStyle!.borderBottom!.width = {
        magnitude: ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT,
        unit: "PT",
      }
    })
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: apiNormalized, driveVersion: "101" }
    )

    await expect(
      write(value, {
        currentTimeMs: () => Date.parse("2026-07-18T12:01:00.000Z"),
      })
    ).resolves.toMatchObject({ status: "written", mutationCallCount: 1 })
    expect(value.batchUpdate).toHaveBeenCalledOnce()
  })

  test("still rejects a non-default inserted interstitial direction", async () => {
    const value = insertionFixture()
    const wrongAfter = withLiveGoogleDocsApiDefaults(value.after)
    const interstitial =
      wrongAfter.tabs?.[0]?.documentTab?.body?.content?.[2]?.paragraph?.paragraphStyle
    if (!interstitial) throw new Error("invalid insertion interstitial fixture")
    interstitial.direction = "RIGHT_TO_LEFT"
    const recovered = structuredClone(value.before)
    recovered.revisionId = "revision-recovered"
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: wrongAfter, driveVersion: "101" },
      { document: recovered, driveVersion: "102" }
    )

    await expect(
      write(value, {
        currentTimeMs: () => Date.parse("2026-07-18T12:01:00.000Z"),
      })
    ).rejects.toMatchObject({
      stage: "postimage_validation",
      mutationCallCount: 2,
      certificationStatus: "rollback_verified",
      rollbackAttempted: true,
      rollbackVerified: true,
    })
    expect(value.batchUpdate).toHaveBeenCalledTimes(2)
  })

  test("rolls back a changed-revision inserted week whose table readback differs", async () => {
    const value = insertionFixture()
    const wrongAfter = structuredClone(value.after)
    const header =
      wrongAfter.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[0]
        ?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]?.textRun
    if (!header) throw new Error("invalid insertion post-state fixture")
    header.content = "Wrong\n"
    const recovered = structuredClone(value.before)
    recovered.revisionId = "revision-recovered"
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: wrongAfter, driveVersion: "101" },
      { document: recovered, driveVersion: "102" }
    )

    let failure: unknown
    try {
      await write(value, {
        currentTimeMs: () => Date.parse("2026-07-18T12:01:00.000Z"),
      })
    } catch (error) {
      failure = error
    }
    expect(stagingEltDocWriteFailureStage(failure)).toBe("postimage_validation")
    expect(failure).toBeInstanceOf(StagingEltDocWriteExecutionError)
    expect(failure).toMatchObject({
      mutationCallCount: 2,
      beforeRevisionId: "revision-before",
      afterRevisionId: "revision-recovered",
      certificationStatus: "rollback_verified",
      rollbackAttempted: true,
      rollbackVerified: true,
    })
    expect((failure as Error).message).toContain("cell text")
    expect(value.batchUpdate).toHaveBeenCalledTimes(2)
    expect(value.batchUpdate.mock.calls[1]?.[0].requestBody.writeControl).toEqual({
      requiredRevisionId: "revision-after-insert",
    })
  })

  test("rolls back a malformed changed-revision postimage under its exact committed revision fence", async () => {
    const value = fixture()
    const malformedPostimage = structuredClone(value.after)
    const malformedCell =
      malformedPostimage.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[1]
        ?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]?.textRun
    if (!malformedCell) throw new Error("invalid malformed replacement post-state fixture")
    malformedCell.content = "Unexpected Role\n"
    const recovered = structuredClone(value.before)
    recovered.revisionId = "revision-recovered"
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: malformedPostimage, driveVersion: "101" },
      { document: recovered, driveVersion: "102" }
    )

    let failure: unknown
    try {
      await write(value)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(StagingEltDocWriteExecutionError)
    expect(failure).toMatchObject({
      stage: "postimage_validation",
      mutationCallCount: 2,
      certificationStatus: "rollback_verified",
      rollbackAttempted: true,
      rollbackVerified: true,
      afterRevisionId: "revision-recovered",
    })
    expect(value.batchUpdate).toHaveBeenCalledTimes(2)
    expect(value.batchUpdate.mock.calls[1]?.[0].requestBody.writeControl).toEqual({
      requiredRevisionId: "revision-after",
    })
  })

  test("refuses rollback when the changed table is not followed by a paragraph anchor", async () => {
    const value = fixture()
    const malformedPostimage = structuredClone(value.after)
    const content = malformedPostimage.tabs?.[0]?.documentTab?.body?.content
    const table = content?.[3]
    const following = content?.[4]
    const malformedCell =
      table?.table?.tableRows?.[1]?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]
        ?.textRun
    if (
      !content ||
      !malformedCell ||
      table?.endIndex === undefined ||
      following?.startIndex !== table.endIndex ||
      following.endIndex === undefined
    ) {
      throw new Error("invalid rollback-anchor fixture")
    }
    malformedCell.content = "Unexpected Role\n"
    content[4] = {
      startIndex: following.startIndex,
      endIndex: following.endIndex,
      sectionBreak: {},
    }
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: malformedPostimage, driveVersion: "101" }
    )

    await expect(write(value)).rejects.toMatchObject({
      stage: "postimage_validation",
      mutationCallCount: 1,
      certificationStatus: "postimage_rejected",
      rollbackAttempted: false,
      rollbackVerified: false,
    })
    expect(value.batchUpdate).toHaveBeenCalledOnce()
  })

  test("certifies an exact preimage after an ambiguous rollback transport response", async () => {
    const value = fixture()
    const malformedPostimage = structuredClone(value.after)
    const malformedCell =
      malformedPostimage.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[1]
        ?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]?.textRun
    if (!malformedCell) throw new Error("invalid ambiguous rollback fixture")
    malformedCell.content = "Unexpected Role\n"
    const recovered = structuredClone(value.before)
    recovered.revisionId = "revision-recovered"
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: malformedPostimage, driveVersion: "101" },
      { document: recovered, driveVersion: "102" }
    )
    value.batchUpdate
      .mockResolvedValueOnce({
        data: { writeControl: { requiredRevisionId: "revision-after" } },
      } as never)
      .mockRejectedValueOnce(new Error("rollback response unavailable"))

    await expect(write(value)).rejects.toMatchObject({
      stage: "postimage_validation",
      mutationCallCount: 2,
      rollbackDriveVersion: "102",
      rollbackPermissionFingerprint: expect.stringMatching(
        /^hmac-sha256:[0-9a-f]{64}$/
      ),
      certificationStatus: "rollback_verified",
      rollbackAttempted: true,
      rollbackVerified: true,
    })
    expect(value.batchUpdate).toHaveBeenCalledTimes(2)
  })

  test("fails closed on an advanced unknown state after ambiguous rollback transport", async () => {
    const value = fixture()
    const malformedPostimage = structuredClone(value.after)
    const malformedCell =
      malformedPostimage.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[1]
        ?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]?.textRun
    if (!malformedCell) throw new Error("invalid ambiguous rollback fixture")
    malformedCell.content = "Unexpected Role\n"
    const unknown = structuredClone(value.before)
    unknown.revisionId = "revision-unknown"
    const narrative =
      unknown.tabs?.[0]?.documentTab?.body?.content?.at(-1)?.paragraph?.elements?.[0]
        ?.textRun
    if (!narrative) throw new Error("invalid ambiguous rollback unknown state")
    narrative.content = "Unknown recovery state\n"
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: malformedPostimage, driveVersion: "101" },
      { document: unknown, driveVersion: "102" }
    )
    value.batchUpdate
      .mockResolvedValueOnce({
        data: { writeControl: { requiredRevisionId: "revision-after" } },
      } as never)
      .mockRejectedValueOnce(new Error("rollback response unavailable"))

    await expect(write(value)).rejects.toMatchObject({
      stage: "rollback",
      mutationCallCount: 2,
      rollbackDriveVersion: "102",
      certificationStatus: "rollback_unverified",
      rollbackAttempted: true,
      rollbackVerified: false,
    })
    expect(value.batchUpdate).toHaveBeenCalledTimes(2)
  })

  test("does not roll back without an exact changed revision owned by the forward response", async () => {
    const unchanged = fixture()
    const unchangedRevisionPostimage = structuredClone(unchanged.after)
    unchangedRevisionPostimage.revisionId = "revision-before"
    unchanged.setStableStates(
      { document: unchanged.before, driveVersion: "100" },
      { document: unchangedRevisionPostimage, driveVersion: "101" }
    )

    await expect(write(unchanged)).rejects.toThrow("did not advance")
    expect(unchanged.batchUpdate).toHaveBeenCalledOnce()

    const mismatched = fixture()
    const malformedPostimage = structuredClone(mismatched.after)
    const malformedCell =
      malformedPostimage.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[1]
        ?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]?.textRun
    if (!malformedCell) throw new Error("invalid mismatched revision fixture")
    malformedCell.content = "Unexpected Role\n"
    mismatched.setStableStates(
      { document: mismatched.before, driveVersion: "100" },
      { document: malformedPostimage, driveVersion: "101" }
    )
    mismatched.batchUpdate.mockResolvedValueOnce({
      data: { writeControl: { requiredRevisionId: "different-committed-revision" } },
    } as never)

    await expect(write(mismatched)).rejects.toThrow("exclusive committed revision")
    expect(mismatched.batchUpdate).toHaveBeenCalledOnce()

    const missing = fixture()
    const missingMalformedPostimage = structuredClone(missing.after)
    const missingMalformedCell =
      missingMalformedPostimage.tabs?.[0]?.documentTab?.body?.content?.[3]?.table
        ?.tableRows?.[1]?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]
        ?.textRun
    if (!missingMalformedCell) throw new Error("invalid missing revision fixture")
    missingMalformedCell.content = "Unexpected Role\n"
    missing.setStableStates(
      { document: missing.before, driveVersion: "100" },
      { document: missingMalformedPostimage, driveVersion: "101" }
    )
    missing.batchUpdate.mockResolvedValueOnce({ data: {} } as never)

    await expect(write(missing)).rejects.toThrow("unknown state")
    expect(missing.batchUpdate).toHaveBeenCalledOnce()
  })

  test("reports an unverified rollback when the exact after-revision fence is rejected", async () => {
    const value = fixture()
    const malformedPostimage = structuredClone(value.after)
    const malformedCell =
      malformedPostimage.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[1]
        ?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]?.textRun
    if (!malformedCell) throw new Error("invalid rollback rejection fixture")
    malformedCell.content = "Unexpected Role\n"
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: malformedPostimage, driveVersion: "101" }
    )
    value.batchUpdate
      .mockResolvedValueOnce({
        data: { writeControl: { requiredRevisionId: "revision-after" } },
      } as never)
      .mockRejectedValueOnce(new Error("revision fence rejected"))

    let failure: unknown
    try {
      await write(value)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(StagingEltDocWriteExecutionError)
    expect(failure).toMatchObject({
      stage: "rollback",
      mutationCallCount: 2,
      certificationStatus: "rollback_unverified",
      rollbackAttempted: true,
      rollbackVerified: false,
      afterRevisionId: "revision-after",
    })
    expect((failure as Error).message).toContain("revision fence rejected")
    expect(value.batchUpdate).toHaveBeenCalledTimes(2)
    expect(value.batchUpdate.mock.calls[1]?.[0].requestBody.writeControl).toEqual({
      requiredRevisionId: "revision-after",
    })
  })

  test("reports an unverified rollback when recovery does not match the full preimage", async () => {
    const value = fixture()
    const malformedPostimage = structuredClone(value.after)
    const malformedCell =
      malformedPostimage.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[1]
        ?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]?.textRun
    if (!malformedCell) throw new Error("invalid rollback recovery fixture")
    malformedCell.content = "Unexpected Role\n"
    const unrecovered = structuredClone(value.before)
    unrecovered.revisionId = "revision-recovered"
    const unrecoveredNarrative =
      unrecovered.tabs?.[0]?.documentTab?.body?.content?.at(-1)?.paragraph?.elements?.[0]
        ?.textRun
    if (!unrecoveredNarrative) throw new Error("invalid rollback recovery narrative fixture")
    unrecoveredNarrative.content = "Recovery drifted\n"
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: malformedPostimage, driveVersion: "101" },
      { document: unrecovered, driveVersion: "102" }
    )

    let failure: unknown
    try {
      await write(value)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(StagingEltDocWriteExecutionError)
    expect(failure).toMatchObject({
      stage: "rollback",
      mutationCallCount: 2,
      certificationStatus: "rollback_unverified",
      rollbackAttempted: true,
      rollbackVerified: false,
      afterRevisionId: "revision-after",
    })
    expect((failure as Error).message).toContain("did not recover the exact document preimage")
    expect(value.batchUpdate).toHaveBeenCalledTimes(2)
  })

  test("writes only the registered copy and exact fact range with one revision fence", async () => {
    const value = fixture()
    const summary = await write(value)

    expect(summary).toMatchObject({
      artifactKey: "elt_doc",
      status: "written",
      action: "replace_top_week",
      mutationCallCount: 1,
      beforeRevisionId: "revision-before",
      afterRevisionId: "revision-after",
      beforeOutsideContentFingerprint: value.plan.outsideContentFingerprint,
      afterOutsideContentFingerprint: value.plan.outsideContentFingerprint,
    })
    expect(value.get).toHaveBeenCalledTimes(4)
    expect(value.get).toHaveBeenNthCalledWith(1, {
      documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
      includeTabsContent: true,
    })
    expect(value.batchUpdate).toHaveBeenCalledOnce()
    expect(value.batchUpdate).toHaveBeenCalledWith({
      documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
      requestBody: {
        requests: expect.arrayContaining([
          {
            deleteContentRange: {
              range: {
                tabId: P1_ELT_DOC_TARGET.tabId,
                startIndex: 9,
                endIndex: value.nextBoundaryStart,
              },
            },
          },
          {
            insertTable: {
              rows: 3,
              columns: 5,
              location: {
                tabId: P1_ELT_DOC_TARGET.tabId,
                index: 9,
              },
            },
          },
        ]),
        writeControl: { requiredRevisionId: "revision-before" },
      },
    })
  })

  test("normalizes shifted archive indexes while proving older history unchanged", async () => {
    const value = fixture()
    expect(
      fingerprintEltDocOutsideContent({
        document: value.after,
        tabId: P1_ELT_DOC_TARGET.tabId,
        startIndex: 9,
        endIndex: value.afterNextBoundaryStart,
        dataProvenance: "live",
      })
    ).toBe(value.plan.outsideContentFingerprint)
    await expect(write(value)).resolves.toMatchObject({ status: "written" })
  })

  test("rechecks the short-lived permit at the actual Docs mutation boundary", async () => {
    const value = fixture()
    const times = [
      Date.parse("2026-07-11T12:01:00.000Z"),
      Date.parse("2026-07-11T12:10:11.000Z"),
    ]
    let error: unknown
    try {
      await write(value, { currentTimeMs: () => times.shift() ?? times[0] })
    } catch (caught) {
      error = caught
    }
    expect(stagingEltDocWriteFailureStage(error)).toBe("mutation")
    expect(error).toMatchObject({
      mutationCallCount: 0,
      beforeRevisionId: "revision-before",
      afterRevisionId: null,
      certificationStatus: "not_attempted",
    })
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("revalidates the durable stop after the ACL read and immediately before mutation", async () => {
    const value = fixture()
    const events: string[] = []
    value.permissionsList.mockImplementationOnce(async () => {
      events.push("acl")
      return {
        data: {
          permissions: [
            { type: "user", role: "owner", emailAddress: RECRUITING_OPS_ELT_DOC_OWNER },
            {
              type: "user",
              role: "writer",
              emailAddress: RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT,
            },
          ],
        },
      }
    })
    value.batchUpdate.mockImplementationOnce(async () => {
      events.push("batch")
      return {
        data: {
          writeControl: {
            requiredRevisionId: value.after.revisionId,
          },
        },
      }
    })

    await write(value, {
      revalidateKillSwitchClear: async () => {
        events.push("kill")
      },
    })

    expect(events).toEqual(["acl", "kill", "batch"])
  })

  test("refuses mutation when the durable stop engages during the ACL read", async () => {
    const value = fixture()
    let failure: unknown
    try {
      await write(value, {
        revalidateKillSwitchClear: async () => {
          throw new Error("stop engaged")
        },
      })
    } catch (error) {
      failure = error
    }
    expect(stagingEltDocWriteFailureStage(failure)).toBe("mutation")
    expect(value.permissionsList).toHaveBeenCalledTimes(2)
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("certifies an exact postimage after an ambiguous Docs transport response without retry", async () => {
    const value = fixture()
    value.batchUpdate.mockRejectedValueOnce(new Error("private transport detail"))

    await expect(write(value)).resolves.toMatchObject({
      status: "written",
      mutationCallCount: 1,
      beforeDriveVersion: "100",
      afterDriveVersion: "101",
    })
    expect(value.batchUpdate).toHaveBeenCalledOnce()
  })

  test("requires identical paired Docs reads bracketed by one stable Drive version", async () => {
    vi.useFakeTimers()
    try {
      const value = fixture()
      const drifted = structuredClone(value.before)
      drifted.tabs![0].tabProperties!.title = "Transient read"
      value.get
        .mockReset()
        .mockResolvedValueOnce({ data: value.before })
        .mockResolvedValueOnce({ data: drifted })
        .mockResolvedValueOnce({ data: value.before })
        .mockResolvedValueOnce({ data: value.before })
        .mockResolvedValueOnce({ data: value.before })
        .mockResolvedValueOnce({ data: value.before })
        .mockResolvedValueOnce({ data: value.after })
        .mockResolvedValueOnce({ data: value.after })
        .mockResolvedValue({ data: value.after })
      value.filesGet
        .mockReset()
        .mockResolvedValueOnce({ data: editableEltDriveMetadata("100") })
        .mockResolvedValueOnce({ data: editableEltDriveMetadata("100") })
        .mockResolvedValueOnce({ data: editableEltDriveMetadata("100") })
        .mockResolvedValueOnce({ data: editableEltDriveMetadata("101") })
        .mockResolvedValueOnce({ data: editableEltDriveMetadata("100") })
        .mockResolvedValueOnce({ data: editableEltDriveMetadata("100") })
        .mockResolvedValueOnce({ data: editableEltDriveMetadata("101") })
        .mockResolvedValueOnce({ data: editableEltDriveMetadata("101") })
        .mockResolvedValue({ data: editableEltDriveMetadata("101") })

      const pending = write(value)
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({
        status: "written",
        beforeDriveVersion: "100",
        afterDriveVersion: "101",
      })
      expect(value.get).toHaveBeenCalledTimes(8)
      expect(value.filesGet).toHaveBeenCalledTimes(8)
      expect(value.batchUpdate).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  test("classifies an ambiguous Docs transport as exact preimage without retry", async () => {
    vi.useFakeTimers()
    const value = fixture()
    value.setStableStates({ document: value.before, driveVersion: "100" })
    value.batchUpdate.mockRejectedValueOnce(new Error("private transport detail"))

    const pending = expect(write(value)).rejects.toMatchObject({
      stage: "mutation",
      mutationCallCount: 1,
      beforeDriveVersion: "100",
      afterDriveVersion: "100",
      certificationStatus: "preimage_verified",
      rollbackAttempted: false,
    })
    await vi.runAllTimersAsync()
    await pending
    expect(value.batchUpdate).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  test("retains only a safe provider status and request index from a rejected batch", async () => {
    vi.useFakeTimers()
    try {
      const value = fixture()
      value.setStableStates({ document: value.before, driveVersion: "100" })
      value.batchUpdate.mockRejectedValueOnce(Object.assign(
        new Error(
          "Invalid requests[137].updateTableCellStyle: private candidate content"
        ),
        {
          response: {
            status: 400,
            data: {
              error: {
                message:
                  "Invalid requests[137].updateTableCellStyle: private candidate content",
              },
            },
          },
        }
      ))

      const pending = expect(write(value)).rejects.toMatchObject({
        stage: "mutation",
        mutationCallCount: 1,
        providerHttpStatus: 400,
        providerRequestIndex: 137,
        certificationStatus: "preimage_verified",
      })
      await vi.runAllTimersAsync()
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  test("does not certify an exact postimage until Drive version advances", async () => {
    vi.useFakeTimers()
    try {
      const value = fixture()
      value.setStableStates(
        { document: value.before, driveVersion: "100" },
        { document: value.after, driveVersion: "100" }
      )
      value.batchUpdate.mockRejectedValueOnce(new Error("private transport detail"))

      const pending = expect(write(value)).rejects.toMatchObject({
        stage: "mutation",
        mutationCallCount: 1,
        beforeDriveVersion: "100",
        afterDriveVersion: "100",
        certificationStatus: "ambiguous",
        rollbackAttempted: false,
      })
      await vi.runAllTimersAsync()
      await pending
      expect(value.batchUpdate).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  test("classifies an ambiguous Docs transport as unknown without retry or rollback", async () => {
    const value = fixture()
    const unknown = structuredClone(value.after)
    unknown.tabs![0].tabProperties!.title = "Concurrent topology drift"
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: unknown, driveVersion: "101" }
    )
    value.batchUpdate.mockRejectedValueOnce(new Error("private transport detail"))

    await expect(write(value)).rejects.toMatchObject({
      stage: "mutation",
      mutationCallCount: 1,
      beforeDriveVersion: "100",
      afterDriveVersion: "101",
      certificationStatus: "ambiguous",
      rollbackAttempted: false,
    })
    expect(value.batchUpdate).toHaveBeenCalledOnce()
  })

  test("a no-op re-proves the copy preimage but performs zero mutations", async () => {
    const value = fixture({ noOp: true })
    const summary = await write(value)
    expect(summary).toMatchObject({ status: "no_change", requestCount: 0, mutationCallCount: 0 })
    expect(summary.beforePermissionFingerprint).toMatch(/^hmac-sha256:[0-9a-f]{64}$/)
    expect(summary.afterPermissionFingerprint).toBe(summary.beforePermissionFingerprint)
    expect(value.get).toHaveBeenCalledTimes(2)
    expect(value.permissionsList).toHaveBeenCalledTimes(2)
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test.each([
    ["an extra named reader added mid-write", { type: "user", role: "reader", emailAddress: "unexpected@example.com" }],
    ["an anyone link added mid-write", { type: "anyone", role: "reader" }],
  ])("tolerates %s and still certifies the no-op (subset ACL fence)", async (_name, extraPermission) => {
    const value = fixture({ noOp: true })
    value.permissionsList.mockResolvedValueOnce({
      data: {
        permissions: [...approvedPermissionResponse().data.permissions, extraPermission],
      },
    } as never)
    const summary = await write(value)
    expect(summary).toMatchObject({ status: "no_change", requestCount: 0, mutationCallCount: 0 })
    // The required-subset fingerprint is unaffected by the extra reader.
    expect(summary.afterPermissionFingerprint).toBe(summary.beforePermissionFingerprint)
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("rejects postimage ACL drift (missing required writer SA) without attempting rollback", async () => {
    const value = fixture()
    value.permissionsList
      .mockResolvedValueOnce(approvedPermissionResponse())
      .mockResolvedValueOnce(approvedPermissionResponse())
      .mockResolvedValueOnce({
        data: {
          permissions: [
            { type: "user", role: "owner", emailAddress: RECRUITING_OPS_ELT_DOC_OWNER },
          ],
        },
      } as never)

    await expect(write(value)).rejects.toThrow("required approved recipient")
    expect(value.batchUpdate).toHaveBeenCalledOnce()
  })

  test("requires the rollback ACL HMAC to equal the preimage ACL HMAC", async () => {
    const value = fixture()
    const malformedPostimage = structuredClone(value.after)
    const malformedCell =
      malformedPostimage.tabs?.[0]?.documentTab?.body?.content?.[3]?.table
        ?.tableRows?.[1]?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]
        ?.textRun
    if (!malformedCell) throw new Error("invalid rollback ACL fixture")
    malformedCell.content = "Unexpected Role\n"
    const recovered = structuredClone(value.before)
    recovered.revisionId = "revision-recovered"
    value.setStableStates(
      { document: value.before, driveVersion: "100" },
      { document: malformedPostimage, driveVersion: "101" },
      { document: recovered, driveVersion: "102" }
    )
    value.permissionsList
      .mockResolvedValueOnce(approvedPermissionResponse())
      .mockResolvedValueOnce(approvedPermissionResponse())
      .mockResolvedValueOnce(approvedPermissionResponse())
      .mockResolvedValueOnce(approvedPermissionResponse())
      .mockResolvedValueOnce({
        data: {
          permissions: [
            { type: "user", role: "owner", emailAddress: RECRUITING_OPS_ELT_DOC_OWNER },
          ],
        },
      } as never)

    await expect(write(value)).rejects.toMatchObject({
      stage: "rollback",
      mutationCallCount: 2,
      rollbackAttempted: true,
      rollbackVerified: false,
    })
    expect(value.batchUpdate).toHaveBeenCalledTimes(2)
  })

  test.each([
    [
      "missing the required writer SA",
      [{ type: "user", role: "owner", emailAddress: RECRUITING_OPS_ELT_DOC_OWNER }],
    ],
    [
      "missing the required owner",
      [
        {
          type: "user",
          role: "writer",
          emailAddress: RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT,
        },
      ],
    ],
    [
      "the wrong owner",
      [
        { type: "user", role: "owner", emailAddress: "wrong@example.com" },
        {
          type: "user",
          role: "writer",
          emailAddress: RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT,
        },
      ],
    ],
  ])("rejects canonical-Doc ACL drift from %s before mutation", async (_name, permissions) => {
    const value = fixture()
    value.permissionsList.mockResolvedValueOnce({ data: { permissions } } as never)
    let failure: unknown
    try {
      await write(value)
    } catch (error) {
      failure = error
    }
    expect(stagingEltDocWriteFailureStage(failure)).toBe("permission_validation")
    expect((failure as Error).message).toContain("required approved recipient")
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("follows a paginated permission read until both required recipients are found", async () => {
    const value = fixture()
    value.permissionsList.mockReset()
    value.permissionsList
      .mockResolvedValueOnce({
        data: {
          nextPageToken: "page-2",
          permissions: [
            { type: "user", role: "owner", emailAddress: RECRUITING_OPS_ELT_DOC_OWNER },
            { type: "user", role: "reader", emailAddress: "reader-one@example.com" },
          ],
        },
      } as never)
      .mockResolvedValueOnce({
        data: {
          permissions: [
            {
              type: "user",
              role: "writer",
              emailAddress: RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT,
            },
          ],
        },
      } as never)
      // Second full ACL read (post-read of the stability check) is satisfied on page 1.
      .mockResolvedValue(approvedPermissionResponse())
    const summary = await write(value)
    expect(summary.status).toBe("written")
    expect(value.permissionsList).toHaveBeenNthCalledWith(1, {
      fileId: P1_ELT_DOC_TARGET.stagingDocumentId,
      supportsAllDrives: true,
      pageSize: 100,
      fields: "nextPageToken,permissions(type,role,emailAddress,deleted,pendingOwner)",
    })
    expect(value.permissionsList).toHaveBeenNthCalledWith(2, {
      fileId: P1_ELT_DOC_TARGET.stagingDocumentId,
      supportsAllDrives: true,
      pageSize: 100,
      pageToken: "page-2",
      fields: "nextPageToken,permissions(type,role,emailAddress,deleted,pendingOwner)",
    })
  })

  test("refuses a permission read that never satisfies both required recipients across bounded pages", async () => {
    const value = fixture()
    value.permissionsList.mockReset()
    value.permissionsList.mockImplementation(async () => ({
      data: {
        nextPageToken: "keeps-going",
        permissions: [{ type: "user", role: "owner", emailAddress: RECRUITING_OPS_ELT_DOC_OWNER }],
      },
    }))
    await expect(write(value)).rejects.toThrow("required approved recipient")
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("rejects altered plan facts whose HMAC no longer matches the permit", async () => {
    const value = fixture()
    value.plan = {
      ...value.plan,
      factTable: {
        ...value.plan.factTable,
        hireRows: [["Altered Role", "Dept", "P1", "Candidate", "TBD"]],
      },
    }
    await expect(write(value)).rejects.toThrow("approved HMAC")
    expect(value.permissionsList).toHaveBeenCalledTimes(2)
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("rejects a rollback fact table that cannot reconstruct the exact preimage", async () => {
    const value = fixture()
    value.plan = {
      ...value.plan,
      rollbackFactTable: {
        ...value.plan.rollbackFactTable!,
        hireRows: [["Wrong Role", "Wrong Dept", "P2", "Wrong Candidate", "TBD"]],
      },
    }
    await expect(write(value)).rejects.toThrow()
    expect(value.permissionsList).toHaveBeenCalledTimes(2)
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("rejects a legacy shared-edge preimage that the rollback renderer would normalize", async () => {
    const legacyBefore = structuredClone(fixture().before)
    const headerCells =
      legacyBefore.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[0]
        ?.tableCells
    if (!headerCells) throw new Error("invalid legacy shared-edge fixture")
    headerCells.forEach((cell) => {
      cell.tableCellStyle!.borderBottom!.width = {
        magnitude: ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT,
        unit: "PT",
      }
    })
    const value = fixture({ before: legacyBefore })

    await expect(write(value)).rejects.toThrow("not exactly reconstructible")
    expect(value.permissionsList).toHaveBeenCalledTimes(2)
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("classifies a non-top compiled range before any Google call", async () => {
    const value = fixture()
    value.plan = {
      ...value.plan,
      archiveBlockRange: { tabId: P1_ELT_DOC_TARGET.tabId, startIndex: 2, endIndex: 16 },
    }

    let failure: unknown
    try {
      await write(value)
    } catch (error) {
      failure = error
    }

    expect(stagingEltDocWriteFailureStage(failure)).toBe("request_compile")
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("top boundary")
    expect(value.get).not.toHaveBeenCalled()
    expect(value.batchUpdate).not.toHaveBeenCalled()
  })

  test("canonical and unknown document ids fail before any Google call", async () => {
    for (const documentId of [P1_ELT_DOC_TARGET.deniedDocumentIds[0], "unknown-document-id"]) {
      const value = fixture()
      value.plan = { ...value.plan, documentId }
      await expect(write(value)).rejects.toThrow("exact registered staging target")
      expect(value.get).not.toHaveBeenCalled()
      expect(value.batchUpdate).not.toHaveBeenCalled()
    }
  })

  test("blocks disabled flags, permit mismatch, revision drift, and preimage drift before mutation", async () => {
    const disabled = fixture({ env: {} })
    await expect(write(disabled)).rejects.toThrow("flags")
    expect(disabled.get).not.toHaveBeenCalled()

    const mismatchedPermit = fixture()
    mismatchedPermit.permit = {
      ...mismatchedPermit.permit,
      payloadFingerprint: `hmac-sha256:${"f".repeat(64)}`,
    }
    await expect(write(mismatchedPermit)).rejects.toThrow("does not match")
    expect(mismatchedPermit.get).not.toHaveBeenCalled()

    const wrongRevisionDocument = structuredClone(fixture().before)
    wrongRevisionDocument.revisionId = "someone-edited"
    const wrongRevision = fixture({ before: wrongRevisionDocument })
    await expect(write(wrongRevision)).rejects.toThrow("revision changed")
    expect(wrongRevision.batchUpdate).not.toHaveBeenCalled()

    const driftedDocument = structuredClone(fixture().before)
    const driftedContent = driftedDocument.tabs?.[0]?.documentTab?.body?.content
    const driftedTextRun = driftedContent?.at(-1)?.paragraph?.elements?.[0]?.textRun
    if (!driftedTextRun) throw new Error("invalid writer test fixture")
    driftedTextRun.content = "Changed\n"
    const drifted = fixture({ before: driftedDocument })
    // Bind the plan to the clean preimage, then serve the drifted copy.
    const clean = fixture()
    drifted.plan.outsideContentFingerprint = clean.plan.outsideContentFingerprint
    drifted.permit.structureHash = clean.plan.outsideContentFingerprint
    await expect(write(drifted)).rejects.toThrow("outside content changed")
    expect(drifted.batchUpdate).not.toHaveBeenCalled()
  })

  test("fails loudly if the post-state changes fact values or any narrative/archive content", async () => {
    const wrongTextDocument = structuredClone(fixture().after)
    const wrongTextRun =
      wrongTextDocument.tabs?.[0]?.documentTab?.body?.content?.[3]?.table?.tableRows?.[1]
        ?.tableCells?.[0]?.content?.[0]?.paragraph?.elements?.[0]?.textRun
    if (!wrongTextRun) throw new Error("invalid writer test fixture")
    wrongTextRun.content = "Nope\n"
    const wrongText = fixture({ after: wrongTextDocument })
    const recovered = structuredClone(wrongText.before)
    recovered.revisionId = "revision-recovered"
    wrongText.setStableStates(
      { document: wrongText.before, driveVersion: "100" },
      { document: wrongTextDocument, driveVersion: "101" },
      { document: recovered, driveVersion: "102" }
    )
    await expect(write(wrongText)).rejects.toThrow()
    expect(wrongText.batchUpdate).toHaveBeenCalledTimes(2)

    const outsideChangedDocument = structuredClone(fixture().after)
    const outsideChangedTextRun =
      outsideChangedDocument.tabs?.[0]?.documentTab?.body?.content?.at(-1)?.paragraph
        ?.elements?.[0]?.textRun
    if (!outsideChangedTextRun) throw new Error("invalid writer test fixture")
    outsideChangedTextRun.content = "Gone\n"
    const outsideChanged = fixture({ after: outsideChangedDocument })
    await expect(write(outsideChanged)).rejects.toThrow("narrative or archive content changed")
    expect(outsideChanged.batchUpdate).toHaveBeenCalledOnce()
  })
})
