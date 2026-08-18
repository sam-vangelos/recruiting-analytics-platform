import { describe, expect, test } from "vitest"

import { getDeliverableAutomationSeed } from "../lib/recruiting-ops/automation-seed-matrix"
import { evaluateDeliveryGates, type DeliveryGateEvaluationInput } from "../lib/recruiting-ops/delivery-gates"

// REGRESSION LOCK (was RED SPEC) — population P2 / ARCH-META-6: "can't check" rendered identical to "checked, fine".
// LEAD-1 closed the freshness not_applicable backdoor ONLY for auto_delivery. For review (and
// shadow), a missing source timestamp + a freshnessNotApplicableReason still returns
// not_applicable, which never enters failedGateIds — so the entire review promotion lane skips
// freshness verification (the internal control-plane excavation audit (2026-06-26) §3 P2).
// FIX: drive NA legitimacy off the contract — when the contract requires freshness, NA is a FAIL
// in every mode, not only auto_delivery.

const contract = getDeliverableAutomationSeed("weekly_progress_sheet")

const reviewInput: DeliveryGateEvaluationInput = {
  contract,
  runId: "t03_review_20260625070000000",
  commandCenterMode: "shadow",
  requestedDeliveryMode: "review",
  autonomyState: "shadow",
  readinessState: "ready_for_delivery",
  evaluatedAt: "2026-06-25T07:00:00.000Z",
  sourceObservedAt: undefined,
  freshnessNotApplicableReason: "scoped rows do not include a source-observed timestamp",
  recipientFingerprint: "sha256:recipient_weekly_progress",
  payloadFingerprint: "sha256:payload_weekly_progress",
  templateHash: "sha256:template_weekly_progress",
  recipientScopeRuleId: "recruiter_scoped_visibility",
  recipientScopePass: true,
  publicSummary: { deliverableId: "weekly_progress_sheet", rowCount: 2 },
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

describe("P2: freshness not_applicable must not silently pass for review-lane delivery", () => {
  test("review-mode NA freshness (no source timestamp) must fail the freshness gate", () => {
    const result = evaluateDeliveryGates(reviewInput)
    // HEAD: freshness returns not_applicable for non-auto modes -> never in failedGateIds.
    expect(result.failedGateIds).toContain("freshness")
  })
})
