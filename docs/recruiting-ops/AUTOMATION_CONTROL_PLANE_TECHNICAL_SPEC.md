# Automation Control Plane Technical Spec

Status: Active
Date: 2026-06-25
Owner: the operator

## Purpose

This spec translates the automation-control-plane philosophy into Phase 0 TypeScript contracts. Phase 0 is contract foundation only: no UI expansion, no production delivery adapters, no live Greenhouse writes, no external-channel sends, no broad PII persistence, and no legacy retirement.

The product model is:

`Capability -> Deliverable -> Lane -> Readiness -> Delivery Authorization -> Gate Evaluation -> Delivery Log`

Readiness != Delivery Authorization. A deliverable can be structurally ready, fresh, and locally rendered while still being unauthorized for external delivery. Delivery authorization is controlled by lane, autonomy state, quality gates, kill switches, recipient-scope rules, and approved adapter posture.

## Phase 0 Public Contracts

Implement these contracts under `lib/recruiting-ops/` before adding UI or production adapters.

```ts
export type DeliverableLane = "auto_delivery" | "review_assisted" | "action_proposal"

export type DeliverableAutonomyState =
  | "disabled"
  | "dev_only"
  | "shadow"
  | "review_required"
  | "auto_eligible"
  | "auto_delivering"
  | "auto_paused"
  | "never_auto"

export type DeliverableReadinessState =
  | "draft_only"
  | "ready_for_review"
  | "ready_with_warnings"
  | "ready_for_delivery"
  | "blocked"
  | "evidence_only"
  | "human_only"
  | "retired_by_signoff"

export type StaleBehavior = "warn" | "block"

export type RecipientScopeType = "individual_recruiter" | "team" | "leadership" | "admin" | "internal_audit"

export type DeliveryGateId =
  | "boundary"
  | "mode"
  | "freshness"
  | "discrepancy_tolerance"
  | "source_gap"
  | "template_stability"
  | "recipient_scope"
  | "pii_posture"
  | "idempotency"
  | "trust_period"
  | "kill_switch"

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
  piiPolicy: "public_safe" | "internal_review_identifiers" | "restricted"
  shadowRunRequirement: number
  autoEligibility: "candidate" | "blocked" | "never_auto"
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
  status: "pass" | "warn" | "fail" | "not_applicable"
  reason: string
  evidenceRefs: readonly string[]
}

export interface KillSwitchState {
  scope: "global" | "capability" | "deliverable" | "recipient_scope"
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
  status: "shadowed" | "delivered" | "paused" | "blocked" | "superseded" | "correction_recorded"
  createdAt: string
  createdBy: string
  correctionOf?: string
  supersededBy?: string
}
```

## Output Contract Migration

`ConcreteOutputContract` must gain automation fields without changing renderer behavior in Phase 0:

- `capabilityId`, copied from the capability registry binding.
- `lane`, copied from the seed matrix.
- `initialAutonomyState`, copied from the seed matrix.
- `freshnessTtlMinutes` and `staleBehavior`.
- `recipientScopeRuleIds`.
- `deliveryLogRequired: true`.
- `deliveryAuthorizationRequired: true`.

Output-contract readiness validates that an artifact is structurally usable. It does not authorize delivery. Delivery authorization requires a gate-evaluator result and an autonomy state that permits the requested mode.

## Action Proposal State Reconciliation

The current action proposal vocabulary is intentionally transitional. Phase 0 must migrate the state names to this model:

| New state | Meaning |
|---|---|
| `drafted` | Proposal exists but has not reached review. |
| `needs_review` | Proposal needs a human to evaluate it. |
| `approved_for_manual_execution` | Human approved manual execution outside the system. This is not live execution by the app. |
| `rejected` | Human rejected the proposal. |
| `deferred` | Human deferred the proposal until a stated date or condition. |
| `blocked` | Proposal cannot proceed because evidence, scope, authorization, or safety gates are missing. |
| `executed_manually` | Human attested that the action was executed outside the app. |

The action proposal record must add `deferUntil`, `deferReason`, `manualExecutionAttestedAt`, `manualExecutionAttestedBy`, and `externalReference`. These fields are metadata only; Phase 0 must not add live write execution.

## Gate Evaluator Contract

The first evaluator is deterministic and local-only. It accepts a deliverable ID, an autonomy contract, output-contract metadata, run/evidence metadata, source-gap/discrepancy counts, recipient-scope information, kill-switch state, and shadow history. It returns `DeliveryGateResult[]` plus a final authorization verdict:

- `authorized_for_shadow`
- `authorized_for_review`
- `authorized_for_auto_delivery`
- `paused`
- `blocked`

Any failed gate must create a delivery-log entry with status `paused` or `blocked`. A `warn` result can only pass when the lane and state allow warnings.

## Phase 0 Non-Goals

- No external delivery adapter.
- No Google Sheets, Google Docs, Slack, Gmail, Greenhouse, LinkedIn, Power BI, or n8n write path.
- No live Greenhouse write path.
- No production persistence migration.
- No broad candidate PII storage.
- No LLM-authored auto-delivery.
- No legacy retirement or cutover.
