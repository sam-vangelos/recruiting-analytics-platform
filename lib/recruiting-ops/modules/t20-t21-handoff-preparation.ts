import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type HandoffReadinessCategory = "workflow" | "access" | "sop" | "evidence" | "acceptance"
export type HandoffReadinessStatus = "accepted" | "ready" | "needs_evidence" | "blocked" | "not_started" | "unknown"
export type SamSignoffStatus = "accepted" | "pending" | "rejected" | "not_requested" | "unknown"

export interface HandoffReadinessFact {
  areaId: string
  areaName: string
  category: HandoffReadinessCategory
  status: string
  owner: string
  evidenceIds: readonly string[]
  blockerCount: number
  acceptanceRequired: boolean
  nextGate?: string
}

export interface SamSignoffFact {
  areaId: string
  status: string
  signedAt?: string
}

export interface LegacyHandoffReadinessEvidenceRow {
  area_id: string
  readiness_status?: HandoffReadinessStatus
  sam_signoff_status?: SamSignoffStatus
}

export interface HandoffReadinessDashboardRow {
  area_id: string
  area_name: string
  category: HandoffReadinessCategory
  readiness_status: HandoffReadinessStatus
  sam_signoff_status: SamSignoffStatus
  owner: string | null
  evidence_count: number
  blocker_count: number
  acceptance_required: boolean
  next_gate: string
  review_required: boolean
}

export interface RunHandoffPreparationModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  readinessFacts: readonly HandoffReadinessFact[]
  samSignoffs: readonly SamSignoffFact[]
  legacyRows?: readonly LegacyHandoffReadinessEvidenceRow[]
}

