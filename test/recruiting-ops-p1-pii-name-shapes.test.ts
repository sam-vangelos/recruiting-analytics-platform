import { describe, expect, test } from "vitest"

import { inspectPublicValue, redactForPublicValue } from "../lib/recruiting-ops/safe-public-output"

// REGRESSION LOCK — population P1 (was test/red/p1-pii-name-shapes.red.test.ts).
// (the internal control-plane excavation audit (2026-06-26) §3 P1, SAFETY-GATES-2/-3.)
//
// Detection is value-driven and shared: every string leaf and array element is scanned
// for person-name-shaped capitalized runs (Unicode-aware, apostrophe-aware) in BOTH
// inspectPublicValue and redactForPublicValue. Each shape below previously evaded the
// key-pattern/labeled-name grammar and was certified public-safe while leaking a name.

const NAME = "Avery Collins"

const evadingShapes: Array<{ label: string; value: Record<string, unknown>; leaks: string }> = [
  { label: "snake_case full_name key (not in the camelCase allow-list)", value: { full_name: NAME }, leaks: NAME },
  { label: "name as free text with no adjacent label word", value: { summary: `${NAME} owns 4 open reqs` }, leaks: NAME },
  { label: "non-roster role key (approverName is not allow-listed)", value: { approverName: NAME }, leaks: NAME },
  { label: "name inside an array element", value: { owners: [NAME, "Marcus Webb"] }, leaks: NAME },
  { label: "accented name the [A-Z][a-z]+ grammar cannot match", value: { note: "García Hernández joined the pod" }, leaks: "García Hernández" },
  { label: "apostrophe name the grammar cannot match", value: { note: "O'Brien led the panel" }, leaks: "O'Brien" },
  { label: "initialed name (period splits the naive run)", value: { note: "J. Smith completed the review" }, leaks: "Smith" },
  { label: "lowercase particles inside the name", value: { note: "Lucas van der Berg is on point" }, leaks: "van der Berg" },
  { label: "double space between name tokens", value: { note: "John  Smith reviewed the packet" }, leaks: "Smith" },
  { label: "hyphenated single-token surname", value: { note: "escalate to Smith-Jones directly" }, leaks: "Smith-Jones" },
]

describe("P1: person names as VALUES are detected and redacted, not just labeled keys", () => {
  for (const shape of evadingShapes) {
    test(`inspectPublicValue flags: ${shape.label}`, () => {
      expect(inspectPublicValue(shape.value).ok).toBe(false)
    })

    test(`redactForPublicValue strips the name: ${shape.label}`, () => {
      expect(JSON.stringify(redactForPublicValue(shape.value))).not.toContain(shape.leaks)
    })
  }
})
