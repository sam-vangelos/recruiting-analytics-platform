import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type RecruiterDailyGateStatus = "dormant" | "resume_requested" | "ready_for_review"

export interface LegacyRecruiterDailyEvidenceRow {
  gate_id: string
  status?: RecruiterDailyGateStatus
  last_run_date?: string
}

export interface RecruiterDailyResumeGateRow {
  gate_id: string
  status: RecruiterDailyGateStatus
  last_run_date: string
  template_preserved: boolean
  resume_requested: boolean
  reason: string
  next_gate: string
}

export interface RunRecruiterDailyDailyReportModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  lastRunDate?: string
  templatePreserved: boolean
  resumeRequested: boolean
  legacyRows?: readonly LegacyRecruiterDailyEvidenceRow[]
}

export const recruiterDailyDailyReportModuleDefinition = {
  moduleId: "t10-recruiter-daily-report",
  workflowId: "T10",
  capabilityId: "automation_custody",
  title: "T10 Recruiter Daily Report",
  sourceIds: ["looker_sql_runner", "google_sheets", "google_apps_script"],
  queryIds: ["Q15"],
  legacyArtifactIds: ["legacy_q15_recruiter_daily_report"],
  outputContractIds: ["recruiter_daily_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "recruiter_daily_sheet")!
if (!outputContract) throw new Error("Missing recruiter daily report concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_q15_recruiter_daily_report")!
if (!legacyArtifact) throw new Error("Missing recruiter daily report legacy artifact")

export function deriveRecruiterDailyResumeGateRow(input: {
  lastRunDate?: string
  templatePreserved: boolean
  resumeRequested: boolean
}): RecruiterDailyResumeGateRow {
  const lastRunDate = normalizeDate(input.lastRunDate)
  if (!input.resumeRequested) {
    return {
      gate_id: "recruiter_daily_resume_gate",
      status: "dormant",
      last_run_date: lastRunDate,
      template_preserved: input.templatePreserved,
      resume_requested: false,
      reason: "T10 is marked Stop/dormant; preserve Q15 and template but do not execute.",
      next_gate: "Ask the operator for explicit resume approval and current consumer before any run.",
    }
  }
  if (!input.templatePreserved) {
    return {
      gate_id: "recruiter_daily_resume_gate",
      status: "resume_requested",
      last_run_date: lastRunDate,
      template_preserved: false,
      resume_requested: true,
      reason: "Resume was requested but the dormant template has not been preserved.",
      next_gate: "Capture Q15, LAST_RUN_DATE behavior, and template reference before execution.",
    }
  }
  return {
    gate_id: "recruiter_daily_resume_gate",
    status: "ready_for_review",
    last_run_date: lastRunDate,
    template_preserved: true,
    resume_requested: true,
    reason: "Resume was requested and the dormant template reference is preserved.",
    next_gate: "Owner review must confirm current consumer and accepted output before any production adapter.",
  }
}

export async function runRecruiterDailyDailyReportModule(
  input: RunRecruiterDailyDailyReportModuleInput
): Promise<RecruitingOpsModuleResult<RecruiterDailyResumeGateRow>> {
  const runId = buildRunId(recruiterDailyDailyReportModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = [deriveRecruiterDailyResumeGateRow(input)]
  const sourceGaps = buildRecruiterDailySourceGaps(normalizedRows[0])
  const discrepancies = buildRecruiterDailyDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Q15 recruiter dormant report evidence and template reference.",
      artifactId: legacyArtifact.id,
      queryId: "Q15",
    },
  ]
  const publicSummary = {
    workflowId: recruiterDailyDailyReportModuleDefinition.workflowId,
    moduleId: recruiterDailyDailyReportModuleDefinition.moduleId,
    status: normalizedRows[0].status,
    resumeRequested: normalizedRows[0].resume_requested,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: recruiterDailyDailyReportModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: recruiterDailyDailyReportModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: recruiterDailyDailyReportModuleDefinition.workflowId,
    capabilityId: recruiterDailyDailyReportModuleDefinition.capabilityId,
    moduleId: recruiterDailyDailyReportModuleDefinition.moduleId,
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
    definition: recruiterDailyDailyReportModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

function buildRecruiterDailySourceGaps(row: RecruiterDailyResumeGateRow): SourceGap[] {
  if (row.status === "ready_for_review") return []
  return [
    {
      id: `gap_t10_${row.status}`,
      workflowId: "T10",
      sourceId: "looker_sql_runner",
      field: row.resume_requested ? "template_preserved" : "resume_requested",
      reason: row.reason,
      blocksCutover: true,
    },
  ]
}

function buildRecruiterDailyDiscrepancies(
  runId: string,
  rows: readonly RecruiterDailyResumeGateRow[],
  legacyRows: readonly LegacyRecruiterDailyEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: recruiterDailyDailyReportModuleDefinition.capabilityId,
      workflowId: "T10",
      class: "intentional_modernization",
      severity: "blocking",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy Q15 may be executable, but command center blocks dormant report execution by default.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "needs_owner",
      owner: "Jordan",
    })
  )

  const legacyByGate = new Map(legacyRows.map((row) => [row.gate_id, row]))
  for (const row of rows) {
    const legacy = legacyByGate.get(row.gate_id)
    if (!legacy) continue
    if (legacy.status && legacy.status !== row.status) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: recruiterDailyDailyReportModuleDefinition.capabilityId,
          workflowId: "T10",
          class: "intentional_modernization",
          severity: "info",
          entityKey: `gate:${row.gate_id}`,
          field: "status",
          modernValueSummary: `Command-center gate status ${row.status}`,
          legacyValueSummary: `Legacy template status ${legacy.status}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (legacy.last_run_date && legacy.last_run_date !== row.last_run_date) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: recruiterDailyDailyReportModuleDefinition.capabilityId,
          workflowId: "T10",
          class: "stale_mapping",
          severity: "warning",
          entityKey: `gate:${row.gate_id}`,
          field: "last_run_date",
          modernValueSummary: `Command-center LAST_RUN_DATE ${row.last_run_date}`,
          legacyValueSummary: `Legacy LAST_RUN_DATE ${legacy.last_run_date}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}

function normalizeDate(value: string | undefined): string {
  if (!value) return "unknown"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "unknown"
  return date.toISOString().slice(0, 10)
}
