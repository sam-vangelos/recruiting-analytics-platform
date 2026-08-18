import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type DuplicateReviewStatus = "needs_review" | "ready_for_owner" | "insufficient_evidence"
export type DuplicateCustodyStatus = "captured" | "export_required" | "credential_owner_required" | "unknown"

export interface DuplicateCandidateCaseFact {
  caseId: string
  primaryApplicationId: string
  duplicateApplicationId: string
  confidence: number
  matchSignals: readonly string[]
  owner?: string
}

export interface DuplicateAutomationCustodyFact {
  workflowId: string
  workflowExportStatus: DuplicateCustodyStatus
  mailgunCredentialStatus: DuplicateCustodyStatus
  owner?: string
}

export interface LegacyDuplicateCandidateEvidenceRow {
  case_id: string
  review_status?: DuplicateReviewStatus
  confidence?: number
}

export interface DuplicateCandidateReviewRow {
  case_id: string
  primary_application_id: string
  duplicate_application_id: string
  confidence: number
  match_signals: string
  review_status: DuplicateReviewStatus
  custody_status: DuplicateCustodyStatus
  owner: string | null
  review_required: boolean
}

export interface RunDuplicateCandidateReviewModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  duplicateCases: readonly DuplicateCandidateCaseFact[]
  custodyFacts: readonly DuplicateAutomationCustodyFact[]
  legacyRows?: readonly LegacyDuplicateCandidateEvidenceRow[]
}

