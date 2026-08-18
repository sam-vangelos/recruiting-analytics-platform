import { getCapability } from "./capabilities"
import { outputContractRegistry } from "./registries"
import {
  assertNonEmptyArray,
  assertNonEmptyString,
  validateId,
  type ValidationSummary,
} from "./substrate"

export const DELIVERABLE_LANES = ["auto_delivery", "review_assisted", "action_proposal"] as const
export const DELIVERABLE_AUTONOMY_STATES = [
  "disabled",
  "dev_only",
  "shadow",
  "review_required",
  "auto_eligible",
  "auto_delivering",
  "auto_paused",
  "never_auto",
] as const
export const DELIVERABLE_READINESS_STATES = [
  "draft_only",
  "ready_for_review",
  "ready_with_warnings",
  "ready_for_delivery",
  "blocked",
  "evidence_only",
  "human_only",
  "retired_by_signoff",
] as const
export const STALE_BEHAVIORS = ["warn", "block"] as const
export const RECIPIENT_SCOPE_TYPES = ["individual_recruiter", "team", "leadership", "admin", "internal_audit"] as const
export const DELIVERY_GATE_IDS = [
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
] as const
export const DELIVERY_GATE_RESULT_STATUSES = ["pass", "warn", "fail", "not_applicable"] as const
export const KILL_SWITCH_SCOPES = ["global", "capability", "deliverable", "recipient_scope"] as const
export const DELIVERY_LOG_STATUSES = [
  "shadowed",
  "authorized_for_review",
  "authorized_for_auto_delivery",
  "delivery_attempted",
  "delivered",
  "withheld",
  "paused",
  "blocked",
  "failed",
  "superseded",
  "correction_recorded",
] as const
export const AUTO_ELIGIBILITY_STATES = ["candidate", "blocked", "never_auto"] as const
export const DELIVERY_AUTHORIZATION_VERDICTS = [
  "authorized_for_shadow",
  "authorized_for_review",
  "authorized_for_auto_delivery",
  "paused",
  "blocked",
] as const

export type DeliverableLane = (typeof DELIVERABLE_LANES)[number]
export type DeliverableAutonomyState = (typeof DELIVERABLE_AUTONOMY_STATES)[number]
export type DeliverableReadinessState = (typeof DELIVERABLE_READINESS_STATES)[number]
export type StaleBehavior = (typeof STALE_BEHAVIORS)[number]
export type RecipientScopeType = (typeof RECIPIENT_SCOPE_TYPES)[number]
export type DeliveryGateId = (typeof DELIVERY_GATE_IDS)[number]
export type DeliveryGateResultStatus = (typeof DELIVERY_GATE_RESULT_STATUSES)[number]
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number]
export type DeliveryLogStatus = (typeof DELIVERY_LOG_STATUSES)[number]
export type AutoEligibility = (typeof AUTO_ELIGIBILITY_STATES)[number]
export type DeliveryAuthorizationVerdict = (typeof DELIVERY_AUTHORIZATION_VERDICTS)[number]
export type AutonomyPiiPolicy = "public_safe" | "internal_review_identifiers" | "restricted"

export interface RecipientScopeRule {
  scopeId: string
  scopeType: RecipientScopeType
  description: string
  allowedAudience: string
  forbiddenPayloadFields: readonly string[]
  requiresRecipientFingerprint: true
}

export interface DeliverableAutonomyContract {
  deliverableId: string
  capabilityId: string
  lane: DeliverableLane
  initialAutonomyState: DeliverableAutonomyState
  eligibleAutonomyStates: readonly DeliverableAutonomyState[]
  readinessStatesAllowed: readonly DeliverableReadinessState[]
  recipientScopeRuleIds: readonly string[]
  freshnessTtlMinutes: number
  staleBehavior: StaleBehavior
  piiPolicy: AutonomyPiiPolicy
  shadowRunRequirement: number
  autoEligibility: AutoEligibility
  blockedReason?: string
  neverAutoReason?: string
}

