import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type N8nCustodyPacketRowType = "workflow_export" | "mailgun_custody" | "dry_run_event"
export type N8nCustodyStatus = "captured" | "export_required" | "owner_required" | "rotation_required" | "blocked" | "unknown"
export type N8nDryRunStatus = "passed" | "failed" | "not_run" | "blocked"

export interface N8nWorkflowSetupFact {
  workflowId: string
  workflowName: string
  exportStatus: string
  activeState?: string
  owner?: string
  exportedAt?: string
}

export interface MailgunCustodyFact {
  credentialId: string
  sendingDomain: string
  custodyStatus: string
  owner?: string
  observedAt?: string
}

export interface N8nDryRunEventFact {
  eventId: string
  workflowId: string
  eventStatus: string
  observedAt: string
  sampleOutputCaptured: boolean
  owner?: string
}

export interface LegacyN8nCustodyEvidenceRow {
  entity_id: string
  status?: N8nCustodyStatus
  dry_run_status?: N8nDryRunStatus
}

export interface N8nCustodyPacketRow {
  row_type: N8nCustodyPacketRowType
  entity_id: string
  workflow_id: string
  status: N8nCustodyStatus
  owner: string | null
  observed_at: string
  dry_run_status: N8nDryRunStatus
  evidence_captured: boolean
  review_required: boolean
  blocker_reason: string
}

export interface RunN8nWorkflowSetupModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  workflowFacts: readonly N8nWorkflowSetupFact[]
  mailgunFacts: readonly MailgunCustodyFact[]
  dryRunEvents: readonly N8nDryRunEventFact[]
  legacyRows?: readonly LegacyN8nCustodyEvidenceRow[]
}

export const n8nWorkflowSetupModuleDefinition = {
  moduleId: "t16-n8n-workflow-setup",
  workflowId: "T16",
  capabilityId: "automation_custody",
  title: "T16 n8n Workflow Setup",
  sourceIds: ["n8n", "mailgun"],
  queryIds: [],
  legacyArtifactIds: ["legacy_n8n_mailgun_custody_packet"],
  outputContractIds: ["n8n_custody_packet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "n8n_custody_packet")!
if (!outputContract) throw new Error("Missing n8n custody packet concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_n8n_mailgun_custody_packet")!
if (!legacyArtifact) throw new Error("Missing n8n/Mailgun custody legacy artifact")

export function normalizeN8nCustodyPacketRows(input: {
  workflowFacts: readonly N8nWorkflowSetupFact[]
  mailgunFacts: readonly MailgunCustodyFact[]
  dryRunEvents: readonly N8nDryRunEventFact[]
}): N8nCustodyPacketRow[] {
  const workflowRows = input.workflowFacts.map((fact) => {
    const status = normalizeCustodyStatus(fact.exportStatus)
    return packetRow({
      row_type: "workflow_export",
      entity_id: fact.workflowId,
      workflow_id: fact.workflowId,
      status,
      owner: fact.owner,
      observed_at: fact.exportedAt,
      dry_run_status: "not_run",
      evidence_captured: status === "captured",
      blocker_reason: status === "captured" ? "" : "Workflow export or disabled-safe configuration evidence is incomplete.",
    })
  })
  const mailgunRows = input.mailgunFacts.map((fact) => {
    const status = normalizeCustodyStatus(fact.custodyStatus)
    return packetRow({
      row_type: "mailgun_custody",
      entity_id: fact.credentialId,
      workflow_id: "",
      status,
      owner: fact.owner,
      observed_at: fact.observedAt,
      dry_run_status: "not_run",
      evidence_captured: status === "captured",
      blocker_reason: status === "captured" ? "" : `Mailgun ownership evidence is incomplete for ${fact.sendingDomain}.`,
    })
  })
  const dryRunRows = input.dryRunEvents.map((fact) => {
    const dryRunStatus = normalizeDryRunStatus(fact.eventStatus)
    const status = dryRunStatus === "passed" && fact.sampleOutputCaptured ? "captured" : dryRunStatus === "failed" ? "blocked" : "export_required"
    return packetRow({
      row_type: "dry_run_event",
      entity_id: fact.eventId,
      workflow_id: fact.workflowId,
      status,
      owner: fact.owner,
      observed_at: fact.observedAt,
      dry_run_status: dryRunStatus,
      evidence_captured: fact.sampleOutputCaptured,
      blocker_reason:
        status === "captured" ? "" : "Dry-run event must pass with redacted sample-output evidence before cutover.",
    })
  })

  return [...workflowRows, ...mailgunRows, ...dryRunRows].sort((a, b) =>
    [a.row_type, a.entity_id].join("|").localeCompare([b.row_type, b.entity_id].join("|"))
  )
}

export async function runN8nWorkflowSetupModule(
  input: RunN8nWorkflowSetupModuleInput
): Promise<RecruitingOpsModuleResult<N8nCustodyPacketRow>> {
  const runId = buildRunId(n8nWorkflowSetupModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizeN8nCustodyPacketRows(input)
  const sourceGaps = buildN8nCustodySourceGaps(input.workflowFacts, input.mailgunFacts, input.dryRunEvents, normalizedRows)
  const discrepancies = buildN8nCustodyDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "n8n workflow setup, Mailgun custody, and disabled-safe dry-run evidence.",
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: n8nWorkflowSetupModuleDefinition.workflowId,
    moduleId: n8nWorkflowSetupModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    reviewRequiredCount: normalizedRows.filter((row) => row.review_required).length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: n8nWorkflowSetupModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: n8nWorkflowSetupModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: n8nWorkflowSetupModuleDefinition.workflowId,
    capabilityId: n8nWorkflowSetupModuleDefinition.capabilityId,
    moduleId: n8nWorkflowSetupModuleDefinition.moduleId,
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
    definition: n8nWorkflowSetupModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

export function normalizeCustodyStatus(value: string): N8nCustodyStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["captured", "exported", "owner_confirmed", "complete", "disabled_safe"].includes(normalized)) return "captured"
  if (["export_required", "needs_export", "missing_export"].includes(normalized)) return "export_required"
  if (["owner_required", "owner_confirm_required", "custody_required"].includes(normalized)) return "owner_required"
  if (["rotation_required", "rotate", "reissue"].includes(normalized)) return "rotation_required"
  if (["blocked", "failed"].includes(normalized)) return "blocked"
  return "unknown"
}

export function normalizeDryRunStatus(value: string): N8nDryRunStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["passed", "pass", "succeeded", "success"].includes(normalized)) return "passed"
  if (["failed", "fail", "error"].includes(normalized)) return "failed"
  if (["blocked"].includes(normalized)) return "blocked"
  return "not_run"
}