export const duplicateCandidateReviewModuleDefinition = {
  moduleId: "t15-duplicate-candidate-review",
  workflowId: "T15",
  capabilityId: "candidate_identity_resolution",
  title: "T15 Duplicate Candidate Check Agent",
  sourceIds: ["greenhouse", "n8n", "mailgun"],
  queryIds: [],
  legacyArtifactIds: ["legacy_duplicate_candidate_n8n_workflow"],
  outputContractIds: ["duplicate_candidate_review_queue"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find(
  (contract) => contract.sourceContractId === "duplicate_candidate_review_queue"
)!
if (!outputContract) throw new Error("Missing duplicate candidate review concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_duplicate_candidate_n8n_workflow")!
if (!legacyArtifact) throw new Error("Missing duplicate candidate legacy artifact")

export function normalizeDuplicateCandidateReviewRows(input: {
  duplicateCases: readonly DuplicateCandidateCaseFact[]
  custodyFacts: readonly DuplicateAutomationCustodyFact[]
}): DuplicateCandidateReviewRow[] {
  const custodyStatus = aggregateCustodyStatus(input.custodyFacts)
  return input.duplicateCases
    .map((item) => ({
      case_id: item.caseId,
      primary_application_id: item.primaryApplicationId,
      duplicate_application_id: item.duplicateApplicationId,
      confidence: clampConfidence(item.confidence),
      match_signals: item.matchSignals.join("|"),
      review_status: reviewStatusForCase(item),
      custody_status: custodyStatus,
      owner: item.owner?.trim() || input.custodyFacts[0]?.owner?.trim() || null,
      review_required: true,
    }))
    .sort((a, b) => a.case_id.localeCompare(b.case_id))
}

export async function runDuplicateCandidateReviewModule(
  input: RunDuplicateCandidateReviewModuleInput
): Promise<RecruitingOpsModuleResult<DuplicateCandidateReviewRow>> {
  const runId = buildRunId(duplicateCandidateReviewModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizeDuplicateCandidateReviewRows(input)
  const sourceGaps = buildDuplicateCandidateSourceGaps(input.duplicateCases, input.custodyFacts, normalizedRows)
  const discrepancies = buildDuplicateCandidateDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "greenhouse_t15_duplicate_case_facts",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Greenhouse-shaped application pair facts for duplicate-candidate review.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Duplicate candidate n8n workflow and Mailgun custody evidence.",
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: duplicateCandidateReviewModuleDefinition.workflowId,
    moduleId: duplicateCandidateReviewModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    reviewRequiredCount: normalizedRows.filter((row) => row.review_required).length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    deliverableId: outputContract.sourceContractId,
    workflowId: duplicateCandidateReviewModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    deliverableId: outputContract.sourceContractId,
    workflowId: duplicateCandidateReviewModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: duplicateCandidateReviewModuleDefinition.workflowId,
    capabilityId: duplicateCandidateReviewModuleDefinition.capabilityId,
    moduleId: duplicateCandidateReviewModuleDefinition.moduleId,
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
    definition: duplicateCandidateReviewModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

function buildDuplicateCandidateSourceGaps(
  duplicateCases: readonly DuplicateCandidateCaseFact[],
  custodyFacts: readonly DuplicateAutomationCustodyFact[],
  rows: readonly DuplicateCandidateReviewRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (duplicateCases.length === 0) {
    gaps.push({
      id: "gap_t15_duplicate_cases_missing",
      workflowId: "T15",
      sourceId: "greenhouse",
      field: "duplicateCases",
      reason: "Duplicate review queue requires deterministic application-pair evidence.",
      blocksCutover: true,
    })
  }
  if (custodyFacts.length === 0 || aggregateCustodyStatus(custodyFacts) !== "captured") {
    gaps.push({
      id: "gap_t15_n8n_mailgun_custody",
      workflowId: "T15",
      sourceId: "n8n",
      field: "custody_status",
      reason: "Duplicate candidate workflow requires n8n export and Mailgun credential-owner custody evidence.",
      blocksCutover: true,
    })
  }
  for (const row of rows) {
    if (row.owner === null) {
      gaps.push({
        id: `gap_t15_owner_${row.case_id}`,
        workflowId: "T15",
        sourceId: "greenhouse",
        field: "owner",
        reason: `Duplicate candidate review owner is unmapped for ${row.case_id}.`,
        blocksCutover: false,
      })
    }
  }
  return gaps
}

function buildDuplicateCandidateDiscrepancies(
  runId: string,
  rows: readonly DuplicateCandidateReviewRow[],
  legacyRows: readonly LegacyDuplicateCandidateEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: duplicateCandidateReviewModuleDefinition.capabilityId,
      workflowId: "T15",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy n8n/Mailgun workflow may contain this duplicate-review evidence.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByCase = new Map(legacyRows.map((row) => [row.case_id, row]))
  for (const row of rows) {
    const legacy = legacyByCase.get(row.case_id)
    if (!legacy) continue
    if (legacy.review_status && legacy.review_status !== row.review_status) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: duplicateCandidateReviewModuleDefinition.capabilityId,
          workflowId: "T15",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `case:${row.case_id}`,
          field: "review_status",
          modernValueSummary: `Command-center review status ${row.review_status}`,
          legacyValueSummary: `Legacy duplicate review status ${legacy.review_status}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (typeof legacy.confidence === "number" && legacy.confidence !== row.confidence) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: duplicateCandidateReviewModuleDefinition.capabilityId,
          workflowId: "T15",
          class: "stale_mapping",
          severity: "warning",
          entityKey: `case:${row.case_id}`,
          field: "confidence",
          modernValueSummary: `Command-center confidence ${row.confidence}`,
          legacyValueSummary: `Legacy duplicate confidence ${legacy.confidence}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}

function reviewStatusForCase(item: DuplicateCandidateCaseFact): DuplicateReviewStatus {
  if (item.matchSignals.length === 0 || item.confidence < 0.5) return "insufficient_evidence"
  if (item.confidence >= 0.85) return "ready_for_owner"
  return "needs_review"
}

function aggregateCustodyStatus(custodyFacts: readonly DuplicateAutomationCustodyFact[]): DuplicateCustodyStatus {
  if (custodyFacts.length === 0) return "unknown"
  return custodyFacts.every(
    (fact) => fact.workflowExportStatus === "captured" && fact.mailgunCredentialStatus === "captured"
  )
    ? "captured"
    : "export_required"
}

function clampConfidence(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return Number(value.toFixed(4))
}