export interface DeliverableAutonomyStateRecord {
  deliverableId: string
  autonomyState: DeliverableAutonomyState
  stateReason: string
  updatedAt: string
  updatedBy: string
  previousState?: DeliverableAutonomyState
}

export interface DeliveryGateResult {
  gateId: DeliveryGateId
  status: DeliveryGateResultStatus
  reason: string
  evidenceRefs: readonly string[]
}

export interface KillSwitchState {
  scope: KillSwitchScope
  scopeId: string
  enabled: boolean
  reason: string
  updatedAt: string
  updatedBy: string
}

export interface DeliveryLogEntry {
  deliveryLogId: string
  capabilityId: string
  deliverableId: string
  runId: string
  lane: DeliverableLane
  autonomyState: DeliverableAutonomyState
  readinessState: DeliverableReadinessState
  recipientFingerprint: string
  payloadFingerprint: string
  gateResults: readonly DeliveryGateResult[]
  status: DeliveryLogStatus
  createdAt: string
  createdBy: string
  correctionOf?: string
  supersededBy?: string
}

export interface DeliverableAutonomyValidationOptions {
  approvedExternalDeliveryAdapter?: boolean
  recipientScopeRules?: readonly RecipientScopeRule[]
}

export const recipientScopeRules = [
  recipientScopeRule(
    "recruiter_scoped_visibility",
    "individual_recruiter",
    "Recruiter-owned req progress, accountability, and scoped visibility outputs.",
    "Named recruiter recipient only",
    ["email", "phone", "candidate_email", "candidate_phone", "rawCandidatePayload", "token", "secret"]
  ),
  recipientScopeRule(
    "team_scoped_visibility",
    "team",
    "Team or recruiter-lead rollups with aggregate rows and no raw contact fields.",
    "Named team or recruiting lead audience",
    ["email", "phone", "candidate_email", "candidate_phone", "rawCandidatePayload", "token", "secret"]
  ),
  recipientScopeRule(
    "leadership_visibility",
    "leadership",
    "Executive, HOD, or leadership visibility over aggregate recruiting facts.",
    "Approved leadership audience",
    ["email", "phone", "candidate_email", "candidate_phone", "rawCandidatePayload", "token", "secret"]
  ),
  recipientScopeRule(
    "admin_action_review",
    "admin",
    "Mutation, access, candidate-impacting, and irreversible work staged for human review.",
    "Approved admin or RecOps reviewer",
    ["email", "phone", "candidate_email", "candidate_phone", "rawCandidatePayload", "token", "secret"]
  ),
  recipientScopeRule(
    "internal_audit",
    "internal_audit",
    "Local/internal custody, validation, delivery-log, and evidence surfaces.",
    "Internal Recruiting Ops audit audience",
    ["email", "phone", "candidate_email", "candidate_phone", "rawCandidatePayload", "token", "secret"]
  ),
] as const satisfies readonly RecipientScopeRule[]

export function validateRecipientScopeRule(rule: RecipientScopeRule): ValidationSummary {
  validateId(rule.scopeId, "recipientScopeRule.scopeId")
  assertKnownValue(rule.scopeType, RECIPIENT_SCOPE_TYPES, `${rule.scopeId}.scopeType`)
  assertNonEmptyString(rule.description, `${rule.scopeId}.description`)
  assertNonEmptyString(rule.allowedAudience, `${rule.scopeId}.allowedAudience`)
  if (rule.requiresRecipientFingerprint !== true) {
    throw new Error(`${rule.scopeId}.requiresRecipientFingerprint must be true`)
  }
  assertNonEmptyArray(rule.forbiddenPayloadFields, `${rule.scopeId}.forbiddenPayloadFields`)
  for (const field of rule.forbiddenPayloadFields) {
    assertNonEmptyString(field, `${rule.scopeId}.forbiddenPayloadFields`)
  }
  return {
    ok: true,
    id: rule.scopeId,
    checked: ["id", "scopeType", "audience", "fingerprint", "forbiddenPayloadFields"],
  }
}

