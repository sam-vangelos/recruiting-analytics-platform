import {
  buildActionProposal,
  type ActionProposal,
  type ActionProposalApprovalState,
  type ActionProposalRiskTier,
  type ActionProposalTargetSystem,
  type ActionProposalType,
} from "../action-proposals"
import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type AdminActionWorkflowId = "S01" | "S02" | "S05" | "S06" | "S07"

export interface AdminActionRequestFact {
  workflowId: AdminActionWorkflowId
  targetReference: string
  targetSystem: ActionProposalTargetSystem
  actionType: ActionProposalType
  actor: string
  reason: string
  riskTier: ActionProposalRiskTier
  approvalState: ActionProposalApprovalState
  evidenceRefs: readonly string[]
  proposedPayload: Record<string, unknown>
  createdAt: string
  deferUntil?: string
  deferReason?: string
  manualExecutionAttestedAt?: string
  manualExecutionAttestedBy?: string
  externalReference?: string
}

export interface AdminActionQueueRow {
  proposal_id: string
  workflow_id: AdminActionWorkflowId
  target_system: ActionProposalTargetSystem
  target_reference: string
  action_type: ActionProposalType
  risk_tier: ActionProposalRiskTier
  approval_state: ActionProposalApprovalState
  evidence_count: number
  payload_fingerprint: string
  defer_until?: string
  defer_reason?: string
  manual_execution_attested_at?: string
  manual_execution_attested_by?: string
  external_reference?: string
  no_live_execution: boolean
  review_required: boolean
}

export interface RunAdminActionQueueModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  workflowId: AdminActionWorkflowId
  actionRequests: readonly AdminActionRequestFact[]
}

interface AdminActionQueueConfig {
  definition: RecruitingOpsModuleDefinition
  legacyArtifactId: string
  outputContractId: string
  expectedTargetSystem: ActionProposalTargetSystem
}

export const adminActionQueueConfigs = {
  S01: config(
    "s01-requisition-action-queue",
    "S01",
    "S01 Open / Update Requisitions",
    "legacy_s01_requisition_action_runbook",
    "requisition_action_queue",
    "greenhouse",
    "requisition_lifecycle_control"
  ),
  S02: config(
    "s02-offer-action-queue",
    "S02",
    "S02 Approve / Update Offers",
    "legacy_s02_offer_action_runbook",
    "offer_action_queue",
    "greenhouse",
    "offer_administration"
  ),
  S05: config(
    "s05-greenhouse-user-action-queue",
    "S05",
    "S05 Create / Modify Greenhouse Users",
    "legacy_s05_greenhouse_user_runbook",
    "greenhouse_user_action_queue",
    "greenhouse",
    "access_and_identity_administration"
  ),
  S06: config(
    "s06-linkedin-manual-action-queue",
    "S06",
    "S06 Update LinkedIn Users",
    "legacy_s06_linkedin_user_runbook",
    "linkedin_manual_action_queue",
    "linkedin",
    "access_and_identity_administration"
  ),
  S07: config(
    "s07-google-groups-action-queue",
    "S07",
    "S07 Update Google Groups TA Team",
    "legacy_s07_google_groups_runbook",
    "google_groups_action_queue",
    "google_admin",
    "access_and_identity_administration"
  ),
} as const satisfies Record<AdminActionWorkflowId, AdminActionQueueConfig>

