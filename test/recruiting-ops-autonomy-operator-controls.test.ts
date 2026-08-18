import { describe, expect, test } from "vitest"

import { getDeliverableAutomationSeed } from "../lib/recruiting-ops/automation-seed-matrix"
import {
  createKillSwitchOperatorEvent,
  evaluateAutonomyPromotion,
  evaluateTrustWindow,
  validateAutonomyPromotionRecord,
} from "../lib/recruiting-ops/autonomy-operator-controls"

const weeklyProgress = getDeliverableAutomationSeed("weekly_progress_sheet")
const offerActionQueue = getDeliverableAutomationSeed("offer_action_queue")

function satisfiedTrustWindow(deliverableId = weeklyProgress.deliverableId) {
  return {
    deliverableId,
    evaluatedAt: "2026-06-24T18:00:00.000Z",
    shadowRunsCompleted: 4,
    cleanShadowRuns: 3,
    blockingGateFailureCount: 0,
    blockingSourceGapCount: 0,
  }
}

describe("Phase 6 autonomy operator controls", () => {
  test("evaluates satisfied and blocked trust windows", () => {
    expect(evaluateTrustWindow(weeklyProgress, satisfiedTrustWindow())).toMatchObject({
      status: "satisfied",
      requiredShadowRuns: weeklyProgress.shadowRunRequirement,
      requiredCleanShadowRuns: 3,
      blockingReasons: [],
    })

    const blocked = evaluateTrustWindow(weeklyProgress, {
      deliverableId: weeklyProgress.deliverableId,
      evaluatedAt: "2026-06-24T18:00:00.000Z",
      shadowRunsCompleted: 2,
      cleanShadowRuns: 1,
      blockingGateFailureCount: 1,
      blockingSourceGapCount: 1,
    })

    expect(blocked.status).toBe("blocked")
    expect(blocked.blockingReasons).toHaveLength(4)
  })

  test("approves only local auto-eligible state when trust window is satisfied", () => {
    const record = evaluateAutonomyPromotion({
      contract: weeklyProgress,
      currentState: "shadow",
      requestedState: "auto_eligible",
      requestedBy: "sam",
      requestedAt: "2026-06-24T18:01:00.000Z",
      trustWindow: satisfiedTrustWindow(),
      activeKillSwitches: [],
      externalAdapterApproved: false,
    })

    expect(record).toMatchObject({
      result: "approved_local_state",
      resolvedState: "auto_eligible",
      deliveryAuthorizationChanged: false,
      externalActivation: false,
    })
    expect(record.operatorControl).toMatchObject({
      result: "approved_local_state",
      externalActivation: false,
      liveMutation: false,
    })
    expect(() => validateAutonomyPromotionRecord(record)).not.toThrow()
  })

  test("blocks external auto-delivery activation even with a satisfied trust window", () => {
    const record = evaluateAutonomyPromotion({
      contract: weeklyProgress,
      currentState: "auto_eligible",
      requestedState: "auto_delivering",
      requestedBy: "sam",
      requestedAt: "2026-06-24T18:02:00.000Z",
      trustWindow: satisfiedTrustWindow(),
      activeKillSwitches: [],
      externalAdapterApproved: true,
    })

    expect(record.result).toBe("blocked")
    expect(record.resolvedState).toBe("auto_eligible")
    expect(record.deliveryAuthorizationChanged).toBe(false)
    expect(record.externalActivation).toBe(false)
    expect(record.checks.filter((check) => check.status === "fail").map((check) => check.checkId)).toEqual([
      "eligible_state",
      "external_activation",
    ])
  })

  test("records kill switch events and uses them to block promotion", () => {
    const killSwitch = createKillSwitchOperatorEvent({
      scope: "deliverable",
      scopeId: weeklyProgress.deliverableId,
      enabled: true,
      reason: "operator pause during trust-window review",
      updatedAt: "2026-06-24T18:03:00.000Z",
      updatedBy: "sam",
    })
    const record = evaluateAutonomyPromotion({
      contract: weeklyProgress,
      currentState: "shadow",
      requestedState: "auto_eligible",
      requestedBy: "sam",
      requestedAt: "2026-06-24T18:04:00.000Z",
      trustWindow: satisfiedTrustWindow(),
      activeKillSwitches: [killSwitch.state],
      externalAdapterApproved: false,
    })

    expect(killSwitch).toMatchObject({
      eventType: "kill_switch",
      externalActivation: false,
      liveMutation: false,
    })
    expect(killSwitch.operatorControl).toMatchObject({
      controlType: "kill_switch_update",
      result: "recorded",
      externalActivation: false,
      liveMutation: false,
    })
    expect(record.result).toBe("blocked")
    expect(record.checks.find((check) => check.checkId === "kill_switch")).toMatchObject({ status: "fail" })
  })

  test("never-auto deliverables cannot be promoted into automated delivery states", () => {
    const record = evaluateAutonomyPromotion({
      contract: offerActionQueue,
      currentState: "never_auto",
      requestedState: "auto_eligible",
      requestedBy: "sam",
      requestedAt: "2026-06-24T18:05:00.000Z",
      trustWindow: satisfiedTrustWindow(offerActionQueue.deliverableId),
      activeKillSwitches: [],
      externalAdapterApproved: false,
    })

    expect(record.result).toBe("blocked")
    expect(record.resolvedState).toBe("never_auto")
    expect(record.checks.filter((check) => check.status === "fail").map((check) => check.checkId)).toEqual([
      "eligible_state",
      "transition_legality",
      "never_auto",
    ])
  })
})
