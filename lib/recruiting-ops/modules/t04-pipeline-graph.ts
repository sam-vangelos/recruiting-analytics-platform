import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { PipelineStageClass, PipelineStageRow } from "./t02-pipeline"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export interface LegacyPipelineGraphEvidenceRow {
  req_group: string
  stage_name?: string
  movement_count?: number
  week_bucket?: string
}

export interface PipelineGraphRow {
  req_group: string
  week_bucket: string
  stage_name: PipelineStageClass
  stage_order: number
  // Canonical stage from the shared taxonomy, carried from the T02 rows (null when the
  // operational class is terminal/non-pipeline or the substage is unmapped).
  core_stage: string | null
  core_stage_order: number | null
  movement_count: number
  total_movement_count: number
  movement_share: number
}

export interface RunPipelineGraphModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  pipelineRows: readonly PipelineStageRow[]
  legacyRows?: readonly LegacyPipelineGraphEvidenceRow[]
}

export const pipelineGraphModuleDefinition = {
  moduleId: "t04-pipeline-graph",
  workflowId: "T04",
  capabilityId: "pipeline_movement_intelligence",
  title: "T04 FDL Pipeline Graph",
  sourceIds: ["greenhouse", "looker_sql_runner", "google_sheets"],
  queryIds: ["Q10"],
  legacyArtifactIds: ["legacy_q10_pipeline_graph"],
  outputContractIds: ["pipeline_graph_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "pipeline_graph_sheet")!
if (!outputContract) throw new Error("Missing pipeline graph concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_q10_pipeline_graph")!
if (!legacyArtifact) throw new Error("Missing pipeline graph legacy artifact")

const STAGE_ORDER: Record<PipelineStageClass, number> = {
  application_review: 10,
  recruiter_screen: 20,
  technical: 30,
  onsite: 40,
  offer: 50,
  hired: 60,
  rejected: 70,
  unknown: 999,
}

export function derivePipelineGraphRows(pipelineRows: readonly PipelineStageRow[]): PipelineGraphRow[] {
  const grouped = new Map<string, { row: PipelineGraphRow; totalKey: string }>()
  const totals = new Map<string, number>()

  for (const row of pipelineRows) {
    const req_group = `req_${row.req_id}`
    const totalKey = [req_group, row.week_bucket].join("|")
    const key = [totalKey, row.stage_name].join("|")
    const current = grouped.get(key)?.row ?? {
      req_group,
      week_bucket: row.week_bucket,
      stage_name: row.stage_name,
      stage_order: STAGE_ORDER[row.stage_name],
      core_stage: row.core_stage,
      core_stage_order: row.core_stage_order,
      movement_count: 0,
      total_movement_count: 0,
      movement_share: 0,
    }
    grouped.set(key, {
      totalKey,
      row: {
        ...current,
        movement_count: current.movement_count + 1,
      },
    })
    totals.set(totalKey, (totals.get(totalKey) ?? 0) + 1)
  }

  return [...grouped.values()]
    .map(({ row, totalKey }) => {
      const total = totals.get(totalKey) ?? 0
      return {
        ...row,
        total_movement_count: total,
        movement_share: total === 0 ? 0 : Number((row.movement_count / total).toFixed(4)),
      }
    })
    .sort((a, b) =>
      [a.week_bucket, a.req_group, String(a.stage_order), a.stage_name].join("|").localeCompare(
        [b.week_bucket, b.req_group, String(b.stage_order), b.stage_name].join("|")
      )
    )
}

export async function runPipelineGraphModule(
  input: RunPipelineGraphModuleInput
): Promise<RecruitingOpsModuleResult<PipelineGraphRow>> {
  const runId = buildRunId(pipelineGraphModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = derivePipelineGraphRows(input.pipelineRows)
  const sourceGaps = buildPipelineGraphSourceGaps(normalizedRows)
  const discrepancies = buildPipelineGraphDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "t02_pipeline_rows_for_t04",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Graph rows derived from T02 pipeline facts.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Q10 FDL pipeline graph legacy evidence artifact.",
      artifactId: legacyArtifact.id,
      queryId: "Q10",
    },
  ]
  const publicSummary = {
    workflowId: pipelineGraphModuleDefinition.workflowId,
    moduleId: pipelineGraphModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    totalMovements: normalizedRows.reduce((sum, row) => sum + row.movement_count, 0),
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: pipelineGraphModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: pipelineGraphModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: pipelineGraphModuleDefinition.workflowId,
    capabilityId: pipelineGraphModuleDefinition.capabilityId,
    moduleId: pipelineGraphModuleDefinition.moduleId,
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
    definition: pipelineGraphModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

function buildPipelineGraphSourceGaps(rows: readonly PipelineGraphRow[]): SourceGap[] {
  return rows
    .filter((row) => row.stage_name === "unknown" || row.week_bucket === "unknown")
    .map((row) => ({
      id: `gap_t04_graph_${row.req_group}_${row.stage_name}_${row.week_bucket}`,
      workflowId: "T04",
      sourceId: "greenhouse",
      field: row.stage_name === "unknown" ? "stage_name" : "week_bucket",
      reason: "T04 graph row depends on unresolved T02 stage taxonomy or week-bucket mapping.",
      blocksCutover: true,
    }))
}

function buildPipelineGraphDiscrepancies(
  runId: string,
  rows: readonly PipelineGraphRow[],
  legacyRows: readonly LegacyPipelineGraphEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: pipelineGraphModuleDefinition.capabilityId,
      workflowId: "T04",
      class: "source_gap",
      severity: "blocking",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy Q10 graph may contain a value for this graph point.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByGraphPoint = new Map(
    legacyRows.map((row) => [[row.req_group, row.stage_name ?? "unknown", row.week_bucket ?? "unknown"].join("|"), row])
  )
  for (const row of rows) {
    const legacy = legacyByGraphPoint.get([row.req_group, row.stage_name, row.week_bucket].join("|"))
    if (!legacy) continue
    if (typeof legacy.movement_count === "number" && legacy.movement_count !== row.movement_count) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: pipelineGraphModuleDefinition.capabilityId,
          workflowId: "T04",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `graph:${row.req_group}:${row.stage_name}:${row.week_bucket}`,
          field: "movement_count",
          modernValueSummary: `T02-derived movement count ${row.movement_count}`,
          legacyValueSummary: `Legacy Q10 movement count ${legacy.movement_count}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}
