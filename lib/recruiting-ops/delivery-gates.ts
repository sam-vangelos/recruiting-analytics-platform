import {
  LOCAL_DELIVERY_LEDGER_MECHANISM,
  buildDeliveryLogId,
  type LocalDeliveryLedgerEntry,
  type LocalDeliveryLedgerEventType,
} from "./delivery-ledger"
import { inspectPublicValue } from "./safe-public-output"
import {
  validateDeliverableAutonomyContract,
  validateDeliveryGateResult,
  type DeliverableAutonomyContract,
  type DeliverableAutonomyState,
  type DeliverableReadinessState,
  type DeliveryAuthorizationVerdict,
  type DeliveryGateId,
  type DeliveryGateResult,
  type KillSwitchState,
} from "./autonomy"
import { type CommandCenterMode } from "./substrate"

export type RequestedDeliveryMode = "shadow" | "review" | "auto_delivery"

export interface DeliveryGateEvaluationInput {
  contract: DeliverableAutonomyContract
  runId: string
  commandCenterMode: CommandCenterMode
  requestedDeliveryMode: RequestedDeliveryMode
  autonomyState: DeliverableAutonomyState
  readinessState: DeliverableReadinessState
  evaluatedAt: string
  sourceObservedAt?: string | null
  freshnessNotApplicableReason?: string
  recipientFingerprint: string
  payloadFingerprint: string
  templateHash: string
  approvedTemplateHash?: string
  recipientScopeRuleId: string
  recipientScopePass: boolean
  recipientScopeReason?: string
  publicSummary: Record<string, unknown>
  artifactIds: readonly string[]
  gateEvidenceRefs: readonly string[]
  blockingDiscrepancyCount: number
  businessDefinitionOpenCount: number
  blockingSourceGapCount: number
  priorPayloadFingerprintsInWindow: readonly string[]
  shadowRunsCompleted: number
  cleanShadowRuns: number
  requiredCleanShadowRuns?: number
  killSwitches: readonly KillSwitchState[]
  externalDeliveryAdapterApproved: boolean
  createdBy?: string
}

export interface DeliveryGateEvaluationResult {
  verdict: DeliveryAuthorizationVerdict
  gateResults: readonly DeliveryGateResult[]
  failedGateIds: readonly DeliveryGateId[]
  deliveryLogEntry: LocalDeliveryLedgerEntry
}

export function evaluateDeliveryGates(input: DeliveryGateEvaluationInput): DeliveryGateEvaluationResult {
  validateDeliverableAutonomyContract(input.contract, {
    approvedExternalDeliveryAdapter: input.externalDeliveryAdapterApproved,
  })
  validateDeliveryGateEvaluationInput(input)
  const gateResults = [
    evaluateBoundaryGate(input),
    evaluateModeGate(input),
    evaluateFreshnessGate(input),
    evaluateDiscrepancyGate(input),
    evaluateSourceGapGate(input),
    evaluateTemplateStabilityGate(input),
    evaluateRecipientScopeGate(input),
    evaluatePiiPostureGate(input),
    evaluateIdempotencyGate(input),
    evaluateTrustPeriodGate(input),
    evaluateKillSwitchGate(input),
  ]
  for (const result of gateResults) validateDeliveryGateResult(result)

  const failedGateIds = gateResults
    .filter((result) => result.status === "fail" || (result.status === "warn" && !warningsAllowed(input)))
    .map((result) => result.gateId)
  const verdict = finalVerdict(input, failedGateIds)
  const deliveryLogEntry = buildEvaluationLogEntry(input, gateResults, verdict)

  return { verdict, gateResults, failedGateIds, deliveryLogEntry }
}

