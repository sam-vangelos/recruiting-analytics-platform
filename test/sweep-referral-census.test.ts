// Census fetch locks for the referral sweep.
//
// The old fetch asked Greenhouse only for applications CREATED in the last 48h, so a referral
// sitting in Application Review longer than that — launch backlog, un-rejects, stage rollbacks,
// any outage longer than the window — was invisible forever. Worse, slaBreachHours equals
// lookbackHours (both 48), and hours-in-stage ≈ hours-since-creation in Application Review, so an
// application aged out of the fetch at the exact moment it crossed into breach: the breach tier
// was structurally unreachable (zero breach rows across twelve thousand sweep_items).
//
// The census fetch adds "every active referral currently in Application Review on an OPEN job,
// any age" alongside the recent window (which is kept so nothing that worked before stops
// working: fresh referrals on closed/draft jobs still get observed, actioned items still land in
// sweep_items). Closed-job sitting referrals stay excluded — on the day this was measured, all
// but a few dozen of the ~1,700 sitting referrals were on closed reqs, non-actionable noise.
//
// Defect 4 rides along: alert_ledger rows are only written for ALERTABLE items now. Writing
// first_alerted_at for items already actioned at first sight (urgency_tier 'actioned') recorded
// "first alerted" for candidates never alerted, and a pre-cutoff row of that kind would terminally
// suppress a legitimate future alert if the candidate later regressed into Application Review.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const HOUR = 60 * 60 * 1000
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

// ---- Supabase mock: the exact chains runReferralSweep issues ----
const sb = vi.hoisted(() => {
  const state = {
    existingLedger: [] as Array<{ application_id: number }>,
    sweepItemInserts: [] as Array<Record<string, unknown>>,
    ledgerUpserts: [] as Array<Record<string, unknown>>,
  }
  const ok = (data: unknown) => ({ data, error: null })
  function from(table: string) {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      update: () => chain,
      insert: (rows: unknown) => {
        if (table === "sweep_items" && Array.isArray(rows)) {
          state.sweepItemInserts.push(...(rows as Array<Record<string, unknown>>))
        }
        return chain
      },
      upsert: (rows: unknown) => {
        if (table === "alert_ledger" && Array.isArray(rows)) {
          state.ledgerUpserts.push(...(rows as Array<Record<string, unknown>>))
        }
        return chain
      },
      single: () => Promise.resolve(ok({ id: "run-1", started_at: iso(0) })),
      then<R>(onf: (v: { data: unknown; error: unknown }) => R) {
        const data = table === "alert_ledger" ? state.existingLedger : null
        return Promise.resolve(ok(data)).then(onf)
      },
    }
    return chain
  }
  return {
    client: { from },
    state,
    reset() {
      state.existingLedger = []
      state.sweepItemInserts = []
      state.ledgerUpserts = []
    },
  }
})
vi.mock("../lib/supabase", () => ({ supabase: sb.client, getSupabase: () => sb.client }))

// ---- Greenhouse mock: routes each fetch shape to test-configured data ----
const gh = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ path: string; params: Record<string, unknown> }>,
    recent: [] as unknown[],
    census: [] as unknown[],
    openJobs: [] as Array<{ id: number; name: string }>,
    jobsById: new Map<number, { id: number; name: string }>(),
  }
  return {
    state,
    reset() {
      state.calls = []
      state.recent = []
      state.census = []
      state.openJobs = []
      state.jobsById.clear()
    },
  }
})
vi.mock("../lib/greenhouse-client", () => ({
  greenhouseGetAll: vi.fn(async (path: string, params: Record<string, unknown>) => {
    gh.state.calls.push({ path, params })
    if (path === "/applications" && "created_at" in params) return gh.state.recent
    if (path === "/applications" && "stage_name" in params) return gh.state.census
    if (path === "/jobs" && params.status === "open") return gh.state.openJobs
    if (path === "/jobs" && typeof params.ids === "string") {
      return String(params.ids)
        .split(",")
        .map((id) => gh.state.jobsById.get(Number(id)))
        .filter(Boolean)
    }
    return []
  }),
}))
vi.mock("../lib/greenhouse-evidence", () => ({
  listJobOwners: async () => [],
  listReferrers: async () => [],
  listUsers: async () => [],
  listJobsByIds: async (ids: Array<number | null | undefined>) =>
    ids
      .filter((id): id is number => typeof id === "number")
      .map((id) => gh.state.jobsById.get(id))
      .filter(Boolean),
  listCandidatesByIds: async () => [],
}))

