// W4-1 — YTD referral read-side (lib/ytd-referral-dashboard.ts) unit tests.
//
// WHAT THIS TESTS, AND WHY IT IS SHAPED THIS WAY
// ----------------------------------------------
// The unit under test is the stage-1 referral loader set in lib/ytd-referral-dashboard.ts:
// getYtdReferralSummary / getYtdReferralReferrers / getYtdReferralRecruiters /
// getYtdReferralApplications / getYtdReferralFilterOptions. Every loader is pure derivation
// over ONE I/O primitive — fetchReferralFacts (ytd-referral-dashboard.ts:216-239), which
// pages ytd_application_facts scoped to scan_year + channel='referral' via a .range() loop
// until a short page. So the only seam these tests need is a fake Supabase whose select
// chain (.eq()/.contains()/.range()) returns scripted rows.
//
// MOCKING STYLE (mirrors test/notification-delivery.test.ts + test/ytd-conflicts.test.ts):
//   * a MOCKED Supabase client via vi.mock("../lib/supabase") with a hand-built PostgREST
//     builder, installed through vi.hoisted so the factory can reference it despite vi.mock
//     hoisting. The module imports `supabase` by RELATIVE path
//     (ytd-referral-dashboard.ts:1), and this repo ships no vitest config / path-alias
//     plumbing, so the relative-path mock is the seam that actually intercepts (same alias
//     gap notification-delivery.test.ts documents).
//   * typed row builders (ytd-conflicts.test.ts style): one fact() factory, override per case.
//
// The chain the loader issues, and how the fake answers it:
//   from("ytd_application_facts").select("*").eq("scan_year",y).eq("channel","referral")
//     [.eq(...)|.contains(...)]*.range(from,to)  ->  awaitable { data, error }
//   Every .eq()/.contains() records its filter and returns the SAME chainable; .range(from,to)
//   is the terminal — it resolves from a row-source the test installs, sliced by [from..to].
//   Because .range() slices a backing array, a backing array LONGER than PAGE_SIZE (1000)
//   forces the loader's pagination loop to iterate, which is exactly the >1000-row assertion.
//
// The behaviors pinned (the W4-1 acceptance set):
//   1. summary aggregates ONLY channel='referral' rows (the channel eq is issued; the
//      submissions count == the referral row count); by_referrer + never_actioned populate.
//   2. referrers loader (by_referrer fan-out) + never_actioned surface through getYtd*.
//   3. pagination loops PAST 1000 rows — a >1000-row scan fetches ALL rows (every .range()
//      page is requested until a short page), asserted via the total + the recorded ranges.
//   4. filter-options derive from the YEAR-SCOPED set, NOT the filtered set — passing extra
//      filters does not narrow the option universe (the loader re-fetches on year alone,
//      ytd-referral-dashboard.ts:379).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { YtdApplicationFact } from "../lib/ytd-types"

// ---------------------------------------------------------------------------
// Hoisted Supabase mock. vi.mock is hoisted above imports; vi.hoisted lifts the controller
// alongside it. The fake is shaped to exactly the chain the referral loader issues.
//
// `rowSource` is the backing data the next .range() loop reads from. A test sets it (or sets
// a function of the recorded eq-filters, so a year-only refetch can return a different set
// than a filtered one — the contract filter-options leans on). Each .range(from,to) returns
// rowSource.slice(from, to+1); the loader stops once a page comes back shorter than
// PAGE_SIZE (1000), so a rowSource longer than 1000 forces multiple pages.
// ---------------------------------------------------------------------------

interface SupabaseResult<T = unknown> {
  data: T
  error: unknown
}

interface RecordedFilter {
  op: "eq" | "contains"
  col: string
  val: unknown
}

interface RecordedScan {
  table: string
  filters: RecordedFilter[]
  ranges: Array<{ from: number; to: number }>
}

