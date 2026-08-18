import { createPayloadFingerprint, createPiiFingerprint, type PiiFingerprintProvenance } from "../checksums"
import { eltReportingFriday, fridayWeekLabels, fridayWeekStartUtc } from "../exec-definitions"
import type { ExecSnapshotRow } from "../exec-snapshot-store"
import type { ExecEltFacts } from "../modules/exec-state-of-play"
import { assertPublicSafe } from "../safe-public-output"
import { renderEltDocRoleProgressParagraphs, type EltDocParagraph } from "./elt-doc-renderer"
import {
  P1_ELT_DOC_TARGET,
  eltDocTargetConflicts,
  eltDocTargetIdConflicts,
} from "./p1-artifacts"

export interface GoogleDocsDocumentSnapshot {
  documentId?: string
  title?: string
  revisionId?: string
  tabs?: GoogleDocsTabSnapshot[]
}

export interface GoogleDocsTabSnapshot {
  tabProperties?: { tabId?: string; title?: string }
  documentTab?: { body?: { content?: GoogleDocsStructuralElement[] } }
  childTabs?: GoogleDocsTabSnapshot[]
}

export interface GoogleDocsStructuralElement {
  startIndex?: number
  endIndex?: number
  paragraph?: {
    paragraphStyle?: {
      namedStyleType?: string
      headingId?: string
      alignment?: string
      direction?: string
      lineSpacing?: number
      spacingMode?: string
      spaceAbove?: GoogleDocsDimension
      spaceBelow?: GoogleDocsDimension
    }
    elements?: {
      startIndex?: number
      endIndex?: number
      textRun?: {
        content?: string
        textStyle?: {
          bold?: boolean
          italic?: boolean
          underline?: boolean
          fontSize?: GoogleDocsDimension
          foregroundColor?: GoogleDocsOptionalColor
        }
      }
      dateElement?: GoogleDocsDateElementSnapshot
      inlineObjectElement?: unknown
    }[]
  }
  table?: {
    columns?: number
    rows?: number
    tableStyle?: {
      tableColumnProperties?: {
        widthType?: string
        width?: GoogleDocsDimension
      }[]
    }
    tableRows?: {
      startIndex?: number
      endIndex?: number
      tableRowStyle?: { minRowHeight?: GoogleDocsDimension }
      tableCells?: {
        startIndex?: number
        endIndex?: number
        tableCellStyle?: GoogleDocsTableCellStyle
        content?: GoogleDocsStructuralElement[]
      }[]
    }[]
  }
  tableOfContents?: { content?: GoogleDocsStructuralElement[] }
  sectionBreak?: unknown
}

interface GoogleDocsDimension {
  magnitude?: number
  unit?: string
}

interface GoogleDocsDateElementProperties {
  displayText?: string
  timestamp?: string
  locale?: string
  dateFormat?: string
  timeFormat?: string
}

interface GoogleDocsDateElementSnapshot {
  dateElementProperties?: GoogleDocsDateElementProperties
  dateId?: string
  textStyle?: {
    foregroundColor?: GoogleDocsOptionalColor
  }
}

interface GoogleDocsOptionalColor {
  color?: { rgbColor?: { red?: number; green?: number; blue?: number } }
}

interface GoogleDocsTableCellBorder {
  color?: GoogleDocsOptionalColor
  width?: GoogleDocsDimension
  dashStyle?: string
}

interface GoogleDocsTableCellStyle {
  backgroundColor?: GoogleDocsOptionalColor
  rowSpan?: number
  columnSpan?: number
  borderLeft?: GoogleDocsTableCellBorder
  borderRight?: GoogleDocsTableCellBorder
  borderTop?: GoogleDocsTableCellBorder
  borderBottom?: GoogleDocsTableCellBorder
  paddingLeft?: GoogleDocsDimension
  paddingRight?: GoogleDocsDimension
  paddingTop?: GoogleDocsDimension
  paddingBottom?: GoogleDocsDimension
  contentAlignment?: string
}

export interface EltDocDryRunBaseInput {
  snapshot: ExecSnapshotRow
  evaluatedAt: string
  maxSnapshotAgeMinutes?: number
  allowedSnapshotModes?: readonly string[]
  dataProvenance: PiiFingerprintProvenance
  liveFlagValue?: string
  /**
   * The standalone planner remains mutation-unreachable. The registered
   * staging adapter may set this only when a second, durable permit boundary
   * will evaluate flags and kill-switch state immediately before the write.
   */
  stagingAdapterPermitBoundary?: boolean
  /**
   * Declares that the snapshot carries a past week's facts for a backfill.
   * The snapshot's labels must match this week exactly, and it must be
   * strictly older than the week the snapshot's own timestamp derives. With
   * it, an absent week older than the newest block may insert at its
   * date-ordered position; without it, behavior is unchanged and such a week
   * still refuses.
   */
  eltBackfillWeekFriday?: string
}

export interface EltDocDryRunInput extends EltDocDryRunBaseInput {
  document: GoogleDocsDocumentSnapshot
}

export interface EltDocDryRunReader {
  /** Read-only port. A mutation method is intentionally absent from this phase. */
  getDocument(input: { documentId: string; tabId: string }): Promise<GoogleDocsDocumentSnapshot>
}

export interface RunEltDocDryRunInput extends EltDocDryRunBaseInput {
  targetDocumentId?: string
}

export type EltDocDryRunAction = "insert_top_week" | "replace_top_week" | "no_op"

export const ELT_DOC_TOP_WEEK_FACTS_RANGE_ID = "elt_doc_top_week_facts" as const
export const ELT_DOC_HIRE_TABLE_HEADERS = [
  "Role",
  "Dept.",
  "Priority",
  "Candidate Name",
  "Start Date",
] as const
export const ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT = [92.25, 93, 93.75, 93, 95.25] as const
export const ELT_DOC_HIRE_TABLE_ROW_HEIGHT_PT = 27
export const ELT_DOC_HIRE_TABLE_PADDING_PT = 2
export const ELT_DOC_HIRE_TABLE_CONTENT_ALIGNMENT = "MIDDLE" as const
export const ELT_DOC_HIRE_TABLE_BORDER_RGB = 0.8
export const ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT = 0.5
export const ELT_DOC_HIRE_TABLE_BODY_BORDER_PT = 0.416667
export const ELT_DOC_HIRE_TABLE_BODY_FONT_PT = 10
export const ELT_DOC_HIRE_TABLE_STRIPE_RGB = {
  red: 0.9647059,
  green: 0.972549,
  blue: 0.98039216,
} as const

export type EltDocHireTableRow = readonly [string, string, string, string, string]

export interface EltDocWeekPrefacePlan {
  weekLabel: string
  startDisplayText: string
  endDisplayText: string
  startTimestamp: string
  endTimestamp: string
  hireRows: readonly EltDocHireTableRow[]
  /**
   * The Role Progress narrative tail written immediately after the hires
   * table (section headings, QTD/stage/offer-accepted body lines). Desired
   * plans populate this from `renderEltDocRoleProgressParagraphs`; observed
   * (rollback) plans populate it from the exact paragraphs Docs returns.
   */
  narrativeParagraphs: readonly EltDocParagraph[]
}

export interface EltDocDryRunPublicSummary {
  deliverableId: "elt_recruiting_doc"
  status: "planned_for_internal_review" | "no_change" | "blocked"
  dryRunOnly: true
  mutationReachable: false
  mutationCallCount: 0
  promotionEligible: false
  promotionBlockingReasons: readonly string[]
  containsPersonIdentifiers: boolean
  liveFlagEnabled: boolean
  snapshotRunId: string
  snapshotWorkflowId: string
  snapshotMode: string
  snapshotAgeMinutes: number | null
  reportingWeek: string | null
  upsertKeyField: "elt_facts.weekShort"
  mutationScope: "weekly_fact_table"
  action: EltDocDryRunAction | null
  targetStartIndex: number | null
  targetEndIndex: number | null
  currentCharacterCount: number
  desiredFactCharacterCount: number
  factColumnCount: 5
  hireCount: number
  sectionCount: number
  payloadFingerprint?: string
  currentBlockFingerprint?: string
  outsideContentFingerprint?: string
  templateHash?: string
  revisionGuardPresent: boolean
  blockingReasons: readonly string[]
}

export interface EltDocDryRunPrivatePlan {
  runId: string
  sourceGeneratedAt: string
  dataProvenance: PiiFingerprintProvenance
  documentId: string
  tabId: string
  requiredRevisionId: string
  payloadFingerprint: string
  preimageFingerprint: string
  preimageDocumentFingerprint: string
  outsideContentFingerprint: string
  approvedRangeIds: readonly [typeof ELT_DOC_TOP_WEEK_FACTS_RANGE_ID]
  mutationScope: "weekly_fact_table"
  action: EltDocDryRunAction
  /** Full newest weekly block: date-chip heading through the Role Progress narrative tail. */
  archiveBlockRange: { tabId: string; startIndex: number; endIndex: number }
  /**
   * Exact mutation-owned range: an empty insertion point, or the existing
   * five-column table plus its Role Progress narrative tail. Older weeks'
   * hand-written history stays outside this range and outside mutation.
   */
  contentGuardRange: { tabId: string; startIndex: number; endIndex: number }
  deleteRange: { tabId: string; startIndex: number; endIndex: number } | null
  insertAt: { tabId: string; index: number } | null
  factTable: EltDocWeekPrefacePlan
  rollbackFactTable: EltDocWeekPrefacePlan | null
}

export interface EltDocDryRunResult {
  publicSummary: EltDocDryRunPublicSummary
  /** Contains person identifiers. Keep in memory; never log or persist for live provenance. */
  privatePlan: EltDocDryRunPrivatePlan | null
}

interface WeekAnchor {
  kind: "week_heading" | "legacy_hires"
  weekLabel: string
  weekStartMs: number
  startIndex: number
}

interface SnapshotPreflight {
  facts: ExecEltFacts | null
  liveFlagEnabled: boolean
  snapshotAgeMinutes: number | null
  reasons: string[]
}

const WEEK_LABEL_PATTERN =
  /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4} - (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}$/
