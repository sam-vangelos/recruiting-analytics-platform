import { describe, expect, test } from "vitest"

import {
  buildActionProposal,
  summarizeActionProposalForPublic,
  validateActionProposal,
  type ActionProposal,
} from "../lib/recruiting-ops/action-proposals"

const baseProposalInput = {
  workflowId: "S01",
  capabilityId: "requisition_lifecycle_control",
  targetSystem: "greenhouse",
  targetReference: "req:123",
  actionType: "requisition_update",
  actor: "Jordan",
  reason: "correct ownership evidence from command-center review",
  riskTier: "high",
  approvalState: "needs_review",
  evidenceRefs: ["legacy_q13_q14_role_assignment"],
  proposedPayload: {
    requisitionId: "123",
    proposedOwner: "Jordan",
    token: "should-not-leak",
  },
  createdAt: "2026-06-24T07:00:00.000Z",
} as const

describe("recruiting ops dry-run action proposals", () => {
  test("builds dry-run proposals with fingerprinted and redacted payload summaries", () => {
    const proposal = buildActionProposal(baseProposalInput)

    expect(proposal.proposalId).toMatch(/^proposal_/)
    expect(proposal.noLiveExecution).toBe(true)
    expect(proposal.payloadFingerprint).toMatch(/^hmac-sha256:/)
    expect(Object.keys(proposal.redactedPayloadSummary)).not.toContain("token")
    expect(Object.values(proposal.redactedPayloadSummary)).toContain("[REDACTED]")
    expect(validateActionProposal(proposal).ok).toBe(true)
    expect(summarizeActionProposalForPublic(proposal)).toMatchObject({
      workflowId: "S01",
      targetSystem: "greenhouse",
      actionType: "requisition_update",
      riskTier: "high",
      approvalState: "needs_review",
    })
  })

  test("rejects attempts to cross the dry-run boundary", () => {
    const proposal = buildActionProposal(baseProposalInput)

    expect(() =>
      validateActionProposal({
        ...proposal,
        noLiveExecution: false,
      } as unknown as ActionProposal)
    ).toThrow("dry-run only")
  })

  test("blocks never-tier proposal approval", () => {
    expect(() =>
      buildActionProposal({
        ...baseProposalInput,
        actionType: "offer_approval_review",
        workflowId: "S02",
        riskTier: "never",
        approvalState: "approved_for_manual_execution",
      })
    ).toThrow("never-tier action cannot be approved")
  })

  test("records deferral metadata and manual-execution attestation without live execution", () => {
    const deferred = buildActionProposal({
      ...baseProposalInput,
      approvalState: "deferred",
      deferUntil: "2026-07-01",
      deferReason: "waiting for owner confirmation",
    })
    const executedManually = buildActionProposal({
      ...baseProposalInput,
      approvalState: "executed_manually",
      manualExecutionAttestedAt: "2026-06-25T08:00:00.000Z",
      manualExecutionAttestedBy: "Jordan",
      externalReference: "greenhouse:req_123",
    })

    expect(deferred.noLiveExecution).toBe(true)
    expect(deferred.deferReason).toBe("waiting for owner confirmation")
    expect(executedManually.noLiveExecution).toBe(true)
    expect(executedManually.manualExecutionAttestedBy).toBe("Jordan")
    expect(executedManually.externalReference).toBe("greenhouse:req_123")
  })

  test("requires metadata for deferred and manual execution proposal states", () => {
    expect(() =>
      buildActionProposal({
        ...baseProposalInput,
        approvalState: "deferred",
      })
    ).toThrow("deferUntil is required")

    expect(() =>
      buildActionProposal({
        ...baseProposalInput,
        approvalState: "executed_manually",
      })
    ).toThrow("manualExecutionAttestedAt is required")
  })

  test("requires evidence references", () => {
    expect(() =>
      buildActionProposal({
        ...baseProposalInput,
        evidenceRefs: [],
      })
    ).toThrow("evidenceRefs must not be empty")
  })
})
