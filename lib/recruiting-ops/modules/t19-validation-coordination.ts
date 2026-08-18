import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type ValidationStatus = "accepted" | "needs_review" | "blocked" | "missing_evidence" | "unknown"
export type AttestationStatus = "accepted" | "pending" | "rejected" | "not_requested" | "unknown"

export interface ValidationTargetFact {
  targetId: string
  workflowId: string
  moduleId: string
  runId: string
  owner: string
  evidenceIds: readonly string[]
  openDiscrepancyCount: number
  blockingCount: number
  sourceGapCount: number
  nextGate?: string
}

export interface OwnerAttestationFact {
  targetId: string
  owner: string
  status: string
  attestedAt?: string
}

export interface LegacyValidationEvidenceRow {
  target_id: string
  validation_status?: ValidationStatus
  attestation_status?: AttestationStatus
}

export interface ValidationSignoffLogRow {
  target_id: string
  workflow_id: string
  run_id: string
  validation_status: ValidationStatus
  attestation_status: AttestationStatus
  owner: string | null
  evidence_count: number
  open_discrepancy_count: number
  blocking_count: number
  source_gap_count: number
  next_gate: string
  review_required: boolean
}

export interface RunValidationCoordinationModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  validationTargets: readonly ValidationTargetFact[]
  attestations: readonly OwnerAttestationFact[]
  legacyRows?: readonly LegacyValidationEvidenceRow[]
}