const LEGACY_HIRES_WEEK_PATTERN = /^Hires:\s*\(Offer Accepted b\/w\s+(.+?)\)\s*$/i
const MONTH_INDEX: ReadonlyMap<string, number> = new Map([
  ["jan", 0], ["january", 0], ["feb", 1], ["february", 1], ["mar", 2], ["march", 2],
  ["apr", 3], ["april", 3], ["may", 4], ["jun", 5], ["june", 5], ["jul", 6],
  ["july", 6], ["aug", 7], ["august", 7], ["sep", 8], ["september", 8],
  ["oct", 9], ["october", 9], ["nov", 10], ["november", 10], ["dec", 11],
  ["december", 11],
] as const)

const PROMOTION_BLOCKING_REASONS = [
  "The ELT output PII contract must be reconciled before promotion.",
  "Only the separately permit-gated staging-copy adapter may consume this dry-run plan.",
] as const

/**
 * Runs the preflight before invoking the read-only document port. Invalid,
 * stale, truncated, or non-staging inputs therefore make zero document calls.
 */
export async function runEltDocDryRun(
  input: RunEltDocDryRunInput,
  reader: EltDocDryRunReader
): Promise<EltDocDryRunResult> {
  const preflight = snapshotPreflight(input)
  const targetDocumentId = input.targetDocumentId?.trim() || P1_ELT_DOC_TARGET.stagingDocumentId
  const reasons = [...preflight.reasons, ...eltDocTargetIdConflicts(targetDocumentId)]
  if (reasons.length > 0) {
    return blockedResult(input, preflight, false, reasons)
  }

  const document = await reader.getDocument({
    documentId: targetDocumentId,
    tabId: P1_ELT_DOC_TARGET.tabId,
  })
  return planEltDocDryRun({ ...input, document })
}

export function planEltDocDryRun(input: EltDocDryRunInput): EltDocDryRunResult {
  const preflight = snapshotPreflight(input)
  const facts = preflight.facts
  const tab = findTab(input.document.tabs ?? [], P1_ELT_DOC_TARGET.tabId)
  const content = tab?.documentTab?.body?.content ?? []
  const blockingReasons = [
    ...preflight.reasons,
    ...documentPreflightReasons(input.document, tab, content, facts?.generatedAt),
  ]

  if (!facts || blockingReasons.length > 0) {
    return blockedResult(
      input,
      preflight,
      Boolean(input.document.revisionId?.trim()),
      blockingReasons
    )
  }

  const anchors = weekAnchors(content, facts.generatedAt)
  const boundaries = archiveWeekBoundaries(anchors)
  const desiredWeekStart = weekStartMs(facts.weekLabel)
  const desiredFactTable = weekPrefaceForFacts(facts)
  const expectedIndexes = boundaries
    .map((anchor, index) => ({ anchor, index }))
    .filter((entry) => desiredWeekStart !== null && entry.anchor.weekStartMs === desiredWeekStart)
  if (expectedIndexes.length > 1) {
    blockingReasons.push("The requested reporting week appears more than once in the document archive.")
  }
  if (expectedIndexes.length === 1 && expectedIndexes[0].index !== 0) {
    blockingReasons.push("Reporting week exists below the newest archive block; refusing to rewrite history.")
  }

  let action: EltDocDryRunAction | null = null
  let archiveBlockStartIndex: number | null = null
  let archiveBlockEndIndex: number | null = null
  let targetStartIndex: number | null = null
  let targetEndIndex: number | null = null
  let rollbackFactTable: EltDocWeekPrefacePlan | null = null
  if (blockingReasons.length === 0 && expectedIndexes.length === 1) {
    const current = expectedIndexes[0].anchor
    const next = boundaries[1]
    if (!next) blockingReasons.push("A next archive boundary is required before replacing the top week.")
    else {
      try {
        const shape = topWeekFactShape(content, current)
        const observedHirePreface = observedWeekPreface(shape, current.weekLabel)
        assertReplacementParagraphAnchor(content, shape.table)
        action = "replace_top_week"
        archiveBlockStartIndex = current.startIndex
        archiveBlockEndIndex = next.startIndex
        targetStartIndex = shape.table.startIndex!
        targetEndIndex = archiveBlockEndIndex

        let narrativeParagraphs: readonly EltDocParagraph[] | null = null
        try {
          narrativeParagraphs = observedNarrativeParagraphs(
            content,
            shape.table.endIndex!,
            archiveBlockEndIndex
          )
        } catch {
          blockingReasons.push(
            "Current top-week narrative tail is not exactly reconstructible for rollback."
          )
          action = null
        }

        if (narrativeParagraphs) {
          rollbackFactTable = { ...observedHirePreface, narrativeParagraphs }
          try {
            assertDateChipHeading(shape.heading, desiredFactTable)
            assertExistingInterstitialParagraph(shape.interstitial)
            assertHireTable(shape.table, desiredFactTable.hireRows, {
              allowCopyOnlyBodyParagraphFields: true,
            })
            const narrativeMatchSplit = splitContentAtTarget(
              content,
              shape.table.endIndex!,
              archiveBlockEndIndex
            )
            if (!narrativeMatchSplit.ok) throw new Error(narrativeMatchSplit.reason)
            assertNarrativeTail(
              normalizeNarrativeElements(narrativeMatchSplit.target),
              desiredFactTable.narrativeParagraphs
            )
            action = "no_op"
          } catch {
            if (textOfElement(shape.interstitial).trim().length > 0) {
              blockingReasons.push(
                "Current top-week table differs but its interstitial context is human-authored."
              )
              action = null
            } else if (!factTableUsesRollbackRendererFormat(shape.table)) {
              blockingReasons.push(
                "Current top-week table is not exactly reconstructible by the rollback renderer."
              )
              action = null
            } else {
              assertBlankParagraph(shape.interstitial)
              targetStartIndex = shape.interstitial.startIndex!
            }
          }
        }
      } catch {
        blockingReasons.push(
          "Current top-week date-chip or five-column hire table is not a deterministic fact-table boundary."
        )
      }
    }
  } else if (blockingReasons.length === 0 && expectedIndexes.length === 0) {
    const currentWeekStart = boundaries[0]?.weekStartMs ?? null
    if (
      desiredWeekStart !== null &&
      currentWeekStart !== null &&
      desiredWeekStart < currentWeekStart &&
      input.eltBackfillWeekFriday !== undefined
    ) {
      // A declared backfill of a week older than the newest block inserts at
      // its date-ordered position: between the unique adjacent pair of
      // retained boundaries that bracket it. The pushed-down block's internal
      // shape is deliberately not validated - a zero-width insert above it
      // touches nothing inside it, and the write side proves both endpoints
      // are adjacent anchors. The preface labels are already pinned to the
      // declared week by the preflight.
      const brackets = boundaries.flatMap((boundary, index) => {
        const below = boundaries[index + 1]
        return below !== undefined &&
          boundary.weekStartMs > desiredWeekStart &&
          below.weekStartMs < desiredWeekStart
          ? [index]
          : []
      })
      if (brackets.length !== 1) {
        blockingReasons.push(
          "Declared backfill week has no unique adjacent archive bracket; refusing to choose a position."
        )
      } else if (
        (boundaries[brackets[0]].weekStartMs - desiredWeekStart) % (7 * 24 * 60 * 60 * 1_000) !== 0
      ) {
        blockingReasons.push(
          "Declared backfill week is not week-aligned with its adjacent archive blocks."
        )
      } else if (!boundaries[brackets[0] + 2]) {
        blockingReasons.push(
          "A next archive boundary below the pushed-down block is required for a mid-archive insert."
        )
      } else {
        action = "insert_top_week"
        archiveBlockStartIndex = boundaries[brackets[0] + 1].startIndex
        archiveBlockEndIndex = boundaries[brackets[0] + 2].startIndex
        targetStartIndex = archiveBlockStartIndex
        targetEndIndex = archiveBlockStartIndex
      }
    } else if (desiredWeekStart === null || currentWeekStart === null || desiredWeekStart <= currentWeekStart) {
      blockingReasons.push("Absent reporting week is not newer than the current top archive block.")
    } else if ((desiredWeekStart - currentWeekStart) % (7 * 24 * 60 * 60 * 1_000) !== 0) {
      // Whole-week gaps are legitimate (unwritten weeks stay unwritten; no
      // backfill), but a misaligned anchor means a misparsed boundary.
      blockingReasons.push("Absent reporting week is not week-aligned with the current top archive block.")
    } else if (!boundaries[1]) {
      blockingReasons.push("A next archive boundary is required before inserting a new top week.")
    } else {
      blockingReasons.push(...observedTopWeekTemplateReasons(content, boundaries[0]))
      if (blockingReasons.length === 0) {
        action = "insert_top_week"
        archiveBlockStartIndex = boundaries[0].startIndex
        archiveBlockEndIndex = boundaries[1].startIndex
        targetStartIndex = boundaries[0].startIndex
        targetEndIndex = boundaries[0].startIndex
      }
    }
  }

  if (
    blockingReasons.length > 0 ||
    archiveBlockStartIndex === null ||
    archiveBlockEndIndex === null ||
    targetStartIndex === null ||
    targetEndIndex === null ||
    !action
  ) {
    if (blockingReasons.length === 0) {
      blockingReasons.push("No safe top-of-archive insertion boundary was found.")
    }
    return blockedResult(input, preflight, true, blockingReasons)
  }

  const split = splitContentAtTarget(content, targetStartIndex, targetEndIndex)
  if (!split.ok) {
    blockingReasons.push(split.reason)
    return blockedResult(input, preflight, true, blockingReasons)
  }

  const currentText = textOfContent(split.target)

  let payloadFingerprint: string
  let currentBlockFingerprint: string
  let preimageDocumentFingerprint: string
  let outsideContentFingerprint: string
  try {
    payloadFingerprint = createPiiFingerprint(desiredFactTable, {
      context: "recops:p1:elt-doc:weekly-facts",
      dataProvenance: input.dataProvenance,
    })
    currentBlockFingerprint = createPiiFingerprint(stripDocumentIndexes(split.target), {
      context: "recops:p1:elt-doc:current-facts",
      dataProvenance: input.dataProvenance,
    })
    preimageDocumentFingerprint = fingerprintEltDocDocumentContent(
      input.document,
      P1_ELT_DOC_TARGET.tabId,
      input.dataProvenance
    )
    outsideContentFingerprint = fingerprintEltDocOutsideContent({
      document: input.document,
      tabId: P1_ELT_DOC_TARGET.tabId,
      startIndex: targetStartIndex,
      endIndex: targetEndIndex,
      dataProvenance: input.dataProvenance,
    })
  } catch {
    blockingReasons.push("Live PII fingerprint secret is unavailable; refusing to emit a replayable dry-run plan.")
    return blockedResult(input, preflight, true, blockingReasons)
  }

  const templateHash = createPayloadFingerprint(
    {
      headers: ELT_DOC_HIRE_TABLE_HEADERS,
      columnWidthsPt: ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT,
      rowHeightPt: ELT_DOC_HIRE_TABLE_ROW_HEIGHT_PT,
      paddingPt: ELT_DOC_HIRE_TABLE_PADDING_PT,
      bodyFontPt: ELT_DOC_HIRE_TABLE_BODY_FONT_PT,
    }
  )
  const publicSummary: EltDocDryRunPublicSummary = {
    ...basePublicSummary(input, preflight, true),
    status: action === "no_op" ? "no_change" : "planned_for_internal_review",
    mutationScope: "weekly_fact_table",
    action,
    targetStartIndex,
    targetEndIndex,
    currentCharacterCount: currentText.length,
    desiredFactCharacterCount: desiredFactTable.hireRows
      .flatMap((row) => row)
      .reduce((count, value) => count + value.length, desiredFactTable.weekLabel.length),
    factColumnCount: 5,
    payloadFingerprint,
    currentBlockFingerprint,
    outsideContentFingerprint,
    templateHash,
    blockingReasons: [],
  }
  assertPublicSafe(publicSummary, "eltDocDryRun.publicSummary")

  return {
    publicSummary,
    privatePlan: {
      runId: input.snapshot.run_id,
      sourceGeneratedAt: new Date(input.snapshot.generated_at).toISOString(),
      dataProvenance: input.dataProvenance,
      documentId: input.document.documentId!,
      tabId: P1_ELT_DOC_TARGET.tabId,
      requiredRevisionId: input.document.revisionId!,
      payloadFingerprint,
      preimageFingerprint: currentBlockFingerprint,
      preimageDocumentFingerprint,
      outsideContentFingerprint,
      approvedRangeIds: [ELT_DOC_TOP_WEEK_FACTS_RANGE_ID],
      mutationScope: "weekly_fact_table",
      action,
      archiveBlockRange: {
        tabId: P1_ELT_DOC_TARGET.tabId,
        startIndex: archiveBlockStartIndex,
        endIndex: archiveBlockEndIndex,
      },
      contentGuardRange: {
        tabId: P1_ELT_DOC_TARGET.tabId,
        startIndex: targetStartIndex,
        endIndex: targetEndIndex,
      },
      deleteRange:
        action === "replace_top_week"
          ? {
              tabId: P1_ELT_DOC_TARGET.tabId,
              startIndex: targetStartIndex,
              endIndex: targetEndIndex,
            }
          : null,
      insertAt:
        action === "replace_top_week" || action === "insert_top_week"
          ? { tabId: P1_ELT_DOC_TARGET.tabId, index: targetStartIndex }
          : null,
      factTable: desiredFactTable,
      rollbackFactTable,
    },
  }
}

