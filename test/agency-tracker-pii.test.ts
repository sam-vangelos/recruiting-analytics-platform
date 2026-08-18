// PII anti-regression for getAgencyTrackerData (lib/sweep-dashboard.ts).
//
// getAgencyTrackerData reads agency_submissions via select("*") and returns the rows as
// conflict_alerts. Those rows carry raw candidate_email TWO ways: the top-level column
// (agency_submissions.candidate_email, sweep-agency.ts:656) AND a copy the sweep nests inside
// the conflict_detail jsonb (sweep-agency.ts:588). Both must be stripped before the payload
// leaves the loader for the client (parity with the YTD loaders — ytd-dashboard.ts:472-476,
// ytd-referral-dashboard.ts:368-372), while the rest of conflict_detail
// (prior_applications/prior_submissions) survives because app/agency/client.tsx renders it.
//
// MOCKING STYLE (mirrors test/ytd-referral-dashboard.test.ts): a hand-built PostgREST fake
// installed via vi.mock("../lib/supabase") through vi.hoisted (so the factory can reference it
// despite hoisting). The loader imports `supabase` by RELATIVE path (sweep-dashboard.ts:6) and
// this repo ships no vitest path-alias plumbing, so the relative-path mock is the seam.
//
// The chains getAgencyTrackerData issues (and how the fake answers each):
//   1. from("agency_submissions").select("id",{count}).gte("submitted_at",..)   -> { count }
//   2. from("agency_submissions").select("*").eq("conflict_detected",true).order(..) -> { data }
//   3. from("agency_submissions").select("*")                                   -> { data }
//   4-5. from("sweep_runs")...limit(1).single()  (health probe; benign completed run)
// Every builder is a thenable; awaiting it resolves to the scripted result for that scan. The
// fake keys its answer on the select columns + whether conflict_detected was filtered, which is
// enough to distinguish the conflict scan (2) from the by-agency scan (3).

import { describe, expect, test, vi } from "vitest"

interface SupabaseResult<T = unknown> {
  data: T
  error: unknown
  count?: number | null
}

const sb = vi.hoisted(() => {
  // Rows the conflict scan (select("*") + .eq("conflict_detected", true)) returns. Each is a
  // raw agency_submissions row — top-level candidate_email AND conflict_detail.candidate_email
  // both present, exactly as the sweep persists them.
  let conflictRows: ReadonlyArray<Record<string, unknown>> = []
  // Rows the unfiltered by-agency scan (bare select("*")) returns.
  let agencyRows: ReadonlyArray<Record<string, unknown>> = []
  // Count answer for the head/count scan.
  let ytdCount = 0

  // Since 2026-07 getAgencyTrackerData also probes the agency sweep_runs lane for
  // health (last completed + last attempt). These PII tests don't exercise health,
  // so the fake answers both sweep_runs reads with one benign completed run — no
  // failure, no PII — keeping the assertions about candidate_email, not liveness.
  const completedSweepRun = {
    id: "run-agency-1",
    sweep_type: "agency",
    started_at: "2026-07-20T08:00:00Z",
    completed_at: "2026-07-20T08:00:30Z",
    status: "completed",
    applications_scanned: 1,
    items_found: 0,
    items_alerted: 0,
    error_message: null,
  }

  function sweepRunsChain() {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      single: () => Promise.resolve({ data: completedSweepRun, error: null } as SupabaseResult),
    }
    return chain
  }

  function from(table: string) {
    if (table === "sweep_runs") return sweepRunsChain()
    let columns = "*"
    let countFiltered = false
    let countMode = false

    const chain: Record<string, unknown> = {
      select(cols: string, opts?: { count?: string; head?: boolean }) {
        columns = cols
        // The count scan selects "id" with { count, head }; the real loader chains .gte(...)
        // AFTER .select then awaits, so select must return the chain (not a Promise) and the
        // terminal resolves to the count.
        if (opts?.count) countMode = true
        return chain
      },
      eq(col: string, _val: unknown) {
        if (col === "conflict_detected") countFiltered = true
        return chain
      },
      gte(_col: string, _val: unknown) {
        return chain
      },
      order(_col: string, _opts?: unknown) {
        // The conflict scan terminates on .order(); resolve it to the conflict rows.
        return Promise.resolve({ data: conflictRows, error: null } as SupabaseResult)
      },
      // The by-agency scan awaits the bare select("*") with no terminal; the thenable resolves
      // to agencyRows. The conflict scan never reaches here (it awaits .order()).
      then<TResult1 = SupabaseResult, TResult2 = never>(
        onfulfilled?:
          | ((value: SupabaseResult) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        const result: SupabaseResult = countMode
          ? { data: null, error: null, count: ytdCount }
          : { data: columns === "*" && !countFiltered ? agencyRows : [], error: null }
        return Promise.resolve(result).then(onfulfilled, onrejected)
      },
    }
    return chain
  }

  const client = { from }

  return {
    client,
    setConflictRows(rows: ReadonlyArray<Record<string, unknown>>) {
      conflictRows = rows
    },
    setAgencyRows(rows: ReadonlyArray<Record<string, unknown>>) {
      agencyRows = rows
    },
    setCount(n: number) {
      ytdCount = n
    },
  }
})