export async function runAdminActionQueueModule(
  input: RunAdminActionQueueModuleInput
): Promise<RecruitingOpsModuleResult<AdminActionQueueRow>> {
  const cfg = adminActionQueueConfigs[input.workflowId]
  const runId = buildRunId(input.workflowId, input.startedAt)
  const scopedActionRequests = input.actionRequests.filter((request) => request.workflowId === input.workflowId)
  const proposals = buildAdminActionProposals(scopedActionRequests, cfg.definition.capabilityId)
  const normalizedRows = proposals.map(proposalToRow).sort((a, b) => a.proposal_id.localeCompare(b.proposal_id))
  const sourceGaps = buildAdminActionSourceGaps(input.workflowId, cfg, scopedActionRequests, proposals)
  const discrepancies = buildAdminActionDiscrepancies(runId, cfg.definition.capabilityId, input.workflowId, cfg.legacyArtifactId, sourceGaps)
  const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === cfg.legacyArtifactId)!
  if (!legacyArtifact) throw new Error(`Missing legacy artifact: ${cfg.legacyArtifactId}`)
  const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === cfg.outputContractId)!
  if (!outputContract) throw new Error(`Missing concrete output contract: ${cfg.outputContractId}`)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: `${cfg.definition.title} legacy runbook and witnessed-action evidence.`,
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: input.workflowId,
    moduleId: cfg.definition.moduleId,
    normalizedRowCount: normalizedRows.length,
    reviewRequiredCount: normalizedRows.filter((row) => row.review_required).length,
    blockedProposalCount: normalizedRows.filter((row) => row.approval_state === "blocked").length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: input.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: input.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: input.workflowId,
    capabilityId: cfg.definition.capabilityId,
    moduleId: cfg.definition.moduleId,
    mode: "fixture",
    status: sourceGaps.some((gap) => gap.blocksCutover) ? "blocked" : "succeeded",
    startedAt: input.startedAt,
    completedAt: input.generatedAt,
    sourceRefs,
    legacyArtifactRefs: [legacyArtifact.id],
    normalizedRows,
    artifactRefs: [jsonArtifact, csvArtifact],
    sourceGaps,
    discrepancies,
    publicSummary,
  })

  return finalizeModuleResult({
    definition: cfg.definition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

export function buildAdminActionProposals(
  actionRequests: readonly AdminActionRequestFact[],
  capabilityId: string
): ActionProposal[] {
  return actionRequests.map((request) =>
    buildActionProposal({
      workflowId: request.workflowId,
      capabilityId,
      targetSystem: request.targetSystem,
      targetReference: request.targetReference,
      actionType: request.actionType,
      actor: request.actor,
      reason: request.reason,
      riskTier: request.riskTier,
      approvalState: request.approvalState,
      evidenceRefs: request.evidenceRefs.length > 0 ? request.evidenceRefs : ["missing_evidence"],
      proposedPayload: request.proposedPayload,
      createdAt: request.createdAt,
      deferUntil: request.deferUntil,
      deferReason: request.deferReason,
      manualExecutionAttestedAt: request.manualExecutionAttestedAt,
      manualExecutionAttestedBy: request.manualExecutionAttestedBy,
      externalReference: request.externalReference,
    })
  )
}

function proposalToRow(proposal: ActionProposal): AdminActionQueueRow {
  return {
    proposal_id: proposal.proposalId,
    workflow_id: proposal.workflowId as AdminActionWorkflowId,
    target_system: proposal.targetSystem,
    target_reference: proposal.targetReference,
    action_type: proposal.actionType,
    risk_tier: proposal.riskTier,
    approval_state: proposal.approvalState,
    evidence_count: proposal.evidenceRefs.filter((ref) => ref !== "missing_evidence").length,
    payload_fingerprint: proposal.payloadFingerprint,
    defer_until: proposal.deferUntil,
    defer_reason: proposal.deferReason,
    manual_execution_attested_at: proposal.manualExecutionAttestedAt,
    manual_execution_attested_by: proposal.manualExecutionAttestedBy,
    external_reference: proposal.externalReference,
    no_live_execution: proposal.noLiveExecution,
    review_required: !["approved_for_manual_execution", "executed_manually"].includes(proposal.approvalState),
  }
}

function buildAdminActionSourceGaps(
  workflowId: AdminActionWorkflowId,
  cfg: AdminActionQueueConfig,
  requests: readonly AdminActionRequestFact[],
  proposals: readonly ActionProposal[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  const scopedRequests = requests.filter((request) => request.workflowId === workflowId)
  if (scopedRequests.length === 0) {
    gaps.push({
      id: `gap_${workflowId.toLowerCase()}_action_requests_missing`,
      workflowId,
      sourceId: cfg.expectedTargetSystem,
      field: "actionRequests",
      reason: `${workflowId} requires at least one dry-run admin action proposal for validation.`,
      blocksCutover: true,
    })
  }
  for (const request of scopedRequests) {
    if (request.targetSystem !== cfg.expectedTargetSystem) {
      gaps.push({
        id: `gap_${workflowId.toLowerCase()}_target_system_${request.targetReference}`,
        workflowId,
        sourceId: cfg.expectedTargetSystem,
        field: "targetSystem",
        reason: `${workflowId} proposal ${request.targetReference} targets ${request.targetSystem}, expected ${cfg.expectedTargetSystem}.`,
        blocksCutover: true,
      })
    }
    if (request.evidenceRefs.length === 0) {
      gaps.push({
        id: `gap_${workflowId.toLowerCase()}_evidence_${request.targetReference}`,
        workflowId,
        sourceId: cfg.expectedTargetSystem,
        field: "evidenceRefs",
        reason: `${workflowId} proposal ${request.targetReference} has no evidence reference.`,
        blocksCutover: true,
      })
    }
  }
  for (const proposal of proposals.filter((item) => item.workflowId === workflowId)) {
    if (proposal.approvalState === "blocked" || proposal.approvalState === "rejected") {
      gaps.push({
        id: `gap_${workflowId.toLowerCase()}_approval_${proposal.targetReference}`,
        workflowId,
        sourceId: cfg.expectedTargetSystem,
        field: "approvalState",
        reason: `${workflowId} proposal ${proposal.targetReference} is ${proposal.approvalState}.`,
        blocksCutover: true,
      })
    }
    if (proposal.riskTier === "never") {
      gaps.push({
        id: `gap_${workflowId.toLowerCase()}_never_tier_${proposal.targetReference}`,
        workflowId,
        sourceId: cfg.expectedTargetSystem,
        field: "riskTier",
        reason: `${workflowId} proposal ${proposal.targetReference} is never-tier and must remain manual review only.`,
        blocksCutover: true,
      })
    }
  }
  return gaps
}

function buildAdminActionDiscrepancies(
  runId: string,
  capabilityId: string,
  workflowId: AdminActionWorkflowId,
  legacyArtifactId: string,
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  return sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId,
      workflowId,
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy admin runbook may contain this evidence or manual boundary.",
      evidenceRefs: [legacyArtifactId],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )
}

function config(
  moduleId: string,
  workflowId: AdminActionWorkflowId,
  title: string,
  legacyArtifactId: string,
  outputContractId: string,
  expectedTargetSystem: ActionProposalTargetSystem,
  capabilityId: string
): AdminActionQueueConfig {
  return {
    definition: {
      moduleId,
      workflowId,
      capabilityId,
      title,
      sourceIds: [expectedTargetSystem],
      queryIds: [],
      legacyArtifactIds: [legacyArtifactId],
      outputContractIds: [outputContractId],
    },
    legacyArtifactId,
    outputContractId,
    expectedTargetSystem,
  }
}
