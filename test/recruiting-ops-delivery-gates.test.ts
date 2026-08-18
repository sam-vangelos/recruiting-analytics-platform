import { describe, expect, test } from "vitest"

import { getDeliverableAutomationSeed } from "../lib/recruiting-ops/automation-seed-matrix"
import { evaluateDeliveryGates, type DeliveryGateEvaluationInput } from "../lib/recruiting-ops/delivery-gates"
import { validateLocalDeliveryLedgerEntry } from "../lib/recruiting-ops/delivery-ledger"

const weeklyProgressContract = getDeliverableAutomationSeed("weekly_progress_sheet")
const autoDeliveringWeeklyProgressContract = {
  ...weeklyProgressContract,
  eligibleAutonomyStates: [...weeklyProgressContract.eligibleAutonomyStates, "auto_delivering" as const],
}

const baseInput: DeliveryGateEvaluationInput = {
  contract: weeklyProgressContract,
  runId: "t03_20260625070000000",
  commandCenterMode: "shadow",
  requestedDeliveryMode: "shadow",
  autonomyState: "shadow",
  readinessState: "ready_for_delivery",
  evaluatedAt: "2026-06-25T07:00:00.000Z",
  sourceObservedAt: "2026-06-25T06:30:00.000Z",
  recipientFingerprint: "sha256:recipient_weekly_progress",
  payloadFingerprint: "sha256:payload_weekly_progress",
  templateHash: "sha256:template_weekly_progress",
  recipientScopeRuleId: "recruiter_scoped_visibility",
  recipientScopePass: true,
  publicSummary: {
    deliverableId: "weekly_progress_sheet",
    rowCount: 2,
  },
  artifactIds: ["artifact_weekly_progress_json"],
  gateEvidenceRefs: ["fixture_weekly_progress"],
  blockingDiscrepancyCount: 0,
  businessDefinitionOpenCount: 0,
  blockingSourceGapCount: 0,
  priorPayloadFingerprintsInWindow: [],
  shadowRunsCompleted: 4,
  cleanShadowRuns: 3,
  killSwitches: [],
  externalDeliveryAdapterApproved: false,
}

