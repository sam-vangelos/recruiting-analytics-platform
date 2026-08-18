import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId } from "../runs"
import type { CommandCenterMode, SourceEvidenceRef } from "../substrate"
import type { PipelineStageRow } from "./t02-pipeline"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export interface ProgressRow {
  req_group: string
  stage_name: string
  // Canonical stage label for this operational group, carried from the T02 rows.
  core_stage: string | null
  movement_count: number
  week_bucket: string
}

export interface RunProgressModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  /** Honest run mode; defaults to "fixture" for fixture-driven tests. */
  mode?: CommandCenterMode
  pipelineRows: readonly PipelineStageRow[]
}

export const progressModuleDefinition = {
  moduleId: "t03-progress",
  workflowId: "T03",
  capabilityId: "pipeline_movement_intelligence",
  title: "T03 weekly progress derived from pipeline facts",
  sourceIds: ["google_sheets"],
  queryIds: [],
  legacyArtifactIds: [],
  outputContractIds: ["weekly_progress_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "weekly_progress_sheet")!
if (!outputContract) throw new Error("Missing progress concrete output contract")

export function deriveProgressRows(pipelineRows: readonly PipelineStageRow[]): ProgressRow[] {
  const grouped = new Map<string, ProgressRow>()
  for (const row of pipelineRows) {
    const req_group = `req_${row.req_id}`
    const key = [req_group, row.stage_name, row.week_bucket].join("|")
    const current = grouped.get(key) ?? {
      req_group,
      stage_name: row.stage_name,
      core_stage: row.core_stage,
      movement_count: 0,
      week_bucket: row.week_bucket,
    }
    grouped.set(key, { ...current, movement_count: current.movement_count + 1 })
  }
  return [...grouped.values()].sort((a, b) =>
    [a.week_bucket, a.req_group, a.stage_name].join("|").localeCompare([b.week_bucket, b.req_group, b.stage_name].join("|"))
  )
}

export async function runProgressModule(
  input: RunProgressModuleInput
): Promise<RecruitingOpsModuleResult<ProgressRow>> {
  const runId = buildRunId(progressModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = deriveProgressRows(input.pipelineRows)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "t02_pipeline_rows_for_t03",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Progress rows derived from T02 pipeline facts.",
    },
  ]
  const publicSummary = {
    workflowId: progressModuleDefinition.workflowId,
    moduleId: progressModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    sourceGapCount: 0,
    discrepancyCount: 0,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: progressModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: progressModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: progressModuleDefinition.workflowId,
    capabilityId: progressModuleDefinition.capabilityId,
    moduleId: progressModuleDefinition.moduleId,
    mode: input.mode ?? "fixture",
    status: "succeeded",
    startedAt: input.startedAt,
    completedAt: input.generatedAt,
    sourceRefs,
    legacyArtifactRefs: [],
    normalizedRows,
    artifactRefs: [jsonArtifact, csvArtifact],
    sourceGaps: [],
    discrepancies: [],
    publicSummary,
  })

  return finalizeModuleResult({
    definition: progressModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies: [],
    sourceGaps: [],
    run,
  })
}
