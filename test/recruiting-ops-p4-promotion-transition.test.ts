import { describe, expect, test } from "vitest"

import { getDeliverableAutomationSeed } from "../lib/recruiting-ops/automation-seed-matrix"
import {
  evaluateAutonomyPromotion,
  type AutonomyPromotionInput,
} from "../lib/recruiting-ops/autonomy-operator-controls"
import type { DeliverableAutonomyContract } from "../lib/recruiting-ops/autonomy"

// REGRESSION LOCK (was RED SPEC) — P4 illegal autonomy transition (defect AUTONOMY-3).
// (the internal control-plane excavation audit (2026-06-26) — autonomy operator controls.)
//
// evaluateAutonomyPromotion gates a promotion on five checks: eligible_state,
// trust_window, kill_switch, never_auto, external_activation. NONE of them is an
// illegal-transition guard. The eligible_state check only verifies that the
// *requested* state is a member of contract.eligibleAutonomyStates — it never
// looks at currentState. So ANY eligible state may jump to ANY other eligible
// state.
//
// weekly_progress_sheet is a candidate seed whose eligibleAutonomyStates is
// ["shadow", "auto_eligible", "auto_paused"]. That means an operator who has
// deliberately PAUSED automation (auto_paused) can immediately re-activate it to
// auto_eligible without any re-promotion path or fresh authorization — the pause
// is bypassable by a single backwards transition. auto_paused -> auto_eligible
// must be blocked by a transition guard.
//
// FIX (AUTONOMY-3): add a transition-legality check keyed on (currentState ->
// requestedState). Reactivating from auto_paused must require a fresh promotion
// gate, not a free jump. When fixed, this file goes green and moves to test/.

const seed = getDeliverableAutomationSeed("weekly_progress_sheet")

// Ensure the contract genuinely lists auto_eligible (and auto_paused) as eligible,
// so the block under test cannot be attributed to the eligible_state check.
// The seed already satisfies this; spread defensively so the spec stays valid even
// if the seed shape shifts.
const contract: DeliverableAutonomyContract = {
  ...seed,
  eligibleAutonomyStates: Array.from(
    new Set([...seed.eligibleAutonomyStates, "auto_paused", "auto_eligible"])
  ),
}

function satisfiedTrustWindow() {
  return {
    deliverableId: contract.deliverableId,
    evaluatedAt: "2026-06-24T18:00:00.000Z",
    shadowRunsCompleted: contract.shadowRunRequirement,
    cleanShadowRuns: contract.shadowRunRequirement,
    blockingGateFailureCount: 0,
    blockingSourceGapCount: 0,
  }
}

const input: AutonomyPromotionInput = {
  contract,
  currentState: "auto_paused",
  requestedState: "auto_eligible",
  requestedBy: "sam",
  requestedAt: "2026-06-24T18:05:00.000Z",
  trustWindow: satisfiedTrustWindow(),
  activeKillSwitches: [],
  externalAdapterApproved: false,
}

describe("P4: auto_paused -> auto_eligible must be blocked by a transition guard", () => {
  test("re-activating a paused deliverable is not a free jump between eligible states", () => {
    const record = evaluateAutonomyPromotion(input)

    // Guard against green-on-HEAD-for-the-wrong-reason: the block must NOT come
    // from eligible_state. auto_eligible IS an eligible state, so that check must
    // pass. If it failed, result would be "blocked" on HEAD for the wrong reason.
    const eligibleStateCheck = record.checks.find((c) => c.checkId === "eligible_state")
    expect(eligibleStateCheck?.status).toBe("pass")

    // HEAD: all five checks pass -> result "approved_local_state". Desired: a
    // transition guard fires and the illegal re-activation is blocked.
    expect(record.result).toBe("blocked")
  })
})