function snapshotPreflight(input: EltDocDryRunBaseInput): SnapshotPreflight {
  const facts = eltFactsOf(input.snapshot.elt_facts)
  const liveFlagEnabled = input.liveFlagValue?.trim() === "true"
  const snapshotAgeMinutes = ageMinutes(input.evaluatedAt, input.snapshot.generated_at)
  const reasons: string[] = []
  const allowedModes = input.allowedSnapshotModes ?? ["shadow"]

  if (!input.snapshot.run_id?.trim()) reasons.push("Snapshot run id is missing.")
  if (input.snapshot.workflow_id !== "E01") reasons.push("Snapshot workflow is not E01.")
  if (!allowedModes.includes(input.snapshot.mode)) reasons.push("Snapshot mode is not approved for this dry-run.")
  if (snapshotAgeMinutes === null) reasons.push("Snapshot or evaluation timestamp is invalid.")
  else if (snapshotAgeMinutes < 0) reasons.push("Snapshot timestamp is in the future.")
  else if (snapshotAgeMinutes > (input.maxSnapshotAgeMinutes ?? 120)) {
    reasons.push("Snapshot exceeds the dry-run freshness limit.")
  }
  if (input.snapshot.org_rollup?.truncation_suspected_pulls !== 0) {
    reasons.push("Snapshot reports a suspected truncated source pull.")
  }
  if (!facts) reasons.push("Snapshot elt_facts contract is missing or malformed.")
  if (input.dataProvenance === "fixture" && input.snapshot.mode !== "fixture") {
    reasons.push("Fixture fingerprint provenance is forbidden for a non-fixture snapshot.")
  }
  if (facts) reasons.push(...reportingWeekReasons(input.snapshot, facts, input.eltBackfillWeekFriday))
  if (liveFlagEnabled && input.stagingAdapterPermitBoundary !== true) {
    reasons.push("Live hydration flag is enabled; this dry-run-only slice refuses to proceed.")
  }
  return {
    facts,
    liveFlagEnabled,
    snapshotAgeMinutes,
    reasons: [...new Set(reasons)],
  }
}

function reportingWeekReasons(
  snapshot: ExecSnapshotRow,
  facts: ExecEltFacts,
  eltBackfillWeekFriday: string | undefined
): string[] {
  const reasons: string[] = []
  const factsGeneratedAt = new Date(facts.generatedAt)
  if (Number.isNaN(factsGeneratedAt.getTime())) {
    return ["Snapshot elt_facts generatedAt timestamp is invalid."]
  }

  const reportingFriday = snapshot.org_rollup?.reporting_week_friday
  if (!validFridayIso(reportingFriday)) {
    return ["Snapshot reporting-week Friday is missing or invalid."]
  }
  const expectedStateOfPlayFriday = fridayWeekStartUtc(factsGeneratedAt)
  if (reportingFriday !== expectedStateOfPlayFriday) {
    reasons.push("Snapshot state-of-play reporting week does not match elt_facts generation time.")
  }
  // The state-of-play rollup uses the in-progress Friday anchor; the legacy
  // ELT Doc intentionally uses the last complete Fri-Thu week. They differ on
  // every day except Thursday and must be validated against their own clocks.
  const expectedEltFriday = eltReportingFriday(factsGeneratedAt)
  if (eltBackfillWeekFriday !== undefined) {
    // A declared backfill week replaces the derived anchor as the labels'
    // authority - but only for a week the honest clock could not produce:
    // a real Friday strictly older than the derived current week.
    if (!validFridayIso(eltBackfillWeekFriday)) {
      reasons.push("The declared backfill week is not a valid Friday date.")
      return reasons
    }
    if (Date.parse(eltBackfillWeekFriday) >= Date.parse(expectedEltFriday)) {
      reasons.push("The declared backfill week is not older than the governed current reporting week.")
      return reasons
    }
    const declaredLabels = fridayWeekLabels(eltBackfillWeekFriday)
    if (facts.weekLabel !== declaredLabels.weekLabel || facts.weekShort !== declaredLabels.weekShort) {
      reasons.push("Snapshot reporting-week labels do not match the declared backfill week.")
    }
    return reasons
  }
  const expectedLabels = fridayWeekLabels(expectedEltFriday)
  if (facts.weekLabel !== expectedLabels.weekLabel || facts.weekShort !== expectedLabels.weekShort) {
    reasons.push("Snapshot reporting-week labels do not match the governed Friday anchor.")
  }
  return reasons
}

function documentPreflightReasons(
  document: GoogleDocsDocumentSnapshot,
  tab: GoogleDocsTabSnapshot | null,
  content: readonly GoogleDocsStructuralElement[],
  referenceGeneratedAt?: string
): string[] {
  const reasons: string[] = []
  if (!document.revisionId?.trim()) {
    reasons.push("Document revision id is missing; concurrent-edit protection is unavailable.")
  }
  if (!eltDocTabTopologyIsExact(document)) {
    reasons.push("Document tab topology does not match the exact approved single-tab surface.")
  }
  if (!tab) reasons.push("Approved document tab is missing.")
  if (content.length === 0) reasons.push("Approved document tab has no body content.")
  reasons.push(
    ...eltDocTargetConflicts({
      documentId: document.documentId,
      title: document.title,
      tabId: tab?.tabProperties?.tabId,
    })
  )
  if (content.length > 0 && weekAnchors(content, referenceGeneratedAt).length === 0) {
    reasons.push("Document archive contains no recognized reporting-week anchors.")
  }
  return [...new Set(reasons)]
}

function basePublicSummary(
  input: EltDocDryRunBaseInput,
  preflight: SnapshotPreflight,
  revisionGuardPresent: boolean
): Omit<
  EltDocDryRunPublicSummary,
  | "status"
  | "action"
  | "targetStartIndex"
  | "targetEndIndex"
  | "currentCharacterCount"
  | "desiredFactCharacterCount"
  | "factColumnCount"
  | "blockingReasons"
> {
  const facts = preflight.facts
  return {
    deliverableId: P1_ELT_DOC_TARGET.deliverableId,
    dryRunOnly: true,
    mutationReachable: false,
    mutationCallCount: 0,
    promotionEligible: false,
    promotionBlockingReasons: [...PROMOTION_BLOCKING_REASONS],
    containsPersonIdentifiers: containsPersonIdentifiers(facts),
    liveFlagEnabled: preflight.liveFlagEnabled,
    snapshotRunId: input.snapshot.run_id,
    snapshotWorkflowId: input.snapshot.workflow_id,
    snapshotMode: input.snapshot.mode,
    snapshotAgeMinutes: preflight.snapshotAgeMinutes,
    reportingWeek: facts?.weekLabel ?? null,
    upsertKeyField: P1_ELT_DOC_TARGET.upsertKeyField,
    mutationScope: "weekly_fact_table",
    hireCount: facts?.hires.length ?? 0,
    sectionCount: facts?.sections.length ?? 0,
    revisionGuardPresent,
  }
}

