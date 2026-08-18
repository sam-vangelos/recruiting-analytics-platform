import {
  validateDeliverableAutonomyContract,
  validateKillSwitchState,
  type DeliverableAutonomyContract,
  type DeliverableAutonomyState,
  type KillSwitchState,
} from "./autonomy"
import { assertPublicSafe } from "./safe-public-output"
import { assertNonEmptyString, validateId, type ValidationSummary } from "./substrate"

export type TrustWindowStatus = "satisfied" | "blocked"
export type OperatorControlType = "promotion_request" | "kill_switch_update"
export type OperatorControlResult = "approved_local_state" | "blocked" | "recorded"
export type PromotionCheckId =
  | "eligible_state"
  | "transition_legality"
  | "trust_window"
  | "kill_switch"
  | "never_auto"
  | "external_activation"

/**
 * AUTONOMY-3: legal promotion transitions. Eligible-state membership alone let any
 * eligible state jump to any other — most dangerously auto_paused -> auto_eligible,
 * which would let a deliberate operator pause be reversed without re-promotion.
 * Paused deliverables re-enter through shadow and earn a fresh trust window.
 */
const LEGAL_AUTONOMY_TRANSITIONS: Readonly<Record<DeliverableAutonomyState, readonly DeliverableAutonomyState[]>> = {
  disabled: ["dev_only", "shadow"],
  dev_only: ["shadow", "disabled"],
  shadow: ["review_required", "auto_eligible", "dev_only", "disabled"],
  review_required: ["shadow", "disabled"],
  auto_eligible: ["auto_delivering", "auto_paused", "shadow", "disabled"],
  auto_delivering: ["auto_paused", "auto_eligible", "disabled"],
  auto_paused: ["shadow", "disabled"],
  never_auto: [],
}

export interface TrustWindowEvidence {
  deliverableId: string
  evaluatedAt: string
  shadowRunsCompleted: number
  cleanShadowRuns: number
  blockingGateFailureCount: number
  blockingSourceGapCount: number
  requiredCleanShadowRuns?: number
}

export interface TrustWindowEvaluation {
  deliverableId: string
  status: TrustWindowStatus
  shadowRunsCompleted: number
  requiredShadowRuns: number
  cleanShadowRuns: number
  requiredCleanShadowRuns: number
  blockingReasons: readonly string[]
  publicSummary: Record<string, unknown>
}

export interface OperatorControlRecord {
  controlId: string
  controlType: OperatorControlType
  targetType: "deliverable" | "capability" | "global" | "recipient_scope"
  targetId: string
  actor: string
  createdAt: string
  result: OperatorControlResult
  externalActivation: false
  liveMutation: false
  publicSummary: Record<string, unknown>
}

export interface AutonomyPromotionInput {
  contract: DeliverableAutonomyContract
  currentState: DeliverableAutonomyState
  requestedState: DeliverableAutonomyState
  requestedBy: string
  requestedAt: string
  trustWindow: TrustWindowEvidence
  activeKillSwitches?: readonly KillSwitchState[]
  externalAdapterApproved?: boolean
}

export interface PromotionCheck {
  checkId: PromotionCheckId
  status: "pass" | "fail"
  detail: string
}

export interface AutonomyPromotionRecord {
  promotionId: string
  deliverableId: string
  capabilityId: string
  fromState: DeliverableAutonomyState
  requestedState: DeliverableAutonomyState
  resolvedState: DeliverableAutonomyState
  result: Extract<OperatorControlResult, "approved_local_state" | "blocked">
  deliveryAuthorizationChanged: false
  externalActivation: false
  trustWindow: TrustWindowEvaluation
  checks: readonly PromotionCheck[]
  operatorControl: OperatorControlRecord
  publicSummary: Record<string, unknown>
}

export interface KillSwitchOperatorEventInput {
  scope: KillSwitchState["scope"]
  scopeId: string
  enabled: boolean
  reason: string
  updatedAt: string
  updatedBy: string
}

