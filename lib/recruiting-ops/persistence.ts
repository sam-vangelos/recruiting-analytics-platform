import type { ActionProposal } from "./action-proposals"
import type { Discrepancy } from "./discrepancies"
import { legacyArtifactRegistry } from "./legacy-artifact-registry"
import type { LegacyArtifact } from "./legacy-artifacts"
import { concreteOutputContracts, type ConcreteOutputContract } from "./output-contracts"
import { workflowRegistry, type WorkflowRegistryRow } from "./registries"
import type { CommandCenterRun, RunArtifact, SourceGap } from "./runs"
import type { SourceEvidenceRef } from "./substrate"

export interface PersistedWorkflowRegistryRow {
  id: string
  title: string
  category: string
  cadence: string
  priority: string
  status: string
  capability: string
  source_ids: readonly string[]
  query_ids: readonly string[]
  output_contract_ids: readonly string[]
  provenance: readonly unknown[]
  blockers: readonly string[]
  next_gate: string
}

export interface PersistedLegacyArtifactRow {
  id: string
  artifact_type: string
  workflow_ids: readonly string[]
  query_ids: readonly string[]
  script_asset_ids: readonly string[]
  output_contract_ids: readonly string[]
  source_id: string
  title: string
  location_label: string
  custody_status: string
  access_status: string
  expected_headers: readonly string[]
  provenance: readonly unknown[]
  blockers: readonly string[]
  next_gate: string
}

export interface PersistedOutputContractRow {
  id: string
  source_contract_id: string
  workflow_ids: readonly string[]
  renderer: string
  format: string
  schema_version: string
  capability_id: string
  lane: string
  initial_autonomy_state: string
  freshness_ttl_minutes: number
  stale_behavior: string
  recipient_scope_rule_ids: readonly string[]
  delivery_log_required: true
  delivery_authorization_required: true
  columns: readonly unknown[]
  manual_fields: readonly string[]
  validation_checks: readonly string[]
  pii_policy: string
  source_ids: readonly string[]
  production_write_enabled: false
  provenance: readonly unknown[]
  blockers: readonly string[]
  next_gate: string
}

export interface PersistedRunRow {
  run_id: string
  workflow_id: string
  capability_id: string
  module_id: string
  mode: string
  status: string
  started_at: string
  completed_at?: string
  input_checksum: string
  normalized_row_count: number
  normalized_checksum: string
  /** Audit lineage: which legacy artifacts this run was diffed against (020). */
  legacy_artifact_refs: readonly string[]
  public_summary: Record<string, unknown>
}

export interface PersistedRunEvidenceRefRow {
  run_id: string
  evidence_ref_id: string
  source_id: string
  adapter: string
  label: string
  artifact_id?: string
}

export interface PersistedRunArtifactRow {
  artifact_id: string
  run_id: string
  workflow_id: string
  capability_id: string
  format: string
  path: string
  row_count: number
  checksum: string
  schema_version: string
  source_refs: readonly string[]
  public_summary: Record<string, unknown>
}

export interface PersistedSourceGapRow {
  id: string
  run_id: string
  workflow_id: string
  capability_id: string
  source_id: string
  field: string
  reason: string
  blocks_cutover: boolean
}

export interface PersistedDiscrepancyRow {
  id: string
  run_id: string
  workflow_id: string
  capability_id: string
  class: string
  severity: string
  entity_key: string
  field: string
  modern_value_summary: string
  legacy_value_summary: string
  evidence_refs: readonly string[]
  resolution_status: string
  owner: string
}

export interface PersistedActionProposalRow {
  proposal_id: string
  workflow_id: string
  capability_id: string
  target_system: string
  target_reference: string
  action_type: string
  actor: string
  reason: string
  risk_tier: string
  approval_state: string
  evidence_refs: readonly string[]
  payload_fingerprint: string
  redacted_payload_summary: Record<string, unknown>
  created_at: string
  defer_until?: string
  defer_reason?: string
  manual_execution_attested_at?: string
  manual_execution_attested_by?: string
  external_reference?: string
  no_live_execution: true
}

export function workflowRegistryPersistenceRows(
  rows: readonly WorkflowRegistryRow[] = workflowRegistry
): PersistedWorkflowRegistryRow[] {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    cadence: row.cadence,
    priority: row.priority,
    status: row.status,
    capability: row.capability,
    source_ids: row.sourceIds,
    query_ids: row.queryIds,
    output_contract_ids: row.outputContractIds,
    provenance: row.provenance,
    blockers: row.blockers,
    next_gate: row.nextGate,
  }))
}

export function legacyArtifactPersistenceRows(
  rows: readonly LegacyArtifact[] = legacyArtifactRegistry
): PersistedLegacyArtifactRow[] {
  return rows.map((row) => ({
    id: row.id,
    artifact_type: row.artifactType,
    workflow_ids: row.workflowIds,
    query_ids: row.queryIds,
    script_asset_ids: row.scriptAssetIds,
    output_contract_ids: row.outputContractIds,
    source_id: row.sourceId,
    title: row.title,
    location_label: row.locationLabel,
    custody_status: row.custodyStatus,
    access_status: row.accessStatus,
    expected_headers: row.expectedHeaders,
    provenance: row.provenance,
    blockers: row.blockers,
    next_gate: row.nextGate,
  }))
}