export function validateRecipientScopeRules(
  rules: readonly RecipientScopeRule[] = recipientScopeRules
): { ok: true; count: number } {
  const seen = new Set<string>()
  for (const rule of rules) {
    validateRecipientScopeRule(rule)
    if (seen.has(rule.scopeId)) throw new Error(`Duplicate recipient scope rule: ${rule.scopeId}`)
    seen.add(rule.scopeId)
  }
  return { ok: true, count: rules.length }
}

export function getRecipientScopeRule(scopeId: string): RecipientScopeRule {
  const rule = recipientScopeRules.find((item) => item.scopeId === scopeId)
  if (!rule) throw new Error(`Unknown recipient scope rule: ${scopeId}`)
  return rule
}

export function validateDeliverableAutonomyContract(
  contract: DeliverableAutonomyContract,
  options: DeliverableAutonomyValidationOptions = {}
): ValidationSummary {
  validateId(contract.deliverableId, "deliverableAutonomy.deliverableId")
  validateId(contract.capabilityId, `${contract.deliverableId}.capabilityId`)
  getCapability(contract.capabilityId)
  assertKnownDeliverable(contract.deliverableId)
  assertKnownValue(contract.lane, DELIVERABLE_LANES, `${contract.deliverableId}.lane`)
  assertKnownValue(contract.initialAutonomyState, DELIVERABLE_AUTONOMY_STATES, `${contract.deliverableId}.initialAutonomyState`)
  assertNonEmptyArray(contract.eligibleAutonomyStates, `${contract.deliverableId}.eligibleAutonomyStates`)
  assertNonEmptyArray(contract.readinessStatesAllowed, `${contract.deliverableId}.readinessStatesAllowed`)
  assertNonEmptyArray(contract.recipientScopeRuleIds, `${contract.deliverableId}.recipientScopeRuleIds`)
  assertPositiveInteger(contract.freshnessTtlMinutes, `${contract.deliverableId}.freshnessTtlMinutes`)
  assertKnownValue(contract.staleBehavior, STALE_BEHAVIORS, `${contract.deliverableId}.staleBehavior`)
  assertKnownValue(contract.piiPolicy, ["public_safe", "internal_review_identifiers", "restricted"] as const, `${contract.deliverableId}.piiPolicy`)
  assertNonNegativeInteger(contract.shadowRunRequirement, `${contract.deliverableId}.shadowRunRequirement`)
  assertKnownValue(contract.autoEligibility, AUTO_ELIGIBILITY_STATES, `${contract.deliverableId}.autoEligibility`)
  assertCapabilityOwnsDeliverable(contract.capabilityId, contract.deliverableId)
  assertLaneStateCompatibility(contract, options.approvedExternalDeliveryAdapter === true)
  assertRecipientScopeReferences(contract.recipientScopeRuleIds, options.recipientScopeRules ?? recipientScopeRules)
  assertRationales(contract)
  return {
    ok: true,
    id: contract.deliverableId,
    checked: [
      "ids",
      "capability",
      "lane",
      "states",
      "freshness",
      "recipientScope",
      "shadow",
      "rationale",
    ],
  }
}

export function validateDeliverableAutonomyContracts(
  contracts: readonly DeliverableAutonomyContract[],
  options: DeliverableAutonomyValidationOptions = {}
): { ok: true; count: number } {
  const seen = new Set<string>()
  for (const contract of contracts) {
    validateDeliverableAutonomyContract(contract, options)
    if (seen.has(contract.deliverableId)) {
      throw new Error(`Duplicate deliverable autonomy contract: ${contract.deliverableId}`)
    }
    seen.add(contract.deliverableId)
  }
  return { ok: true, count: contracts.length }
}

export function createDeliverableAutonomyLookup(contracts: readonly DeliverableAutonomyContract[]): {
  getDeliverableAutonomyContract(deliverableId: string): DeliverableAutonomyContract
} {
  validateDeliverableAutonomyContracts(contracts)
  return {
    getDeliverableAutonomyContract(deliverableId: string): DeliverableAutonomyContract {
      const contract = contracts.find((item) => item.deliverableId === deliverableId)
      if (!contract) throw new Error(`Unknown deliverable autonomy contract: ${deliverableId}`)
      return contract
    },
  }
}

