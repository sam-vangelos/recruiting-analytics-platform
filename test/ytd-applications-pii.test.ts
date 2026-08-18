import { beforeEach, describe, expect, test, vi } from "vitest"

interface RecordedFilter {
  op: "eq" | "contains"
  col: string
  val: unknown
}

interface RecordedScan {
  table: string
  selectArgs: unknown[]
  filters: RecordedFilter[]
  orderArgs: unknown[]
  ranges: Array<{ from: number; to: number }>
}

const sb = vi.hoisted(() => {
  let rows: readonly Record<string, unknown>[] = []
  let exactCount = 0
  const scans: RecordedScan[] = []

  function from(table: string) {
    const scan: RecordedScan = {
      table,
      selectArgs: [],
      filters: [],
      orderArgs: [],
      ranges: [],
    }

    function chain() {
      const next = {
        eq(col: string, val: unknown) {
          scan.filters.push({ op: "eq", col, val })
          return next
        },
        contains(col: string, val: unknown) {
          scan.filters.push({ op: "contains", col, val })
          return next
        },
        order(...args: unknown[]) {
          scan.orderArgs = args
          return next
        },
        range(fromIndex: number, toIndex: number) {
          scan.ranges.push({ from: fromIndex, to: toIndex })
          return Promise.resolve({
            data: rows.slice(fromIndex, toIndex + 1),
            error: null,
            count: exactCount,
          })
        },
      }
      return next
    }

    return {
      select(...args: unknown[]) {
        scan.selectArgs = args
        scans.push(scan)
        return chain()
      },
    }
  }

  return {
    client: { from },
    scans,
    setRows(nextRows: readonly Record<string, unknown>[], count = nextRows.length) {
      rows = nextRows
      exactCount = count
    },
    reset() {
      rows = []
      exactCount = 0
      scans.length = 0
    },
  }
})

vi.mock("../lib/supabase", () => ({
  supabase: sb.client,
  getSupabase: () => sb.client,
}))

import { getYtdApplications } from "../lib/ytd-dashboard"

beforeEach(() => {
  sb.reset()
})

describe("getYtdApplications PII projection", () => {
  test("strips raw candidate email from generic YTD application pages", async () => {
    sb.setRows(
      [
        {
          application_id: 123,
          scan_year: 2026,
          channel: "agency",
          candidate_id: 456,
          candidate_name: "Candidate One",
          candidate_email: "private@example.com",
          job_id: 789,
          recruiter_ids: [700],
        },
      ],
      1
    )

    const page = await getYtdApplications({
      year: 2026,
      channel: "agency",
      recruiter_id: 700,
      page: 1,
      page_size: 10,
    })

    expect(page).toMatchObject({
      page: 1,
      page_size: 10,
      total: 1,
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      application_id: 123,
      candidate_id: 456,
      candidate_name: "Candidate One",
    })
    expect(page.items[0]).not.toHaveProperty("candidate_email")
    expect(JSON.stringify(page)).not.toContain("private@example.com")

    expect(sb.scans).toHaveLength(1)
    expect(sb.scans[0].selectArgs).toEqual(["*", { count: "exact" }])
    expect(sb.scans[0].filters).toEqual([
      { op: "eq", col: "scan_year", val: 2026 },
      { op: "eq", col: "channel", val: "agency" },
      { op: "contains", col: "recruiter_ids", val: [700] },
    ])
    expect(sb.scans[0].orderArgs).toEqual([
      "applied_at",
      { ascending: false, nullsFirst: false },
    ])
    expect(sb.scans[0].ranges).toEqual([{ from: 0, to: 9 }])
  })
})