vi.mock("../lib/supabase", () => ({
  supabase: sb.client,
  getSupabase: () => sb.client,
}))

// Import AFTER the mock is registered (vi.mock is hoisted, so this static import sees the fake).
import { getAgencyTrackerData } from "../lib/sweep-dashboard"

// A raw agency_submissions row as the sweep persists it: candidate_email on the row AND nested
// inside conflict_detail, plus a prior_applications array that MUST survive the strip.
function submissionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub-1",
    application_id: 5001,
    candidate_id: 9001,
    candidate_email: "leak@candidate.com",
    agency_source_id: 100,
    agency_source_name: "Acme Talent",
    source_resolution_status: "resolved",
    job_id: 20,
    job_title: "Staff Engineer",
    submitted_at: "2026-03-01T00:00:00Z",
    checked_at: "2026-03-01T00:00:00Z",
    conflict_detected: true,
    conflict_type: "prior_history",
    conflict_detail: {
      prior_applications: [{ application_id: 1, status: "active" }],
      candidate_email: "leak@candidate.com",
    },
    ...over,
  }
}

describe("getAgencyTrackerData PII strip", () => {
  test("strips top-level candidate_email from every conflict_alerts row", async () => {
    sb.setCount(10)
    sb.setConflictRows([submissionRow(), submissionRow({ id: "sub-2", application_id: 5002 })])
    sb.setAgencyRows([])

    const out = await getAgencyTrackerData()
    expect(out.conflict_alerts).toHaveLength(2)
    for (const alert of out.conflict_alerts) {
      expect("candidate_email" in (alert as unknown as Record<string, unknown>)).toBe(false)
    }
  })

  test("strips candidate_email nested inside conflict_detail but keeps prior_applications", async () => {
    sb.setCount(10)
    sb.setConflictRows([submissionRow()])
    sb.setAgencyRows([])

    const out = await getAgencyTrackerData()
    const detail = out.conflict_alerts[0].conflict_detail as Record<string, unknown>
    expect("candidate_email" in detail).toBe(false)
    expect(detail.prior_applications).toEqual([{ application_id: 1, status: "active" }])
  })

  test("no candidate_email survives anywhere in the serialized payload", async () => {
    sb.setCount(10)
    sb.setConflictRows([submissionRow(), submissionRow({ id: "sub-2", application_id: 5002 })])
    sb.setAgencyRows([])

    const out = await getAgencyTrackerData()
    expect(JSON.stringify(out)).not.toContain("leak@candidate.com")
    expect(JSON.stringify(out)).not.toContain("candidate_email")
  })

  test("leaves a row without conflict_detail untouched (no crash, still no email)", async () => {
    sb.setCount(10)
    sb.setConflictRows([submissionRow({ conflict_detail: null })])
    sb.setAgencyRows([])

    const out = await getAgencyTrackerData()
    expect(out.conflict_alerts).toHaveLength(1)
    expect("candidate_email" in (out.conflict_alerts[0] as unknown as Record<string, unknown>)).toBe(false)
    expect(out.conflict_alerts[0].conflict_detail).toBeNull()
  })
})
