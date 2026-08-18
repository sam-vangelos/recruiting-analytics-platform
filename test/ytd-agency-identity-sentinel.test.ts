import { readFileSync } from "node:fs"

import { beforeEach, describe, expect, test, vi } from "vitest"
import type { YtdApplicationFact } from "../lib/ytd-types"

interface SupabaseResult<T = unknown> {
  data: T
  error: unknown
}

interface RecordedFilter {
  op: "eq" | "contains"
  col: string
  val: unknown
}

const sb = vi.hoisted(() => {
  let rows: readonly unknown[] = []
  const scans: Array<{ table: string; filters: RecordedFilter[] }> = []

  const ok = (data: unknown): SupabaseResult => ({ data, error: null })

  function from(table: string) {
    const scan = { table, filters: [] as RecordedFilter[] }

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
        range(fromIndex: number, toIndex: number) {
          return Promise.resolve(ok(rows.slice(fromIndex, toIndex + 1)))
        },
      }
      return next
    }

    return {
      select() {
        scans.push(scan)
        return chain()
      },
    }
  }

  return {
    client: { from },
    scans,
    setRows(nextRows: readonly unknown[]) {
      rows = nextRows
    },
    reset() {
      rows = []
      scans.length = 0
    },
  }
})

vi.mock("../lib/supabase", () => ({
  supabase: sb.client,
  getSupabase: () => sb.client,
}))

import {
  getYtdAgencyAgencies,
  getYtdAgencyApplications,
} from "../lib/ytd-dashboard"

function fact(overrides: Partial<YtdApplicationFact> = {}): YtdApplicationFact {
  return {
    application_id: 1,
    scan_year: 2026,
    channel: "agency",
    candidate_id: 10,
    candidate_name: "Candidate",
    candidate_email: "candidate@example.com",
    job_id: 20,
    job_title: "Staff Engineer",
    source_id: 100,
    source_name: "Agency",
    department_id: 30,
    department_name: "Engineering",
    application_status: "active",
    applied_at: "2026-05-10T00:00:00Z",
    submitted_at: "2026-05-10T00:00:00Z",
    last_activity_at: "2026-05-10T00:00:00Z",
    referrer_id: null,
    referrer_name: null,
    agency_source_id: 900,
    agency_source_name: "Acme Talent",
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

describe("agency YTD unresolved identity handling", () => {
  test("agency groups keep unresolved agency source names null", async () => {
    sb.setRows([
      fact({ application_id: 1, agency_source_id: null, agency_source_name: null }),
      fact({ application_id: 2, agency_source_id: 900, agency_source_name: "Acme Talent" }),
    ])

    const agencies = await getYtdAgencyAgencies({ year: 2026 })

    const unresolved = agencies.find((row) => row.agency_source_id === null)
    expect(unresolved).toMatchObject({
      agency_source_id: null,
      agency_source_name: null,
      submissions: 1,
    })
    expect(agencies.map((row) => row.agency_source_name)).not.toContain("Unknown")
    expect(sb.scans[0].filters).toContainEqual({ op: "eq", col: "channel", val: "agency" })
  })

  test("agency applications strip candidate email and preserve null identity fields", async () => {
    sb.setRows([
      fact({
        agency_source_id: null,
        agency_source_name: null,
        primary_recruiter_id: null,
        primary_recruiter_name: null,
        recruiter_ids: [],
        recruiter_names: [],
      }),
    ])

    const page = await getYtdAgencyApplications({ year: 2026, page: 1, page_size: 10 })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]).not.toHaveProperty("candidate_email")
    expect(page.items[0]).toMatchObject({
      agency_source_name: null,
      primary_recruiter_name: null,
    })
    expect(JSON.stringify(page.items)).not.toContain("Unknown")
  })

  test("client uses explicit unresolved labels instead of identity Unknown fallbacks", () => {
    const source = readFileSync("app/(workbench)/agency/ytd/client.tsx", "utf8")

    expect(source).toContain("Unresolved owner")
    expect(source).toContain("Unresolved agency")
    expect(source).not.toMatch(/row\.(?:recruiter_name|primary_recruiter_name|agency_source_name)\s*\?\?\s*["']Unknown["']/)
  })
})
