import { describe, expect, test } from "vitest"

import {
  CORE_STAGE_ORDER,
  stageTaxonomyConfigV1,
} from "../lib/recruiting-ops/dimensions/config/stage-taxonomy.v1"
import { legacyArtifactRegistry } from "../lib/recruiting-ops/legacy-artifact-registry"
import { concreteOutputContracts } from "../lib/recruiting-ops/output-contracts"
import {
  queryRegistry,
  scriptAssetRegistry,
  sourceRegistry,
  workflowRegistry,
} from "../lib/recruiting-ops/registries"
import { operationalWords } from "../lib/recruiting-ops/dimensions/operational-vocabulary"
import {
  assertPublicSafe,
  inspectPublicValue,
  redactForPublicValue,
} from "../lib/recruiting-ops/safe-public-output"

function canonicalStrings(): string[] {
  return [
    ...workflowRegistry.map((row) => row.title),
    ...sourceRegistry.map((row) => row.title),
    ...queryRegistry.map((row) => row.title),
    ...scriptAssetRegistry.map((row) => row.title),
    ...legacyArtifactRegistry.map((row) => row.title),
    ...concreteOutputContracts.flatMap((contract) => contract.columns.map((column) => column.label)),
    ...stageTaxonomyConfigV1.flatMap((entry) => [entry.substage, entry.coreStage]),
    ...CORE_STAGE_ORDER.map((entry) => entry.coreStage),
  ].filter((value) => typeof value === "string" && value.trim().length > 0)
}

describe("recruiting ops public output safety", () => {
  test("allows aggregate command-center summaries", () => {
    expect(() =>
      assertPublicSafe({
        workflowId: "T01",
        rowCount: 25,
        discrepancyCount: 2,
      })
    ).not.toThrow()
  })

  test("detects direct contact fields and values", () => {
    const result = inspectPublicValue({
      candidate_email: "person@example.com",
    })

    expect(result.ok).toBe(false)
    expect(result.violations.map((violation) => violation.reason)).toContain("direct contact field")
    expect(() => assertPublicSafe({ owner: "person@example.com" })).toThrow("not public-safe")
    expect(inspectPublicValue({ ownerLabel: "Avery Collins" }).violations.map((violation) => violation.reason)).toContain(
      "person-identifying field"
    )
    expect(inspectPublicValue({ recruiter_name: "Avery Collins" }).violations.map((violation) => violation.reason)).toContain(
      "person-identifying field"
    )
    expect(inspectPublicValue({ displayName: "Avery Collins" }).violations.map((violation) => violation.reason)).toContain(
      "person-identifying field"
    )
    expect(inspectPublicValue({ owner: "Avery Collins" }).violations.map((violation) => violation.reason)).toContain(
      "person-identifying field"
    )
    expect(inspectPublicValue({ summary: "Fixture owner Avery Collins" }).violations.map((violation) => violation.reason)).toContain(
      "person-identifying value"
    )
  })

  test("redacts unsafe values before action proposal summaries are exposed", () => {
    expect(
      redactForPublicValue({
        token: "abc",
        ownerLabel: "Avery Collins",
        nested: {
          owner: "person@example.com",
        },
      })
    ).toEqual({
      redacted_field_1: "[REDACTED]",
      redacted_field_2: "[REDACTED]",
      nested: {
        redacted_field_1: "[REDACTED]",
      },
    })
    expect(redactForPublicValue({ summary: "Fixture owner Avery Collins" })).toEqual({
      summary: "Fixture owner [REDACTED]",
    })
  })

  test("drift-lock: every canonical operational string passes strict inspection", () => {
    // Vocabulary contract (dimensions/operational-vocabulary.ts): registry titles,
    // taxonomy strings, and output-contract column labels are canonical operational
    // language. If a newly added canonical string fails here, extend the vocabulary (or
    // the phrase allowlist) in a reviewed change — never weaken the detector.
    const failures = canonicalStrings()
      .map((value) => ({ value, result: inspectPublicValue({ label: value }) }))
      .filter(({ result }) => !result.ok)

    expect(failures.map(({ value }) => value)).toEqual([])
  })

  test("drift-lock: word-level vocabulary actually covers canonical strings", () => {
    // The exact-phrase allowlist is assembled from the same registries as the strings
    // above, so the inspection round-trip alone cannot catch a missing WORD (the phrase
    // membership short-circuits first). Lock word coverage directly: every capitalized
    // token of every canonical string must be an operational word — or be declared here
    // as a known person-name word that only exact canonical phrases may carry.
    const canonicalPersonWords = new Set([
      // Taxonomy interviewer rounds and named report/tracker owners.
      "arjun", "idris", "elias", "vikram", "jordan",
    ])

    const uncovered = new Set<string>()
    for (const value of canonicalStrings()) {
      for (const match of value.matchAll(/\p{Lu}[\p{L}'’-]*/gu)) {
        for (const part of match[0].replace(/\.+$/, "").split("-")) {
          const word = part.toLowerCase()
          // Single letters ("Q01" → "q") are bare initials to the detector — never
          // operational by definition, so the word list cannot and need not cover them.
          if (word.length <= 1) continue
          if (!operationalWords.has(word) && !canonicalPersonWords.has(word)) uncovered.add(word)
        }
      }
    }

    expect([...uncovered].sort()).toEqual([])
  })

  test("person-name shapes still flag when embedded near canonical vocabulary", () => {
    // Negative controls for the vocabulary: canonical phrases are allowed as exact
    // labels, but bare person names near vocabulary words must keep flagging.
    expect(inspectPublicValue({ note: "Ravi Pillai" }).ok).toBe(false)
    expect(inspectPublicValue({ note: "Escalated to Avery Collins for review" }).ok).toBe(false)
    expect(inspectPublicValue({ note: "Weekly Progress Sheet for Frontier Data Lead" }).ok).toBe(true)
    expect(inspectPublicValue({ note: "Application Review" }).ok).toBe(true)
  })
})