export function validateDeliverableAutonomyStateRecord(record: DeliverableAutonomyStateRecord): ValidationSummary {
  validateId(record.deliverableId, "autonomyStateRecord.deliverableId")
  assertKnownDeliverable(record.deliverableId)
  assertKnownValue(record.autonomyState, DELIVERABLE_AUTONOMY_STATES, `${record.deliverableId}.autonomyState`)
  if (record.previousState) {
    assertKnownValue(record.previousState, DELIVERABLE_AUTONOMY_STATES, `${record.deliverableId}.previousState`)
  }
  assertNonEmptyString(record.stateReason, `${record.deliverableId}.stateReason`)
  assertNonEmptyString(record.updatedAt, `${record.deliverableId}.updatedAt`)
  assertNonEmptyString(record.updatedBy, `${record.deliverableId}.updatedBy`)
  return { ok: true, id: record.deliverableId, checked: ["id", "state", "reason", "actor"] }
}

export function validateDeliveryGateResult(result: DeliveryGateResult): ValidationSummary {
  assertKnownValue(result.gateId, DELIVERY_GATE_IDS, "deliveryGateResult.gateId")
  assertKnownValue(result.status, DELIVERY_GATE_RESULT_STATUSES, `${result.gateId}.status`)
  assertNonEmptyString(result.reason, `${result.gateId}.reason`)
  return { ok: true, id: result.gateId, checked: ["gateId", "status", "reason"] }
}

export function validateKillSwitchState(state: KillSwitchState): ValidationSummary {
  assertKnownValue(state.scope, KILL_SWITCH_SCOPES, "killSwitch.scope")
  assertNonEmptyString(state.scopeId, `${state.scope}.scopeId`)
  assertNonEmptyString(state.reason, `${state.scope}.reason`)
  assertNonEmptyString(state.updatedAt, `${state.scope}.updatedAt`)
  assertNonEmptyString(state.updatedBy, `${state.scope}.updatedBy`)
  return { ok: true, id: `${state.scope}:${state.scopeId}`, checked: ["scope", "scopeId", "reason", "actor"] }
}

export function validateDeliveryLogEntry(entry: DeliveryLogEntry): ValidationSummary {
  validateId(entry.deliveryLogId, "deliveryLog.deliveryLogId")
  validateId(entry.capabilityId, `${entry.deliveryLogId}.capabilityId`)
  validateId(entry.deliverableId, `${entry.deliveryLogId}.deliverableId`)
  validateId(entry.runId, `${entry.deliveryLogId}.runId`)
  getCapability(entry.capabilityId)
  assertKnownDeliverable(entry.deliverableId)
  assertCapabilityOwnsDeliverable(entry.capabilityId, entry.deliverableId)
  assertKnownValue(entry.lane, DELIVERABLE_LANES, `${entry.deliveryLogId}.lane`)
  assertKnownValue(entry.autonomyState, DELIVERABLE_AUTONOMY_STATES, `${entry.deliveryLogId}.autonomyState`)
  assertKnownValue(entry.readinessState, DELIVERABLE_READINESS_STATES, `${entry.deliveryLogId}.readinessState`)
  assertNonEmptyString(entry.recipientFingerprint, `${entry.deliveryLogId}.recipientFingerprint`)
  assertNonEmptyString(entry.payloadFingerprint, `${entry.deliveryLogId}.payloadFingerprint`)
  for (const result of entry.gateResults) validateDeliveryGateResult(result)
  assertKnownValue(entry.status, DELIVERY_LOG_STATUSES, `${entry.deliveryLogId}.status`)
  assertNonEmptyString(entry.createdAt, `${entry.deliveryLogId}.createdAt`)
  assertNonEmptyString(entry.createdBy, `${entry.deliveryLogId}.createdBy`)
  return {
    ok: true,
    id: entry.deliveryLogId,
    checked: ["id", "capability", "deliverable", "fingerprints", "gateResults", "status"],
  }
}