function blockedResult(
  input: EltDocDryRunBaseInput,
  preflight: SnapshotPreflight,
  revisionGuardPresent: boolean,
  blockingReasons: readonly string[]
): EltDocDryRunResult {
  const publicSummary: EltDocDryRunPublicSummary = {
    ...basePublicSummary(input, preflight, revisionGuardPresent),
    status: "blocked",
    action: null,
    targetStartIndex: null,
    targetEndIndex: null,
    currentCharacterCount: 0,
    desiredFactCharacterCount: 0,
    factColumnCount: 5,
    blockingReasons: [...new Set(blockingReasons)],
  }
  assertPublicSafe(publicSummary, "eltDocDryRun.publicSummary")
  return { publicSummary, privatePlan: null }
}

function ageMinutes(evaluatedAt: string, generatedAt: string): number | null {
  const evaluated = Date.parse(evaluatedAt)
  const generated = Date.parse(generatedAt)
  if (Number.isNaN(evaluated) || Number.isNaN(generated)) return null
  return (evaluated - generated) / 60_000
}

function eltFactsOf(value: unknown): ExecEltFacts | null {
  if (!value || typeof value !== "object") return null
  const facts = value as Partial<ExecEltFacts>
  if (!facts.generatedAt?.trim() || !facts.weekLabel?.trim() || !facts.weekShort?.trim()) return null
  if (!Array.isArray(facts.hires) || !Array.isArray(facts.sections) || typeof facts.hiresNote !== "string") return null
  for (const hire of facts.hires) {
    if (
      !hire ||
      typeof hire !== "object" ||
      !hire.role?.trim() ||
      !hire.candidate?.trim() ||
      !nullableString(hire.startsOn) ||
      !nullableString(hire.department) ||
      !nullableString(hire.priority) ||
      !nullableString(hire.location) ||
      (hire.reqId !== null && !Number.isFinite(hire.reqId))
    ) {
      return null
    }
  }
  for (const section of facts.sections) {
    if (!section || typeof section !== "object" || !section.title?.trim()) return null
    if (
      !Array.isArray(section.subs) ||
      !section.subs.every(nonEmptyString) ||
      !nonNegativeCount(section.qtdOffers?.total) ||
      !Array.isArray(section.stages) ||
      !Array.isArray(section.qtdOffers?.subs) ||
      !Array.isArray(section.qtdOffers?.names) ||
      !section.qtdOffers.names.every(nonEmptyString) ||
      !section.qtdOffers.subs.every(countSplitIsValid) ||
      !nonNegativeCount(section.weekOffers?.total) ||
      !Array.isArray(section.weekOffers?.subs) ||
      !Array.isArray(section.weekOffers?.names) ||
      !section.weekOffers.names.every(nonEmptyString) ||
      !section.weekOffers.subs.every(countSplitIsValid)
    ) {
      return null
    }
    for (const stage of section.stages) {
      if (
        !stage ||
        !nonEmptyString(stage.label) ||
        !nonNegativeCount(stage.conducted) ||
        !nonNegativeCount(stage.passed) ||
        !Array.isArray(stage.subs) ||
        !stage.subs.every(stageSplitIsValid)
      ) {
        return null
      }
    }
  }
  return facts as ExecEltFacts
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string"
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function nonNegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function countSplitIsValid(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const row = value as { label?: unknown; count?: unknown }
  return nonEmptyString(row.label) && nonNegativeCount(row.count)
}

function stageSplitIsValid(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const row = value as { label?: unknown; conducted?: unknown; passed?: unknown }
  return (
    nonEmptyString(row.label) &&
    nonNegativeCount(row.conducted) &&
    nonNegativeCount(row.passed)
  )
}

function containsPersonIdentifiers(facts: ExecEltFacts | null): boolean {
  if (!facts) return false
  return (
    facts.hires.length > 0 ||
    facts.sections.some(
      (section) => section.qtdOffers.names.length > 0 || section.weekOffers.names.length > 0
    )
  )
}

function validFridayIso(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getUTCDay() === 5
}

function findTab(tabs: readonly GoogleDocsTabSnapshot[], tabId: string): GoogleDocsTabSnapshot | null {
  for (const tab of tabs) {
    if (tab.tabProperties?.tabId === tabId) return tab
    const child = findTab(tab.childTabs ?? [], tabId)
    if (child) return child
  }
  return null
}

/** Returns the exact requested tab, including nested Docs tabs. */
export function findEltDocTab(
  document: GoogleDocsDocumentSnapshot,
  tabId: string
): GoogleDocsTabSnapshot | null {
  return findTab(document.tabs ?? [], tabId)
}

export function eltDocTabTopologyIsExact(
  document: GoogleDocsDocumentSnapshot
): boolean {
  const tabs = document.tabs ?? []
  return (
    tabs.length === 1 &&
    tabs[0]?.tabProperties?.tabId === P1_ELT_DOC_TARGET.tabId &&
    (tabs[0]?.childTabs?.length ?? 0) === 0
  )
}

export interface EltDocFactTableCertification {
  factTableRange: { tabId: string; startIndex: number; endIndex: number }
  rollbackRendererCompatible: boolean
}

/**
 * Independently certifies the connector-visible date chip, hire table, and
 * Role Progress narrative tail. The returned range ends at the next archive
 * boundary, so only older weeks' hand-written history stays outside mutation.
 */
export function certifyEltDocFactTablePostimage(input: {
  document: GoogleDocsDocumentSnapshot
  plan: EltDocDryRunPrivatePlan
}): EltDocFactTableCertification {
  const { document, plan } = input
  const tab = findEltDocTab(document, plan.tabId)
  if (!tab) throw new Error("Approved ELT document tab is missing.")
  const content = tab.documentTab?.body?.content ?? []
  const anchors = weekAnchors(content, plan.sourceGeneratedAt)
  const boundaries = archiveWeekBoundaries(anchors)
  const expectedStart = weekStartMs(plan.factTable.weekLabel)
  const matches = boundaries.filter((boundary) => boundary.weekStartMs === expectedStart)
  if (expectedStart === null || matches.length !== 1 || matches[0].kind !== "week_heading") {
    throw new Error("Staging ELT post-state does not contain one unique top-week fact boundary.")
  }
  const matchOrdinal = boundaries.indexOf(matches[0])
  if (plan.action === "insert_top_week") {
    // An insert certifies at its planned position, wherever in the archive that
    // is: the block must sit exactly where the plan pointed, with a strictly
    // newer week above it (when one exists) and a strictly older week below.
    // At the top of the archive the planned index is 1 and the above-neighbor
    // condition is vacuous, which is the historical behavior.
    const above = matchOrdinal > 0 ? boundaries[matchOrdinal - 1] : null
    const below = boundaries[matchOrdinal + 1]
    if (
      matches[0].startIndex !== plan.insertAt?.index ||
      !below ||
      below.weekStartMs >= expectedStart ||
      (above !== null && above.weekStartMs <= expectedStart)
    ) {
      throw new Error("Staging ELT post-state does not contain one unique top-week fact boundary.")
    }
  } else if (
    boundaries[0] !== matches[0] ||
    matches[0].startIndex !== 1 ||
    !boundaries[1]
  ) {
    throw new Error("Staging ELT post-state does not contain one unique top-week fact boundary.")
  }

  const shape = topWeekFactShape(content, matches[0])
  assertDateChipHeading(shape.heading, plan.factTable)
  if (plan.action === "no_op") {
    assertExistingInterstitialParagraph(shape.interstitial)
  } else {
    assertBlankParagraph(shape.interstitial)
  }
  assertHireTable(shape.table, plan.factTable.hireRows, {
    allowCopyOnlyBodyParagraphFields: plan.action === "no_op",
  })
  const nextBoundaryStart = boundaries[matchOrdinal + 1].startIndex
  const narrativeSplit = splitContentAtTarget(content, shape.table.endIndex!, nextBoundaryStart)
  if (!narrativeSplit.ok) throw new Error(narrativeSplit.reason)
  assertNarrativeTail(normalizeNarrativeElements(narrativeSplit.target), plan.factTable.narrativeParagraphs)
  const factTableRange = {
    tabId: plan.tabId,
    startIndex:
      plan.action === "insert_top_week"
        ? plan.insertAt!.index
        : plan.action === "replace_top_week"
          ? shape.interstitial.startIndex!
          : shape.table.startIndex!,
    endIndex: nextBoundaryStart,
  }
  return {
    factTableRange,
    rollbackRendererCompatible: factTableUsesRollbackRendererFormat(shape.table),
  }
}

/**
 * Every direct archive boundary startIndex (week-heading or legacy-Hires
 * anchor), in document order. Callers use `[1]` to find the next block's
 * start — the exclusive end of the current top-week mutation-owned range.
 */
export function eltDocArchiveBoundaryStartIndexes(input: {
  document: GoogleDocsDocumentSnapshot
  tabId: string
  referenceGeneratedAt: string
}): readonly number[] {
  const tab = findEltDocTab(input.document, input.tabId)
  const content = tab?.documentTab?.body?.content ?? []
  return archiveWeekBoundaries(weekAnchors(content, input.referenceGeneratedAt)).map(
    (boundary) => boundary.startIndex
  )
}

function observedTopWeekTemplateReasons(
  content: readonly GoogleDocsStructuralElement[],
  current: WeekAnchor
): string[] {
  try {
    if (current.kind !== "week_heading" || current.startIndex !== 1) throw new Error("shape")
    observedWeekPreface(topWeekFactShape(content, current), current.weekLabel)
    return []
  } catch {
    return [
      "Newest archive block does not match the observed date-chip, single interstitial paragraph, five-column hire-table template.",
    ]
  }
}

function topWeekFactShape(
  content: readonly GoogleDocsStructuralElement[],
  current: WeekAnchor
): {
  heading: GoogleDocsStructuralElement
  interstitial: GoogleDocsStructuralElement
  table: GoogleDocsStructuralElement
} {
  const headingIndex = content.findIndex((element) => element.startIndex === current.startIndex)
  const heading = content[headingIndex]
  const interstitial = content[headingIndex + 1]
  const table = content[headingIndex + 2]
  if (
    headingIndex < 0 ||
    !heading?.paragraph ||
    interstitial?.startIndex !== heading.endIndex ||
    !interstitial.paragraph ||
    table?.startIndex !== interstitial.endIndex ||
    !table.table ||
    !Number.isInteger(table.endIndex)
  ) {
    throw new Error("ELT top-week preface structure is incomplete.")
  }
  return normalizeObservedGoogleDocsDefaults({ heading, interstitial, table })
}

function assertReplacementParagraphAnchor(
  content: readonly GoogleDocsStructuralElement[],
  table: GoogleDocsStructuralElement
): void {
  const following = content.find((element) => element.startIndex === table.endIndex)
  if (!following?.paragraph) {
    throw new Error("ELT replacement table is not followed by a paragraph insertion anchor.")
  }
}

/**
 * Docs includes semantically empty/default fields in live reads that it omits
 * from mutation requests. Normalize only their exact observed values before
 * the strict template assertions; any different or unknown value remains and
 * is rejected downstream.
 */
function normalizeObservedGoogleDocsDefaults(
  shape: ReturnType<typeof topWeekFactShape>
): ReturnType<typeof topWeekFactShape> {
  const normalized = structuredClone(shape)
  const headingStyle = normalized.heading.paragraph?.paragraphStyle
  if (headingStyle?.direction === "LEFT_TO_RIGHT") delete headingStyle.direction
  for (const part of normalized.heading.paragraph?.elements ?? []) {
    if (part.dateElement?.textStyle && Object.keys(part.dateElement.textStyle).length === 0) {
      delete part.dateElement.textStyle
    }
    if (part.textRun?.textStyle && Object.keys(part.textRun.textStyle).length === 0) {
      delete part.textRun.textStyle
    }
  }

  const interstitialStyle = normalized.interstitial.paragraph?.paragraphStyle
  if (interstitialStyle?.direction === "LEFT_TO_RIGHT") {
    delete interstitialStyle.direction
  }
  for (const part of normalized.interstitial.paragraph?.elements ?? []) {
    if (part.textRun?.textStyle && Object.keys(part.textRun.textStyle).length === 0) {
      delete part.textRun.textStyle
    }
  }

  const table = normalized.table.table
  const rows = table?.tableRows ?? []
  const hasRowIndexes = rows.some(
    (row) => row.startIndex !== undefined || row.endIndex !== undefined
  )
  const rowIndexesAreExact =
    hasRowIndexes &&
    Number.isInteger(normalized.table.startIndex) &&
    Number.isInteger(normalized.table.endIndex) &&
    rows.every(
      (row, index) =>
        Number.isInteger(row.startIndex) &&
        Number.isInteger(row.endIndex) &&
        row.startIndex ===
          (index === 0
            ? normalized.table.startIndex! + 1
            : rows[index - 1].endIndex) &&
        row.endIndex ===
          (index === rows.length - 1
            ? normalized.table.endIndex! - 1
            : rows[index + 1].startIndex)
    )
  if (rowIndexesAreExact) {
    for (const row of rows) {
      delete row.startIndex
      delete row.endIndex
    }
  }

  rows.forEach((row, rowIndex) => {
    for (const cell of row.tableCells ?? []) {
      const style = cell.tableCellStyle
      if (style?.rowSpan === 1) delete style.rowSpan
      if (style?.columnSpan === 1) delete style.columnSpan
      if (
        rowIndex === 0 &&
        style?.backgroundColor &&
        Object.keys(style.backgroundColor).length === 0
      ) {
        delete style.backgroundColor
      }
      if (rowIndex > 0) {
        dropExactEmptyGoogleColor(style?.borderLeft)
        dropExactEmptyGoogleColor(style?.borderRight)
      }

      const paragraphStyle = cell.content?.[0]?.paragraph?.paragraphStyle
      if (paragraphStyle?.direction === "LEFT_TO_RIGHT") delete paragraphStyle.direction
      if (paragraphStyle?.lineSpacing === 100) delete paragraphStyle.lineSpacing

      const textStyle = cell.content?.[0]?.paragraph?.elements?.[0]?.textRun?.textStyle
      if (rowIndex > 0 && textStyle && !Object.hasOwn(textStyle, "bold")) {
        textStyle.bold = false
      }
    }
  })
  return normalized
}

function dropExactEmptyGoogleColor(border: GoogleDocsTableCellBorder | undefined): void {
  const color = border?.color
  const nested = color?.color
  const rgb = nested?.rgbColor
  if (
    color &&
    nested &&
    rgb &&
    Object.keys(color).length === 1 &&
    Object.keys(nested).length === 1 &&
    Object.keys(rgb).length === 0
  ) {
    delete border!.color
  }
}

function observedWeekPreface(
  shape: ReturnType<typeof topWeekFactShape>,
  weekLabel: string
): EltDocWeekPrefacePlan {
  const hireRows = (shape.table.table?.tableRows ?? []).slice(1).map((row) => {
    const values = (row.tableCells ?? []).map((cell) =>
      textOfContent(cell.content ?? []).replace(/\n$/, "")
    )
    if (values.length !== ELT_DOC_HIRE_TABLE_HEADERS.length) {
      throw new Error("ELT hire table row does not contain five cells.")
    }
    return values as unknown as EltDocHireTableRow
  })
  const observed = weekPrefaceForWeekLabel(weekLabel, hireRows, [])
  assertDateChipHeading(shape.heading, observed)
  assertExistingInterstitialParagraph(shape.interstitial)
  assertHireTable(shape.table, hireRows, {
    allowCopyOnlyBodyParagraphFields: true,
  })
  return observed
}

/**
 * Reads the exact observed paragraphs between the hire table and the next
 * archive boundary — text, namedStyleType, and (uniform per-paragraph) bold —
 * for rollback recompilation. Throws (never approximates) on anything it
 * cannot faithfully reconstruct: a nested table, an inline image, mixed bold
 * within one paragraph, an unsupported style, or a non-paragraph element.
 */
function observedNarrativeParagraphs(
  content: readonly GoogleDocsStructuralElement[],
  startIndex: number,
  endIndex: number
): EltDocParagraph[] {
  const split = splitContentAtTarget(content, startIndex, endIndex)
  if (!split.ok) throw new Error(split.reason)
  return split.target.map(narrativeParagraphOfElement)
}

function narrativeParagraphOfElement(element: GoogleDocsStructuralElement): EltDocParagraph {
  const paragraph = element.paragraph
  if (!paragraph) {
    throw new Error("ELT narrative tail contains a non-paragraph structural element.")
  }
  const parts = paragraph.elements ?? []
  if (parts.length !== 1 || !parts[0]?.textRun) {
    throw new Error("ELT narrative tail paragraph text structure is ambiguous.")
  }
  const textRun = parts[0].textRun
  const text = textRun.content ?? ""
  if (!text.endsWith("\n")) {
    throw new Error("ELT narrative tail paragraph is not newline-terminated.")
  }
  const namedStyleType = paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT"
  if (
    namedStyleType !== "HEADING_1" &&
    namedStyleType !== "HEADING_2" &&
    namedStyleType !== "NORMAL_TEXT"
  ) {
    throw new Error("ELT narrative tail paragraph style is not reconstructible.")
  }
  return {
    kind: namedStyleType === "HEADING_2" ? "section_heading" : "body",
    text: text.slice(0, -1),
    namedStyleType,
    bold: textRun.textStyle?.bold ?? false,
    tone: "ink",
  }
}

/**
 * Strict structural comparison of the observed narrative tail against a
 * planned/desired one — same rigor as `assertHireTable`, since both sides
 * of this check are content our own compiler is expected to have written.
 */
function assertNarrativeTail(
  elements: readonly GoogleDocsStructuralElement[],
  expected: readonly EltDocParagraph[]
): void {
  if (elements.length !== expected.length) {
    throw new Error("ELT narrative tail paragraph count does not match the planned post-state.")
  }
  elements.forEach((element, index) => {
    const want = expected[index]
    assertAllowedKeys(
      element,
      ["startIndex", "endIndex", "paragraph"],
      "ELT narrative tail structure changed."
    )
    const paragraph = element.paragraph
    if (!paragraph) throw new Error("ELT narrative tail structure changed.")
    assertExactKeys(
      paragraph,
      ["paragraphStyle", "elements"],
      "ELT narrative tail paragraph structure changed."
    )
    // `headingId` is Docs-assigned bookkeeping, not formatting the compiler
    // chooses: Docs stamps one onto every HEADING_2 paragraph, and the narrative
    // tail's section headings are HEADING_2. Demanding the key set be exactly
    // ["namedStyleType"] is therefore unsatisfiable against a real document --
    // it rejected every ELT write at post-image certification. The sibling
    // heading assertion already allows and validates it the same way.
    assertAllowedKeys(
      paragraph.paragraphStyle,
      ["namedStyleType", "headingId"],
      "ELT narrative tail formatting changed."
    )
    if (
      paragraph.paragraphStyle?.headingId !== undefined &&
      !paragraph.paragraphStyle.headingId.trim()
    ) {
      throw new Error("ELT narrative tail metadata changed.")
    }
    if (paragraph.paragraphStyle?.namedStyleType !== want.namedStyleType) {
      throw new Error("ELT narrative tail paragraph style does not match the planned post-state.")
    }
    const parts = paragraph.elements ?? []
    if (parts.length !== 1 || !parts[0]?.textRun) {
      throw new Error("ELT narrative tail paragraph text structure is ambiguous.")
    }
    assertAllowedKeys(
      parts[0],
      ["startIndex", "endIndex", "textRun"],
      "ELT narrative tail text structure changed."
    )
    const textRun = parts[0].textRun!
    // An unbolded run carries no `bold` property, so Docs returns `textStyle: {}`
    // -- which `normalizeNarrativeElements` then strips entirely. Requiring the
    // key set to be exactly ["content", "textStyle"] therefore contradicted the
    // normalizer three lines away and rejected every body paragraph in the tail.
    // Absence is the legitimate representation of "not bold"; extra properties
    // (an inherited colour or font size leaking in from the insertion anchor)
    // must still be refused, so this stays an allow-list rather than a subset.
    assertAllowedKeys(textRun, ["content", "textStyle"], "ELT narrative tail text metadata changed.")
    assertAllowedKeys(textRun.textStyle ?? {}, ["bold"], "ELT narrative tail typography changed.")
    if (textRun.content !== `${want.text}\n`) {
      throw new Error("ELT narrative tail text does not match the planned post-state.")
    }
    if ((textRun.textStyle?.bold ?? false) !== want.bold) {
      throw new Error("ELT narrative tail typography does not match the planned post-state.")
    }
  })
}

/** Same Docs-default stripping as `normalizeObservedGoogleDocsDefaults`, for narrative paragraphs. */
function normalizeNarrativeElements(
  elements: readonly GoogleDocsStructuralElement[]
): GoogleDocsStructuralElement[] {
  return elements.map((element) => {
    const normalized = structuredClone(element)
    const style = normalized.paragraph?.paragraphStyle
    if (style?.direction === "LEFT_TO_RIGHT") delete style.direction
    for (const part of normalized.paragraph?.elements ?? []) {
      if (part.textRun?.textStyle && Object.keys(part.textRun.textStyle).length === 0) {
        delete part.textRun.textStyle
      }
    }
    return normalized
  })
}

function weekPrefaceForFacts(facts: ExecEltFacts): EltDocWeekPrefacePlan {
  return weekPrefaceForWeekLabel(
    facts.weekLabel,
    facts.hires.map(
      (hire): EltDocHireTableRow => [
        hire.role,
        hire.department ?? "",
        hire.priority ?? "",
        hire.candidate,
        hire.startsOn ?? "TBD",
      ]
    ),
    renderEltDocRoleProgressParagraphs(facts)
  )
}

function weekPrefaceForWeekLabel(
  weekLabel: string,
  hireRows: readonly EltDocHireTableRow[],
  narrativeParagraphs: readonly EltDocParagraph[]
): EltDocWeekPrefacePlan {
  if (!WEEK_LABEL_PATTERN.test(weekLabel)) throw new Error("ELT reporting-week label is invalid.")
  const [startDisplayText, endDisplayText] = weekLabel.split(" - ")
  const start = Date.parse(`${startDisplayText} 12:00:00 UTC`)
  const end = Date.parse(`${endDisplayText} 12:00:00 UTC`)
  if (Number.isNaN(start) || Number.isNaN(end) || end - start !== 6 * 24 * 60 * 60 * 1_000) {
    throw new Error("ELT reporting-week date-chip range is invalid.")
  }
  return {
    weekLabel,
    startDisplayText,
    endDisplayText,
    startTimestamp: new Date(start).toISOString(),
    endTimestamp: new Date(end).toISOString(),
    hireRows,
    narrativeParagraphs,
  }
}

function assertDateChipHeading(
  element: GoogleDocsStructuralElement,
  expected: EltDocWeekPrefacePlan
): void {
  const paragraph = element.paragraph
  const parts = paragraph?.elements ?? []
  if (
    !paragraph ||
    paragraph.paragraphStyle?.namedStyleType !== "HEADING_2" ||
    parts.length !== 4
  ) {
    throw new Error("ELT week heading does not match the observed date-chip shape.")
  }
  assertAllowedKeys(element, ["startIndex", "endIndex", "paragraph"], "ELT week heading structure changed.")
  assertExactKeys(
    paragraph,
    ["paragraphStyle", "elements"],
    "ELT week heading paragraph structure changed."
  )
  assertAllowedKeys(
    paragraph.paragraphStyle,
    ["namedStyleType", "headingId"],
    "ELT week heading formatting changed."
  )
  if (
    paragraph.paragraphStyle?.headingId !== undefined &&
    !paragraph.paragraphStyle.headingId.trim()
  ) {
    throw new Error("ELT week heading metadata changed.")
  }
  assertAllowedKeys(
    parts[0],
    ["startIndex", "endIndex", "dateElement"],
    "ELT week start-chip structure changed."
  )
  assertDateElementMetadata(parts[0]?.dateElement, "ELT week start-chip metadata changed.")
  assertAllowedKeys(
    parts[1],
    ["startIndex", "endIndex", "textRun"],
    "ELT week date separator structure changed."
  )
  assertHeadingTextRun(parts[1]?.textRun, "ELT week date separator formatting changed.")
  assertAllowedKeys(
    parts[2],
    ["startIndex", "endIndex", "dateElement"],
    "ELT week end-chip structure changed."
  )
  assertDateElementMetadata(parts[2]?.dateElement, "ELT week end-chip metadata changed.")
  assertAllowedKeys(
    parts[3],
    ["startIndex", "endIndex", "textRun"],
    "ELT week heading spacer structure changed."
  )
  assertHeadingTextRun(parts[3]?.textRun, "ELT week heading spacer formatting changed.")
  assertDateChip(parts[0]?.dateElement?.dateElementProperties, expected.startTimestamp, expected.startDisplayText)
  if (parts[1]?.textRun?.content !== " - ") throw new Error("ELT week date-chip separator changed.")
  assertDateChip(parts[2]?.dateElement?.dateElementProperties, expected.endTimestamp, expected.endDisplayText)
  if (parts[3]?.textRun?.content !== "  \n") throw new Error("ELT week heading spacer changed.")
}

function assertDateElementMetadata(
  dateElement: GoogleDocsDateElementSnapshot | undefined,
  message: string
): void {
  assertAllowedKeys(
    dateElement,
    ["dateElementProperties", "dateId", "textStyle"],
    message
  )
  if (dateElement?.dateId !== undefined && !dateElement.dateId.trim()) {
    throw new Error(message)
  }
  assertOptionalHeadingTextStyle(dateElement?.textStyle, message)
}

function assertHeadingTextRun(
  textRun: {
    content?: string
    textStyle?: {
      bold?: boolean
      italic?: boolean
      underline?: boolean
      fontSize?: GoogleDocsDimension
      foregroundColor?: GoogleDocsOptionalColor
    }
  } | undefined,
  message: string
): void {
  assertAllowedKeys(textRun, ["content", "textStyle"], message)
  assertOptionalHeadingTextStyle(textRun?.textStyle, message)
}

function assertOptionalHeadingTextStyle(
  textStyle: { foregroundColor?: GoogleDocsOptionalColor } | undefined,
  message: string
): void {
  if (textStyle === undefined) return
  assertExactKeys(textStyle, ["foregroundColor"], message)
  assertExactKeys(textStyle.foregroundColor, ["color"], message)
  assertExactKeys(textStyle.foregroundColor?.color, ["rgbColor"], message)
  const rgb = textStyle.foregroundColor?.color?.rgbColor
  assertAllowedKeys(rgb, ["red", "green", "blue"], message)
  if (
    Object.values(rgb ?? {}).some(
      (value) => typeof value !== "number" || !Number.isFinite(value)
    )
  ) {
    throw new Error(message)
  }
}

function assertDateChip(
  properties: GoogleDocsDateElementProperties | undefined,
  expectedTimestamp: string,
  expectedDisplayText: string
): void {
  assertExactKeys(
    properties,
    ["displayText", "timestamp", "locale", "dateFormat", "timeFormat"],
    "ELT date chip formatting changed."
  )
  if (
    !properties ||
    Date.parse(properties.timestamp ?? "") !== Date.parse(expectedTimestamp) ||
    properties.displayText !== expectedDisplayText ||
    properties.locale !== "en" ||
    properties.dateFormat !== "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED" ||
    properties.timeFormat !== "TIME_FORMAT_DISABLED"
  ) {
    throw new Error("ELT date chip properties do not match the planned reporting week.")
  }
}

function assertExistingInterstitialParagraph(
  element: GoogleDocsStructuralElement
): void {
  assertAllowedKeys(
    element,
    ["startIndex", "endIndex", "paragraph"],
    "ELT week interstitial structure changed."
  )
  if (!element.paragraph) {
    throw new Error("ELT week interstitial must be exactly one paragraph.")
  }
  if (textOfElement(element).trim().length === 0) {
    assertBlankParagraph(element)
  }
}

function assertBlankParagraph(element: GoogleDocsStructuralElement): void {
  const paragraph = element.paragraph
  const parts = paragraph?.elements ?? []
  if (
    paragraph?.paragraphStyle?.namedStyleType !== "NORMAL_TEXT" ||
    parts.length !== 1 ||
    parts[0]?.textRun?.content !== "\n" ||
    textOfElement(element) !== "\n"
  ) {
    throw new Error("ELT week preface blank paragraph changed.")
  }
  assertAllowedKeys(
    element,
    ["startIndex", "endIndex", "paragraph"],
    "ELT week preface blank structure changed."
  )
  assertExactKeys(
    paragraph,
    ["paragraphStyle", "elements"],
    "ELT week preface blank paragraph structure changed."
  )
  assertExactKeys(
    paragraph.paragraphStyle,
    ["namedStyleType"],
    "ELT week preface blank formatting changed."
  )
  assertAllowedKeys(
    parts[0],
    ["startIndex", "endIndex", "textRun"],
    "ELT week preface blank text structure changed."
  )
  assertExactKeys(
    parts[0]?.textRun,
    ["content"],
    "ELT week preface blank text formatting changed."
  )
}

function assertHireTable(
  element: GoogleDocsStructuralElement,
  expectedHireRows: readonly EltDocHireTableRow[] | null,
  options: { allowCopyOnlyBodyParagraphFields?: boolean } = {}
): void {
  const table = element.table
  const rows = table?.tableRows ?? []
  const expectedRowCount = expectedHireRows === null ? null : expectedHireRows.length + 1
  if (
    !table ||
    table.columns !== ELT_DOC_HIRE_TABLE_HEADERS.length ||
    table.rows !== rows.length ||
    rows.length < 1 ||
    (expectedRowCount !== null && rows.length !== expectedRowCount) ||
    table.tableStyle?.tableColumnProperties?.length !== ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT.length
  ) {
    throw new Error("ELT hire table dimensions do not match the observed template.")
  }
  assertAllowedKeys(
    element,
    ["startIndex", "endIndex", "table"],
    "ELT hire table structural fields changed."
  )
  assertExactKeys(
    table,
    ["columns", "rows", "tableStyle", "tableRows"],
    "ELT hire table metadata changed."
  )
  assertExactKeys(
    table.tableStyle,
    ["tableColumnProperties"],
    "ELT hire table style metadata changed."
  )
  table.tableStyle.tableColumnProperties.forEach((column, index) => {
    assertExactKeys(
      column,
      ["widthType", "width"],
      "ELT hire table column formatting changed."
    )
    assertDimensionKeys(column.width, "ELT hire table column width changed.")
    if (
      column.widthType !== "FIXED_WIDTH" ||
      !dimensionEquals(column.width, ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT[index])
    ) {
      throw new Error("ELT hire table column widths do not match the observed template.")
    }
  })
  const headerCells = rows[0]?.tableCells ?? []
  const uniformImportedHeaderEdge = headerCells.every((cell) =>
    dimensionEquals(
      cell.tableCellStyle?.borderBottom?.width,
      ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT
    )
  )
  const uniformRendererHeaderEdge = headerCells.every((cell) =>
    dimensionEquals(
      cell.tableCellStyle?.borderBottom?.width,
      ELT_DOC_HIRE_TABLE_BODY_BORDER_PT
    )
  )
  if (!uniformImportedHeaderEdge && !uniformRendererHeaderEdge) {
    throw new Error("ELT hire table shared header border is not deterministic.")
  }

  rows.forEach((row, rowIndex) => {
    const cells = row.tableCells ?? []
    if (
      cells.length !== ELT_DOC_HIRE_TABLE_HEADERS.length ||
      !dimensionEquals(row.tableRowStyle?.minRowHeight, ELT_DOC_HIRE_TABLE_ROW_HEIGHT_PT)
    ) {
      throw new Error("ELT hire table row shape does not match the observed template.")
    }
    assertExactKeys(
      row,
      ["tableRowStyle", "tableCells"],
      "ELT hire table row structure changed."
    )
    assertExactKeys(
      row.tableRowStyle,
      ["minRowHeight"],
      "ELT hire table row formatting changed."
    )
    assertDimensionKeys(
      row.tableRowStyle?.minRowHeight,
      "ELT hire table row height changed."
    )
    const expectedBodyBackground =
      rowIndex === 0
        ? null
        : rowIndex % 2 === 1
          ? { red: 1, green: 1, blue: 1 }
          : ELT_DOC_HIRE_TABLE_STRIPE_RGB
    cells.forEach((cell, columnIndex) => {
      assertAllowedKeys(
        cell,
        ["startIndex", "endIndex", "tableCellStyle", "content"],
        "ELT hire table cell structure changed."
      )
      assertHireTableCellStyle(cell.tableCellStyle, rowIndex, expectedBodyBackground)
      const expectedText =
        rowIndex === 0
          ? ELT_DOC_HIRE_TABLE_HEADERS[columnIndex]
          : expectedHireRows?.[rowIndex - 1]?.[columnIndex]
      if (expectedText !== undefined && textOfContent(cell.content ?? []) !== `${expectedText}\n`) {
        throw new Error("ELT hire table cell text does not match the planned post-state.")
      }
      const paragraphs = cell.content ?? []
      if (paragraphs.length !== 1) throw new Error("ELT hire table cell has an ambiguous structure.")
      const cellElement = paragraphs[0]
      const paragraph = cellElement.paragraph
      const parts = paragraph?.elements ?? []
      assertAllowedKeys(
        cellElement,
        ["startIndex", "endIndex", "paragraph"],
        "ELT hire table cell paragraph structure changed."
      )
      assertExactKeys(
        paragraph,
        ["paragraphStyle", "elements"],
        "ELT hire table cell paragraph metadata changed."
      )
      const paragraphStyle = paragraph?.paragraphStyle
      if (rowIndex === 0 || !options.allowCopyOnlyBodyParagraphFields) {
        assertExactKeys(
          paragraphStyle,
          ["namedStyleType", "alignment"],
          "ELT hire table cell paragraph formatting changed."
        )
      } else {
        const keys = Object.keys(paragraphStyle ?? {}).sort()
        const canonicalKeys = ["alignment", "namedStyleType"]
        const observedCopyKeys = [
          "alignment",
          "lineSpacing",
          "namedStyleType",
          "spaceAbove",
          "spaceBelow",
          "spacingMode",
        ]
        if (
          !sameStringKeys(keys, canonicalKeys) &&
          !sameStringKeys(keys, observedCopyKeys)
        ) {
          throw new Error("ELT hire table cell paragraph formatting changed.")
        }
      }
      if (
        paragraphStyle?.namedStyleType !== "NORMAL_TEXT" ||
        paragraphStyle.alignment !== "CENTER"
      ) {
        throw new Error("ELT hire table cell alignment does not match the observed template.")
      }
      if (parts.length !== 1 || !parts[0]?.textRun) {
        throw new Error("ELT hire table cell text structure is ambiguous.")
      }
      assertAllowedKeys(
        parts[0],
        ["startIndex", "endIndex", "textRun"],
        "ELT hire table cell text structure changed."
      )
      assertExactKeys(
        parts[0].textRun,
        ["content", "textStyle"],
        "ELT hire table cell text metadata changed."
      )
      assertExactKeys(
        parts[0].textRun.textStyle,
        rowIndex === 0 ? ["bold"] : ["bold", "fontSize"],
        "ELT hire table typography changed."
      )
      if (rowIndex > 0) {
        assertDimensionKeys(
          parts[0].textRun.textStyle?.fontSize,
          "ELT hire table body font size changed."
        )
      }
      const textStyles = [parts[0].textRun.textStyle]
      if (
        textStyles.length === 0 ||
        (rowIndex === 0
          ? textStyles.some((style) => style?.bold !== true)
          : textStyles.some(
              (style) =>
                style?.bold === true ||
                !dimensionEquals(style?.fontSize, ELT_DOC_HIRE_TABLE_BODY_FONT_PT)
            ))
      ) {
        throw new Error("ELT hire table typography does not match the observed template.")
      }
    })
  })
}

function factTableUsesRollbackRendererFormat(
  element: GoogleDocsStructuralElement
): boolean {
  const headerCells = element.table?.tableRows?.[0]?.tableCells ?? []
  const bodyCells =
    element.table?.tableRows?.slice(1).flatMap((row) => row.tableCells ?? []) ?? []
  return (
    headerCells.length === ELT_DOC_HIRE_TABLE_HEADERS.length &&
    headerCells.every((cell) =>
      dimensionEquals(
        cell.tableCellStyle?.borderBottom?.width,
        ELT_DOC_HIRE_TABLE_BODY_BORDER_PT
      )
    ) &&
    bodyCells.every((cell) =>
      sameStringKeys(
        Object.keys(cell.content?.[0]?.paragraph?.paragraphStyle ?? {}).sort(),
        ["alignment", "namedStyleType"]
      )
    )
  )
}

function sameStringKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertHireTableCellStyle(
  style: GoogleDocsTableCellStyle | undefined,
  rowIndex: number,
  expectedBodyBackground: { red: number; green: number; blue: number } | null
): void {
  assertExactKeys(
    style,
    rowIndex === 0
      ? [
          "borderLeft",
          "borderRight",
          "borderTop",
          "borderBottom",
          "paddingLeft",
          "paddingRight",
          "paddingTop",
          "paddingBottom",
          "contentAlignment",
        ]
      : [
          "backgroundColor",
          "borderLeft",
          "borderRight",
          "borderTop",
          "borderBottom",
          "paddingLeft",
          "paddingRight",
          "paddingTop",
          "paddingBottom",
          "contentAlignment",
        ],
    "ELT hire table cell formatting fields changed."
  )
  if (
    !style ||
    style.contentAlignment !== ELT_DOC_HIRE_TABLE_CONTENT_ALIGNMENT ||
    !dimensionEquals(style.paddingLeft, ELT_DOC_HIRE_TABLE_PADDING_PT) ||
    !dimensionEquals(style.paddingRight, ELT_DOC_HIRE_TABLE_PADDING_PT) ||
    !dimensionEquals(style.paddingTop, ELT_DOC_HIRE_TABLE_PADDING_PT) ||
    !dimensionEquals(style.paddingBottom, ELT_DOC_HIRE_TABLE_PADDING_PT)
  ) {
    throw new Error("ELT hire table cell spacing does not match the observed template.")
  }
  for (const dimension of [
    style.paddingLeft,
    style.paddingRight,
    style.paddingTop,
    style.paddingBottom,
  ]) {
    assertDimensionKeys(dimension, "ELT hire table cell padding changed.")
  }
  const solidBorder = (border: GoogleDocsTableCellBorder | undefined, width: number) =>
    dimensionEquals(border?.width, width) && border?.dashStyle === "SOLID"
  if (rowIndex === 0) {
    // Docs couples a shared cell edge. Applying the first body-row top border
    // can normalize the header bottom from the imported 0.5pt representation
    // to the body's 0.416667pt representation while preserving the same edge.
    if (
      !solidBorder(style.borderLeft, ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT) ||
      !solidBorder(style.borderRight, ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT) ||
      !solidBorder(style.borderTop, ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT) ||
      (!solidBorder(style.borderBottom, ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT) &&
        !solidBorder(style.borderBottom, ELT_DOC_HIRE_TABLE_BODY_BORDER_PT))
    ) {
      throw new Error("ELT hire table borders do not match the observed template.")
    }
  } else {
    for (const border of [style.borderLeft, style.borderRight, style.borderTop, style.borderBottom]) {
      if (!solidBorder(border, ELT_DOC_HIRE_TABLE_BODY_BORDER_PT)) {
        throw new Error("ELT hire table borders do not match the observed template.")
      }
    }
  }
  if (rowIndex === 0) {
    for (const border of [style.borderLeft, style.borderRight, style.borderTop, style.borderBottom]) {
      assertBorderKeys(border, true)
      if (!rgbEquals(border?.color, { red: 0.8, green: 0.8, blue: 0.8 })) {
        throw new Error("ELT hire table header borders do not match the observed template.")
      }
    }
    return
  }
  assertBorderKeys(style.borderLeft, false)
  assertBorderKeys(style.borderRight, false)
  assertBorderKeys(style.borderTop, true)
  assertBorderKeys(style.borderBottom, true)
  if (
    !rgbEquals(style.borderTop?.color, { red: 0.8, green: 0.8, blue: 0.8 }) ||
    !rgbEquals(style.borderBottom?.color, { red: 0.8, green: 0.8, blue: 0.8 })
  ) {
    throw new Error("ELT hire table body borders do not match the observed template.")
  }
  if (!expectedBodyBackground || !rgbEquals(style.backgroundColor, expectedBodyBackground)) {
    throw new Error("ELT hire table row striping does not match the observed template.")
  }
  assertColorKeys(style.backgroundColor, "ELT hire table row background changed.")
}

function assertBorderKeys(
  border: GoogleDocsTableCellBorder | undefined,
  colorRequired: boolean
): void {
  assertExactKeys(
    border,
    colorRequired ? ["color", "width", "dashStyle"] : ["width", "dashStyle"],
    "ELT hire table border formatting changed."
  )
  assertDimensionKeys(border?.width, "ELT hire table border width changed.")
  if (colorRequired) {
    assertColorKeys(border?.color, "ELT hire table border color changed.")
  }
}

function assertColorKeys(
  value: GoogleDocsOptionalColor | undefined,
  message: string
): void {
  assertExactKeys(value, ["color"], message)
  assertExactKeys(value?.color, ["rgbColor"], message)
  assertExactKeys(value?.color?.rgbColor, ["red", "green", "blue"], message)
}

function assertDimensionKeys(
  value: GoogleDocsDimension | undefined,
  message: string
): void {
  assertExactKeys(value, ["magnitude", "unit"], message)
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  message: string
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message)
  }
  const actual = Object.keys(value as Record<string, unknown>).sort()
  const expected = [...expectedKeys].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(message)
  }
}

