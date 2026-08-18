// Behavior of the sweep-health verdict + banner (lib/sweep-health.ts). The point
// of this module is that a lane which has STARTED FAILING cannot present as
// healthy behind the last successful run's figures — the June 2026 Greenhouse-401
// outage ran unnoticed for eleven days because the tracker read completed-only.
// So the load-bearing assertions here are: a failed latest attempt => danger, and
// a healthy latest attempt with an OLD last success still => healthy (not a false
// alarm). Both are red-tested against the naive "read latest completed" behavior.

import { describe, expect, test } from "vitest"

import { buildSweepHealthNotice, computeSweepHealth } from "../lib/sweep-health"
import type { SweepRunSummary } from "../lib/sweep-types"

const T0 = Date.parse("2026-07-27T12:00:00Z")

function run(overrides: Partial<SweepRunSummary> = {}): SweepRunSummary {
  return {
    id: "r1",
    sweep_type: "referral",
    started_at: "2026-07-27T11:30:00Z",
    completed_at: "2026-07-27T11:30:20Z",
    status: "completed",
    applications_scanned: 3,
    items_found: 1,
    items_alerted: 1,
    error_message: null,
    ...overrides,
  }
}

describe("computeSweepHealth", () => {
  test("a completed recent run is healthy", () => {
    const h = computeSweepHealth({
      sweepType: "referral",
      latestAttempt: run(),
      latestSuccess: run(),
      nowMs: T0,
    })
    expect(h.status).toBe("healthy")
    expect(h.reason).toBe("ok")
    expect(buildSweepHealthNotice(h)).toBeNull()
  })

  test("a FAILED latest attempt is degraded even when a good run exists behind it", () => {
    const failed = run({
      id: "r2",
      status: "failed",
      completed_at: null,
      started_at: "2026-07-27T11:45:00Z",
      error_message: "Greenhouse API error: 401 Unauthorized (/v3/jobs)",
    })
    const lastGood = run({ id: "r1", started_at: "2026-07-27T10:45:00Z" })

    const h = computeSweepHealth({
      sweepType: "referral",
      latestAttempt: failed,
      latestSuccess: lastGood,
      nowMs: T0,
    })

    expect(h.status).toBe("degraded")
    expect(h.reason).toBe("last_run_failed")
    // The last success is still reported — the tracker's figures come from it —
    // but health does not inherit its "completed" status.
    expect(h.latest_success).toBe(lastGood)

    const notice = buildSweepHealthNotice(h)
    expect(notice?.tone).toBe("danger")
    expect(notice?.detail).toContain("401 Unauthorized")
  })

  test("a healthy recent attempt with an OLD last success is NOT a false alarm", () => {
    // A genuinely quiet lane: the newest run completed a moment ago and found
    // nothing, so the previous *success* it supersedes is irrelevant to health.
    const h = computeSweepHealth({
      sweepType: "referral",
      latestAttempt: run({ started_at: "2026-07-27T11:59:00Z" }),
      latestSuccess: run({ id: "old", started_at: "2026-07-01T00:00:00Z" }),
      nowMs: T0,
    })
    expect(h.status).toBe("healthy")
    expect(buildSweepHealthNotice(h)).toBeNull()
  })

  test("no run past 3x cadence is stalled (referral hourly => >3h)", () => {
    const h = computeSweepHealth({
      sweepType: "referral",
      latestAttempt: run({ started_at: "2026-07-27T08:00:00Z" }), // 4h before T0
      latestSuccess: run({ started_at: "2026-07-27T08:00:00Z" }),
      nowMs: T0,
    })
    expect(h.reason).toBe("stalled")
    expect(buildSweepHealthNotice(h)?.tone).toBe("danger")
  })

  test("agency tolerates a longer gap than referral (4h cadence => 12h stall window)", () => {
    // 5h old: stalled for referral (>3h) but healthy for agency (<12h).
    const startedAt = "2026-07-27T07:00:00Z"
    expect(
      computeSweepHealth({ sweepType: "referral", latestAttempt: run({ started_at: startedAt }), latestSuccess: null, nowMs: T0 }).reason
    ).toBe("stalled")
    expect(
      computeSweepHealth({ sweepType: "agency", latestAttempt: run({ sweep_type: "agency", started_at: startedAt }), latestSuccess: null, nowMs: T0 }).reason
    ).toBe("ok")
  })

  test("a lane that has never run is a warning, not a danger", () => {
    const h = computeSweepHealth({
      sweepType: "referral",
      latestAttempt: null,
      latestSuccess: null,
      nowMs: T0,
    })
    expect(h.reason).toBe("never_run")
    expect(buildSweepHealthNotice(h)?.tone).toBe("warning")
  })

  test("an in-flight (running) recent attempt is healthy", () => {
    const h = computeSweepHealth({
      sweepType: "referral",
      latestAttempt: run({ status: "running", completed_at: null, started_at: "2026-07-27T11:59:30Z" }),
      latestSuccess: run(),
      nowMs: T0,
    })
    expect(h.status).toBe("healthy")
  })
})
