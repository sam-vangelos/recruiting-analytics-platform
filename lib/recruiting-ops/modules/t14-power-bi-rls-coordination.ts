import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type PowerBiCoordinationRowType = "rls_access" | "vendor_coordination"
export type PowerBiCoordinationStatus = "confirmed" | "pending" | "blocked" | "unknown"
export type PowerBiPaymentStatus = "not_applicable" | "owned" | "open" | "unknown"

export interface PowerBiRlsAccessFact {
  accessId: string
  workspaceName: string
  dashboardId: string
  accessScope: string
  status: string
  owner?: string
}

export interface VendorCoordinationFact {
  coordinationId: string
  vendorName: string
  topic: string
  status: string
  owner?: string
  paymentStatus?: string
}

export interface LegacyPowerBiRlsEvidenceRow {
  entity_id: string
  status?: string
  review_required?: boolean
}

export interface PowerBiRlsCoordinationRow {
  row_type: PowerBiCoordinationRowType
  entity_id: string
  status: PowerBiCoordinationStatus
  owner: string | null
  workspace_name: string
  dashboard_id: string
  access_scope: string
  vendor_name: string
  coordination_topic: string
  payment_status: PowerBiPaymentStatus
  review_required: boolean
}

export interface RunPowerBiRlsVendorCoordinationModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  rlsAccessFacts: readonly PowerBiRlsAccessFact[]
  vendorFacts: readonly VendorCoordinationFact[]
  legacyRows?: readonly LegacyPowerBiRlsEvidenceRow[]
}

export const powerBiRlsVendorCoordinationModuleDefinition = {
  moduleId: "t14-power-bi-rls-coordination",
  workflowId: "T14",
  capabilityId: "external_artifact_monitoring",
  title: "T14 Power BI RLS / the BI vendor Coordination",
  sourceIds: ["power_bi", "google_sheets", "vendor"],
  queryIds: [],
  legacyArtifactIds: ["legacy_power_bi_rls_vendor_packet"],
  outputContractIds: ["power_bi_rls_matrix"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "power_bi_rls_matrix")!
if (!outputContract) throw new Error("Missing Power BI RLS concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_power_bi_rls_vendor_packet")!
if (!legacyArtifact) throw new Error("Missing Power BI RLS/the BI vendor legacy artifact")

export function normalizePowerBiRlsCoordinationRows(input: {
  rlsAccessFacts: readonly PowerBiRlsAccessFact[]
  vendorFacts: readonly VendorCoordinationFact[]
}): PowerBiRlsCoordinationRow[] {
  const rlsRows = input.rlsAccessFacts.map((fact) => {
    const status = normalizeCoordinationStatus(fact.status)
    return {
      row_type: "rls_access" as const,
      entity_id: fact.accessId,
      status,
      owner: fact.owner?.trim() || null,
      workspace_name: fact.workspaceName,
      dashboard_id: fact.dashboardId,
      access_scope: fact.accessScope,
      vendor_name: "",
      coordination_topic: "",
      payment_status: "not_applicable" as const,
      review_required: status !== "confirmed",
    }
  })
  const vendorRows = input.vendorFacts.map((fact) => {
    const status = normalizeCoordinationStatus(fact.status)
    const payment_status = normalizePaymentStatus(fact.paymentStatus)
    return {
      row_type: "vendor_coordination" as const,
      entity_id: fact.coordinationId,
      status,
      owner: fact.owner?.trim() || null,
      workspace_name: "",
      dashboard_id: "",
      access_scope: "",
      vendor_name: fact.vendorName,
      coordination_topic: fact.topic,
      payment_status,
      review_required: status !== "confirmed" || payment_status === "open" || payment_status === "unknown",
    }
  })

  return [...rlsRows, ...vendorRows].sort((a, b) =>
    [a.row_type, a.entity_id].join("|").localeCompare([b.row_type, b.entity_id].join("|"))
  )
}

export async function runPowerBiRlsVendorCoordinationModule(
  input: RunPowerBiRlsVendorCoordinationModuleInput
): Promise<RecruitingOpsModuleResult<PowerBiRlsCoordinationRow>> {
  const runId = buildRunId(powerBiRlsVendorCoordinationModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizePowerBiRlsCoordinationRows(input)
  const sourceGaps = buildPowerBiRlsSourceGaps(input.rlsAccessFacts, input.vendorFacts, normalizedRows)
  const discrepancies = buildPowerBiRlsDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Power BI RLS access matrix and the BI vendor coordination evidence.",
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: powerBiRlsVendorCoordinationModuleDefinition.workflowId,
    moduleId: powerBiRlsVendorCoordinationModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    reviewRequiredCount: normalizedRows.filter((row) => row.review_required).length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: powerBiRlsVendorCoordinationModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: powerBiRlsVendorCoordinationModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: powerBiRlsVendorCoordinationModuleDefinition.workflowId,
    capabilityId: powerBiRlsVendorCoordinationModuleDefinition.capabilityId,
    moduleId: powerBiRlsVendorCoordinationModuleDefinition.moduleId,
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
    definition: powerBiRlsVendorCoordinationModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

export function normalizeCoordinationStatus(value: string): PowerBiCoordinationStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["confirmed", "complete", "done"].includes(normalized)) return "confirmed"
  if (["pending", "in_progress", "waiting"].includes(normalized)) return "pending"
  if (["blocked", "stuck"].includes(normalized)) return "blocked"
  return "unknown"
}

export function normalizePaymentStatus(value: string | undefined): PowerBiPaymentStatus {
  if (!value) return "unknown"
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["not_applicable", "n/a", "na"].includes(normalized)) return "not_applicable"
  if (["owned", "assigned", "paid"].includes(normalized)) return "owned"
  if (["open", "due", "unpaid"].includes(normalized)) return "open"
  return "unknown"
}

