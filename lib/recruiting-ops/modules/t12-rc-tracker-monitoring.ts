import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type RcTrackerStatus = "on_track" | "at_risk" | "blocked" | "unknown"

export interface RcTrackerSourceRow {
  rcId: string
  status: string
  owner?: string
  lastUpdatedAt?: string
  exceptionReason?: string
}

export interface LegacyRcTrackerEvidenceRow {
  rc_id: string
  status?: string
  exception_flag?: boolean
}

export interface RcTrackerMonitorRow {
  rc_id: string
  status: RcTrackerStatus
  owner: string | null
  last_updated_at: string
  exception_flag: boolean
  exception_reason: string
  follow_up_required: boolean
}

export interface RunRcTrackerMonitoringModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  sourceRows: readonly RcTrackerSourceRow[]
  legacyRows?: readonly LegacyRcTrackerEvidenceRow[]
}

export const rcTrackerMonitoringModuleDefinition = {
  moduleId: "t12-rc-tracker-monitoring",
  workflowId: "T12",
  capabilityId: "external_artifact_monitoring",
  title: "T12 RC Tracker Monitoring",
  sourceIds: ["google_sheets"],
  queryIds: [],
  legacyArtifactIds: ["legacy_rc_tracker_sheet"],
  outputContractIds: ["rc_tracker_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "rc_tracker_sheet")!
if (!outputContract) throw new Error("Missing RC Tracker concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_rc_tracker_sheet")!
if (!legacyArtifact) throw new Error("Missing RC Tracker legacy artifact")

export function normalizeRcTrackerRows(rows: readonly RcTrackerSourceRow[]): RcTrackerMonitorRow[] {
  return rows
    .map((row) => {
      const status = normalizeRcStatus(row.status)
      const exception_flag = status === "at_risk" || status === "blocked" || status === "unknown"
      return {
        rc_id: row.rcId,
        status,
        owner: row.owner?.trim() || null,
        last_updated_at: normalizeTimestamp(row.lastUpdatedAt),
        exception_flag,
        exception_reason: row.exceptionReason?.trim() || (exception_flag ? defaultExceptionReason(status) : ""),
        follow_up_required: exception_flag,
      }
    })
    .sort((a, b) => a.rc_id.localeCompare(b.rc_id))
}

export async function runRcTrackerMonitoringModule(
  input: RunRcTrackerMonitoringModuleInput
): Promise<RecruitingOpsModuleResult<RcTrackerMonitorRow>> {
  const runId = buildRunId(rcTrackerMonitoringModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizeRcTrackerRows(input.sourceRows)
  const sourceGaps = buildRcTrackerSourceGaps(input.sourceRows, normalizedRows)
  const discrepancies = buildRcTrackerDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "RC Tracker external sheet evidence.",
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: rcTrackerMonitoringModuleDefinition.workflowId,
    moduleId: rcTrackerMonitoringModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    exceptionCount: normalizedRows.filter((row) => row.exception_flag).length,
    followUpRequiredCount: normalizedRows.filter((row) => row.follow_up_required).length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: rcTrackerMonitoringModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: rcTrackerMonitoringModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: rcTrackerMonitoringModuleDefinition.workflowId,
    capabilityId: rcTrackerMonitoringModuleDefinition.capabilityId,
    moduleId: rcTrackerMonitoringModuleDefinition.moduleId,
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
    definition: rcTrackerMonitoringModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

export function normalizeRcStatus(value: string): RcTrackerStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["on_track", "active", "healthy", "ok"].includes(normalized)) return "on_track"
  if (["at_risk", "risk", "watch"].includes(normalized)) return "at_risk"
  if (["blocked", "stuck"].includes(normalized)) return "blocked"
  return "unknown"
}

function buildRcTrackerSourceGaps(
  sourceRows: readonly RcTrackerSourceRow[],
  rows: readonly RcTrackerMonitorRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (sourceRows.length === 0) {
    gaps.push({
      id: "gap_t12_source_rows_missing",
      workflowId: "T12",
      sourceId: "google_sheets",
      field: "sourceRows",
      reason: "RC Tracker monitor requires a current external sheet extract before local rendering.",
      blocksCutover: true,
    })
  }
  for (const row of rows) {
    if (row.status === "unknown") {
      gaps.push({
        id: `gap_t12_status_${row.rc_id}`,
        workflowId: "T12",
        sourceId: "google_sheets",
        field: "status",
        reason: `RC Tracker status taxonomy is open for ${row.rc_id}.`,
        blocksCutover: true,
      })
    }
    if (row.owner === null) {
      gaps.push({
        id: `gap_t12_owner_${row.rc_id}`,
        workflowId: "T12",
        sourceId: "google_sheets",
        field: "owner",
        reason: `RC Tracker owner is unmapped for ${row.rc_id}.`,
        blocksCutover: false,
      })
    }
  }
  return gaps
}

function buildRcTrackerDiscrepancies(
  runId: string,
  rows: readonly RcTrackerMonitorRow[],
  legacyRows: readonly LegacyRcTrackerEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: rcTrackerMonitoringModuleDefinition.capabilityId,
      workflowId: "T12",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy RC Tracker may contain a populated value for this field.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByRc = new Map(legacyRows.map((row) => [row.rc_id, row]))
  for (const row of rows) {
    const legacy = legacyByRc.get(row.rc_id)
    if (!legacy) continue
    if (legacy.status && normalizeRcStatus(legacy.status) !== row.status) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: rcTrackerMonitoringModuleDefinition.capabilityId,
          workflowId: "T12",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `rc:${row.rc_id}`,
          field: "status",
          modernValueSummary: `Command-center RC status ${row.status}`,
          legacyValueSummary: `Legacy RC status ${legacy.status}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (typeof legacy.exception_flag === "boolean" && legacy.exception_flag !== row.exception_flag) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: rcTrackerMonitoringModuleDefinition.capabilityId,
          workflowId: "T12",
          class: "stale_mapping",
          severity: "warning",
          entityKey: `rc:${row.rc_id}`,
          field: "exception_flag",
          modernValueSummary: `Command-center exception flag ${row.exception_flag}`,
          legacyValueSummary: `Legacy RC exception flag ${legacy.exception_flag}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}

function normalizeTimestamp(value: string | undefined): string {
  if (!value) return "unknown"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "unknown"
  return date.toISOString()
}

function defaultExceptionReason(status: RcTrackerStatus): string {
  if (status === "at_risk") return "RC tracker row is marked at risk."
  if (status === "blocked") return "RC tracker row is blocked."
  return "RC tracker status taxonomy is open."
}