describe("recruiting ops deterministic delivery gate evaluator", () => {
  test("authorizes a clean local shadow run and returns a ledger entry draft", () => {
    const result = evaluateDeliveryGates(baseInput)

    expect(result.verdict).toBe("authorized_for_shadow")
    expect(result.failedGateIds).toEqual([])
    expect(result.gateResults.map((gate) => gate.gateId)).toEqual([
      "boundary",
      "mode",
      "freshness",
      "discrepancy_tolerance",
      "source_gap",
      "template_stability",
      "recipient_scope",
      "pii_posture",
      "idempotency",
      "trust_period",
      "kill_switch",
    ])
    expect(validateLocalDeliveryLedgerEntry(result.deliveryLogEntry).deliveryLogId).toContain(
      "delivery_weekly_progress_sheet_shadow_run"
    )
  })

  test("kill switch forces a paused verdict", () => {
    const result = evaluateDeliveryGates({
      ...baseInput,
      killSwitches: [
        {
          scope: "global",
          scopeId: "global",
          enabled: true,
          reason: "operator pause",
          updatedAt: "2026-06-25T06:59:00.000Z",
          updatedBy: "Jordan",
        },
      ],
    })

    expect(result.verdict).toBe("paused")
    expect(result.failedGateIds).toContain("kill_switch")
    expect(result.deliveryLogEntry.status).toBe("paused")
  })

  test("stale data follows warn versus block behavior", () => {
    const warnResult = evaluateDeliveryGates({
      ...baseInput,
      contract: getDeliverableAutomationSeed("weekly_recruitment_sheet"),
      requestedDeliveryMode: "review",
      autonomyState: "review_required",
      readinessState: "ready_for_review",
      recipientScopeRuleId: "leadership_visibility",
      sourceObservedAt: "2026-06-10T07:00:00.000Z",
    })
    const blockResult = evaluateDeliveryGates({
      ...baseInput,
      sourceObservedAt: "2026-06-10T07:00:00.000Z",
    })

    expect(warnResult.gateResults.find((gate) => gate.gateId === "freshness")).toMatchObject({
      status: "warn",
    })
    expect(warnResult.verdict).toBe("authorized_for_review")
    expect(warnResult.deliveryLogEntry.status).toBe("authorized_for_review")
    expect(blockResult.gateResults.find((gate) => gate.gateId === "freshness")).toMatchObject({
      status: "fail",
    })
    expect(blockResult.verdict).toBe("blocked")
  })

  test("recipient-scope mismatch blocks authorization", () => {
    const result = evaluateDeliveryGates({
      ...baseInput,
      recipientScopePass: false,
      recipientScopeReason: "row owner does not match recipient fingerprint",
    })

    expect(result.verdict).toBe("blocked")
    expect(result.failedGateIds).toContain("recipient_scope")
    expect(result.deliveryLogEntry.status).toBe("blocked")
  })

  test("insufficient shadow history blocks auto-delivery but permits shadow", () => {
    const autoResult = evaluateDeliveryGates({
      ...baseInput,
      commandCenterMode: "local",
      requestedDeliveryMode: "auto_delivery",
      autonomyState: "auto_eligible",
      externalDeliveryAdapterApproved: true,
      approvedTemplateHash: "sha256:template_weekly_progress",
      shadowRunsCompleted: 2,
      cleanShadowRuns: 2,
    })
    const shadowResult = evaluateDeliveryGates({
      ...baseInput,
      shadowRunsCompleted: 2,
      cleanShadowRuns: 2,
    })

    expect(autoResult.verdict).toBe("paused")
    expect(autoResult.failedGateIds).toContain("trust_period")
    expect(shadowResult.verdict).toBe("authorized_for_shadow")
  })

  test("keeps auto-delivery unreachable without an approved external delivery adapter", () => {
    expect(() =>
      evaluateDeliveryGates({
        ...baseInput,
        commandCenterMode: "local",
        requestedDeliveryMode: "auto_delivery",
        autonomyState: "auto_delivering",
        approvedTemplateHash: "sha256:template_weekly_progress",
        externalDeliveryAdapterApproved: false,
      })
    ).toThrow("auto_delivering requires an approved external delivery adapter")
  })

  test("rejects adapter-approved flags on shadow and review paths", () => {
    expect(() =>
      evaluateDeliveryGates({
        ...baseInput,
        externalDeliveryAdapterApproved: true,
      })
    ).toThrow("externalDeliveryAdapterApproved cannot be true")
    expect(() =>
      evaluateDeliveryGates({
        ...baseInput,
        contract: getDeliverableAutomationSeed("weekly_recruitment_sheet"),
        requestedDeliveryMode: "review",
        autonomyState: "review_required",
        recipientScopeRuleId: "leadership_visibility",
        externalDeliveryAdapterApproved: true,
      })
    ).toThrow("externalDeliveryAdapterApproved cannot be true")
  })

  test("fails explicit freshness not-applicable in every mode whose contract requires freshness (P2)", () => {
    // "Can't check" must never render as "checked, fine": a contract with a freshness TTL
    // requires freshness in shadow and review exactly as in auto-delivery.
    const shadowResult = evaluateDeliveryGates({
      ...baseInput,
      sourceObservedAt: null,
      freshnessNotApplicableReason: "Fixture shadow run has no scoped source timestamp.",
    })
    const reviewResult = evaluateDeliveryGates({
      ...baseInput,
      contract: getDeliverableAutomationSeed("weekly_recruitment_sheet"),
      requestedDeliveryMode: "review",
      autonomyState: "review_required",
      readinessState: "ready_for_review",
      recipientScopeRuleId: "leadership_visibility",
      sourceObservedAt: undefined,
      freshnessNotApplicableReason: "Review run has no scoped source timestamp.",
    })
    const autoResult = evaluateDeliveryGates({
      ...baseInput,
      contract: autoDeliveringWeeklyProgressContract,
      commandCenterMode: "local",
      requestedDeliveryMode: "auto_delivery",
      autonomyState: "auto_delivering",
      sourceObservedAt: null,
      freshnessNotApplicableReason: "Auto-delivery must not accept not applicable freshness.",
      approvedTemplateHash: "sha256:template_weekly_progress",
      externalDeliveryAdapterApproved: true,
    })

    expect(shadowResult.gateResults.find((gate) => gate.gateId === "freshness")).toMatchObject({
      status: "fail",
    })
    expect(shadowResult.failedGateIds).toContain("freshness")
    expect(reviewResult.gateResults.find((gate) => gate.gateId === "freshness")).toMatchObject({
      status: "fail",
    })
    expect(reviewResult.failedGateIds).toContain("freshness")
    expect(reviewResult.deliveryLogEntry.status).toBe("blocked")
    expect(autoResult.gateResults.find((gate) => gate.gateId === "freshness")).toMatchObject({
      status: "fail",
    })
    expect(autoResult.failedGateIds).toContain("freshness")
    expect(autoResult.verdict).toBe("paused")
  })

  test("review-mode delivery with in-TTL freshness passes and authorizes for review", () => {
    // Positive-path lock for the P2 change: review mode still authorizes when freshness
    // is genuinely verifiable (status "pass", not merely tolerated "warn").
    const result = evaluateDeliveryGates({
      ...baseInput,
      contract: getDeliverableAutomationSeed("weekly_recruitment_sheet"),
      requestedDeliveryMode: "review",
      autonomyState: "review_required",
      readinessState: "ready_for_review",
      recipientScopeRuleId: "leadership_visibility",
      sourceObservedAt: baseInput.evaluatedAt,
    })

    expect(result.gateResults.find((gate) => gate.gateId === "freshness")).toMatchObject({
      status: "pass",
    })
    expect(result.verdict).toBe("authorized_for_review")
    expect(result.deliveryLogEntry.status).toBe("authorized_for_review")
  })

  test("fails closed when auto-delivery freshness timestamp is missing", () => {
    const result = evaluateDeliveryGates({
      ...baseInput,
      contract: autoDeliveringWeeklyProgressContract,
      commandCenterMode: "local",
      requestedDeliveryMode: "auto_delivery",
      autonomyState: "auto_delivering",
      sourceObservedAt: undefined,
      approvedTemplateHash: "sha256:template_weekly_progress",
      externalDeliveryAdapterApproved: true,
    })

    expect(result.gateResults.find((gate) => gate.gateId === "freshness")).toMatchObject({
      status: "fail",
    })
    expect(result.failedGateIds).toContain("freshness")
    expect(result.verdict).toBe("paused")
  })

  test("records authorization status without pretending delivery was attempted", () => {
    const result = evaluateDeliveryGates({
      ...baseInput,
      contract: autoDeliveringWeeklyProgressContract,
      commandCenterMode: "local",
      requestedDeliveryMode: "auto_delivery",
      autonomyState: "auto_delivering",
      approvedTemplateHash: "sha256:template_weekly_progress",
      externalDeliveryAdapterApproved: true,
    })

    expect(result.verdict).toBe("authorized_for_auto_delivery")
    expect(result.deliveryLogEntry.eventType).toBe("delivery_authorization")
    expect(result.deliveryLogEntry.status).toBe("authorized_for_auto_delivery")
  })

  test("treats a future-dated source as warn for shadow and fail for auto-delivery", () => {
    const future = "2026-06-25T08:00:00.000Z"
    const shadowResult = evaluateDeliveryGates({ ...baseInput, sourceObservedAt: future })
    expect(shadowResult.gateResults.find((gate) => gate.gateId === "freshness")).toMatchObject({
      status: "warn",
    })
    expect(shadowResult.verdict).toBe("authorized_for_shadow")

    const autoResult = evaluateDeliveryGates({
      ...baseInput,
      requestedDeliveryMode: "auto_delivery",
      sourceObservedAt: future,
    })
    expect(autoResult.gateResults.find((gate) => gate.gateId === "freshness")).toMatchObject({
      status: "fail",
    })
    expect(autoResult.failedGateIds).toContain("freshness")
  })
})
