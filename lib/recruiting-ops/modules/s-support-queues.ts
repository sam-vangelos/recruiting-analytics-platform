import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type SupportWorkflowId = "S03" | "S04"
export type SupportQueueStatus = "accepted" | "ready" | "needs_review" | "blocked" | "unknown"

export interface GreenhouseClarificationFact {
  caseId: string
  topic: string
  status: string
  owner?: string
  evidenceIds: readonly string[]
  decisionRequired: boolean
  nextGate?: string
}

export interface RecruitingInboxTriageFact {
  itemId: string
  category: string
  status: string
  owner?: string
  evidenceIds: readonly string[]
  draftResponse?: string
  humanSendRequired: boolean
  nextGate?: string
}

export interface LegacySupportQueueEvidenceRow {
  item_id: string
  status?: SupportQueueStatus
}

export interface SupportQueueRow {
  item_id: string
  workflow_id: SupportWorkflowId
  source_system: "greenhouse" | "gmail"
  category: string
  status: SupportQueueStatus
  owner: string | null
  evidence_count: number
  draft_response: string
  human_action_required: boolean
  review_required: boolean
  next_gate: string
}

export interface RunSupportQueueModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  workflowId: SupportWorkflowId
  clarificationFacts?: readonly GreenhouseClarificationFact[]
  inboxFacts?: readonly RecruitingInboxTriageFact[]
  legacyRows?: readonly LegacySupportQueueEvidenceRow[]
}

interface SupportQueueConfig {
  definition: RecruitingOpsModuleDefinition
  legacyArtifactId: string
  outputContractId: string
  sourceSystem: "greenhouse" | "gmail"
}

export const supportQueueConfigs = {
  S03: config(
    "s03-greenhouse-clarification-log",
    "S03",
    "S03 Greenhouse Clarifications",
    "legacy_s03_greenhouse_clarification_log",
    "greenhouse_clarification_log",
    "greenhouse"
  ),
  S04: config(
    "s04-recruiting-inbox-queue",
    "S04",
    "S04 Recruiting Inbox Responses",
    "legacy_s04_recruiting_inbox_runbook",
    "recruiting_inbox_queue",
    "gmail"
  ),
} as const satisfies Record<SupportWorkflowId, SupportQueueConfig>

export async function runSupportQueueModule(
  input: RunSupportQueueModuleInput
): Promise<RecruitingOpsModuleResult<SupportQueueRow>> {
  const cfg = supportQueueConfigs[input.workflowId]
  const runId = buildRunId(input.workflowId, input.startedAt)
  const normalizedRows =
    input.workflowId === "S03"
      ? normalizeGreenhouseClarificationRows(input.clarificationFacts ?? [])
      : normalizeRecruitingInboxRows(input.inboxFacts ?? [])
  const sourceGaps = buildSupportSourceGaps(input.workflowId, cfg, normalizedRows)
  const discrepancies = buildSupportDiscrepancies(
    runId,
    cfg.definition.capabilityId,
    input.workflowId,
    cfg.legacyArtifactId,
    normalizedRows,
    input.legacyRows ?? [],
    sourceGaps
  )
  const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === cfg.legacyArtifactId)!
  if (!legacyArtifact) throw new Error(`Missing legacy artifact: ${cfg.legacyArtifactId}`)
  const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === cfg.outputContractId)!
  if (!outputContract) throw new Error(`Missing concrete output contract: ${cfg.outputContractId}`)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: `${cfg.definition.title} support runbook and queue evidence.`,
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: input.workflowId,
    moduleId: cfg.definition.moduleId,
    normalizedRowCount: normalizedRows.length,
    reviewRequiredCount: normalizedRows.filter((row) => row.review_required).length,
    humanActionRequiredCount: normalizedRows.filter((row) => row.human_action_required).length,
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

export function normalizeGreenhouseClarificationRows(
  facts: readonly GreenhouseClarificationFact[]
): SupportQueueRow[] {
  return facts
    .map((fact) => {
      const status = normalizeSupportStatus(fact.status)
      return {
        item_id: fact.caseId,
        workflow_id: "S03" as const,
        source_system: "greenhouse" as const,
        category: fact.topic,
        status,
        owner: fact.owner?.trim() || null,
        evidence_count: fact.evidenceIds.length,
        draft_response: "",
        human_action_required: fact.decisionRequired,
        review_required: status !== "accepted" || fact.decisionRequired || fact.evidenceIds.length === 0,
        next_gate: fact.nextGate?.trim() || nextGateForSupportStatus(status),
      }
    })
    .sort((a, b) => a.item_id.localeCompare(b.item_id))
}

