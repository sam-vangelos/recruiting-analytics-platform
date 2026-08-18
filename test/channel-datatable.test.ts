// Pure-logic tests for the U0 DataTable primitive's extracted helpers
// (app/_components/channel/DataTable.tsx). No react-testing-library / jsdom — the
// repo forbids new deps for this wave, and typecheck is OFF (next.config
// typescript.ignoreBuildErrors:true, frozen-spec:93), so these unit tests are the
// only guard on the sort-state, row-rule, and pagination logic. Full render is
// verified later in the pixel audit.

import { describe, expect, test } from "vitest"
import { nextSortState, rowRuleShadow, paginationWindow } from "../app/_components/channel/DataTable"

describe("nextSortState", () => {
  test("clicking a fresh column selects it descending (worst/biggest first)", () => {
    expect(nextSortState("submissions", undefined)).toEqual({
      sortBy: "submissions",
      sortDir: "desc",
    })
  })

  test("clicking a column different from the active one selects it descending", () => {
    expect(nextSortState("median_action_hours", { sortBy: "submissions", sortDir: "asc" })).toEqual({
      sortBy: "median_action_hours",
      sortDir: "desc",
    })
  })

  test("clicking the active column toggles desc -> asc", () => {
    expect(nextSortState("submissions", { sortBy: "submissions", sortDir: "desc" })).toEqual({
      sortBy: "submissions",
      sortDir: "asc",
    })
  })

  test("clicking the active column toggles asc -> desc", () => {
    expect(nextSortState("submissions", { sortBy: "submissions", sortDir: "asc" })).toEqual({
      sortBy: "submissions",
      sortDir: "desc",
    })
  })

  test("active column with no prior dir starts descending then toggles on the next click", () => {
    const first = nextSortState("over_7d_count", { sortBy: "over_7d_count" })
    expect(first).toEqual({ sortBy: "over_7d_count", sortDir: "desc" })
    expect(nextSortState("over_7d_count", first)).toEqual({ sortBy: "over_7d_count", sortDir: "asc" })
  })
})

describe("rowRuleShadow — left RULE only, never a fill", () => {
  test("no selection, no accent => no shadow at all", () => {
    expect(rowRuleShadow(false, null)).toBeUndefined()
    expect(rowRuleShadow(false, undefined)).toBeUndefined()
  })

  test("selection is the NEUTRAL ink rule, never a risk color", () => {
    const shadow = rowRuleShadow(true, null)
    expect(shadow).toBe("inset 3px 0 0 var(--ink)")
    // canon: selection emphasis is ink, not danger/warning/success/info
    expect(shadow).not.toMatch(/danger|warning|success|info/)
  })

  test("each accent renders its own tone rule as a left inset (not a fill)", () => {
    expect(rowRuleShadow(false, "danger")).toBe("inset 3px 0 0 var(--danger-rule)")
    expect(rowRuleShadow(false, "warning")).toBe("inset 3px 0 0 var(--warning-rule)")
    expect(rowRuleShadow(false, "success")).toBe("inset 3px 0 0 var(--success-rule)")
    expect(rowRuleShadow(false, "info")).toBe("inset 3px 0 0 var(--info)")
  })

  test("every accent shadow is an inset left rule (no 0px x-offset fill)", () => {
    for (const accent of ["danger", "warning", "success", "info"] as const) {
      const shadow = rowRuleShadow(false, accent)!
      expect(shadow.startsWith("inset ")).toBe(true)
      // a left rule has a positive x-offset; a fill would be a spread/blur
      expect(shadow).toMatch(/^inset \d+px 0 0 /)
    }
  })

  test("selection + accent compose: ink rule stays at 3px, accent steps behind to 6px", () => {
    const shadow = rowRuleShadow(true, "danger")
    expect(shadow).toBe("inset 3px 0 0 var(--ink), inset 6px 0 0 var(--danger-rule)")
    // both signals survive — neither clobbers the other
    expect(shadow).toContain("var(--ink)")
    expect(shadow).toContain("var(--danger-rule)")
  })
})

describe("paginationWindow", () => {
  test("first page of a full set", () => {
    expect(paginationWindow(1, 50, 230)).toEqual({ start: 1, end: 50, canBack: false, canForward: true })
  })

  test("middle page", () => {
    expect(paginationWindow(3, 50, 230)).toEqual({ start: 101, end: 150, canBack: true, canForward: true })
  })

  test("last (partial) page clamps end to total and disables forward", () => {
    expect(paginationWindow(5, 50, 230)).toEqual({ start: 201, end: 230, canBack: true, canForward: false })
  })

  test("single full page disables both edges", () => {
    expect(paginationWindow(1, 50, 50)).toEqual({ start: 1, end: 50, canBack: false, canForward: false })
  })

  test("empty result reports a zero window with both edges disabled", () => {
    expect(paginationWindow(1, 50, 0)).toEqual({ start: 0, end: 0, canBack: false, canForward: false })
  })
})
