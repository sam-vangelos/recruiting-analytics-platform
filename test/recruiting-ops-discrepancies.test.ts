import { describe, expect, test } from "vitest"

import {
  assertAllDifferencesClassified,
  buildDiscrepancy,
  summarizeDiscrepancies,
  validateDiscrepancy,
  type Discrepancy,
} from "../lib/recruiting-ops/discrepancies"

const baseDiscrepancy = {
  runId: "t07_20260624010101000",
  workflowId: "T07",
  capabilityId: "offer_and_hire_lifecycle_intelligence",
  class: "source_gap",
  severity: "blocking",
  entityKey: "application:123",
  field: "offer_status",
  modernValueSummary: "missing status source",
  legacyValueSummary: "legacy artifact has populated status",
  evidenceRefs: ["legacy_q12_final_offer"],
  resolutionStatus: "open",
  owner: "Jordan",
} as const

describe("recruiting ops discrepancy substrate", () => {
  test("builds deterministic discrepancy rows and summaries", () => {
    const discrepancy = buildDiscrepancy(baseDiscrepancy)

    expect(discrepancy.id).toMatch(/^disc_/)
    expect(validateDiscrepancy(discrepancy).ok).toBe(true)
    expect(summarizeDiscrepancies([discrepancy])).toMatchObject({
      total: 1,
      blocking: 1,
      byClass: {
        source_gap: 1,
      },
    })
  })

  test("rejects unknown classes and unclassified differences", () => {
    expect(() =>
      validateDiscrepancy({
        ...buildDiscrepancy(baseDiscrepancy),
        class: "needs_vibes",
      } as unknown as Discrepancy)
    ).toThrow("Unknown discrepancy class")

    expect(() => assertAllDifferencesClassified([{ id: "diff_1", class: null }])).toThrow(
      "Unclassified difference"
    )
  })

  test("redacts public-unsafe values at discrepancy composition", () => {
    // Redact-at-build (P1/render-seam family): unsafe values never enter the record
    // graph; fidelity for adjudication lives behind evidenceRefs.
    const contact = buildDiscrepancy({
      ...baseDiscrepancy,
      modernValueSummary: "person@example.com",
    })
    expect(contact.modernValueSummary).toBe("[REDACTED]")

    const name = buildDiscrepancy({
      ...baseDiscrepancy,
      legacyValueSummary: "assigned to Avery Collins",
    })
    expect(name.legacyValueSummary).not.toContain("Avery Collins")
    expect(name.legacyValueSummary).toContain("[REDACTED]")
  })

  test("validateDiscrepancy still rejects hand-built records with raw unsafe summaries", () => {
    expect(() =>
      validateDiscrepancy({
        ...baseDiscrepancy,
        id: "disc_manual_unsafe",
        modernValueSummary: "person@example.com",
      })
    ).toThrow("not public-safe")
  })
})