export function outputContractPersistenceRows(
  rows: readonly ConcreteOutputContract[] = concreteOutputContracts
): PersistedOutputContractRow[] {
  return rows.map((row) => ({
    id: row.id,
    source_contract_id: row.sourceContractId,
    workflow_ids: row.workflowIds,
    renderer: row.renderer,
    format: row.format,
    schema_version: row.schemaVersion,
    capability_id: row.capabilityId,
    lane: row.lane,
    initial_autonomy_state: row.initialAutonomyState,
    freshness_ttl_minutes: row.freshnessTtlMinutes,
    stale_behavior: row.staleBehavior,
    recipient_scope_rule_ids: row.recipientScopeRuleIds,
    delivery_log_required: row.deliveryLogRequired,
    delivery_authorization_required: row.deliveryAuthorizationRequired,
    columns: row.columns,
    manual_fields: row.manualFields,
    validation_checks: row.validationChecks,
    pii_policy: row.piiPolicy,
    source_ids: row.sourceIds,
    production_write_enabled: row.productionWriteEnabled,
    provenance: row.provenance,
    blockers: row.blockers,
    next_gate: row.nextGate,
  }))
}

export function runPersistenceRow(run: CommandCenterRun): PersistedRunRow {
  return {
    run_id: run.runId,
    workflow_id: run.workflowId,
    capability_id: requireCapability(run.capabilityId, run.runId),
    module_id: run.moduleId,
    mode: run.mode,
    status: run.status,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    input_checksum: run.inputChecksum,
    normalized_row_count: run.normalizedRowCount,
    normalized_checksum: run.normalizedChecksum,
    legacy_artifact_refs: run.legacyArtifactRefs,
    public_summary: run.publicSummary,
  }
}

export function runEvidenceRefPersistenceRows(run: CommandCenterRun): PersistedRunEvidenceRefRow[] {
  return run.sourceRefs.map((ref) => sourceEvidenceRefPersistenceRow(run.runId, ref))
}

export function sourceEvidenceRefPersistenceRow(runId: string, ref: SourceEvidenceRef): PersistedRunEvidenceRefRow {
  return {
    run_id: runId,
    evidence_ref_id: ref.id,
    source_id: ref.sourceId,
    adapter: ref.adapter,
    label: ref.label,
    artifact_id: ref.artifactId,
  }
}

export function runArtifactPersistenceRows(run: CommandCenterRun): PersistedRunArtifactRow[] {
  return run.artifactRefs.map(runArtifactPersistenceRow)
}

export function runArtifactPersistenceRow(artifact: RunArtifact): PersistedRunArtifactRow {
  return {
    artifact_id: artifact.artifactId,
    run_id: artifact.runId,
    workflow_id: artifact.workflowId,
    capability_id: requireCapability(artifact.capabilityId, artifact.artifactId),
    format: artifact.format,
    path: artifact.path,
    row_count: artifact.rowCount,
    checksum: artifact.checksum,
    schema_version: artifact.schemaVersion,
    source_refs: artifact.sourceRefs,
    public_summary: artifact.publicSummary,
  }
}

export function sourceGapPersistenceRows(run: CommandCenterRun): PersistedSourceGapRow[] {
  return run.sourceGaps.map((gap) => sourceGapPersistenceRow(run.runId, gap))
}

export function sourceGapPersistenceRow(runId: string, gap: SourceGap): PersistedSourceGapRow {
  return {
    // Gap ids are deterministic per record/field, so they REPEAT across runs;
    // the persisted primary key is runId-scoped to keep every run's gaps.
    id: `${runId}__${gap.id}`,
    run_id: runId,
    workflow_id: gap.workflowId,
    capability_id: requireCapability(gap.capabilityId, gap.id),
    source_id: gap.sourceId,
    field: gap.field,
    reason: gap.reason,
    blocks_cutover: gap.blocksCutover,
  }
}

export function discrepancyPersistenceRows(discrepancies: readonly Discrepancy[]): PersistedDiscrepancyRow[] {
  return discrepancies.map((discrepancy) => ({
    id: discrepancy.id,
    run_id: discrepancy.runId,
    workflow_id: discrepancy.workflowId,
    capability_id: requireCapability(discrepancy.capabilityId, discrepancy.id),
    class: discrepancy.class,
    severity: discrepancy.severity,
    entity_key: discrepancy.entityKey,
    field: discrepancy.field,
    modern_value_summary: discrepancy.modernValueSummary,
    legacy_value_summary: discrepancy.legacyValueSummary,
    evidence_refs: discrepancy.evidenceRefs,
    resolution_status: discrepancy.resolutionStatus,
    owner: discrepancy.owner,
  }))
}

export function actionProposalPersistenceRow(proposal: ActionProposal): PersistedActionProposalRow {
  return {
    proposal_id: proposal.proposalId,
    workflow_id: proposal.workflowId,
    capability_id: requireCapability(proposal.capabilityId, proposal.proposalId),
    target_system: proposal.targetSystem,
    target_reference: proposal.targetReference,
    action_type: proposal.actionType,
    actor: proposal.actor,
    reason: proposal.reason,
    risk_tier: proposal.riskTier,
    approval_state: proposal.approvalState,
    evidence_refs: proposal.evidenceRefs,
    payload_fingerprint: proposal.payloadFingerprint,
    redacted_payload_summary: proposal.redactedPayloadSummary,
    created_at: proposal.createdAt,
    defer_until: proposal.deferUntil,
    defer_reason: proposal.deferReason,
    manual_execution_attested_at: proposal.manualExecutionAttestedAt,
    manual_execution_attested_by: proposal.manualExecutionAttestedBy,
    external_reference: proposal.externalReference,
    no_live_execution: proposal.noLiveExecution,
  }
}

/**
 * Capability-first provenance guard. capabilityId is optional on some substrate
 * record types (so module literals stay terse), but it must be present and
 * stamped before any record reaches a persistence row — never persist an
 * unattributed run, artifact, source gap, discrepancy, or proposal.
 */
function requireCapability(capabilityId: string | undefined, ref: string): string {
  if (!capabilityId) {
    throw new Error(`Missing capabilityId provenance for ${ref} (must be stamped before persistence)`)
  }
  return capabilityId
}