function assertAllowedKeys(
  value: unknown,
  allowedKeys: readonly string[],
  message: string
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message)
  }
  const allowed = new Set(allowedKeys)
  if (Object.keys(value as Record<string, unknown>).some((key) => !allowed.has(key))) {
    throw new Error(message)
  }
}

function dimensionEquals(value: GoogleDocsDimension | undefined, magnitude: number): boolean {
  return value?.unit === "PT" && Math.abs((value.magnitude ?? Number.NaN) - magnitude) < 0.00001
}

function rgbEquals(
  value: GoogleDocsOptionalColor | undefined,
  expected: { red: number; green: number; blue: number }
): boolean {
  const rgb = value?.color?.rgbColor
  return Boolean(
    rgb &&
      Math.abs((rgb.red ?? Number.NaN) - expected.red) < 0.00001 &&
      Math.abs((rgb.green ?? Number.NaN) - expected.green) < 0.00001 &&
      Math.abs((rgb.blue ?? Number.NaN) - expected.blue) < 0.00001
  )
}

/**
 * HMACs the exact tab topology and every tab's content outside the planned
 * weekly block. Docs character indexes are intentionally removed first:
 * inserting a new top block shifts the preserved archive without changing it,
 * and that harmless shift must not defeat the preservation proof.
 */