export const validationCoordinationModuleDefinition = {
  moduleId: "t19-validation-coordination",
  workflowId: "T19",
  capabilityId: "transition_readiness_control",
  title: "T19 Validation Coordination",
  sourceIds: ["slack", "google_sheets"],
  queryIds: [],
  legacyArtifactIds: ["legacy_validation_coordination_log"],
  outputContractIds: ["validation_signoff_log"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "validation_signoff_log")!
if (!outputContract) throw new Error("Missing validation signoff concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_validation_coordination_log")!
if (!legacyArtifact) throw new Error("Missing validation coordination legacy artifact")

export function normalizeValidationSignoffRows(input: {
  validationTargets: readonly ValidationTargetFact[]
  attestations: readonly OwnerAttestationFact[]
}): ValidationSignoffLogRow[] {
  const attestationByTarget = new Map(input.attestations.map((item) => [item.targetId, item]))
  return input.validationTargets
    .map((target) => {
      const attestation = attestationByTarget.get(target.targetId)
      const attestation_status = normalizeAttestationStatus(attestation?.status)
      const validation_status = deriveValidationStatus(target, attestation_status)
      return {
        target_id: target.targetId,
        workflow_id: target.workflowId,
        run_id: target.runId,
        validation_status,
        attestation_status,
        owner: attestation?.owner?.trim() || target.owner.trim() || null,
        evidence_count: target.evidenceIds.length,
        open_discrepancy_count: target.openDiscrepancyCount,
        blocking_count: target.blockingCount,
        source_gap_count: target.sourceGapCount,
        next_gate: target.nextGate?.trim() || nextGateForStatus(validation_status),
        review_required: validation_status !== "accepted",
      }
    })
    .sort((a, b) => [a.workflow_id, a.target_id].join("|").localeCompare([b.workflow_id, b.target_id].join("|")))
}

export async function runValidationCoordinationModule(
  input: RunValidationCoordinationModuleInput
): Promise<RecruitingOpsModuleResult<ValidationSignoffLogRow>> {
  const runId = buildRunId(validationCoordinationModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizeValidationSignoffRows(input)
  const sourceGaps = buildValidationSourceGaps(input.validationTargets, normalizedRows)
  const discrepancies = buildValidationDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "t19_local_run_evidence",
      sourceId: "google_sheets",
      adapter: "local_renderer",
      label: "Command-center run, evidence, discrepancy, and owner-attestation facts for validation coordination.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Legacy validation coordination tracker and owner signoff pattern.",
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: validationCoordinationModuleDefinition.workflowId,
    moduleId: validationCoordinationModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    acceptedCount: normalizedRows.filter((row) => row.validation_status === "accepted").length,
    reviewRequiredCount: normalizedRows.filter((row) => row.review_required).length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: validationCoordinationModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: validationCoordinationModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: validationCoordinationModuleDefinition.workflowId,
    capabilityId: validationCoordinationModuleDefinition.capabilityId,
    moduleId: validationCoordinationModuleDefinition.moduleId,
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
    definition: validationCoordinationModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

export function normalizeAttestationStatus(value: string | undefined): AttestationStatus {
  if (!value) return "not_requested"
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["accepted", "approved", "signed_off"].includes(normalized)) return "accepted"
  if (["pending", "requested", "waiting"].includes(normalized)) return "pending"
  if (["rejected", "failed"].includes(normalized)) return "rejected"
  if (["not_requested", "n/a", "na"].includes(normalized)) return "not_requested"
  return "unknown"
}

export function deriveValidationStatus(target: ValidationTargetFact, attestationStatus: AttestationStatus): ValidationStatus {
  if (target.blockingCount > 0 || target.sourceGapCount > 0 || attestationStatus === "rejected") return "blocked"
  if (target.evidenceIds.length === 0) return "missing_evidence"
  if (attestationStatus === "accepted" && target.openDiscrepancyCount === 0) return "accepted"
  if (["pending", "not_requested", "unknown"].includes(attestationStatus) || target.openDiscrepancyCount > 0) {
    return "needs_review"
  }
  return "unknown"
}

function nextGateForStatus(status: ValidationStatus): string {
  if (status === "accepted") return "Ready for next gated module or shadow-run evidence package."
  if (status === "missing_evidence") return "Attach required evidence before owner signoff."
  if (status === "blocked") return "Resolve blocking discrepancy, source gap, or rejected attestation."
  if (status === "needs_review") return "Request owner review and classify open differences."
  return "Clarify validation state with the operator."
}

function buildValidationSourceGaps(
  validationTargets: readonly ValidationTargetFact[],
  rows: readonly ValidationSignoffLogRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (validationTargets.length === 0) {
    gaps.push({
      id: "gap_t19_validation_targets_missing",
      workflowId: "T19",
      sourceId: "google_sheets",
      field: "validationTargets",
      reason: "Validation coordination requires at least one module run or handoff target.",
      blocksCutover: true,
    })
  }
  for (const row of rows) {
    if (row.evidence_count === 0) {
      gaps.push({
        id: `gap_t19_evidence_${row.target_id}`,
        workflowId: "T19",
        sourceId: "google_sheets",
        field: "evidence_count",
        reason: `Validation target ${row.target_id} has no attached evidence.`,
        blocksCutover: true,
      })
    }
    if (row.attestation_status !== "accepted") {
      gaps.push({
        id: `gap_t19_attestation_${row.target_id}`,
        workflowId: "T19",
        sourceId: "slack",
        field: "attestation_status",
        reason: `Validation target ${row.target_id} does not have accepted owner attestation.`,
        blocksCutover: true,
      })
    }
    if (row.owner === null) {
      gaps.push({
        id: `gap_t19_owner_${row.target_id}`,
        workflowId: "T19",
        sourceId: "google_sheets",
        field: "owner",
        reason: `Validation target ${row.target_id} has no owner.`,
        blocksCutover: false,
      })
    }
  }
  return gaps
}

function buildValidationDiscrepancies(
  runId: string,
  rows: readonly ValidationSignoffLogRow[],
  legacyRows: readonly LegacyValidationEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: validationCoordinationModuleDefinition.capabilityId,
      workflowId: "T19",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy validation tracker may contain this evidence.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByTarget = new Map(legacyRows.map((row) => [row.target_id, row]))
  for (const row of rows) {
    const legacy = legacyByTarget.get(row.target_id)
    if (!legacy) continue
    for (const field of ["validation_status", "attestation_status"] as const) {
      if (legacy[field] && legacy[field] !== row[field]) {
        discrepancies.push(
          buildDiscrepancy({
            runId,
            capabilityId: validationCoordinationModuleDefinition.capabilityId,
            workflowId: "T19",
            class: "business_definition_open",
            severity: "warning",
            entityKey: row.target_id,
            field,
            modernValueSummary: row[field],
            legacyValueSummary: legacy[field],
            evidenceRefs: [legacyArtifact.id],
            resolutionStatus: "open",
            owner: "Jordan",
          })
        )
      }
    }
  }
  return discrepancies
}