function recipientScopeRule(
  scopeId: string,
  scopeType: RecipientScopeType,
  description: string,
  allowedAudience: string,
  forbiddenPayloadFields: readonly string[]
): RecipientScopeRule {
  return {
    scopeId,
    scopeType,
    description,
    allowedAudience,
    forbiddenPayloadFields,
    requiresRecipientFingerprint: true,
  }
}

function assertKnownDeliverable(deliverableId: string): void {
  if (!outputContractRegistry.some((row) => row.id === deliverableId)) {
    throw new Error(`Unknown deliverable: ${deliverableId}`)
  }
}

function assertCapabilityOwnsDeliverable(capabilityId: string, deliverableId: string): void {
  const capability = getCapability(capabilityId)
  if (!capability.deliverableIds.includes(deliverableId)) {
    throw new Error(`${capabilityId} does not own deliverable ${deliverableId}`)
  }
}

function assertRecipientScopeReferences(
  scopeIds: readonly string[],
  rules: readonly RecipientScopeRule[]
): void {
  validateRecipientScopeRules(rules)
  const known = new Set(rules.map((rule) => rule.scopeId))
  for (const scopeId of scopeIds) {
    if (!known.has(scopeId)) throw new Error(`Unknown recipient scope rule: ${scopeId}`)
  }
}

function assertLaneStateCompatibility(
  contract: DeliverableAutonomyContract,
  approvedExternalDeliveryAdapter: boolean
): void {
  const allowed = allowedStatesForLane(contract.lane, approvedExternalDeliveryAdapter)
  const states = [contract.initialAutonomyState, ...contract.eligibleAutonomyStates]
  if (states.includes("auto_delivering") && !approvedExternalDeliveryAdapter) {
    throw new Error(`${contract.deliverableId}.auto_delivering requires an approved external delivery adapter`)
  }
  for (const state of states) {
    assertKnownValue(state, DELIVERABLE_AUTONOMY_STATES, `${contract.deliverableId}.state`)
    if (!allowed.has(state)) {
      throw new Error(`${contract.deliverableId}.${state} is incompatible with lane ${contract.lane}`)
    }
  }
  if (!contract.eligibleAutonomyStates.includes(contract.initialAutonomyState)) {
    throw new Error(`${contract.deliverableId}.eligibleAutonomyStates must include initialAutonomyState`)
  }
  if (contract.autoEligibility === "candidate" && contract.lane !== "auto_delivery") {
    throw new Error(`${contract.deliverableId}.autoEligibility candidate requires auto_delivery lane`)
  }
  if (contract.lane === "auto_delivery" && contract.autoEligibility === "candidate" && contract.shadowRunRequirement <= 0) {
    throw new Error(`${contract.deliverableId}.shadowRunRequirement must be positive for auto_delivery candidates`)
  }
}

function allowedStatesForLane(
  lane: DeliverableLane,
  approvedExternalDeliveryAdapter: boolean
): ReadonlySet<DeliverableAutonomyState> {
  if (lane === "auto_delivery") {
    return new Set([
      "disabled",
      "dev_only",
      "shadow",
      "auto_eligible",
      "auto_paused",
      ...(approvedExternalDeliveryAdapter ? (["auto_delivering"] as const) : []),
    ])
  }
  if (lane === "review_assisted") {
    return new Set(["disabled", "dev_only", "shadow", "review_required"])
  }
  return new Set(["disabled", "dev_only", "review_required", "never_auto"])
}

function assertRationales(contract: DeliverableAutonomyContract): void {
  if (contract.autoEligibility === "blocked" && !contract.blockedReason?.trim()) {
    throw new Error(`${contract.deliverableId}.blockedReason is required when autoEligibility is blocked`)
  }
  if (
    (contract.autoEligibility === "never_auto" || contract.initialAutonomyState === "never_auto") &&
    !contract.neverAutoReason?.trim()
  ) {
    throw new Error(`${contract.deliverableId}.neverAutoReason is required for never_auto deliverables`)
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
}

function assertKnownValue<const T extends readonly string[]>(value: string, allowed: T, label: string): asserts value is T[number] {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} is invalid: ${value}`)
  }
}
