import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { scriptAssetRegistry } from "../registries"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type AppsScriptExportStatus = "captured" | "export_required" | "reference_only" | "blocked" | "unknown"
export type AppsScriptTriggerStatus = "captured" | "owner_required" | "disabled" | "not_applicable" | "blocked" | "unknown"
export type AppsScriptScopeStatus = "captured" | "redaction_required" | "rotation_required" | "not_applicable" | "unknown"
export type AppsScriptCredentialPosture = "service_owned" | "personal_or_departing_risk" | "not_secret_bearing" | "unknown"

export interface AppsScriptAssetCustodyFact {
  assetId: string
  workflowId: string
  projectName: string
  exportStatus: string
  triggerStatus: string
  scopeStatus: string
  credentialPosture: string
  owner?: string
  capturedAt?: string
}

export interface LegacyAppsScriptAssetEvidenceRow {
  asset_id: string
  export_status?: AppsScriptExportStatus
  trigger_status?: AppsScriptTriggerStatus
  scope_status?: AppsScriptScopeStatus
}

export interface AppsScriptAssetRegistryRow {
  asset_id: string
  workflow_id: string
  project_name: string
  export_status: AppsScriptExportStatus
  trigger_status: AppsScriptTriggerStatus
  scope_status: AppsScriptScopeStatus
  custody_posture: AppsScriptCredentialPosture
  owner: string | null
  captured_at: string
  /** Secret-bearing credential not yet rotated to a service identity. */
  rotation_required: boolean
  review_required: boolean
  blocker_reason: string
}

export interface RunAppsScriptDevelopmentModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  assetFacts: readonly AppsScriptAssetCustodyFact[]
  legacyRows?: readonly LegacyAppsScriptAssetEvidenceRow[]
}

export const appsScriptDevelopmentModuleDefinition = {
  moduleId: "t17-apps-script-development",
  workflowId: "T17",
  capabilityId: "automation_custody",
  title: "T17 Apps Script Development",
  sourceIds: ["google_apps_script", "google_sheets"],
  queryIds: [],
  legacyArtifactIds: ["legacy_apps_script_asset_registry"],
  outputContractIds: ["apps_script_asset_registry"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find(
  (contract) => contract.sourceContractId === "apps_script_asset_registry"
)!
if (!outputContract) throw new Error("Missing Apps Script asset registry concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_apps_script_asset_registry")!
if (!legacyArtifact) throw new Error("Missing Apps Script asset registry legacy artifact")

const registeredAppsScriptAssetIds = scriptAssetRegistry
  .filter((asset) => asset.platform === "apps_script")
  .map((asset) => asset.id)

export function normalizeAppsScriptAssetRegistryRows(input: {
  assetFacts: readonly AppsScriptAssetCustodyFact[]
}): AppsScriptAssetRegistryRow[] {
  return input.assetFacts
    .map((fact) => {
      const export_status = normalizeAppsScriptExportStatus(fact.exportStatus)
      const trigger_status = normalizeAppsScriptTriggerStatus(fact.triggerStatus)
      const scope_status = normalizeAppsScriptScopeStatus(fact.scopeStatus)
      const custody_posture = normalizeAppsScriptCredentialPosture(fact.credentialPosture)
      const rotation_required = credentialRotationRequired(custody_posture, scope_status)
      const issues = custodyIssues({ export_status, trigger_status, scope_status, custody_posture })
      if (rotation_required) issues.push("credential must be rotated to a service identity before preserve/export")
      if (!fact.owner?.trim()) issues.push("custody owner is unmapped")
      return {
        asset_id: fact.assetId,
        workflow_id: fact.workflowId,
        project_name: fact.projectName,
        export_status,
        trigger_status,
        scope_status,
        custody_posture,
        owner: fact.owner?.trim() || null,
        captured_at: fact.capturedAt ?? "",
        rotation_required,
        review_required: issues.length > 0,
        blocker_reason: issues.join("; "),
      }
    })
    .sort((a, b) => a.asset_id.localeCompare(b.asset_id))
}

export async function runAppsScriptDevelopmentModule(
  input: RunAppsScriptDevelopmentModuleInput
): Promise<RecruitingOpsModuleResult<AppsScriptAssetRegistryRow>> {
  const runId = buildRunId(appsScriptDevelopmentModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizeAppsScriptAssetRegistryRows(input)
  const sourceGaps = buildAppsScriptSourceGaps(input.assetFacts, normalizedRows)
  const discrepancies = buildAppsScriptDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Apps Script project export, trigger, scope, and owner custody evidence.",
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: appsScriptDevelopmentModuleDefinition.workflowId,
    moduleId: appsScriptDevelopmentModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    reviewRequiredCount: normalizedRows.filter((row) => row.review_required).length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: appsScriptDevelopmentModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: appsScriptDevelopmentModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: appsScriptDevelopmentModuleDefinition.workflowId,
    capabilityId: appsScriptDevelopmentModuleDefinition.capabilityId,
    moduleId: appsScriptDevelopmentModuleDefinition.moduleId,
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
    definition: appsScriptDevelopmentModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

export function normalizeAppsScriptExportStatus(value: string): AppsScriptExportStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["captured", "exported", "versioned"].includes(normalized)) return "captured"
  if (["reference_only", "dormant_reference"].includes(normalized)) return "reference_only"
  if (["export_required", "needs_export", "missing_export"].includes(normalized)) return "export_required"
  if (["blocked", "failed"].includes(normalized)) return "blocked"
  return "unknown"
}

export function normalizeAppsScriptTriggerStatus(value: string): AppsScriptTriggerStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["captured", "owner_confirmed", "documented"].includes(normalized)) return "captured"
  if (["disabled", "stopped"].includes(normalized)) return "disabled"
  if (["not_applicable", "n/a", "na"].includes(normalized)) return "not_applicable"
  if (["owner_required", "owner_confirm_required"].includes(normalized)) return "owner_required"
  if (["blocked", "failed"].includes(normalized)) return "blocked"
  return "unknown"
}