function buildPowerBiRlsSourceGaps(
  rlsAccessFacts: readonly PowerBiRlsAccessFact[],
  vendorFacts: readonly VendorCoordinationFact[],
  rows: readonly PowerBiRlsCoordinationRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (rlsAccessFacts.length === 0) {
    gaps.push({
      id: "gap_t14_rls_matrix_missing",
      workflowId: "T14",
      sourceId: "power_bi",
      field: "rlsAccessFacts",
      reason: "Power BI RLS coordination requires an access matrix before local rendering.",
      blocksCutover: true,
    })
  }
  if (vendorFacts.length === 0) {
    gaps.push({
      id: "gap_t14_vendor_coordination_missing",
      workflowId: "T14",
      sourceId: "vendor",
      field: "vendorFacts",
      reason: "the BI vendor coordination requires vendor ownership/payment context before local rendering.",
      blocksCutover: true,
    })
  }
  for (const row of rows) {
    if (row.status === "unknown") {
      gaps.push({
        id: `gap_t14_status_${row.entity_id}`,
        workflowId: "T14",
        sourceId: row.row_type === "rls_access" ? "power_bi" : "vendor",
        field: "status",
        reason: `T14 coordination status taxonomy is open for ${row.entity_id}.`,
        blocksCutover: true,
      })
    }
    if (row.owner === null) {
      gaps.push({
        id: `gap_t14_owner_${row.entity_id}`,
        workflowId: "T14",
        sourceId: row.row_type === "rls_access" ? "power_bi" : "vendor",
        field: "owner",
        reason: `T14 owner is unmapped for ${row.entity_id}.`,
        blocksCutover: false,
      })
    }
  }
  return gaps
}

function buildPowerBiRlsDiscrepancies(
  runId: string,
  rows: readonly PowerBiRlsCoordinationRow[],
  legacyRows: readonly LegacyPowerBiRlsEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: powerBiRlsVendorCoordinationModuleDefinition.capabilityId,
      workflowId: "T14",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy Power BI/the BI vendor evidence may contain this matrix or coordination field.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByEntity = new Map(legacyRows.map((row) => [row.entity_id, row]))
  for (const row of rows) {
    const legacy = legacyByEntity.get(row.entity_id)
    if (!legacy) continue
    if (legacy.status && normalizeCoordinationStatus(legacy.status) !== row.status) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: powerBiRlsVendorCoordinationModuleDefinition.capabilityId,
          workflowId: "T14",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `${row.row_type}:${row.entity_id}`,
          field: "status",
          modernValueSummary: `Command-center coordination status ${row.status}`,
          legacyValueSummary: `Legacy T14 status ${legacy.status}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (typeof legacy.review_required === "boolean" && legacy.review_required !== row.review_required) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: powerBiRlsVendorCoordinationModuleDefinition.capabilityId,
          workflowId: "T14",
          class: "stale_mapping",
          severity: "warning",
          entityKey: `${row.row_type}:${row.entity_id}`,
          field: "review_required",
          modernValueSummary: `Command-center review required ${row.review_required}`,
          legacyValueSummary: `Legacy T14 review required ${legacy.review_required}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}