const sb = vi.hoisted(() => {
  // The row source for the CURRENT scan campaign. A function lets a test branch on the
  // accumulated filters of the scan being answered (used by the filter-options test to make
  // the year-only refetch return the full set while the filtered scan would have returned a
  // subset).
  type RowSource = (filters: RecordedFilter[]) => readonly unknown[]
  let rowSource: RowSource = () => []
  // Every scan the loader runs is recorded so a test can assert the channel eq, the issued
  // filters, and the .range() pages requested (the pagination proof).
  const scans: RecordedScan[] = []
  let scanError: unknown = null

  const ok = (data: unknown): SupabaseResult => ({ data, error: scanError })

  function from(table: string) {
    // One scan campaign = one select() -> [.eq()|.contains()]* -> .range()-loop. Filters and
    // ranges accumulate on this record; .range() resolves the slice for its window.
    const scan: RecordedScan = { table, filters: [], ranges: [] }

    function makeChain(): PromiseLike<SupabaseResult> & {
      eq: (col: string, val: unknown) => ReturnType<typeof makeChain>
      contains: (col: string, val: unknown) => ReturnType<typeof makeChain>
      range: (from: number, to: number) => PromiseLike<SupabaseResult>
    } {
      const chain = {
        eq(col: string, val: unknown) {
          scan.filters.push({ op: "eq", col, val })
          return chain
        },
        contains(col: string, val: unknown) {
          scan.filters.push({ op: "contains", col, val })
          return chain
        },
        range(rangeFrom: number, rangeTo: number) {
          scan.ranges.push({ from: rangeFrom, to: rangeTo })
          const rows = rowSource(scan.filters)
          const page = rows.slice(rangeFrom, rangeTo + 1)
          return Promise.resolve(ok(scanError ? null : page))
        },
        // The loader never awaits the chain before .range(); these satisfy the thenable
        // shape only so an accidental await would still resolve to an empty page.
        then<TResult1 = SupabaseResult, TResult2 = never>(
          onfulfilled?:
            | ((value: SupabaseResult) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ): PromiseLike<TResult1 | TResult2> {
          return Promise.resolve(ok(scanError ? null : [])).then(onfulfilled, onrejected)
        },
      }
      return chain
    }

    return {
      select(_cols: string) {
        scans.push(scan)
        return makeChain()
      },
    }
  }

  const client = { from }

  return {
    client,
    scans,
    // Every .range() window issued, in order, flattened across scans. fetchReferralFacts
    // re-issues from().select() per loop iteration (one scan record per page), so the
    // pagination windows live across scan records, not within one — this is the seam the
    // pagination tests assert on.
    allRanges(): Array<{ from: number; to: number }> {
      return scans.flatMap((s) => s.ranges)
    },
    setRows(rows: readonly unknown[] | RowSource) {
      rowSource = typeof rows === "function" ? rows : () => rows
    },
    setError(err: unknown) {
      scanError = err
    },
    reset() {
      scans.length = 0
      rowSource = () => []
      scanError = null
    },
  }
})

vi.mock("../lib/supabase", () => ({
  supabase: sb.client,
  getSupabase: () => sb.client,
}))

// Import AFTER the mock is registered (vi.mock is hoisted, so this static import sees the fake).
import {
  getYtdReferralSummary,
  getYtdReferralReferrers,
  getYtdReferralRecruiters,
  getYtdReferralApplications,
  getYtdReferralFilterOptions,
} from "../lib/ytd-referral-dashboard"

// ---------------------------------------------------------------------------
// Row builder. A complete YtdApplicationFact (every loader reads select("*") rows), defaulted
// to a referral fact and overridden per case. Mirrors ytd-conflicts.test.ts's fact().
// ---------------------------------------------------------------------------

function fact(overrides: Partial<YtdApplicationFact> = {}): YtdApplicationFact {
  return {
    application_id: 1,
    scan_year: 2026,
    channel: "referral",
    candidate_id: 10,
    candidate_name: "Candidate",
    candidate_email: "candidate@example.com",
    job_id: 20,
    job_title: "Staff Engineer",
    source_id: 100,
    source_name: "Referral",
    department_id: 30,
    department_name: "Engineering",
    application_status: "active",
    applied_at: "2026-05-10T00:00:00Z",
    submitted_at: "2026-05-10T00:00:00Z",
    last_activity_at: "2026-05-10T00:00:00Z",
    referrer_id: 500,
    referrer_name: "Pat Referrer",
    agency_source_id: null,
    agency_source_name: null,
    primary_recruiter_id: 700,
    primary_recruiter_name: "Riley Recruiter",
    recruiter_ids: [700],
    recruiter_names: ["Riley Recruiter"],
    current_stage_id: 1,
    current_stage_name: "Application Review",
    current_stage_entered_at: "2026-05-10T00:00:00Z",
    application_review_entered_at: "2026-05-10T00:00:00Z",
    application_review_exited_at: null,
    actioned_at: null,
    first_action_at: null,
    action_time_hours: null,
    first_action_time_hours: null,
    never_actioned: true,
    action_time_quality: "unknown",
    action_bucket: "unactioned_lt_7d",
    max_stage_id: 1,
    max_stage_name: "Application Review",
    max_stage_rank: 1,
    terminal_outcome: "active",
    conflict_detected: false,
    conflict_types: [],
    dual_agency_group_key: null,
    prior_internal_application_ids: [],
    duplicate_confidence: "none",
    duplicate_evidence_types: [],
    duplicate_candidate_ids: [],
    fee_risk_state: "not_duplicate",
    fee_risk_reason: null,
    conflict_detail: null,
    data_quality_flags: [],
    last_synced_at: "2026-05-27T00:00:00Z",
    sync_run_id: null,
    ...overrides,
  }
}

beforeEach(() => {
  sb.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ===========================================================================
// (1) summary aggregates channel='referral' rows; by_referrer + never_actioned populate.
// ===========================================================================

describe("getYtdReferralSummary — aggregates the referral scan", () => {
  // The scan is the referral fact set; submissions == row count, by_referrer fans out by
  // referrer_name, never_actioned counts rows with never_actioned=true. We also pin that the
  // scan was channel-scoped (the eq the loader issues, ytd-referral-dashboard.ts:224), which
  // is what makes "referral rows" honest rather than the whole table.
  test("submissions, by_referrer and never_actioned reflect the referral row set", async () => {
    sb.setRows([
      fact({ application_id: 1, referrer_name: "Pat Referrer", never_actioned: true }),
      fact({
        application_id: 2,
        referrer_name: "Pat Referrer",
        never_actioned: false,
        first_action_at: "2026-05-12T00:00:00Z",
        first_action_time_hours: 40,
        action_bucket: "d2_7",
      }),
      fact({
        application_id: 3,
        referrer_id: 501,
        referrer_name: "the operator Sourcer",
        never_actioned: true,
      }),
    ])

    const summary = await getYtdReferralSummary({ year: 2026 })

    expect(summary.submissions).toBe(3)
    expect(summary.never_actioned).toBe(2) // two never-actioned rows
    expect(summary.actioned).toBe(1) // the one with first_action_at

    // by_referrer fans out by name, sorted by count desc: Pat (2) before the operator (1).
    expect(summary.by_referrer).toEqual([
      { key: "Pat Referrer", count: 2 },
      { key: "the operator Sourcer", count: 1 },
    ])

    // The scan was scoped to channel='referral' (and the year) — not the whole table.
    expect(sb.scans).toHaveLength(1)
    const filters = sb.scans[0].filters
    expect(filters).toContainEqual({ op: "eq", col: "channel", val: "referral" })
    expect(filters).toContainEqual({ op: "eq", col: "scan_year", val: 2026 })
  })

  // never_actioned is a real count, not a passthrough of submissions: an all-actioned scan
  // reports zero. Guards the complement so the populate-assertion above can't pass on a stub.
  test("never_actioned is 0 when every referral row has been actioned", async () => {
    sb.setRows([
      fact({ application_id: 1, never_actioned: false, first_action_at: "2026-05-11T00:00:00Z" }),
      fact({ application_id: 2, never_actioned: false, first_action_at: "2026-05-12T00:00:00Z" }),
    ])

    const summary = await getYtdReferralSummary({ year: 2026 })

    expect(summary.submissions).toBe(2)
    expect(summary.never_actioned).toBe(0)
    expect(summary.actioned).toBe(2)
  })
})

// ===========================================================================
// (2) by_referrer (referrers loader) + never_actioned populate through the table loaders.
// ===========================================================================

describe("getYtdReferralReferrers — groups by referrer and surfaces never_actioned", () => {
  // The referrers table groups on referrer_id (groupRows, ytd-referral-dashboard.ts:301) and
  // each group carries aggregateHandling (submissions + never_actioned + action stats). Two
  // referrers, distinct submission counts, distinct never_actioned counts.
  test("each referrer row carries its submission count and never_actioned tally", async () => {
    sb.setRows([
      fact({ application_id: 1, referrer_id: 500, referrer_name: "Pat Referrer", never_actioned: true }),
      fact({ application_id: 2, referrer_id: 500, referrer_name: "Pat Referrer", never_actioned: true }),
      fact({
        application_id: 3,
        referrer_id: 501,
        referrer_name: "the operator Sourcer",
        never_actioned: false,
        first_action_at: "2026-05-12T00:00:00Z",
        first_action_time_hours: 30,
      }),
    ])

    const referrers = await getYtdReferralReferrers({ year: 2026 }, { sort_by: "submissions", sort_dir: "desc" })

    expect(referrers).toHaveLength(2)
    const pat = referrers.find((r) => r.referrer_id === 500)!
    const sam = referrers.find((r) => r.referrer_id === 501)!

    expect(pat.referrer_name).toBe("Pat Referrer")
    expect(pat.submissions).toBe(2)
    expect(pat.never_actioned).toBe(2)

    expect(sam.referrer_name).toBe("the operator Sourcer")
    expect(sam.submissions).toBe(1)
    expect(sam.never_actioned).toBe(0)
    expect(sam.actioned).toBe(1)
  })

  // CANON: an unresolved referrer never becomes the literal "Unknown". A row with a null
  // referrer_id lands in the 'unknown' grouping bucket, which the loader maps back to
  // referrer_id=null + referrer_name=null (ytd-referral-dashboard.ts:308-309) — the cell
  // renders the defect treatment from that null, never a sentinel string.
  test("a referrer-less row surfaces as referrer_id null + name null (no 'Unknown' sentinel)", async () => {
    sb.setRows([
      fact({ application_id: 1, referrer_id: 500, referrer_name: "Pat Referrer" }),
      fact({ application_id: 2, referrer_id: null, referrer_name: null }),
    ])

    const referrers = await getYtdReferralReferrers({ year: 2026 })

    const missing = referrers.find((r) => r.referrer_id === null)
    expect(missing, "the referrer-less row must surface as a null-id bucket").toBeDefined()
    expect(missing!.referrer_name).toBeNull()
    // No row's name is ever the banned sentinel string.
    for (const r of referrers) {
      expect(r.referrer_name).not.toBe("Unknown")
    }
  })
})

describe("getYtdReferralRecruiters — recruiter membership fan-out", () => {
  // C1: the table groups on recruiter_ids membership (the SAME axis the server filters with
  // .contains). A row owned by two recruiters fans into BOTH groups, so each recruiter's
  // count equals the set returned when its row is clicked. never_actioned rides along per
  // group via aggregateHandling.
  test("a row owned by two recruiters fans into both recruiter groups", async () => {
    sb.setRows([
      fact({
        application_id: 1,
        recruiter_ids: [700, 701],
        recruiter_names: ["Riley Recruiter", "Quinn Recruiter"],
        never_actioned: true,
      }),
      fact({ application_id: 2, recruiter_ids: [700], recruiter_names: ["Riley Recruiter"], never_actioned: false, first_action_at: "2026-05-12T00:00:00Z" }),
    ])

    const recruiters = await getYtdReferralRecruiters({ year: 2026 })

    const riley = recruiters.find((r) => r.recruiter_id === 700)!
    const quinn = recruiters.find((r) => r.recruiter_id === 701)!
    expect(riley.submissions).toBe(2) // both rows
    expect(quinn.submissions).toBe(1) // only the dual-owned row
    expect(riley.never_actioned).toBe(1)
    expect(quinn.never_actioned).toBe(1)
  })

  // CANON: a row whose recruiter_ids is EMPTY belongs to no recruiter (an ownership defect),
  // so it is DROPPED from the recruiter table rather than masquerading as a recruiter named
  // "Unknown" (ytd-referral-dashboard.ts:106-118). The defect surfaces elsewhere (W4b), never
  // as a sentinel here.
  test("a row with no recruiter owners is dropped, not bucketed as an 'Unknown' recruiter", async () => {
    sb.setRows([
      fact({ application_id: 1, recruiter_ids: [700], recruiter_names: ["Riley Recruiter"] }),
      fact({ application_id: 2, recruiter_ids: [], recruiter_names: [] }),
    ])

    const recruiters = await getYtdReferralRecruiters({ year: 2026 })

    expect(recruiters).toHaveLength(1)
    expect(recruiters[0].recruiter_id).toBe(700)
    for (const r of recruiters) {
      expect(r.recruiter_name).not.toBe("Unknown")
    }
  })
})

// ===========================================================================
// (3) pagination loops PAST 1000 rows — a >1000-row scan fetches every page.
// ===========================================================================

describe("fetchReferralFacts pagination (via the loaders) — scans past the 1000-row default", () => {
  // PAGE_SIZE is 1000 (ytd-referral-dashboard.ts:11). A backing set of 2300 rows must be
  // fetched in FULL: the loader requests range(0,999), range(1000,1999), range(2000,2999),
  // and stops on the third (short) page. We assert (a) every row was aggregated — summary
  // submissions == 2300 — and (b) the exact .range() windows the loop issued, which is the
  // pagination proof (a single un-looped fetch would cap at 1000 and request only one range).
  test("a 2300-row referral scan is fetched in full across three .range() pages", async () => {
    const rows = Array.from({ length: 2300 }, (_, i) =>
      fact({
        application_id: i + 1,
        referrer_id: 500 + (i % 2), // two referrers so by_referrer is non-trivial
        referrer_name: i % 2 === 0 ? "Pat Referrer" : "the operator Sourcer",
        never_actioned: i % 3 === 0,
      })
    )
    sb.setRows(rows)

    const summary = await getYtdReferralSummary({ year: 2026 })

    // Every row was aggregated — the scan did not stop at the 1000-row PostgREST default.
    expect(summary.submissions).toBe(2300)
    // by_referrer covers the full set: 1150 each.
    const total = summary.by_referrer.reduce((sum, b) => sum + b.count, 0)
    expect(total).toBe(2300)
    // never_actioned counted across all pages (every 3rd row): ceil(2300/3) = 767.
    expect(summary.never_actioned).toBe(767)

    // The exact pagination windows: three pages, the last one short, then the loop breaks.
    // (fetchReferralFacts re-issues from().select() per iteration, so each page is its own
    // scan record — the windows are read across scans via allRanges().)
    expect(sb.allRanges()).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
      { from: 2000, to: 2999 },
    ])
  })

  // The boundary case that catches an off-by-one in the loop's break condition: EXACTLY 1000
  // rows. A full first page (length === PAGE_SIZE) must trigger a SECOND fetch; the second
  // page is empty (length 0 < PAGE_SIZE) and breaks. A loop that broke on `<= PAGE_SIZE`
  // would stop after one page and silently cap; a loop that broke only on empty would here
  // do exactly two fetches, which we assert.
  test("an exactly-1000-row page triggers a second (empty) fetch before stopping", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => fact({ application_id: i + 1 }))
    sb.setRows(rows)

    const summary = await getYtdReferralSummary({ year: 2026 })

    expect(summary.submissions).toBe(1000)
    expect(sb.allRanges()).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ])
  })

  // The applications loader paginates the SAME scan, then page-slices in memory. A >1000-row
  // scan must report a total spanning all pages even when only one in-memory page is returned
  // — proving the loader fetched everything before slicing.
  test("getYtdReferralApplications totals the full >1000 scan while returning one in-memory page", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) =>
      fact({ application_id: i + 1, submitted_at: `2026-05-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z` })
    )
    sb.setRows(rows)

    const page = await getYtdReferralApplications({ year: 2026, page_size: 50, page: 1 }, undefined)

    expect(page.total).toBe(1500) // the full scan, not the 1000-row cap
    expect(page.items).toHaveLength(50) // one in-memory page
    expect(page.page).toBe(1)
    // Two .range() windows were issued (1500 rows => page 0-999 full, then 1000-1999 short).
    expect(sb.allRanges()).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ])
  })
})