export function validateDeliveryGateEvaluationInput(input: DeliveryGateEvaluationInput): { ok: true } {
  if (input.requestedDeliveryMode !== "auto_delivery" && input.externalDeliveryAdapterApproved) {
    throw new Error("externalDeliveryAdapterApproved cannot be true for shadow or review delivery modes")
  }
  if (input.requestedDeliveryMode === "auto_delivery" && input.contract.lane !== "auto_delivery") {
    throw new Error("auto_delivery can only be requested for auto_delivery lane contracts")
  }
  if (input.autonomyState === "auto_delivering" && !input.externalDeliveryAdapterApproved) {
    throw new Error("auto_delivering requires an approved external delivery adapter")
  }
  if (!input.contract.eligibleAutonomyStates.includes(input.autonomyState)) {
    throw new Error(`autonomyState ${input.autonomyState} is not eligible for ${input.contract.deliverableId}`)
  }
  if (!input.contract.readinessStatesAllowed.includes(input.readinessState)) {
    throw new Error(`readinessState ${input.readinessState} is not allowed for ${input.contract.deliverableId}`)
  }
  if (input.requestedDeliveryMode === "auto_delivery" && input.readinessState !== "ready_for_delivery") {
    throw new Error("auto_delivery requires ready_for_delivery readiness")
  }
  if (!input.recipientScopePass && !input.recipientScopeReason?.trim()) {
    throw new Error("recipientScopeReason is required when recipientScopePass is false")
  }
  return { ok: true }
}

function evaluateBoundaryGate(input: DeliveryGateEvaluationInput): DeliveryGateResult {
  if (input.requestedDeliveryMode === "auto_delivery" && !input.externalDeliveryAdapterApproved) {
    return fail("boundary", "External delivery adapter is not approved for Phase 0.", input)
  }
  return pass("boundary", "Requested mode is within the approved local boundary.", input)
}

function evaluateModeGate(input: DeliveryGateEvaluationInput): DeliveryGateResult {
  if (!input.contract.eligibleAutonomyStates.includes(input.autonomyState)) {
    return fail(
      "mode",
      `Autonomy state ${input.autonomyState} is not eligible under ${input.contract.deliverableId}.`,
      input
    )
  }
  if (!input.contract.readinessStatesAllowed.includes(input.readinessState)) {
    return fail(
      "mode",
      `Readiness state ${input.readinessState} is not allowed under ${input.contract.deliverableId}.`,
      input
    )
  }
  if (input.requestedDeliveryMode === "auto_delivery" && input.commandCenterMode === "fixture") {
    return fail("mode", "Fixture runs cannot deliver to real audiences.", input)
  }
  return pass("mode", "Run mode is compatible with the requested delivery mode.", input)
}

function evaluateFreshnessGate(input: DeliveryGateEvaluationInput): DeliveryGateResult {
  if (input.freshnessNotApplicableReason?.trim()) {
    // P2/ARCH-META-6: "can't check" must not render as "checked, fine". NA legitimacy is
    // driven off the CONTRACT — a deliverable with a freshness TTL requires freshness in
    // every mode (shadow, review, auto), so a missing source timestamp is a FAIL, not NA.
    if (input.contract.freshnessTtlMinutes > 0) {
      return fail(
        "freshness",
        `Freshness cannot be not_applicable when the contract requires it (TTL ${input.contract.freshnessTtlMinutes}m): ${input.freshnessNotApplicableReason}`,
        input
      )
    }
    return notApplicable("freshness", input.freshnessNotApplicableReason, input)
  }
  const evaluatedAt = Date.parse(input.evaluatedAt)
  if (!input.sourceObservedAt?.trim()) {
    return fail("freshness", "Source observed timestamp is required unless explicitly not applicable.", input)
  }
  const observedAt = Date.parse(input.sourceObservedAt)
  if (Number.isNaN(evaluatedAt) || Number.isNaN(observedAt)) {
    return fail("freshness", "Freshness timestamps must be valid ISO timestamps.", input)
  }
  const ageMinutes = Math.floor((evaluatedAt - observedAt) / 60000)
  if (ageMinutes < 0) {
    const reason = `Source timestamp is ${Math.abs(ageMinutes)} minute(s) ahead of evaluation; a future-dated source is not treated as fresh.`
    return input.requestedDeliveryMode === "auto_delivery"
      ? fail("freshness", reason, input)
      : warn("freshness", reason, input)
  }
  if (ageMinutes <= input.contract.freshnessTtlMinutes) {
    return pass("freshness", `Source age ${ageMinutes} minute(s) is inside TTL.`, input)
  }
  if (input.contract.staleBehavior === "warn") {
    return warn("freshness", `Source age ${ageMinutes} minute(s) exceeds TTL.`, input)
  }
  return fail("freshness", `Source age ${ageMinutes} minute(s) exceeds TTL.`, input)
}