export function normalizeAppsScriptScopeStatus(value: string): AppsScriptScopeStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["captured", "reviewed", "documented"].includes(normalized)) return "captured"
  if (["not_applicable", "n/a", "na"].includes(normalized)) return "not_applicable"
  if (["redaction_required", "contains_sensitive_values"].includes(normalized)) return "redaction_required"
  if (["rotation_required", "reissue_required"].includes(normalized)) return "rotation_required"
  return "unknown"
}

export function normalizeAppsScriptCredentialPosture(value: string): AppsScriptCredentialPosture {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["service_owned", "service_identity"].includes(normalized)) return "service_owned"
  if (["personal_or_departing_risk", "personal", "departing_owner"].includes(normalized)) {
    return "personal_or_departing_risk"
  }
  if (["not_secret_bearing", "reference_only"].includes(normalized)) return "not_secret_bearing"
  return "unknown"
}

export function credentialRotationRequired(
  posture: AppsScriptCredentialPosture,
  scopeStatus: AppsScriptScopeStatus
): boolean {
  // A secret-bearing or unknown-owner credential must be rotated to a service identity
  // before any preserve/export action; a pending rotation flag also counts. This is the
  // gate that stops the custody capability from faithfully preserving a leaked secret.
  return posture === "personal_or_departing_risk" || posture === "unknown" || scopeStatus === "rotation_required"
}

function custodyIssues(input: {
  export_status: AppsScriptExportStatus
  trigger_status: AppsScriptTriggerStatus
  scope_status: AppsScriptScopeStatus
  custody_posture: AppsScriptCredentialPosture
}): string[] {
  const issues: string[] = []
  if (!["captured", "reference_only"].includes(input.export_status)) issues.push("source export is incomplete")
  if (!["captured", "disabled", "not_applicable"].includes(input.trigger_status)) {
    issues.push("trigger ownership evidence is incomplete")
  }
  if (!["captured", "not_applicable"].includes(input.scope_status)) issues.push("scope review or rotation is incomplete")
  if (!["service_owned", "not_secret_bearing"].includes(input.custody_posture)) {
    issues.push("credential ownership remains unsafe")
  }
  return issues
}

function buildAppsScriptSourceGaps(
  assetFacts: readonly AppsScriptAssetCustodyFact[],
  rows: readonly AppsScriptAssetRegistryRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  const factIds = new Set(assetFacts.map((fact) => fact.assetId))
  if (assetFacts.length === 0) {
    gaps.push({
      id: "gap_t17_apps_script_assets_missing",
      workflowId: "T17",
      sourceId: "google_apps_script",
      field: "assetFacts",
      reason: "Apps Script development custody requires exported project metadata before rebuild or retirement decisions.",
      blocksCutover: true,
    })
  }
  for (const requiredId of registeredAppsScriptAssetIds) {
    if (!factIds.has(requiredId)) {
      gaps.push({
        id: `gap_t17_registered_asset_${requiredId}`,
        workflowId: "T17",
        sourceId: "google_apps_script",
        field: "asset_id",
        reason: `Registered Apps Script asset ${requiredId} is missing from custody evidence.`,
        blocksCutover: true,
      })
    }
  }
  for (const row of rows) {
    const issues = custodyIssues(row)
    for (const issue of issues) {
      gaps.push({
        id: `gap_t17_${row.asset_id}_${issue.replace(/[^a-z0-9]+/g, "_")}`,
        workflowId: "T17",
        sourceId: "google_apps_script",
        field: row.asset_id,
        reason: `${row.asset_id}: ${issue}.`,
        blocksCutover: true,
      })
    }
    if (row.rotation_required) {
      gaps.push({
        id: `gap_t17_rotation_${row.asset_id}`,
        workflowId: "T17",
        sourceId: "google_apps_script",
        field: "credential_rotation",
        reason: `${row.asset_id}: credential is secret-bearing and must be rotated to a service identity before any preserve/export action.`,
        blocksCutover: true,
      })
    }
    if (row.owner === null) {
      gaps.push({
        id: `gap_t17_owner_${row.asset_id}`,
        workflowId: "T17",
        sourceId: "google_apps_script",
        field: "owner",
        reason: `Custody owner is unmapped for ${row.asset_id}.`,
        blocksCutover: false,
      })
    }
  }
  return gaps
}

function buildAppsScriptDiscrepancies(
  runId: string,
  rows: readonly AppsScriptAssetRegistryRow[],
  legacyRows: readonly LegacyAppsScriptAssetEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: appsScriptDevelopmentModuleDefinition.capabilityId,
      workflowId: "T17",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy Apps Script custody packet may contain this evidence.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByAsset = new Map(legacyRows.map((row) => [row.asset_id, row]))
  for (const row of rows) {
    const legacy = legacyByAsset.get(row.asset_id)
    if (!legacy) continue
    for (const field of ["export_status", "trigger_status", "scope_status"] as const) {
      if (legacy[field] && legacy[field] !== row[field]) {
        discrepancies.push(
          buildDiscrepancy({
            runId,
            capabilityId: appsScriptDevelopmentModuleDefinition.capabilityId,
            workflowId: "T17",
            class: field === "scope_status" ? "business_definition_open" : "stale_mapping",
            severity: "warning",
            entityKey: row.asset_id,
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
