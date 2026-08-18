import type { ExecEltFacts } from "../modules/exec-state-of-play"

export type EltDocParagraphKind =
  | "week_heading"
  | "section_heading"
  | "lead"
  | "body"
  | "note"

export interface EltDocParagraph {
  kind: EltDocParagraphKind
  text: string
  namedStyleType: "HEADING_1" | "HEADING_2" | "NORMAL_TEXT"
  bold: boolean
  tone: "ink" | "muted"
}

export interface RenderedEltDocBlock {
  paragraphs: readonly EltDocParagraph[]
  /** Text payload only. A later approved writer may translate paragraph styles to Docs requests. */
  text: string
}

const WORDS: Readonly<Record<number, string>> = {
  0: "no",
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
}

function paragraph(
  kind: EltDocParagraphKind,
  text: string,
  options: Pick<EltDocParagraph, "namedStyleType" | "bold" | "tone">
): EltDocParagraph {
  return { kind, text, ...options }
}

function splitLabelCounts(rows: readonly { label: string; count: number }[]): string {
  return `(${rows.map((row) => `${row.label} ${row.count}`).join(", ")})`
}

function splitStageCounts(
  rows: readonly { label: string; conducted: number; passed: number }[],
  key: "conducted" | "passed"
): string {
  return `(${rows.map((row) => `${row.label} ${row[key]}`).join(", ")})`
}

function hireLine(hire: ExecEltFacts["hires"][number]): string {
  const parts = [hire.role]
  if (hire.location) parts.push(hire.location)
  parts.push(hire.candidate)
  if (hire.department && hire.priority) parts.push(`${hire.department} (${hire.priority})`)
  else if (hire.department) parts.push(hire.department)
  else if (hire.priority) parts.push(`(${hire.priority})`)
  parts.push(`Start date ${hire.startsOn || "TBD"}`)
  return `${parts.join(" - ")}.`
}

function namesSuffix(names: readonly string[]): string {
  return names.length > 0 ? ` - ${names.join(", ")}` : ""
}

function stageLine(
  stage: ExecEltFacts["sections"][number]["stages"][number],
  index: number
): string {
  const prefix = index === 0 ? "" : `${index}. `
  // Post-A6, `conducted` is an entry-windowed count and `passed` is exit-windowed;
  // a stage can legitimately show 0 conducted / 1+ passed. Always render the
  // passed clause — clamping or hiding it on `conducted === 0` would hide a real
  // pass and must never happen (never fabricate, never suppress a true count).
  return `${prefix}${stage.label} Conducted - ${stage.conducted} ${splitStageCounts(stage.subs, "conducted")}: ${stage.passed} passed`
}

function renderHiresParagraphs(facts: ExecEltFacts): EltDocParagraph[] {
  const paragraphs: EltDocParagraph[] = []
  paragraphs.push(
    paragraph("section_heading", `Hires: (Offer Accepted b/w ${facts.weekShort})`, {
      namedStyleType: "HEADING_2",
      bold: true,
      tone: "ink",
    })
  )

  const hireCount = facts.hires.length
  paragraphs.push(
    paragraph(
      "lead",
      `We had ${WORDS[hireCount] ?? String(hireCount)} offer${hireCount === 1 ? "" : "s"} accepted this week.`,
      { namedStyleType: "NORMAL_TEXT", bold: true, tone: "ink" }
    )
  )
  for (const hire of facts.hires) {
    paragraphs.push(
      paragraph("body", hireLine(hire), {
        namedStyleType: "NORMAL_TEXT",
        bold: false,
        tone: "ink",
      })
    )
  }
  if (facts.hires.length === 0) {
    paragraphs.push(
      paragraph("note", "No offers accepted this week.", {
        namedStyleType: "NORMAL_TEXT",
        bold: false,
        tone: "muted",
      })
    )
  }
  paragraphs.push(
    paragraph("note", facts.hiresNote, {
      namedStyleType: "NORMAL_TEXT",
      bold: false,
      tone: "muted",
    })
  )
  return paragraphs
}

function renderRoleProgressParagraphs(facts: ExecEltFacts): EltDocParagraph[] {
  const paragraphs: EltDocParagraph[] = []
  for (const section of facts.sections) {
    paragraphs.push(
      paragraph("section_heading", `${section.title} Role Progress b/w ${facts.weekShort}`, {
        namedStyleType: "HEADING_2",
        bold: true,
        tone: "ink",
      })
    )
    paragraphs.push(
      paragraph(
        "body",
        `QTD Offer Accepted - ${section.qtdOffers.total} ${splitLabelCounts(section.qtdOffers.subs)}${namesSuffix(section.qtdOffers.names)}`,
        { namedStyleType: "NORMAL_TEXT", bold: false, tone: "ink" }
      )
    )
    section.stages.forEach((stage, index) => {
      paragraphs.push(
        paragraph("body", stageLine(stage, index), {
          namedStyleType: "NORMAL_TEXT",
          bold: false,
          tone: "ink",
        })
      )
    })
    paragraphs.push(
      paragraph(
        "body",
        `5. Offer Accepted - ${section.weekOffers.total} ${splitLabelCounts(section.weekOffers.subs)}${namesSuffix(section.weekOffers.names)}`,
        { namedStyleType: "NORMAL_TEXT", bold: false, tone: "ink" }
      )
    )
  }
  return paragraphs
}

/**
 * Deterministic text/paragraph equivalent of scripts/build-elt-update.py.
 * Business facts stay in E01; this module only renders the existing contract.
 */
export function renderEltDocBlock(
  facts: ExecEltFacts,
  options: { includeWeekHeading?: boolean } = {}
): RenderedEltDocBlock {
  const paragraphs: EltDocParagraph[] = []
  if (options.includeWeekHeading !== false) {
    paragraphs.push(
      paragraph("week_heading", facts.weekLabel, {
        namedStyleType: "HEADING_1",
        bold: true,
        tone: "ink",
      })
    )
  }
  paragraphs.push(...renderHiresParagraphs(facts))
  paragraphs.push(...renderRoleProgressParagraphs(facts))

  return { paragraphs, text: `${paragraphs.map((row) => row.text).join("\n")}\n` }
}

/**
 * The Role Progress portion only (per-section QTD offer line, numbered stage
 * lines, offer-accepted line) — no week heading, no Hires block. This is the
 * narrative tail the ELT Doc automation compiles into Docs requests after the
 * hires table; the exact same formatting `renderEltDocBlock` uses for the
 * legacy full-block text render, reused rather than duplicated.
 */
export function renderEltDocRoleProgressParagraphs(
  facts: ExecEltFacts
): readonly EltDocParagraph[] {
  return renderRoleProgressParagraphs(facts)
}