// ===========================================================================
// (4) filter-options derive from the YEAR-SCOPED set, not the filtered set.
// ===========================================================================

describe("getYtdReferralFilterOptions — option universe is year-scoped, not filtered", () => {
  // C5: the option lists must come from the full year-scoped referral set so each control's
  // universe stays stable as siblings change (ytd-referral-dashboard.ts:374-417). We prove
  // this by branching the fake on the scan's filters: when the loader scans with a
  // referrer_id/department_id filter (the "filtered" subset) it would see ONE row, but the
  // year-only refetch (no referrer_id, no department_id) sees the FULL set. We pass a heavily
  // filtered argument and assert the options still cover the whole year — i.e. the loader
  // ignored the extra filters and re-fetched on year alone.
  test("passing extra filters does not narrow the option lists (re-fetch is year-only)", async () => {
    const fullYear = [
      fact({ application_id: 1, department_id: 30, department_name: "Engineering", referrer_id: 500, referrer_name: "Pat Referrer", current_stage_name: "Application Review", action_bucket: "unactioned_lt_7d", terminal_outcome: "active" }),
      fact({ application_id: 2, department_id: 31, department_name: "Design", referrer_id: 501, referrer_name: "the operator Sourcer", current_stage_name: "Phone Screen", action_bucket: "d2_7", terminal_outcome: "rejected" }),
      fact({ application_id: 3, department_id: 32, department_name: "Sales", referrer_id: 502, referrer_name: "Lee Lead", current_stage_name: "Onsite", action_bucket: "gt_7d", terminal_outcome: "hired" }),
    ]
    // Branch: a scan carrying a referrer_id filter is the "filtered subset" and would return
    // just one row; the year-only scan (no referrer_id / department_id) returns everything.
    // The loader is correct iff it issues the year-only scan for options.
    sb.setRows((filters) => {
      const isFiltered = filters.some(
        (f) => f.col === "referrer_id" || f.col === "department_id" || f.col === "current_stage_name"
      )
      return isFiltered ? [fullYear[0]] : fullYear
    })

    const options = await getYtdReferralFilterOptions({
      year: 2026,
      department_id: 30,
      referrer_id: 500,
      current_stage_name: "Application Review",
    })

    // All three referrers / departments / stages / outcomes are present — the option universe
    // was NOT narrowed by the passed-in filters.
    expect(options.referrers.map((r) => r.value).sort()).toEqual(["500", "501", "502"])
    expect(options.departments.map((d) => d.value).sort()).toEqual(["30", "31", "32"])
    expect(options.current_stages.sort()).toEqual(["Application Review", "Onsite", "Phone Screen"])
    expect(options.terminal_outcomes.sort()).toEqual(["active", "hired", "rejected"])

    // And the proof at the seam: the options scan carried NO referrer_id/department_id/stage
    // filter (only the year + channel), even though the caller passed them.
    expect(sb.scans).toHaveLength(1)
    const cols = sb.scans[0].filters.map((f) => f.col)
    expect(cols).toContain("scan_year")
    expect(cols).toContain("channel")
    expect(cols).not.toContain("referrer_id")
    expect(cols).not.toContain("department_id")
    expect(cols).not.toContain("current_stage_name")
  })

  // CANON in the options path: a referrer with no resolvable name is OMITTED (the option()
  // helper skips null/empty keys, ytd-referral-dashboard.ts:386-389) rather than offered as
  // an "Unknown" choice — and the recruiter list omits unresolved-name recruiters entirely
  // (ytd-referral-dashboard.ts:403-406). No option ever carries the sentinel label.
  test("options omit unresolved identities rather than offering an 'Unknown' choice", async () => {
    sb.setRows([
      fact({ application_id: 1, referrer_id: 500, referrer_name: "Pat Referrer", recruiter_ids: [700], recruiter_names: ["Riley Recruiter"] }),
      // referrer-less + a recruiter id with no resolvable name anywhere.
      fact({ application_id: 2, referrer_id: null, referrer_name: null, recruiter_ids: [800], recruiter_names: [] }),
    ])

    const options = await getYtdReferralFilterOptions(2026)

    // Only the resolved referrer is offered; the null-referrer row contributes no option.
    expect(options.referrers).toEqual([{ value: "500", label: "Pat Referrer" }])
    // Only the named recruiter is offered; recruiter 800 (no resolvable name) is omitted.
    expect(options.recruiters).toEqual([{ value: "700", label: "Riley Recruiter" }])
    // Nothing carries the banned sentinel.
    for (const opt of [...options.referrers, ...options.recruiters, ...options.departments]) {
      expect(opt.label).not.toBe("Unknown")
    }
  })
})

// ===========================================================================
// (5) the scan surfaces the channel filter for agency exclusion — a defensive guard that
// the loader is genuinely referral-only (an agency row in the backing set is the table's,
// not ours; the eq is what keeps it out at the DB). Pins the channel='referral' eq once more
// at the loader most likely to be reused for the agency surface by copy-paste.
// ===========================================================================

describe("channel scoping is referral-only across loaders", () => {
  test("every loader issues the channel='referral' eq", async () => {
    sb.setRows([fact({ application_id: 1 })])

    await getYtdReferralSummary({ year: 2026 })
    await getYtdReferralReferrers({ year: 2026 })
    await getYtdReferralRecruiters({ year: 2026 })
    await getYtdReferralApplications({ year: 2026, page: 1 }, undefined)
    await getYtdReferralFilterOptions({ year: 2026 })

    expect(sb.scans.length).toBe(5)
    for (const scan of sb.scans) {
      expect(scan.filters).toContainEqual({ op: "eq", col: "channel", val: "referral" })
    }
  })
})