export function fingerprintEltDocOutsideContent(input: {
  document: GoogleDocsDocumentSnapshot
  tabId: string
  startIndex: number
  endIndex: number
  dataProvenance: PiiFingerprintProvenance
}): string {
  if (!eltDocTabTopologyIsExact(input.document)) {
    throw new Error("Approved ELT document tab topology is not exact.")
  }
  const tabs = structuredClone(input.document.tabs ?? [])
  const matchingTabs = allEltDocTabs(tabs).filter(
    (tab) => tab.tabProperties?.tabId === input.tabId
  )
  if (matchingTabs.length !== 1) {
    throw new Error("Approved ELT document tab topology is not exact.")
  }
  const tab = matchingTabs[0]
  const split = splitContentAtTarget(
    tab.documentTab?.body?.content ?? [],
    input.startIndex,
    input.endIndex
  )
  if (!split.ok) throw new Error(split.reason)
  if (!tab.documentTab?.body) {
    throw new Error("Approved ELT document tab body is missing.")
  }
  tab.documentTab.body.content = split.outside
  return createPiiFingerprint(stripDocumentIndexes(tabs), {
    context: "recops:p1:elt-doc:outside-content",
    dataProvenance: input.dataProvenance,
  })
}

export function fingerprintEltDocContentRange(input: {
  document: GoogleDocsDocumentSnapshot
  tabId: string
  startIndex: number
  endIndex: number
  dataProvenance: PiiFingerprintProvenance
}): string {
  const tab = findEltDocTab(input.document, input.tabId)
  if (!tab) throw new Error("Approved ELT document tab is missing.")
  const split = splitContentAtTarget(
    tab.documentTab?.body?.content ?? [],
    input.startIndex,
    input.endIndex
  )
  if (!split.ok) throw new Error(split.reason)
  return createPiiFingerprint(stripDocumentIndexes(split.target), {
    context: "recops:p1:elt-doc:current-facts",
    dataProvenance: input.dataProvenance,
  })
}

