// Anti-regression for the by_agency re-keying fix (lib/sweep-dashboard.ts aggregateAgenciesBySource).
//
// The old aggregation keyed the Map on agency_source_name. With 005 the name is NULL for an
// unresolved source, so every unresolved row collapsed under one phantom null key AND two distinct
// agencies that happen to share a name would merge. The fix keys on source_id for resolved rows and
// buckets all unresolved sources into one explicit defect group.

import { describe, expect, test } from "vitest"
import { aggregateAgenciesBySource } from "../lib/sweep-dashboard"

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agency_source_id: 100,
    agency_source_name: "Acme Talent",
    source_resolution_status: "resolved",
    conflict_detected: false,
    conflict_type: null,
    ...over,
  }
}

describe("aggregateAgenciesBySource", () => {
  test("resolved rows group by source_id and show the gated name", () => {
    const out = aggregateAgenciesBySource([row(), row({ conflict_detected: true })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source_id: 100,
      agency_name: "Acme Talent",
      resolved: true,
      submissions: 2,
      conflicts: 1,
    })
  })

  test("two different source_ids that share a NAME stay separate (name is not the key)", () => {
    const out = aggregateAgenciesBySource([
      row({ agency_source_id: 1, agency_source_name: "Acme" }),
      row({ agency_source_id: 2, agency_source_name: "Acme" }),
    ])
    expect(out).toHaveLength(2)
  })

  test("every unresolved-source row collapses into ONE defect bucket, not a null-name phantom", () => {
    const out = aggregateAgenciesBySource([
      row({ agency_source_id: null, agency_source_name: null, source_resolution_status: "unresolved" }),
      row({ agency_source_id: null, agency_source_name: null, source_resolution_status: "ambiguous" }),
      row({ agency_source_id: null, agency_source_name: null, source_resolution_status: null }),
    ])
    const defect = out.filter((a) => !a.resolved)
    expect(defect).toHaveLength(1)
    expect(defect[0].submissions).toBe(3)
    expect(defect[0].source_id).toBeNull()
    expect(defect[0].agency_name).toBe("Unresolved source")
  })

  test("a row resolved-by-status but missing source_id is treated as unresolved (no null key)", () => {
    const out = aggregateAgenciesBySource([
      row({ agency_source_id: null, source_resolution_status: "resolved" }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].resolved).toBe(false)
  })

  test("dual_agency flag rides on the bucket; sort is conflicts desc", () => {
    const out = aggregateAgenciesBySource([
      row({ agency_source_id: 1, conflict_detected: false }),
      row({ agency_source_id: 2, conflict_detected: true, conflict_type: "dual_agency" }),
    ])
    expect(out[0].source_id).toBe(2) // most conflicts first
    expect(out[0].has_dual_agency).toBe(true)
  })
})