function evaluateDiscrepancyGate(input: DeliveryGateEvaluationInput): DeliveryGateResult {
  if (input.blockingDiscrepancyCount > 0 || input.businessDefinitionOpenCount > 0) {
    return fail(
      "discrepancy_tolerance",
      `Blocking discrepancies: ${input.blockingDiscrepancyCount}; open business definitions: ${input.businessDefinitionOpenCount}.`,
      input
    )
  }
  return pass("discrepancy_tolerance", "No blocking discrepancy or open business definition affects rendered fields.", input)
}

function evaluateSourceGapGate(input: DeliveryGateEvaluationInput): DeliveryGateResult {
  if (input.blockingSourceGapCount > 0) {
    return fail("source_gap", `Blocking source gaps: ${input.blockingSourceGapCount}.`, input)
  }
  return pass("source_gap", "No blocking source gap affects the deliverable.", input)
}

function evaluateTemplateStabilityGate(input: DeliveryGateEvaluationInput): DeliveryGateResult {
  if (input.requestedDeliveryMode !== "auto_delivery" && !input.approvedTemplateHash) {
    return notApplicable("template_stability", "Template promotion hash is not required before auto-delivery.", input)
  }
  if (!input.approvedTemplateHash) return fail("template_stability", "Approved template hash is required.", input)
  if (input.templateHash !== input.approvedTemplateHash) {
    return fail("template_stability", "Rendered template hash does not match the approved promotion hash.", input)
  }
  return pass("template_stability", "Rendered template hash matches the approved promotion hash.", input)
}

function evaluateRecipientScopeGate(input: DeliveryGateEvaluationInput): DeliveryGateResult {
  if (!input.contract.recipientScopeRuleIds.includes(input.recipientScopeRuleId)) {
    return fail("recipient_scope", `Recipient scope rule ${input.recipientScopeRuleId} is not allowed.`, input)
  }
  if (!input.recipientScopePass) {
    return fail("recipient_scope", input.recipientScopeReason ?? "Recipient scope rule failed.", input)
  }
  return pass("recipient_scope", "Recipient scope rule passed.", input)
}

function evaluatePiiPostureGate(input: DeliveryGateEvaluationInput): DeliveryGateResult {
  const result = inspectPublicValue(input.publicSummary, `${input.contract.deliverableId}.publicSummary`)
  if (!result.ok) {
    return fail(
      "pii_posture",
      result.violations.map((violation) => `${violation.path}: ${violation.reason}`).join("; "),
      input
    )
  }
  return pass("pii_posture", "Public summary is PII-safe.", input)
}

function evaluateIdempotencyGate(input: DeliveryGateEvaluationInput): DeliveryGateResult {
  if (input.priorPayloadFingerprintsInWindow.includes(input.payloadFingerprint)) {
    return fail("idempotency", "Payload fingerprint already exists in the cadence window.", input)
  }
  return pass("idempotency", "No payload fingerprint collision in the cadence window.", input)
}

function evaluateTrustPeriodGate(input: DeliveryGateEvaluationInput): DeliveryGateResult {
  if (input.requestedDeliveryMode !== "auto_delivery") {
    return notApplicable("trust_period", "Trust-period promotion is not required for shadow or review runs.", input)
  }
  const requiredCleanRuns = input.requiredCleanShadowRuns ?? Math.max(input.contract.shadowRunRequirement - 1, 1)
  if (
    input.shadowRunsCompleted < input.contract.shadowRunRequirement ||
    input.cleanShadowRuns < requiredCleanRuns ||
    input.autonomyState !== "auto_delivering"
  ) {
    return fail(
      "trust_period",
      `Shadow runs ${input.shadowRunsCompleted}/${input.contract.shadowRunRequirement}; clean runs ${input.cleanShadowRuns}/${requiredCleanRuns}; autonomy state ${input.autonomyState}.`,
      input
    )
  }
  return pass("trust_period", "Shadow run and clean-window requirements are satisfied.", input)
}

function evaluateKillSwitchGate(input: DeliveryGateEvaluationInput): DeliveryGateResult {
  const activeSwitch = input.killSwitches.find((state) => state.enabled && appliesToInput(state, input))
  if (activeSwitch) {
    return fail("kill_switch", `Kill switch enabled at ${activeSwitch.scope}:${activeSwitch.scopeId}.`, input)
  }
  return pass("kill_switch", "No applicable kill switch is enabled.", input)
}

