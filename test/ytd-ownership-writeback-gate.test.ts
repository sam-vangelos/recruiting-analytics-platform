// Anti-regression for the 005 writeback gate (lib/ytd-extract.ts projectFactsForWriteback).
//
// The bug class this guards: the YTD fact upsert ships YtdApplicationFactWithOwnership objects that
// carry three 005-only columns (ownership_confidence / ownership_resolution_status /
// source_resolution_status, migration 005:113-118). Against a PRE-005 database PostgREST rejects the
// unknown columns and ZERO facts persist — the existing /ytd/agency surface silently goes stale. The
// fix is a dormant-by-default gate: with YTD_OWNERSHIP_WRITEBACK off (the default), the projection
// strips exactly those three columns so the upsert only references base 003/004 columns; with it on
// (post-005) they pass through. We unit-test the PURE projection so the gate is provable without a DB.

import { describe, expect, test } from "vitest"
import { projectFactsForWriteback } from "../lib/ytd-extract"
import type { YtdApplicationFactWithOwnership } from "../lib/ytd-normalize"

const OWNERSHIP_KEYS = [
  "ownership_confidence",
  "ownership_resolution_status",
  "source_resolution_status",
] as const

// Minimal fixture: a couple of base columns plus the three 005-only writeback columns. The
// projection only reads/strips by key, so a representative object is enough; cast through unknown
// because we deliberately omit the rest of the (large) fact shape.
function factWithOwnership(
  overrides: Partial<Record<string, unknown>> = {}
): YtdApplicationFactWithOwnership {
  return {
    application_id: 1,
    channel: "agency",
    candidate_name: "Candidate",
    candidate_email: "candidate@example.com",
    primary_recruiter_id: 42,
    ownership_confidence: "high",
    ownership_resolution_status: "resolved",
    source_resolution_status: "resolved",
    ...overrides,
  } as unknown as YtdApplicationFactWithOwnership
}

describe("005 writeback gate — projectFactsForWriteback", () => {
  test("OFF (pre-005 default) strips exactly the three 005-only columns", () => {
    const rows = projectFactsForWriteback([factWithOwnership()], false)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    for (const key of OWNERSHIP_KEYS) expect(row).not.toHaveProperty(key)
    // base columns must survive the strip
    expect(row).toHaveProperty("application_id", 1)
    expect(row).toHaveProperty("candidate_name", "Candidate")
    expect(row).toHaveProperty("channel", "agency")
  })

  test("ON (post-005) passes the ownership columns through unchanged", () => {
    const row = projectFactsForWriteback([factWithOwnership()], true)[0]
    expect(row).toMatchObject({
      ownership_confidence: "high",
      ownership_resolution_status: "resolved",
      source_resolution_status: "resolved",
    })
  })

  test("OFF strips ONLY those three keys — every other key is preserved", () => {
    const fact = factWithOwnership({ job_id: 20, never_actioned: true })
    const before = Object.keys(fact as unknown as Record<string, unknown>)
    const after = Object.keys(projectFactsForWriteback([fact], false)[0])
    const expected = before
      .filter((k) => !OWNERSHIP_KEYS.includes(k as (typeof OWNERSHIP_KEYS)[number]))
      .sort()
    expect(after.sort()).toEqual(expected)
    // and it really did remove three keys, not zero
    expect(before.length - after.length).toBe(3)
  })

  test("does not mutate the input fact (returns a copy)", () => {
    const fact = factWithOwnership()
    projectFactsForWriteback([fact], false)
    expect(fact).toHaveProperty("ownership_confidence", "high")
  })
})
