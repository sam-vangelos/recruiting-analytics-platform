import { describe, expect, test } from "vitest"

import { getDeliverableAutomationSeed } from "../lib/recruiting-ops/automation-seed-matrix"
import { evaluateDeliveryGates, type DeliveryGateEvaluationInput } from "../lib/recruiting-ops/delivery-gates"
import { evaluateAutonomyPromotion, type TrustWindowEvidence } from "../lib/recruiting-ops/autonomy-operator-controls"

// GREEN CATCHER TESTS. These lock logic that is correct in isolation but was previously
// untested because the gate fixtures only ever fed clean inputs (so a mutation probe could
// disable the gate and the suite stayed green — audit P3 + test-honesty probe). Each gate is
// now driven to BOTH pass and fail; disabling the gate flips the fail case and turns these red.
// The mutation corpus seeds exactly these disablements.

const contract = getDeliverableAutomationSeed("weekly_progress_sheet")

const baseInput: DeliveryGateEvaluationInput = {
  contract,
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

describe("delivery gate decision matrix — every gate is driven to both pass and fail", () => {
  test("idempotency gate passes clean and fails on a duplicate payload fingerprint in the window", () => {
    expect(evaluateDeliveryGates(baseInput).failedGateIds).not.toContain("idempotency")
    const dup = evaluateDeliveryGates({
      ...baseInput,
      priorPayloadFingerprintsInWindow: [baseInput.payloadFingerprint],
    })
    expect(dup.failedGateIds).toContain("idempotency")
  })

  test("discrepancy_tolerance gate passes clean and fails on a blocking discrepancy or open definition", () => {
    expect(evaluateDeliveryGates(baseInput).failedGateIds).not.toContain("discrepancy_tolerance")
    expect(evaluateDeliveryGates({ ...baseInput, blockingDiscrepancyCount: 1 }).failedGateIds).toContain(
      "discrepancy_tolerance"
    )
    expect(evaluateDeliveryGates({ ...baseInput, businessDefinitionOpenCount: 1 }).failedGateIds).toContain(
      "discrepancy_tolerance"
    )
  })

  test("source_gap gate passes clean and fails on a blocking source gap", () => {
    expect(evaluateDeliveryGates(baseInput).failedGateIds).not.toContain("source_gap")
    expect(evaluateDeliveryGates({ ...baseInput, blockingSourceGapCount: 1 }).failedGateIds).toContain("source_gap")
  })
})

describe("autonomy promotion trust-window guard", () => {
  const window = (overrides: Partial<TrustWindowEvidence>): TrustWindowEvidence => ({
    deliverableId: contract.deliverableId,
    evaluatedAt: "2026-06-25T07:00:00.000Z",
    shadowRunsCompleted: 0,
    cleanShadowRuns: 0,
    blockingGateFailureCount: 0,
    blockingSourceGapCount: 0,
    ...overrides,
  })

  const promote = (trustWindow: TrustWindowEvidence) =>
    evaluateAutonomyPromotion({
      contract,
      currentState: "shadow",
      requestedState: "auto_eligible",
      requestedBy: "sam",
      requestedAt: "2026-06-25T07:00:00.000Z",
      trustWindow,
    })

  test("a blocked trust window fails the trust_window check on an auto_eligible promotion", () => {
    const record = promote(window({ shadowRunsCompleted: 0, cleanShadowRuns: 0 }))
    expect(record.checks.find((c) => c.checkId === "trust_window")?.status).toBe("fail")
  })

  test("a satisfied trust window passes the trust_window check", () => {
    const record = promote(
      window({
        shadowRunsCompleted: contract.shadowRunRequirement,
        cleanShadowRuns: contract.shadowRunRequirement,
      })
    )
    expect(record.checks.find((c) => c.checkId === "trust_window")?.status).toBe("pass")
  })
})