export interface KillSwitchOperatorEvent {
  eventId: string
  eventType: "kill_switch"
  state: KillSwitchState
  operatorControl: OperatorControlRecord
  externalActivation: false
  liveMutation: false
  publicSummary: Record<string, unknown>
}

export function evaluateTrustWindow(
  contract: DeliverableAutonomyContract,
  evidence: TrustWindowEvidence
): TrustWindowEvaluation {
  validateDeliverableAutonomyContract(contract)
  validateTrustWindowEvidence(evidence)
  if (evidence.deliverableId !== contract.deliverableId) {
    throw new Error(`Trust window evidence deliverable ${evidence.deliverableId} does not match ${contract.deliverableId}`)
  }
  // AUTONOMY-4: the contract-derived minimum is a FLOOR — caller-supplied overrides may
  // raise the requirement but never lower it below the contract.
  const contractCleanShadowRunsFloor = Math.max(
    contract.shadowRunRequirement - 1,
    contract.shadowRunRequirement > 0 ? 1 : 0
  )
  const requiredCleanShadowRuns = Math.max(
    evidence.requiredCleanShadowRuns ?? contractCleanShadowRunsFloor,
    contractCleanShadowRunsFloor
  )
  const blockingReasons = [
    evidence.shadowRunsCompleted < contract.shadowRunRequirement
      ? `Shadow runs ${evidence.shadowRunsCompleted}/${contract.shadowRunRequirement}`
      : "",
    evidence.cleanShadowRuns < requiredCleanShadowRuns
      ? `Clean shadow runs ${evidence.cleanShadowRuns}/${requiredCleanShadowRuns}`
      : "",
    evidence.blockingGateFailureCount > 0 ? `Blocking gate failures ${evidence.blockingGateFailureCount}` : "",
    evidence.blockingSourceGapCount > 0 ? `Blocking source gaps ${evidence.blockingSourceGapCount}` : "",
  ].filter(Boolean)
  const status: TrustWindowStatus = blockingReasons.length === 0 ? "satisfied" : "blocked"
  const publicSummary = {
    deliverableId: contract.deliverableId,
    status,
    shadowRunsCompleted: evidence.shadowRunsCompleted,
    requiredShadowRuns: contract.shadowRunRequirement,
    cleanShadowRuns: evidence.cleanShadowRuns,
    requiredCleanShadowRuns,
    blockingReasonCount: blockingReasons.length,
  }
  assertPublicSafe(publicSummary, `${contract.deliverableId}.trustWindow.publicSummary`)
  return {
    deliverableId: contract.deliverableId,
    status,
    shadowRunsCompleted: evidence.shadowRunsCompleted,
    requiredShadowRuns: contract.shadowRunRequirement,
    cleanShadowRuns: evidence.cleanShadowRuns,
    requiredCleanShadowRuns,
    blockingReasons,
    publicSummary,
  }
}