export function fingerprintEltDocDocumentContent(
  document: GoogleDocsDocumentSnapshot,
  tabId: string,
  dataProvenance: PiiFingerprintProvenance
): string {
  if (!eltDocTabTopologyIsExact(document)) {
    throw new Error("Approved ELT document tab topology is not exact.")
  }
  if (
    allEltDocTabs(document.tabs ?? []).filter(
      (tab) => tab.tabProperties?.tabId === tabId
    ).length !== 1
  ) {
    throw new Error("Approved ELT document tab topology is not exact.")
  }
  return createPiiFingerprint(
    stripDocumentIndexes(document.tabs ?? []),
    { context: "recops:p1:elt-doc:full-content", dataProvenance }
  )
}

function allEltDocTabs(tabs: readonly GoogleDocsTabSnapshot[]): GoogleDocsTabSnapshot[] {
  return tabs.flatMap((tab) => [tab, ...allEltDocTabs(tab.childTabs ?? [])])
}

function weekAnchors(
  content: readonly GoogleDocsStructuralElement[],
  referenceGeneratedAt?: string
): WeekAnchor[] {
  const anchors: WeekAnchor[] = []
  for (const element of content) {
    const startIndex = element.startIndex
    if (!Number.isInteger(startIndex)) continue
    const text = textOfElement(element).trim()
    const parsed = parsedWeekAnchor(text, referenceGeneratedAt)
    if (parsed) anchors.push({ ...parsed, startIndex: startIndex! })
  }
  return anchors.sort((a, b) => a.startIndex - b.startIndex)
}

