import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type PowerBiRefreshStatus = "succeeded" | "failed" | "stale" | "unknown"
export type PowerBiAlertSeverity = "none" | "warning" | "critical"

export interface PowerBiDashboardFact {
  dashboardId: string
  dashboardTitle: string
  workspaceName: string
  refreshStatus: string
  lastRefreshAt?: string
  owner?: string
}

export interface LegacyPowerBiDashboardEvidenceRow {
  dashboard_id: string
  refresh_status?: string
  alert_severity?: PowerBiAlertSeverity
}

export interface PowerBiDashboardAlertRow {
  dashboard_id: string
  dashboard_title: string
  workspace_name: string
  refresh_status: PowerBiRefreshStatus
  last_refresh_at: string
  owner: string | null
  alert_severity: PowerBiAlertSeverity
  triage_required: boolean
}

export interface RunPowerBiDashboardMonitoringModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  dashboardFacts: readonly PowerBiDashboardFact[]
  legacyRows?: readonly LegacyPowerBiDashboardEvidenceRow[]
}

export const powerBiDashboardMonitoringModuleDefinition = {
  moduleId: "t13-power-bi-dashboard-monitoring",
  workflowId: "T13",
  capabilityId: "external_artifact_monitoring",
  title: "T13 Power BI Dashboard Monitoring",
  sourceIds: ["power_bi"],
  queryIds: [],
  legacyArtifactIds: ["legacy_power_bi_dashboard_registry"],
  outputContractIds: ["power_bi_dashboard_alerts"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find(
  (contract) => contract.sourceContractId === "power_bi_dashboard_alerts"
)!
if (!outputContract) throw new Error("Missing Power BI dashboard concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_power_bi_dashboard_registry")!
if (!legacyArtifact) throw new Error("Missing Power BI dashboard legacy artifact")

export function normalizePowerBiDashboardRows(
  facts: readonly PowerBiDashboardFact[]
): PowerBiDashboardAlertRow[] {
  return facts
    .map((fact) => {
      const refresh_status = normalizePowerBiRefreshStatus(fact.refreshStatus)
      const alert_severity = severityForRefreshStatus(refresh_status)
      return {
        dashboard_id: fact.dashboardId,
        dashboard_title: fact.dashboardTitle,
        workspace_name: fact.workspaceName,
        refresh_status,
        last_refresh_at: normalizeTimestamp(fact.lastRefreshAt),
        owner: fact.owner?.trim() || null,
        alert_severity,
        triage_required: alert_severity !== "none",
      }
    })
    .sort((a, b) => a.dashboard_id.localeCompare(b.dashboard_id))
}

export async function runPowerBiDashboardMonitoringModule(
  input: RunPowerBiDashboardMonitoringModuleInput
): Promise<RecruitingOpsModuleResult<PowerBiDashboardAlertRow>> {
  const runId = buildRunId(powerBiDashboardMonitoringModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizePowerBiDashboardRows(input.dashboardFacts)
  const sourceGaps = buildPowerBiDashboardSourceGaps(input.dashboardFacts, normalizedRows)
  const discrepancies = buildPowerBiDashboardDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Power BI dashboard registry and refresh-alert evidence.",
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: powerBiDashboardMonitoringModuleDefinition.workflowId,
    moduleId: powerBiDashboardMonitoringModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    criticalAlertCount: normalizedRows.filter((row) => row.alert_severity === "critical").length,
    triageRequiredCount: normalizedRows.filter((row) => row.triage_required).length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: powerBiDashboardMonitoringModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: powerBiDashboardMonitoringModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: powerBiDashboardMonitoringModuleDefinition.workflowId,
    capabilityId: powerBiDashboardMonitoringModuleDefinition.capabilityId,
    moduleId: powerBiDashboardMonitoringModuleDefinition.moduleId,
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
    definition: powerBiDashboardMonitoringModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

export function normalizePowerBiRefreshStatus(value: string): PowerBiRefreshStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["succeeded", "success", "healthy"].includes(normalized)) return "succeeded"
  if (["failed", "failure", "error"].includes(normalized)) return "failed"
  if (["stale", "delayed", "late"].includes(normalized)) return "stale"
  return "unknown"
}

function buildPowerBiDashboardSourceGaps(
  facts: readonly PowerBiDashboardFact[],
  rows: readonly PowerBiDashboardAlertRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (facts.length === 0) {
    gaps.push({
      id: "gap_t13_dashboard_inventory_missing",
      workflowId: "T13",
      sourceId: "power_bi",
      field: "dashboardFacts",
      reason: "Power BI monitor requires a dashboard inventory before local triage rendering.",
      blocksCutover: true,
    })
  }
  for (const row of rows) {
    if (row.refresh_status === "unknown") {
      gaps.push({
        id: `gap_t13_refresh_status_${row.dashboard_id}`,
        workflowId: "T13",
        sourceId: "power_bi",
        field: "refresh_status",
        reason: `Power BI refresh status taxonomy is open for ${row.dashboard_id}.`,
        blocksCutover: true,
      })
    }
    if (row.owner === null) {
      gaps.push({
        id: `gap_t13_owner_${row.dashboard_id}`,
        workflowId: "T13",
        sourceId: "power_bi",
        field: "owner",
        reason: `Power BI dashboard owner is unmapped for ${row.dashboard_id}.`,
        blocksCutover: false,
      })
    }
  }
  return gaps
}

function buildPowerBiDashboardDiscrepancies(
  runId: string,
  rows: readonly PowerBiDashboardAlertRow[],
  legacyRows: readonly LegacyPowerBiDashboardEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: powerBiDashboardMonitoringModuleDefinition.capabilityId,
      workflowId: "T13",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy Power BI evidence may contain this inventory or alert-routing field.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByDashboard = new Map(legacyRows.map((row) => [row.dashboard_id, row]))
  for (const row of rows) {
    const legacy = legacyByDashboard.get(row.dashboard_id)
    if (!legacy) continue
    if (legacy.refresh_status && normalizePowerBiRefreshStatus(legacy.refresh_status) !== row.refresh_status) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: powerBiDashboardMonitoringModuleDefinition.capabilityId,
          workflowId: "T13",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `dashboard:${row.dashboard_id}`,
          field: "refresh_status",
          modernValueSummary: `Command-center refresh status ${row.refresh_status}`,
          legacyValueSummary: `Legacy Power BI refresh status ${legacy.refresh_status}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (legacy.alert_severity && legacy.alert_severity !== row.alert_severity) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: powerBiDashboardMonitoringModuleDefinition.capabilityId,
          workflowId: "T13",
          class: "stale_mapping",
          severity: "warning",
          entityKey: `dashboard:${row.dashboard_id}`,
          field: "alert_severity",
          modernValueSummary: `Command-center alert severity ${row.alert_severity}`,
          legacyValueSummary: `Legacy Power BI alert severity ${legacy.alert_severity}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}

function severityForRefreshStatus(status: PowerBiRefreshStatus): PowerBiAlertSeverity {
  if (status === "failed" || status === "unknown") return "critical"
  if (status === "stale") return "warning"
  return "none"
}

function normalizeTimestamp(value: string | undefined): string {
  if (!value) return "unknown"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "unknown"
  return date.toISOString()
}