export function evaluateAutonomyPromotion(input: AutonomyPromotionInput): AutonomyPromotionRecord {
  validateDeliverableAutonomyContract(input.contract)
  assertNonEmptyString(input.requestedBy, "autonomyPromotion.requestedBy")
  assertNonEmptyString(input.requestedAt, "autonomyPromotion.requestedAt")
  const trustWindow = evaluateTrustWindow(input.contract, input.trustWindow)
  const applicableKillSwitch = input.activeKillSwitches?.find((state) => killSwitchApplies(state, input.contract))
  if (applicableKillSwitch) validateKillSwitchState(applicableKillSwitch)
  const checks = [
    check(
      "eligible_state",
      input.contract.eligibleAutonomyStates.includes(input.requestedState) ? "pass" : "fail",
      "Requested state must be listed in the deliverable autonomy contract."
    ),
    check(
      "transition_legality",
      (LEGAL_AUTONOMY_TRANSITIONS[input.currentState] ?? []).includes(input.requestedState) ? "pass" : "fail",
      `Transition ${input.currentState} -> ${input.requestedState} must follow the promotion state machine; paused deliverables re-enter via shadow re-promotion.`
    ),
    check(
      "trust_window",
      input.requestedState === "auto_eligible" && trustWindow.status !== "satisfied" ? "fail" : "pass",
      "Auto-eligible promotion requires a satisfied trust window."
    ),
    check(
      "kill_switch",
      applicableKillSwitch?.enabled ? "fail" : "pass",
      applicableKillSwitch?.enabled
        ? `Active kill switch blocks promotion at ${applicableKillSwitch.scope}:${applicableKillSwitch.scopeId}.`
        : "No applicable kill switch blocks promotion."
    ),
    check(
      "never_auto",
      input.contract.autoEligibility === "never_auto" && input.requestedState !== "never_auto" ? "fail" : "pass",
      "Never-auto deliverables cannot be promoted into automated delivery states."
    ),
    check(
      "external_activation",
      input.requestedState === "auto_delivering" || input.externalAdapterApproved === true ? "fail" : "pass",
      "Phase 6 records local state only; external auto-delivery activation remains disabled."
    ),
  ]
  const hasFailure = checks.some((item) => item.status === "fail")
  const result: AutonomyPromotionRecord["result"] = hasFailure ? "blocked" : "approved_local_state"
  const resolvedState = result === "approved_local_state" ? input.requestedState : input.currentState
  const promotionId = `promotion_${input.contract.deliverableId}_${input.requestedAt.replace(/[^0-9]/g, "")}`
  const publicSummary = {
    promotionId,
    deliverableId: input.contract.deliverableId,
    capabilityId: input.contract.capabilityId,
    fromState: input.currentState,
    requestedState: input.requestedState,
    resolvedState,
    result,
    deliveryAuthorizationChanged: false,
    externalActivation: false,
    failedCheckCount: checks.filter((item) => item.status === "fail").length,
  }
  assertPublicSafe(publicSummary, `${promotionId}.publicSummary`)
  const operatorControl = buildOperatorControlRecord({
    controlType: "promotion_request",
    targetType: "deliverable",
    targetId: input.contract.deliverableId,
    actor: input.requestedBy,
    createdAt: input.requestedAt,
    result,
    publicSummary,
  })
  const record = {
    promotionId,
    deliverableId: input.contract.deliverableId,
    capabilityId: input.contract.capabilityId,
    fromState: input.currentState,
    requestedState: input.requestedState,
    resolvedState,
    result,
    deliveryAuthorizationChanged: false,
    externalActivation: false,
    trustWindow,
    checks,
    operatorControl,
    publicSummary,
  } as const satisfies AutonomyPromotionRecord
  validateAutonomyPromotionRecord(record)
  return record
}

export function createKillSwitchOperatorEvent(input: KillSwitchOperatorEventInput): KillSwitchOperatorEvent {
  const state: KillSwitchState = {
    scope: input.scope,
    scopeId: input.scopeId,
    enabled: input.enabled,
    reason: input.reason,
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy,
  }
  validateKillSwitchState(state)
  const eventId = `kill_switch_${input.scope}_${input.scopeId}_${input.updatedAt.replace(/[^0-9]/g, "")}`
  const publicSummary = {
    eventId,
    scope: input.scope,
    scopeId: input.scopeId,
    enabled: input.enabled,
    externalActivation: false,
    liveMutation: false,
  }
  assertPublicSafe(publicSummary, `${eventId}.publicSummary`)
  return {
    eventId,
    eventType: "kill_switch",
    state,
    operatorControl: buildOperatorControlRecord({
      controlType: "kill_switch_update",
      targetType: input.scope,
      targetId: input.scopeId,
      actor: input.updatedBy,
      createdAt: input.updatedAt,
      result: "recorded",
      publicSummary,
    }),
    externalActivation: false,
    liveMutation: false,
    publicSummary,
  }
}