function packetRow(input: {
  row_type: N8nCustodyPacketRowType
  entity_id: string
  workflow_id: string
  status: N8nCustodyStatus
  owner?: string
  observed_at?: string
  dry_run_status: N8nDryRunStatus
  evidence_captured: boolean
  blocker_reason: string
}): N8nCustodyPacketRow {
  return {
    row_type: input.row_type,
    entity_id: input.entity_id,
    workflow_id: input.workflow_id,
    status: input.status,
    owner: input.owner?.trim() || null,
    observed_at: input.observed_at ?? "",
    dry_run_status: input.dry_run_status,
    evidence_captured: input.evidence_captured,
    review_required: input.status !== "captured" || input.dry_run_status === "failed" || input.owner?.trim() === "",
    blocker_reason: input.blocker_reason,
  }
}

function buildN8nCustodySourceGaps(
  workflowFacts: readonly N8nWorkflowSetupFact[],
  mailgunFacts: readonly MailgunCustodyFact[],
  dryRunEvents: readonly N8nDryRunEventFact[],
  rows: readonly N8nCustodyPacketRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (workflowFacts.length === 0) {
    gaps.push({
      id: "gap_t16_n8n_export_missing",
      workflowId: "T16",
      sourceId: "n8n",
      field: "workflowFacts",
      reason: "n8n setup requires exported workflow metadata before rebuild or retirement decisions.",
      blocksCutover: true,
    })
  }
  if (mailgunFacts.length === 0) {
    gaps.push({
      id: "gap_t16_mailgun_custody_missing",
      workflowId: "T16",
      sourceId: "mailgun",
      field: "mailgunFacts",
      reason: "Mailgun ownership evidence is required before the duplicate workflow can be operated safely.",
      blocksCutover: true,
    })
  }
  if (!dryRunEvents.some((event) => normalizeDryRunStatus(event.eventStatus) === "passed" && event.sampleOutputCaptured)) {
    gaps.push({
      id: "gap_t16_dry_run_evidence_missing",
      workflowId: "T16",
      sourceId: "n8n",
      field: "dryRunEvents",
      reason: "At least one disabled-safe passing dry-run event with redacted sample evidence is required.",
      blocksCutover: true,
    })
  }
  for (const row of rows) {
    if (row.owner === null) {
      gaps.push({
        id: `gap_t16_owner_${row.entity_id}`,
        workflowId: "T16",
        sourceId: row.row_type === "mailgun_custody" ? "mailgun" : "n8n",
        field: "owner",
        reason: `Custody owner is unmapped for ${row.entity_id}.`,
        blocksCutover: false,
      })
    }
    if (row.status === "rotation_required") {
      // Mirrors the t17 Apps Script gate: a secret-bearing credential (e.g. a Mailgun
      // sending key) must be rotated before any preserve/export of the duplicate workflow.
      gaps.push({
        id: `gap_t16_rotation_${row.entity_id}`,
        workflowId: "T16",
        sourceId: row.row_type === "mailgun_custody" ? "mailgun" : "n8n",
        field: "credential_rotation",
        reason: `${row.entity_id}: credential is secret-bearing and must be rotated before any preserve/export action.`,
        blocksCutover: true,
      })
    }
  }
  return gaps
}

function buildN8nCustodyDiscrepancies(
  runId: string,
  rows: readonly N8nCustodyPacketRow[],
  legacyRows: readonly LegacyN8nCustodyEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: n8nWorkflowSetupModuleDefinition.capabilityId,
      workflowId: "T16",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy n8n/Mailgun custody packet may contain this evidence.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByEntity = new Map(legacyRows.map((row) => [row.entity_id, row]))
  for (const row of rows) {
    const legacy = legacyByEntity.get(row.entity_id)
    if (!legacy) continue
    if (legacy.status && legacy.status !== row.status) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: n8nWorkflowSetupModuleDefinition.capabilityId,
          workflowId: "T16",
          class: "stale_mapping",
          severity: "warning",
          entityKey: row.entity_id,
          field: "status",
          modernValueSummary: row.status,
          legacyValueSummary: legacy.status,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "open",
          owner: "Jordan",
        })
      )
    }
    if (legacy.dry_run_status && legacy.dry_run_status !== row.dry_run_status) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: n8nWorkflowSetupModuleDefinition.capabilityId,
          workflowId: "T16",
          class: "business_definition_open",
          severity: "warning",
          entityKey: row.entity_id,
          field: "dry_run_status",
          modernValueSummary: row.dry_run_status,
          legacyValueSummary: legacy.dry_run_status,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "open",
          owner: "Jordan",
        })
      )
    }
  }
  return discrepancies
}
