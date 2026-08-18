import { beforeEach, describe, expect, test, vi } from "vitest"

interface SupabaseResult<T = unknown> {
  data: T | null
  error: { code?: string; message?: string } | null
  count?: number | null
}

const sb = vi.hoisted(() => {
  let results: Array<SupabaseResult & { table: string }> = []

  function next(table: string): SupabaseResult {
    const result = results.shift()
    if (!result) throw new Error(`missing Supabase mock result for ${table}`)
    if (result.table !== table) {
      throw new Error(`expected Supabase mock table ${result.table}, received ${table}`)
    }
    return result
  }

  function from(table: string) {
    const chain: Record<string, unknown> = {
      select() {
        return chain
      },
      eq() {
        return chain
      },
      is() {
        return chain
      },
      order() {
        return chain
      },
      limit() {
        return chain
      },
      single() {
        return Promise.resolve(next(table))
      },
      then<TResult1 = SupabaseResult, TResult2 = never>(
        onfulfilled?: ((value: SupabaseResult) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve(next(table)).then(onfulfilled, onrejected)
      },
    }
    return chain
  }

  return {
    client: { from },
    setResults(nextResults: Array<SupabaseResult & { table: string }>) {
      results = [...nextResults]
    },
  }
})

vi.mock("../lib/supabase", () => ({
  supabase: sb.client,
  getSupabase: () => sb.client,
}))

import {
  fetchSweepDashboardData,
  getAgencyDashboardData,
  getReferralDashboardData,
} from "../lib/sweep-dashboard"

function result<T>(
  table: string,
  data: T | null,
  error: SupabaseResult["error"] = null,
  count?: number | null
): SupabaseResult<T> & { table: string } {
  return { table, data, error, count }
}

describe("legacy sweep dashboard Supabase errors", () => {
  beforeEach(() => {
    sb.setResults([])
  })

  test("keeps no completed referral sweep as an expected empty state", async () => {
    sb.setResults([
      result("sweep_runs", null, { code: "PGRST116", message: "No rows" }),
      result("alert_ledger", []),
      result("alert_ledger", null, null, 0),
    ])

    const data = await getReferralDashboardData()

    expect(data.latest_run).toBeNull()
    expect(data.active_referrals).toEqual([])
    expect(data.unresolved_count).toBe(0)
  })

  test("surfaces referral dashboard read errors instead of rendering a false empty state", async () => {
    sb.setResults([
      result("sweep_runs", null, { code: "401", message: "Invalid API key" }),
    ])

    await expect(getReferralDashboardData()).rejects.toThrow(
      "sweep_runs referral latest run query failed: Invalid API key"
    )
  })

  test("does not catch combined dashboard loader errors into null sections", async () => {
    sb.setResults([
      result("sweep_runs", null, { code: "42501", message: "permission denied" }),
      result("sweep_runs", null, { code: "PGRST116", message: "No rows" }),
      result("alert_ledger", null, null, 0),
    ])

    await expect(fetchSweepDashboardData()).rejects.toThrow(
      "sweep_runs referral latest run query failed: permission denied"
    )
  })

  test("strips candidate email from legacy agency active conflicts", async () => {
    sb.setResults([
      result("sweep_runs", {
        id: "run-1",
        sweep_type: "agency",
        started_at: "2026-06-22T00:00:00.000Z",
        completed_at: "2026-06-22T00:01:00.000Z",
        status: "completed",
        applications_scanned: 1,
        items_found: 1,
        items_alerted: 1,
      }),
      result("sweep_items", [
        {
          application_id: 100,
          candidate_id: 200,
          candidate_name: "Private Candidate",
          job_id: 300,
          job_title: "Engineer",
          source_name: "Acme Agency",
          conflict_detail: {
            candidate_email: "candidate@example.com",
            prior_applications: [],
            conflict_type: "prior_history",
            risk_level: "medium",
          },
        },
      ]),
      result("alert_ledger", null, null, 0),
    ])

    const data = await getAgencyDashboardData()

    expect(data.active_conflicts[0].candidate_email).toBeNull()
    expect(JSON.stringify(data)).not.toContain("candidate@example.com")
  })

  test("keeps unresolved legacy agency conflict source null instead of Unknown", async () => {
    sb.setResults([
      result("sweep_runs", {
        id: "run-1",
        sweep_type: "agency",
        started_at: "2026-06-22T00:00:00.000Z",
        completed_at: "2026-06-22T00:01:00.000Z",
        status: "completed",
        applications_scanned: 1,
        items_found: 1,
        items_alerted: 1,
      }),
      result("sweep_items", [
        {
          application_id: 100,
          candidate_id: 200,
          candidate_name: "Private Candidate",
          job_id: 300,
          job_title: "Engineer",
          source_name: null,
          conflict_detail: {
            prior_applications: [],
            conflict_type: "prior_history",
            risk_level: "medium",
          },
        },
      ]),
      result("alert_ledger", null, null, 0),
    ])

    const data = await getAgencyDashboardData()

    expect(data.active_conflicts[0].agency_source_name).toBeNull()
    expect(JSON.stringify(data)).not.toContain("Unknown")
  })
})
