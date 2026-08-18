import { describe, expect, test } from "vitest"

import { getDeliverableAutomationSeed } from "../lib/recruiting-ops/automation-seed-matrix"
import { evaluateTrustWindow } from "../lib/recruiting-ops/autonomy-operator-controls"

// REGRESSION LOCK (was RED SPEC) — AUTONOMY-4 (population P3): the trust window is self-bypassable.
// evaluateTrustWindow honors a caller-supplied requiredCleanShadowRuns with NO floor, so
// requiredCleanShadowRuns:0 makes a window with 0 clean runs "satisfied"
// (the internal control-plane excavation audit (2026-06-26) §3 P3).
// FIX: floor requiredCleanShadowRuns at the contract-derived minimum; reject lower overrides.
// shadowRunRequirement is pinned to 5 so the spec is deterministic regardless of the seed value.

const contract = { ...getDeliverableAutomationSeed("weekly_progress_sheet"), shadowRunRequirement: 5 }

describe("AUTONOMY-4: trust window must floor requiredCleanShadowRuns at the contract minimum", () => {
  test("a caller-supplied requiredCleanShadowRuns:0 with 0 clean runs must NOT satisfy the window", () => {
    const result = evaluateTrustWindow(contract, {
      deliverableId: contract.deliverableId,
      evaluatedAt: "2026-06-25T07:00:00.000Z",
      shadowRunsCompleted: 5,
      cleanShadowRuns: 0,
      blockingGateFailureCount: 0,
      blockingSourceGapCount: 0,
      requiredCleanShadowRuns: 0,
    })
    // HEAD: "satisfied" (0 >= 0). Desired: "blocked" — 0 is below the contract floor.
    expect(result.status).toBe("blocked")
  })
})
