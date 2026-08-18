import { describe, expect, test } from "vitest"

import {
  EXEC_SNAPSHOT_TABLE,
  execSnapshotPersistenceRow,
  loadLatestExecSnapshot,
  writeExecSnapshot,
  type ExecSnapshotDatabaseClient,
} from "../lib/recruiting-ops/exec-snapshot-store"
import type { ExecStateBundle } from "../lib/recruiting-ops/modules/exec-state-of-play"

const BUNDLE: ExecStateBundle = {
  rows: [
    {
      req_id: 101,
      job_id: "1",
      role: "Senior Engineer",
      department: "Engineering",
      confidential: false,
      req_class: "role",
      owner: "Kavya Menon",
      owner_kind: "recruiter",
      owner_on_roster: true,
      seats: 2,
      opened_on: "2026-05-27",
      days_open: 40,
      funnel: [{ stage: "Onsite Interview", count: 1, oldest_days: 2, median_days: 2 }],
      engaged_depth: 1,
      application_pile: 0,
      unclassified_count: 0,
      furthest_stage: "Onsite Interview",
      finalists: [
        { name: "Ada Lovelace", url: "https://app.greenhouse.io/people/9001", stage: "Onsite Interview", in_stage_days: 2 },
      ],
      conducted_last7: 1,
      conducted_prior7: 1,
      pending_writeups: 1,
      advanced_last7: 1,
      advanced_prior7: 0,
      added_last7: 0,
      conducted_last30: 2,
      advanced_last30: 1,
      added_last30: 0,
      last_advance_at: "2026-07-04T12:00:00.000Z",
      last_hire_accepted_on: "2026-06-06",
      movement_14d: [{ stage: "Recruiter Phone Screen", conducted: 1, advanced_in: 0 }],
      tier: "in_play",
      tier_rule: "moving_30d",
      tier_reason: "2 interviews and 1 advance in the last 30 days",
      attention: [],
      momentum: "moving",
      health: "amber",
      health_rule: "thin_vs_seats",
      health_reason: "1 candidate beyond screen for 2 open seats",
      offers_accepted_12wk: 1,
      week_stage_activity: [{ stage: "Recruiter Phone Screen", conducted: 1, passed: 0 }],
    },
  ],
  hires: [
    {
      candidate: "Grace Hopper",
      url: "https://app.greenhouse.io/people/900",
      role: "Closed Architect",
      req_id: 900,
      department: "Architecture",
      priority: "P0",
      location: null,
      accepted_on: "2026-07-01",
      starts_on: "2026-08-01",
      week_friday: "2026-06-26",
    },
  ],
  eltFacts: {
    generatedAt: "2026-07-06T12:00:00.000Z",
    weekLabel: "Jun 26, 2026 - Jul 2, 2026",
    weekShort: "Jun 26 - Jul 2",
    hires: [],
    hiresNote: "",
    sections: [],
  },
  rollup: {
    as_of: "2026-07-06T12:00:00.000Z",
    reporting_week_friday: "2026-07-03",
    open_roles: 1,
    pools_campaigns_templates: 0,
    red: 0,
    amber: 1,
    green: 0,
    seats: 2,
    unowned_roles: 0,
    offers_accepted_12wk: 1,
    momentum: { moving: 1 },
    tiers: { in_play: 1, gone_quiet: 0, filled_not_closed: 0, no_search: 0 },
    attention_count: 0,
    positions_in_play: 2,
    offers_out: { count: 0, waiting_14d_plus: 0 },
    off_scope_scorecards: 0,
    conducted_unattributed_stage: 0,
    truncation_suspected_pulls: 0,
  },
}

function memoryClient(): ExecSnapshotDatabaseClient & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    rows,
    async upsert(table, row, onConflict) {
      expect(table).toBe(EXEC_SNAPSHOT_TABLE)
      expect(onConflict).toBe("run_id")
      rows.set(String(row.run_id), row)
    },
    async selectLatest() {
      const all = [...rows.values()]
      if (all.length === 0) return null
      return all.sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)))[0]
    },
  }
}

describe("exec snapshot store", () => {
  test("persistence row carries the full bundle keyed by run", () => {
    const row = execSnapshotPersistenceRow({
      runId: "e01_20260706120000000",
      mode: "local",
      generatedAt: "2026-07-06T12:00:05.000Z",
      bundle: BUNDLE,
      eltFacts: { weekShort: "Jul 3 - Jul 9" },
    })
    expect(row).toMatchObject({
      run_id: "e01_20260706120000000",
      workflow_id: "E01",
      mode: "local",
      generated_at: "2026-07-06T12:00:05.000Z",
    })
    expect((row.req_rows as unknown[]).length).toBe(1)
    expect((row.hires as unknown[]).length).toBe(1)
    expect((row.elt_facts as { weekShort: string }).weekShort).toBe("Jul 3 - Jul 9")
  })

  test("write then read round-trips; latest wins by generated_at", async () => {
    const client = memoryClient()
    await writeExecSnapshot(
      { runId: "run_old", mode: "local", generatedAt: "2026-07-05T12:00:00.000Z", bundle: BUNDLE },
      client
    )
    await writeExecSnapshot(
      { runId: "run_new", mode: "local", generatedAt: "2026-07-06T12:00:00.000Z", bundle: BUNDLE },
      client
    )
    const latest = await loadLatestExecSnapshot(client)
    expect(latest.status).toBe("available")
    if (latest.status === "available") {
      expect(latest.snapshot.run_id).toBe("run_new")
      expect(latest.snapshot.req_rows[0].finalists[0].name).toBe("Ada Lovelace")
      expect(latest.snapshot.org_rollup.open_roles).toBe(1)
    }
  })

  test("re-running the same run id upserts, never duplicates", async () => {
    const client = memoryClient()
    const input = { runId: "run_x", mode: "local" as const, generatedAt: "2026-07-06T12:00:00.000Z", bundle: BUNDLE }
    await writeExecSnapshot(input, client)
    await writeExecSnapshot(input, client)
    expect(client.rows.size).toBe(1)
  })

  test("empty store reads as an honest unavailable, not a throw", async () => {
    const latest = await loadLatestExecSnapshot(memoryClient())
    expect(latest).toMatchObject({ status: "unavailable" })
    if (latest.status === "unavailable") expect(latest.reason).toContain("no snapshot rows")
  })

  test("a failing client reads as unavailable with the error surfaced", async () => {
    const latest = await loadLatestExecSnapshot({
      async upsert() {},
      async selectLatest() {
        throw new Error("connection refused")
      },
    })
    expect(latest).toMatchObject({ status: "unavailable", reason: "connection refused" })
  })
})