export const handoffPreparationModuleDefinition = {
  moduleId: "t20-t21-handoff-preparation",
  workflowId: "T20/T21",
  capabilityId: "transition_readiness_control",
  title: "T20/T21 the operator Handoff Preparation",
  sourceIds: ["google_sheets", "google_docs"],
  queryIds: [],
  legacyArtifactIds: ["legacy_handoff_readiness_tracker"],
  outputContractIds: ["handoff_readiness_dashboard"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find(
  (contract) => contract.sourceContractId === "handoff_readiness_dashboard"
)!
if (!outputContract) throw new Error("Missing handoff readiness concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_handoff_readiness_tracker")!
if (!legacyArtifact) throw new Error("Missing handoff readiness legacy artifact")

export function normalizeHandoffReadinessRows(input: {
  readinessFacts: readonly HandoffReadinessFact[]
  samSignoffs: readonly SamSignoffFact[]
}): HandoffReadinessDashboardRow[] {
  const signoffByArea = new Map(input.samSignoffs.map((signoff) => [signoff.areaId, signoff]))
  return input.readinessFacts
    .map((fact) => {
      const sam_signoff_status = normalizeSamSignoffStatus(signoffByArea.get(fact.areaId)?.status)
      const readiness_status = deriveHandoffReadinessStatus(fact, sam_signoff_status)
      return {
        area_id: fact.areaId,
        area_name: fact.areaName,
        category: fact.category,
        readiness_status,
        sam_signoff_status,
        owner: fact.owner.trim() || null,
        evidence_count: fact.evidenceIds.length,
        blocker_count: fact.blockerCount,
        acceptance_required: fact.acceptanceRequired,
        next_gate: fact.nextGate?.trim() || nextGateForReadiness(readiness_status),
        review_required: readiness_status !== "accepted",
      }
    })
    .sort((a, b) => [a.category, a.area_id].join("|").localeCompare([b.category, b.area_id].join("|")))
}

export async function runHandoffPreparationModule(
  input: RunHandoffPreparationModuleInput
): Promise<RecruitingOpsModuleResult<HandoffReadinessDashboardRow>> {
  const runId = buildRunId(handoffPreparationModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizeHandoffReadinessRows(input)
  const sourceGaps = buildHandoffSourceGaps(input.readinessFacts, normalizedRows)
  const discrepancies = buildHandoffDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "t20_t21_transition_tracker",
      sourceId: "google_sheets",
      adapter: "local_renderer",
      label: "Transition tracker, SOP closure, access custody, and evidence readiness facts.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Legacy handoff tracker and readiness checklist evidence.",
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: handoffPreparationModuleDefinition.workflowId,
    moduleId: handoffPreparationModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    acceptedCount: normalizedRows.filter((row) => row.readiness_status === "accepted").length,
    reviewRequiredCount: normalizedRows.filter((row) => row.review_required).length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: handoffPreparationModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: handoffPreparationModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: handoffPreparationModuleDefinition.workflowId,
    capabilityId: handoffPreparationModuleDefinition.capabilityId,
    moduleId: handoffPreparationModuleDefinition.moduleId,
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
    definition: handoffPreparationModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

export function normalizeSamSignoffStatus(value: string | undefined): SamSignoffStatus {
  if (!value) return "not_requested"
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["accepted", "approved", "signed_off"].includes(normalized)) return "accepted"
  if (["pending", "requested", "waiting"].includes(normalized)) return "pending"
  if (["rejected", "failed"].includes(normalized)) return "rejected"
  if (["not_requested", "n/a", "na"].includes(normalized)) return "not_requested"
  return "unknown"
}

export function normalizeHandoffStatus(value: string): HandoffReadinessStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["accepted", "signed_off"].includes(normalized)) return "accepted"
  if (["ready", "complete"].includes(normalized)) return "ready"
  if (["needs_evidence", "evidence_missing"].includes(normalized)) return "needs_evidence"
  if (["blocked", "failed"].includes(normalized)) return "blocked"
  if (["not_started", "todo"].includes(normalized)) return "not_started"
  return "unknown"
}

export function deriveHandoffReadinessStatus(
  fact: HandoffReadinessFact,
  samSignoffStatus: SamSignoffStatus
): HandoffReadinessStatus {
  const declaredStatus = normalizeHandoffStatus(fact.status)
  if (fact.blockerCount > 0 || samSignoffStatus === "rejected" || declaredStatus === "blocked") return "blocked"
  if (fact.evidenceIds.length === 0 || declaredStatus === "needs_evidence") return "needs_evidence"
  if (fact.acceptanceRequired && samSignoffStatus !== "accepted") return "ready"
  if (fact.acceptanceRequired && samSignoffStatus === "accepted") return "accepted"
  if (declaredStatus === "accepted") return "accepted"
  return declaredStatus === "unknown" ? "ready" : declaredStatus
}

function nextGateForReadiness(status: HandoffReadinessStatus): string {
  if (status === "accepted") return "Preserve evidence package; do not cut over or retire without explicit approval."
  if (status === "ready") return "Request the operator signoff or owner acceptance."
  if (status === "needs_evidence") return "Attach required evidence before signoff."
  if (status === "blocked") return "Resolve blockers before acceptance."
  if (status === "not_started") return "Capture owner, evidence, and first walkthrough."
  return "Clarify readiness state with the operator."
}

function buildHandoffSourceGaps(
  readinessFacts: readonly HandoffReadinessFact[],
  rows: readonly HandoffReadinessDashboardRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (readinessFacts.length === 0) {
    gaps.push({
      id: "gap_t20_t21_readiness_facts_missing",
      workflowId: "T20/T21",
      sourceId: "google_sheets",
      field: "readinessFacts",
      reason: "Handoff readiness requires workflow, access, SOP, evidence, and acceptance rows.",
      blocksCutover: true,
    })
  }
  for (const row of rows) {
    if (row.evidence_count === 0) {
      gaps.push({
        id: `gap_t20_t21_evidence_${row.area_id}`,
        workflowId: "T20/T21",
        sourceId: "google_sheets",
        field: "evidence_count",
        reason: `Handoff area ${row.area_id} has no attached evidence.`,
        blocksCutover: true,
      })
    }
    if (row.blocker_count > 0) {
      gaps.push({
        id: `gap_t20_t21_blockers_${row.area_id}`,
        workflowId: "T20/T21",
        sourceId: "google_sheets",
        field: "blocker_count",
        reason: `Handoff area ${row.area_id} has unresolved blockers.`,
        blocksCutover: true,
      })
    }
    if (row.acceptance_required && row.sam_signoff_status !== "accepted") {
      gaps.push({
        id: `gap_t20_t21_sam_signoff_${row.area_id}`,
        workflowId: "T20/T21",
        sourceId: "google_docs",
        field: "sam_signoff_status",
        reason: `Handoff area ${row.area_id} requires the operator acceptance before closeout.`,
        blocksCutover: true,
      })
    }
    if (row.owner === null) {
      gaps.push({
        id: `gap_t20_t21_owner_${row.area_id}`,
        workflowId: "T20/T21",
        sourceId: "google_sheets",
        field: "owner",
        reason: `Handoff area ${row.area_id} has no owner.`,
        blocksCutover: false,
      })
    }
  }
  return gaps
}

function buildHandoffDiscrepancies(
  runId: string,
  rows: readonly HandoffReadinessDashboardRow[],
  legacyRows: readonly LegacyHandoffReadinessEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: handoffPreparationModuleDefinition.capabilityId,
      workflowId: "T20/T21",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy handoff tracker may contain this evidence.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByArea = new Map(legacyRows.map((row) => [row.area_id, row]))
  for (const row of rows) {
    const legacy = legacyByArea.get(row.area_id)
    if (!legacy) continue
    for (const field of ["readiness_status", "sam_signoff_status"] as const) {
      if (legacy[field] && legacy[field] !== row[field]) {
        discrepancies.push(
          buildDiscrepancy({
            runId,
            capabilityId: handoffPreparationModuleDefinition.capabilityId,
            workflowId: "T20/T21",
            class: "business_definition_open",
            severity: "warning",
            entityKey: row.area_id,
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