export function normalizeRecruitingInboxRows(facts: readonly RecruitingInboxTriageFact[]): SupportQueueRow[] {
  return facts
    .map((fact) => {
      const status = normalizeSupportStatus(fact.status)
      const draftResponse = fact.draftResponse?.trim() ?? ""
      return {
        item_id: fact.itemId,
        workflow_id: "S04" as const,
        source_system: "gmail" as const,
        category: fact.category,
        status,
        owner: fact.owner?.trim() || null,
        evidence_count: fact.evidenceIds.length,
        draft_response: draftResponse,
        human_action_required: fact.humanSendRequired,
        review_required:
          status !== "accepted" || fact.humanSendRequired || fact.evidenceIds.length === 0 || draftResponse.length === 0,
        next_gate: fact.nextGate?.trim() || nextGateForSupportStatus(status),
      }
    })
    .sort((a, b) => a.item_id.localeCompare(b.item_id))
}

export function normalizeSupportStatus(value: string): SupportQueueStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["accepted", "resolved", "closed"].includes(normalized)) return "accepted"
  if (["ready", "drafted"].includes(normalized)) return "ready"
  if (["needs_review", "pending", "open"].includes(normalized)) return "needs_review"
  if (["blocked", "failed"].includes(normalized)) return "blocked"
  return "unknown"
}

function nextGateForSupportStatus(status: SupportQueueStatus): string {
  if (status === "accepted") return "Preserve evidence and keep external action human-owned."
  if (status === "ready") return "Request human owner review."
  if (status === "needs_review") return "Resolve open question or approve draft."
  if (status === "blocked") return "Resolve blocker before external action."
  return "Clarify support status with owner."
}

function buildSupportSourceGaps(
  workflowId: SupportWorkflowId,
  cfg: SupportQueueConfig,
  rows: readonly SupportQueueRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (rows.length === 0) {
    gaps.push({
      id: `gap_${workflowId.toLowerCase()}_support_rows_missing`,
      workflowId,
      sourceId: cfg.sourceSystem,
      field: "supportRows",
      reason: `${workflowId} requires at least one local support queue row for validation.`,
      blocksCutover: true,
    })
  }
  for (const row of rows) {
    if (row.evidence_count === 0) {
      gaps.push({
        id: `gap_${workflowId.toLowerCase()}_evidence_${row.item_id}`,
        workflowId,
        sourceId: cfg.sourceSystem,
        field: "evidence_count",
        reason: `${workflowId} support item ${row.item_id} has no evidence reference.`,
        blocksCutover: true,
      })
    }
    if (row.owner === null) {
      gaps.push({
        id: `gap_${workflowId.toLowerCase()}_owner_${row.item_id}`,
        workflowId,
        sourceId: cfg.sourceSystem,
        field: "owner",
        reason: `${workflowId} support item ${row.item_id} has no owner.`,
        blocksCutover: false,
      })
    }
    if (row.status === "blocked" || row.status === "unknown") {
      gaps.push({
        id: `gap_${workflowId.toLowerCase()}_status_${row.item_id}`,
        workflowId,
        sourceId: cfg.sourceSystem,
        field: "status",
        reason: `${workflowId} support item ${row.item_id} is ${row.status}.`,
        blocksCutover: true,
      })
    }
    if (workflowId === "S04" && row.draft_response.length === 0) {
      gaps.push({
        id: `gap_s04_draft_${row.item_id}`,
        workflowId,
        sourceId: cfg.sourceSystem,
        field: "draft_response",
        reason: `S04 inbox item ${row.item_id} has no local draft response.`,
        blocksCutover: true,
      })
    }
  }
  return gaps
}

function buildSupportDiscrepancies(
  runId: string,
  capabilityId: string,
  workflowId: SupportWorkflowId,
  legacyArtifactId: string,
  rows: readonly SupportQueueRow[],
  legacyRows: readonly LegacySupportQueueEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId,
      workflowId,
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy support runbook may contain this evidence or owner rule.",
      evidenceRefs: [legacyArtifactId],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )
  const legacyByItem = new Map(legacyRows.map((row) => [row.item_id, row]))
  for (const row of rows) {
    const legacy = legacyByItem.get(row.item_id)
    if (legacy?.status && legacy.status !== row.status) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId,
          workflowId,
          class: "business_definition_open",
          severity: "warning",
          entityKey: row.item_id,
          field: "status",
          modernValueSummary: row.status,
          legacyValueSummary: legacy.status,
          evidenceRefs: [legacyArtifactId],
          resolutionStatus: "open",
          owner: "Jordan",
        })
      )
    }
  }
  return discrepancies
}

function config(
  moduleId: string,
  workflowId: SupportWorkflowId,
  title: string,
  legacyArtifactId: string,
  outputContractId: string,
  sourceSystem: "greenhouse" | "gmail"
): SupportQueueConfig {
  return {
    definition: {
      moduleId,
      workflowId,
      capabilityId: "recruiting_inbox_triage",
      title,
      sourceIds: [sourceSystem],
      queryIds: [],
      legacyArtifactIds: [legacyArtifactId],
      outputContractIds: [outputContractId],
    },
    legacyArtifactId,
    outputContractId,
    sourceSystem,
  }
}