function finalVerdict(
  input: DeliveryGateEvaluationInput,
  failedGateIds: readonly DeliveryGateId[]
): DeliveryAuthorizationVerdict {
  if (failedGateIds.includes("kill_switch")) return "paused"
  if (failedGateIds.length > 0) return input.requestedDeliveryMode === "auto_delivery" ? "paused" : "blocked"
  if (input.requestedDeliveryMode === "shadow") return "authorized_for_shadow"
  if (input.requestedDeliveryMode === "review") return "authorized_for_review"
  return "authorized_for_auto_delivery"
}

function buildEvaluationLogEntry(
  input: DeliveryGateEvaluationInput,
  gateResults: readonly DeliveryGateResult[],
  verdict: DeliveryAuthorizationVerdict
): LocalDeliveryLedgerEntry {
  const eventType = eventTypeForVerdict(input, verdict)
  return {
    deliveryLogId: buildDeliveryLogId(input.contract.deliverableId, input.runId, eventType),
    eventType,
    capabilityId: input.contract.capabilityId,
    deliverableId: input.contract.deliverableId,
    runId: input.runId,
    lane: input.contract.lane,
    autonomyState: input.autonomyState,
    readinessState: input.readinessState,
    recipientFingerprint: input.recipientFingerprint,
    payloadFingerprint: input.payloadFingerprint,
    gateResults,
    status: statusForVerdict(verdict),
    deliveryMechanism: LOCAL_DELIVERY_LEDGER_MECHANISM,
    artifactIds: input.artifactIds,
    publicSummary: {
      ...input.publicSummary,
      verdict,
      failedGateIds: gateResults.filter((result) => result.status === "fail").map((result) => result.gateId),
    },
    createdAt: input.evaluatedAt,
    createdBy: input.createdBy ?? "gate_evaluator",
  }
}

function eventTypeForVerdict(
  input: DeliveryGateEvaluationInput,
  verdict: DeliveryAuthorizationVerdict
): LocalDeliveryLedgerEventType {
  if (verdict === "paused") return "auto_pause"
  if (verdict === "blocked") return "gate_failure"
  if (input.requestedDeliveryMode === "auto_delivery" || input.requestedDeliveryMode === "review") {
    return "delivery_authorization"
  }
  return "shadow_run"
}

function statusForVerdict(verdict: DeliveryAuthorizationVerdict): LocalDeliveryLedgerEntry["status"] {
  if (verdict === "authorized_for_shadow") return "shadowed"
  if (verdict === "authorized_for_review") return "authorized_for_review"
  if (verdict === "authorized_for_auto_delivery") return "authorized_for_auto_delivery"
  return verdict
}

function warningsAllowed(input: DeliveryGateEvaluationInput): boolean {
  return input.requestedDeliveryMode !== "auto_delivery"
}

function appliesToInput(state: KillSwitchState, input: DeliveryGateEvaluationInput): boolean {
  if (state.scope === "global") return true
  if (state.scope === "capability") return state.scopeId === input.contract.capabilityId
  if (state.scope === "deliverable") return state.scopeId === input.contract.deliverableId
  return state.scopeId === input.recipientScopeRuleId
}

function pass(gateId: DeliveryGateId, reason: string, input: DeliveryGateEvaluationInput): DeliveryGateResult {
  return gateResult(gateId, "pass", reason, input)
}

function warn(gateId: DeliveryGateId, reason: string, input: DeliveryGateEvaluationInput): DeliveryGateResult {
  return gateResult(gateId, "warn", reason, input)
}

function fail(gateId: DeliveryGateId, reason: string, input: DeliveryGateEvaluationInput): DeliveryGateResult {
  return gateResult(gateId, "fail", reason, input)
}

function notApplicable(gateId: DeliveryGateId, reason: string, input: DeliveryGateEvaluationInput): DeliveryGateResult {
  return gateResult(gateId, "not_applicable", reason, input)
}

function gateResult(
  gateId: DeliveryGateId,
  status: DeliveryGateResult["status"],
  reason: string,
  input: DeliveryGateEvaluationInput
): DeliveryGateResult {
  return {
    gateId,
    status,
    reason,
    evidenceRefs: status === "not_applicable" ? [] : input.gateEvidenceRefs,
  }
}
