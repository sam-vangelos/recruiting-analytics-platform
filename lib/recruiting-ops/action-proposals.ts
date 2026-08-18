import { createLocalPiiFingerprint, isSupportedFingerprint } from "./checksums"
import { assertPublicSafe, redactForPublicValue } from "./safe-public-output"
import {
  assertKnownWorkflowIds,
  assertNonEmptyString,
  validateId,
  type ValidationSummary,
} from "./substrate"

export type ActionProposalTargetSystem = "greenhouse" | "linkedin" | "google_admin" | "gmail"
export type ActionProposalRiskTier = "low" | "medium" | "high" | "never"
export type ActionProposalApprovalState =
  | "drafted"
  | "needs_review"
  | "approved_for_manual_execution"
  | "rejected"
  | "deferred"
  | "blocked"
  | "executed_manually"

export type ActionProposalType =
  | "requisition_update"
  | "requisition_open"
  | "offer_update"
  | "offer_approval_review"
  | "greenhouse_user_update"
  | "linkedin_user_checklist"
  | "google_group_membership_update"
  | "inbox_draft"

export interface ActionProposal {
  proposalId: string
  workflowId: string
  /** Capability-first provenance — required on every proposal before persistence. */
  capabilityId: string
  targetSystem: ActionProposalTargetSystem
  targetReference: string
  actionType: ActionProposalType
  actor: string
  reason: string
  riskTier: ActionProposalRiskTier
  approvalState: ActionProposalApprovalState
  evidenceRefs: readonly string[]
  payloadFingerprint: string
  redactedPayloadSummary: Record<string, unknown>
  createdAt: string
  deferUntil?: string
  deferReason?: string
  manualExecutionAttestedAt?: string
  manualExecutionAttestedBy?: string
  externalReference?: string
  noLiveExecution: true
}

export function buildActionProposal(input: Omit<ActionProposal, "proposalId" | "payloadFingerprint" | "redactedPayloadSummary" | "noLiveExecution"> & {
  proposalId?: string
  proposedPayload: Record<string, unknown>
}): ActionProposal {
  const payloadFingerprint = createLocalPiiFingerprint(input.proposedPayload, "action_proposal_payload")
  const proposal = {
    proposalId:
      input.proposalId ??
      `proposal_${fingerprintToken(payloadFingerprint)}`,
    workflowId: input.workflowId,
    capabilityId: input.capabilityId,
    targetSystem: input.targetSystem,
    targetReference: input.targetReference,
    actionType: input.actionType,
    actor: input.actor,
    reason: input.reason,
    riskTier: input.riskTier,
    approvalState: input.approvalState,
    evidenceRefs: input.evidenceRefs,
    payloadFingerprint,
    redactedPayloadSummary: redactForPublicValue(input.proposedPayload) as Record<string, unknown>,
    createdAt: input.createdAt,
    deferUntil: input.deferUntil,
    deferReason: input.deferReason,
    manualExecutionAttestedAt: input.manualExecutionAttestedAt,
    manualExecutionAttestedBy: input.manualExecutionAttestedBy,
    externalReference: input.externalReference,
    noLiveExecution: true as const,
  }
  validateActionProposal(proposal)
  return proposal
}

function fingerprintToken(fingerprint: string): string {
  return fingerprint.slice(fingerprint.indexOf(":") + 1, fingerprint.indexOf(":") + 17)
}

export function validateActionProposal(proposal: ActionProposal): ValidationSummary {
  validateId(proposal.proposalId, "actionProposal.proposalId")
  assertKnownWorkflowIds([proposal.workflowId], `${proposal.proposalId}.workflowId`)
  assertNonEmptyString(proposal.capabilityId, `${proposal.proposalId}.capabilityId`)
  assertNonEmptyString(proposal.targetReference, `${proposal.proposalId}.targetReference`)
  assertNonEmptyString(proposal.actor, `${proposal.proposalId}.actor`)
  assertNonEmptyString(proposal.reason, `${proposal.proposalId}.reason`)
  assertNonEmptyString(proposal.payloadFingerprint, `${proposal.proposalId}.payloadFingerprint`)
  if (!isSupportedFingerprint(proposal.payloadFingerprint)) {
    throw new Error(`${proposal.proposalId}.payloadFingerprint must be a supported fingerprint`)
  }
  assertNonEmptyString(proposal.createdAt, `${proposal.proposalId}.createdAt`)
  if (proposal.evidenceRefs.length === 0) throw new Error(`${proposal.proposalId}.evidenceRefs must not be empty`)
  if (!proposal.noLiveExecution) throw new Error(`${proposal.proposalId} must remain dry-run only`)
  assertDeferralMetadata(proposal)
  assertManualExecutionAttestation(proposal)
  assertNeverTierGate(proposal)
  assertPublicSafe(proposal.redactedPayloadSummary, `${proposal.proposalId}.redactedPayloadSummary`)
  return {
    ok: true,
    id: proposal.proposalId,
    checked: ["id", "workflow", "target", "evidence", "fingerprint", "dryRun", "publicSafety"],
  }
}

export function summarizeActionProposalForPublic(proposal: ActionProposal): Record<string, unknown> {
  validateActionProposal(proposal)
  return {
    proposalId: proposal.proposalId,
    workflowId: proposal.workflowId,
    targetSystem: proposal.targetSystem,
    actionType: proposal.actionType,
    riskTier: proposal.riskTier,
    approvalState: proposal.approvalState,
    externalReference: proposal.externalReference,
    evidenceCount: proposal.evidenceRefs.length,
    payloadFingerprint: proposal.payloadFingerprint,
  }
}

function assertNeverTierGate(proposal: ActionProposal): void {
  if (proposal.riskTier !== "never") return
  if (proposal.approvalState === "approved_for_manual_execution" || proposal.approvalState === "executed_manually") {
    throw new Error(`${proposal.proposalId} never-tier action cannot be approved`)
  }
}

function assertDeferralMetadata(proposal: ActionProposal): void {
  if (proposal.approvalState !== "deferred") return
  if (!proposal.deferUntil?.trim()) throw new Error(`${proposal.proposalId}.deferUntil is required when deferred`)
  if (!proposal.deferReason?.trim()) throw new Error(`${proposal.proposalId}.deferReason is required when deferred`)
}

function assertManualExecutionAttestation(proposal: ActionProposal): void {
  if (proposal.approvalState !== "executed_manually") return
  if (!proposal.manualExecutionAttestedAt?.trim()) {
    throw new Error(`${proposal.proposalId}.manualExecutionAttestedAt is required when executed_manually`)
  }
  if (!proposal.manualExecutionAttestedBy?.trim()) {
    throw new Error(`${proposal.proposalId}.manualExecutionAttestedBy is required when executed_manually`)
  }
}