export function validateAutonomyPromotionRecord(record: AutonomyPromotionRecord): ValidationSummary {
  validateId(record.promotionId, "autonomyPromotion.promotionId")
  validateId(record.deliverableId, `${record.promotionId}.deliverableId`)
  validateId(record.capabilityId, `${record.promotionId}.capabilityId`)
  if (record.deliveryAuthorizationChanged !== false) {
    throw new Error(`${record.promotionId}.deliveryAuthorizationChanged must remain false`)
  }
  if (record.externalActivation !== false) throw new Error(`${record.promotionId}.externalActivation must remain false`)
  validateOperatorControlRecord(record.operatorControl)
  assertPublicSafe(record.publicSummary, `${record.promotionId}.publicSummary`)
  return { ok: true, id: record.promotionId, checked: ["ids", "localOnly", "operatorControl", "publicSafety"] }
}

export function validateOperatorControlRecord(record: OperatorControlRecord): ValidationSummary {
  validateId(record.controlId, "operatorControl.controlId")
  assertNonEmptyString(record.actor, `${record.controlId}.actor`)
  assertNonEmptyString(record.createdAt, `${record.controlId}.createdAt`)
  validateId(record.targetId, `${record.controlId}.targetId`)
  if (record.externalActivation !== false) throw new Error(`${record.controlId}.externalActivation must remain false`)
  if (record.liveMutation !== false) throw new Error(`${record.controlId}.liveMutation must remain false`)
  assertPublicSafe(record.publicSummary, `${record.controlId}.publicSummary`)
  return { ok: true, id: record.controlId, checked: ["id", "actor", "localOnly", "publicSafety"] }
}

function validateTrustWindowEvidence(evidence: TrustWindowEvidence): void {
  validateId(evidence.deliverableId, "trustWindow.deliverableId")
  assertNonEmptyString(evidence.evaluatedAt, `${evidence.deliverableId}.evaluatedAt`)
  assertNonNegative(evidence.shadowRunsCompleted, `${evidence.deliverableId}.shadowRunsCompleted`)
  assertNonNegative(evidence.cleanShadowRuns, `${evidence.deliverableId}.cleanShadowRuns`)
  assertNonNegative(evidence.blockingGateFailureCount, `${evidence.deliverableId}.blockingGateFailureCount`)
  assertNonNegative(evidence.blockingSourceGapCount, `${evidence.deliverableId}.blockingSourceGapCount`)
  if (evidence.requiredCleanShadowRuns !== undefined) {
    assertNonNegative(evidence.requiredCleanShadowRuns, `${evidence.deliverableId}.requiredCleanShadowRuns`)
  }
}

function buildOperatorControlRecord(input: {
  controlType: OperatorControlType
  targetType: OperatorControlRecord["targetType"]
  targetId: string
  actor: string
  createdAt: string
  result: OperatorControlResult
  publicSummary: Record<string, unknown>
}): OperatorControlRecord {
  const record = {
    controlId: `control_${input.controlType}_${input.targetId}_${input.createdAt.replace(/[^0-9]/g, "")}`,
    controlType: input.controlType,
    targetType: input.targetType,
    targetId: input.targetId,
    actor: input.actor,
    createdAt: input.createdAt,
    result: input.result,
    externalActivation: false,
    liveMutation: false,
    publicSummary: input.publicSummary,
  } as const satisfies OperatorControlRecord
  validateOperatorControlRecord(record)
  return record
}

function check(checkId: PromotionCheckId, status: PromotionCheck["status"], detail: string): PromotionCheck {
  return { checkId, status, detail }
}

function killSwitchApplies(state: KillSwitchState, contract: DeliverableAutonomyContract): boolean {
  if (!state.enabled) return false
  if (state.scope === "global") return true
  if (state.scope === "capability") return state.scopeId === contract.capabilityId
  if (state.scope === "deliverable") return state.scopeId === contract.deliverableId
  return contract.recipientScopeRuleIds.includes(state.scopeId)
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
}