import { runReferralSweep } from "../lib/sweep-referral"

/** An in-process referral application sitting in Application Review. */
function app(o: { id: number; job_id: number; ageMs: number; stage?: string; status?: string }) {
  return {
    id: o.id,
    candidate_id: o.id + 1000,
    job_id: o.job_id,
    status: o.status ?? "in_process",
    current_stage: null,
    stage_name: o.stage ?? "Application Review",
    source: { id: 4000194004, name: "Referral" },
    credited_to: null,
    referrer_id: null,
    applied_at: iso(o.ageMs),
    created_at: iso(o.ageMs),
    last_activity_at: null,
    current_stage_at: iso(o.ageMs),
  }
}

beforeEach(() => {
  sb.reset()
  gh.reset()
})
afterEach(() => vi.unstubAllEnvs())

describe("referral sweep census fetch", () => {
  test("issues the census query (active + Application Review) and the open-jobs query alongside the recent window", async () => {
    await runReferralSweep({})
    const appCalls = gh.state.calls.filter((c) => c.path === "/applications")
    expect(appCalls.some((c) => "created_at" in c.params)).toBe(true)
    expect(
      appCalls.some(
        (c) =>
          c.params.status === "active" &&
          c.params.stage_name === "Application Review" &&
          typeof c.params.source_ids === "string"
      )
    ).toBe(true)
    expect(gh.state.calls.some((c) => c.path === "/jobs" && c.params.status === "open")).toBe(true)
  })

  test("a 90-day-old referral in Application Review on an OPEN job becomes a breach-tier item and a ledger row", async () => {
    gh.state.census = [app({ id: 1, job_id: 10, ageMs: 90 * 24 * HOUR })]
    gh.state.openJobs = [{ id: 10, name: "AI/ML Engineer" }]
    const result = await runReferralSweep({})
    expect(result.items.map((i) => i.application_id)).toEqual([1])
    expect(result.items[0].urgency_tier).toBe("breach")
    expect(result.items[0].job_title).toBe("AI/ML Engineer")
    expect(sb.state.ledgerUpserts.map((r) => r.application_id)).toEqual([1])
  })

  test("a sitting referral on a CLOSED job is excluded from the census", async () => {
    gh.state.census = [app({ id: 2, job_id: 99, ageMs: 90 * 24 * HOUR })]
    gh.state.openJobs = [] // job 99 not open
    const result = await runReferralSweep({})
    expect(result.items).toEqual([])
    expect(sb.state.ledgerUpserts).toEqual([])
  })

  test("a recent-window referral on a closed job is still included (status quo preserved)", async () => {
    gh.state.recent = [app({ id: 3, job_id: 99, ageMs: 2 * HOUR })]
    gh.state.jobsById.set(99, { id: 99, name: "Closed Req" })
    const result = await runReferralSweep({})
    expect(result.items.map((i) => i.application_id)).toEqual([3])
    expect(result.items[0].urgency_tier).toBe("new")
    expect(result.items[0].job_title).toBe("Closed Req")
    // 'new' is alertable (hour-1 DM) — it MUST be ledgered
    expect(sb.state.ledgerUpserts.map((r) => r.application_id)).toEqual([3])
  })

  test("an application returned by both fetches appears exactly once", async () => {
    const shared = app({ id: 4, job_id: 10, ageMs: 30 * HOUR })
    gh.state.recent = [shared]
    gh.state.census = [shared]
    gh.state.openJobs = [{ id: 10, name: "Job" }]
    const result = await runReferralSweep({})
    expect(result.items.map((i) => i.application_id)).toEqual([4])
    expect(sb.state.sweepItemInserts.filter((r) => r.application_id === 4)).toHaveLength(1)
  })

  test("an item already actioned at first sight is recorded in sweep_items but NOT in alert_ledger", async () => {
    gh.state.recent = [app({ id: 5, job_id: 10, ageMs: 2 * HOUR, stage: "Recruiter Screen" })]
    gh.state.jobsById.set(10, { id: 10, name: "Job" })
    const result = await runReferralSweep({})
    expect(result.items.map((i) => i.application_id)).toEqual([5])
    expect(result.items[0].urgency_tier).toBe("actioned")
    expect(sb.state.sweepItemInserts.map((r) => r.application_id)).toEqual([5])
    expect(sb.state.ledgerUpserts).toEqual([])
  })
})
