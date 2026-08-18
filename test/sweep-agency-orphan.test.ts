// Anti-regression for the skip-orphan fix (lib/sweep-agency.ts conflictsToPersist).
//
// The agency sweep pushes a detected conflict into conflicts[] BEFORE deciding whether the
// agency_submissions row can be persisted. When a sourceless agency app is SKIPPED pre-005 (to
// avoid the banned 0/"Unknown Agency" sentinel), its conflict must NOT still land in sweep_items +
// alert_ledger — both are written from conflicts[] unconditionally, so a skipped conflict would
// orphan: a live tracker/alert row with no agency_submissions backing, invisible to the next
// sweep's dup-check. conflictsToPersist drops the skipped apps' conflicts before persistence.

import { describe, expect, test } from "vitest"
import { conflictsToPersist } from "../lib/sweep-agency"

const c = (agency_application_id: number) => ({
  agency_application_id,
  conflict_type: "dual_agency" as const,
})

describe("conflictsToPersist — skip-orphan guard", () => {
  test("drops conflicts whose application was skipped at the submissions write", () => {
    const out = conflictsToPersist([c(1), c(2), c(3)], new Set([2]))
    expect(out.map((x) => x.agency_application_id)).toEqual([1, 3])
  })

  test("keeps everything when nothing was skipped", () => {
    expect(conflictsToPersist([c(10), c(11)], new Set())).toHaveLength(2)
  })

  test("a skipped app removes ALL of its conflicts (no orphan into sweep_items/alert_ledger)", () => {
    const out = conflictsToPersist([c(5), c(5), c(6)], new Set([5]))
    expect(out.every((x) => x.agency_application_id !== 5)).toBe(true)
    expect(out).toHaveLength(1)
  })

  test("does not mutate the input array", () => {
    const conflicts = [c(1), c(2)]
    conflictsToPersist(conflicts, new Set([1]))
    expect(conflicts).toHaveLength(2)
  })
})