/**
 * Date headings define weekly block boundaries when present. A legacy Hires
 * heading is an internal narrative anchor when the nearest preceding date
 * heading represents the same week; otherwise it remains the boundary for an
 * older text-only archive shape.
 */
function archiveWeekBoundaries(anchors: readonly WeekAnchor[]): WeekAnchor[] {
  const dateHeadings = anchors.filter((anchor) => anchor.kind === "week_heading")
  const boundaries = [...dateHeadings]
  for (const anchor of anchors) {
    if (anchor.kind !== "legacy_hires") continue
    const nearestPrecedingDate = dateHeadings
      .filter((dateHeading) => dateHeading.startIndex < anchor.startIndex)
      .at(-1)
    if (nearestPrecedingDate?.weekStartMs === anchor.weekStartMs) continue
    boundaries.push(anchor)
  }
  return boundaries.sort((a, b) => a.startIndex - b.startIndex)
}

function parsedWeekAnchor(
  text: string,
  referenceGeneratedAt?: string
): Pick<WeekAnchor, "kind" | "weekLabel" | "weekStartMs"> | null {
  if (WEEK_LABEL_PATTERN.test(text)) {
    const parsed = weekStartMs(text)
    return parsed === null
      ? null
      : { kind: "week_heading", weekLabel: text, weekStartMs: parsed }
  }
  const legacy = LEGACY_HIRES_WEEK_PATTERN.exec(text)
  if (!legacy) return null
  const parsed = legacyWeekStartMs(legacy[1], referenceGeneratedAt)
  return parsed === null
    ? null
    : { kind: "legacy_hires", weekLabel: legacy[1], weekStartMs: parsed }
}

function legacyWeekStartMs(range: string, referenceGeneratedAt?: string): number | null {
  const match = /^([A-Za-z]+)\s+0?(\d{1,2})(?:,\s*(\d{4}))?\s+-/.exec(range.trim())
  if (!match) return null
  const month = MONTH_INDEX.get(match[1].toLocaleLowerCase("en-US"))
  const day = Number(match[2])
  const reference = new Date(referenceGeneratedAt ?? "")
  if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31 || Number.isNaN(reference.getTime())) {
    return null
  }
  const explicitYear = match[3] ? Number(match[3]) : null
  const year = explicitYear ?? reference.getUTCFullYear() - (month > reference.getUTCMonth() ? 1 : 0)
  const timestamp = Date.UTC(year, month, day)
  const date = new Date(timestamp)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCDay() !== 5
  ) {
    return null
  }
  return timestamp
}

function weekStartMs(weekLabel: string): number | null {
  if (!WEEK_LABEL_PATTERN.test(weekLabel)) return null
  const firstDate = weekLabel.split(" - ")[0]
  const parsed = Date.parse(`${firstDate} 00:00:00 UTC`)
  return Number.isNaN(parsed) ? null : parsed
}

function splitContentAtTarget(
  content: readonly GoogleDocsStructuralElement[],
  startIndex: number,
  endIndex: number
):
  | { ok: true; target: GoogleDocsStructuralElement[]; outside: GoogleDocsStructuralElement[] }
  | { ok: false; reason: string } {
  const target: GoogleDocsStructuralElement[] = []
  const outside: GoogleDocsStructuralElement[] = []
  for (const element of content) {
    const start = element.startIndex ?? 0
    const end = element.endIndex ?? start
    const overlaps = end > startIndex && start < endIndex
    if (!overlaps) {
      outside.push(element)
      continue
    }
    if (start < startIndex || end > endIndex) {
      return { ok: false, reason: "Target boundary splits a document structural element." }
    }
    target.push(element)
  }
  return { ok: true, target, outside }
}

function stripDocumentIndexes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDocumentIndexes)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "startIndex" && key !== "endIndex")
      .map(([key, child]) => [key, stripDocumentIndexes(child)])
  )
}

function textOfContent(content: readonly GoogleDocsStructuralElement[]): string {
  return content.map(textOfElement).join("")
}

function textOfElement(element: GoogleDocsStructuralElement): string {
  let text = ""
  for (const inline of element.paragraph?.elements ?? []) {
    text +=
      inline.textRun?.content ??
      inline.dateElement?.dateElementProperties?.displayText ??
      ""
  }
  for (const row of element.table?.tableRows ?? []) {
    for (const cell of row.tableCells ?? []) text += textOfContent(cell.content ?? [])
  }
  text += textOfContent(element.tableOfContents?.content ?? [])
  return text
}

