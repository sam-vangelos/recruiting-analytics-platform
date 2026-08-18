import { resolveStage } from "../dimensions/stage-taxonomy"
import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { CommandCenterMode, SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type PipelineStageClass =
  | "application_review"
  | "recruiter_screen"
  | "technical"
  | "onsite"
  | "offer"
  | "hired"
  | "rejected"
  | "unknown"

export interface GreenhousePipelineStageFact {
  applicationId: string
  jobId: string
  reqId: string
  stageName: string
  stageChangedAt: string
}

export interface LegacyPipelineEvidenceRow {
  application_id: string
  req_id?: string
  stage_name?: string
  week_bucket?: string
}

export interface PipelineStageRow {
  application_id: string
  job_id: string
  req_id: string
  stage_name: PipelineStageClass
  // Canonical pipeline stage from the shared substage→core_stage dimension. NULL is a
  // defect (unmapped substage) for active rows; terminal/non-pipeline rows are NULL by design.
  core_stage: string | null
  core_stage_order: number | null
  stage_changed_at: string
  week_bucket: string
  dedupe_key: string
}

// Operational classes that represent terminal/non-pipeline states; a NULL core_stage on
// these is expected (the canonical taxonomy intentionally omits them), not a defect.
const NON_PIPELINE_STAGE_CLASSES: ReadonlySet<PipelineStageClass> = new Set(["hired", "rejected", "unknown"])

export interface RunPipelineModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  /** Honest run mode; defaults to "fixture" for fixture-driven tests. */
  mode?: CommandCenterMode
  greenhouseFacts: readonly GreenhousePipelineStageFact[]
  /** Boundary-level mapping gaps: source records the read adapter could not turn into facts. */
  adapterSourceGaps?: readonly SourceGap[]
  legacyRows?: readonly LegacyPipelineEvidenceRow[]
}

export const pipelineModuleDefinition = {
  moduleId: "t02-pipeline",
  workflowId: "T02",
  capabilityId: "pipeline_movement_intelligence",
  title: "T02 role-specific pipeline and stage movement",
  sourceIds: ["greenhouse", "looker_sql_runner", "google_sheets", "google_apps_script"],
  queryIds: ["Q04", "Q05", "Q06", "Q07", "Q08", "Q09"],
  legacyArtifactIds: ["legacy_q04_q09_pipeline_family"],
  outputContractIds: ["role_pipeline_sheets"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "role_pipeline_sheets")!
if (!outputContract) throw new Error("Missing pipeline concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_q04_q09_pipeline_family")!
if (!legacyArtifact) throw new Error("Missing pipeline legacy artifact")

export function normalizePipelineRows(facts: readonly GreenhousePipelineStageFact[]): PipelineStageRow[] {
  return facts.filter(hasRequiredPipelineFactIdentity).map((fact) => {
    const week_bucket = weekBucket(fact.stageChangedAt)
    const stage_name = normalizePipelineStage(fact.stageName)
    const stage = resolveStage(fact.stageName)
    return {
      application_id: fact.applicationId,
      job_id: fact.jobId,
      req_id: fact.reqId,
      stage_name,
      core_stage: stage.core_stage,
      core_stage_order: stage.stage_order,
      stage_changed_at: normalizeTimestamp(fact.stageChangedAt),
      week_bucket,
      dedupe_key: [fact.applicationId, fact.jobId, fact.reqId, stage_name, week_bucket].join("|"),
    }
  })
}

export async function runPipelineModule(
  input: RunPipelineModuleInput
): Promise<RecruitingOpsModuleResult<PipelineStageRow>> {
  const runId = buildRunId(pipelineModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizePipelineRows(input.greenhouseFacts)
  const sourceGaps = [
    ...(input.adapterSourceGaps ?? []),
    ...buildPipelineSourceGaps(input.greenhouseFacts, normalizedRows),
  ]
  const discrepancies = buildPipelineDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "greenhouse_t02_stage_facts",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Greenhouse-style application stage movement facts for T02.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Q04-Q09 role pipeline legacy evidence artifact family.",
      artifactId: legacyArtifact.id,
      queryId: "Q04",
    },
  ]
  const publicSummary = {
    workflowId: pipelineModuleDefinition.workflowId,
    moduleId: pipelineModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    deliverableId: outputContract.sourceContractId,
    workflowId: pipelineModuleDefinition.workflowId,
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
    workflowId: pipelineModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: pipelineModuleDefinition.workflowId,
    capabilityId: pipelineModuleDefinition.capabilityId,
    moduleId: pipelineModuleDefinition.moduleId,
    mode: input.mode ?? "fixture",
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
    definition: pipelineModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

export function normalizePipelineStage(stageName: string): PipelineStageClass {
  const normalized = stageName.trim().toLowerCase()
  if (normalized.includes("application")) return "application_review"
  if (normalized.includes("recruiter") || normalized.includes("phone")) return "recruiter_screen"
  if (normalized.includes("technical")) return "technical"
  if (normalized.includes("onsite") || normalized.includes("on-site")) return "onsite"
  if (normalized.includes("offer")) return "offer"
  if (normalized.includes("hired")) return "hired"
  if (normalized.includes("reject")) return "rejected"
  return "unknown"
}

function normalizeTimestamp(dateValue: string): string {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return "unknown"
  return date.toISOString()
}

function weekBucket(dateValue: string): string {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return "unknown"
  const day = date.getUTCDay()
  const diffToMonday = (day + 6) % 7
  date.setUTCDate(date.getUTCDate() - diffToMonday)
  return date.toISOString().slice(0, 10)
}

function buildPipelineSourceGaps(
  facts: readonly GreenhousePipelineStageFact[],
  rows: readonly PipelineStageRow[]
): SourceGap[] {
  const gaps: SourceGap[] = buildRequiredPipelineSourceGaps(facts)
  rows.forEach((row, index) => {
    if (row.stage_name === "unknown" && row.core_stage === null) {
      gaps.push({
        id: `gap_t02_stage_${row.application_id}_row_${index}`,
        workflowId: "T02",
        sourceId: "greenhouse",
        field: "stage_name",
        reason: `Stage taxonomy is open for source stage ${facts[index]?.stageName ?? "missing"}.`,
        blocksCutover: true,
      })
    }
    if (row.week_bucket === "unknown" || row.stage_changed_at === "unknown") {
      gaps.push({
        id: `gap_t02_stage_changed_at_${row.application_id}_row_${index}`,
        workflowId: "T02",
        sourceId: "greenhouse",
        field: "stage_changed_at",
        reason: "Stage movement timestamp could not be normalized.",
        blocksCutover: true,
      })
    }
    if (row.core_stage === null && !NON_PIPELINE_STAGE_CLASSES.has(row.stage_name)) {
      gaps.push({
        id: `gap_t02_core_stage_${row.application_id}_row_${index}`,
        workflowId: "T02",
        sourceId: "greenhouse",
        field: "core_stage",
        reason: `Active substage ${facts[index]?.stageName ?? "missing"} is not in the shared stage taxonomy (unresolved core stage).`,
        blocksCutover: false,
      })
    }
  })
  return gaps
}

function buildRequiredPipelineSourceGaps(facts: readonly GreenhousePipelineStageFact[]): SourceGap[] {
  const gaps: SourceGap[] = []
  facts.forEach((fact, index) => {
    for (const [field, value] of [
      ["application_id", fact.applicationId],
      ["job_id", fact.jobId],
      ["req_id", fact.reqId],
    ] as const) {
      if (!isUsableId(value)) {
        gaps.push(requiredGap("T02", field, `source_${index}`, `${field} is required before pipeline rows can be grouped or deduped.`))
      }
    }
    if (!isUsableTimestamp(fact.stageChangedAt)) {
      gaps.push(
        requiredGap(
          "T02",
          "stage_changed_at",
          // Facts are movement-grain: the same application appears once per
          // movement, so the entity must carry the index to stay unique.
          `${fact.applicationId || "source"}_${index}`,
          "Stage movement timestamp is required before pipeline rows can be rendered."
        )
      )
    }
  })
  return gaps
}

function hasRequiredPipelineFactIdentity(fact: GreenhousePipelineStageFact): boolean {
  return (
    isUsableId(fact.applicationId) &&
    isUsableId(fact.jobId) &&
    isUsableId(fact.reqId) &&
    isUsableTimestamp(fact.stageChangedAt)
  )
}

function isUsableId(value: string): boolean {
  return Boolean(value?.trim()) && value.trim().toLowerCase() !== "unknown"
}

function isUsableTimestamp(value: string): boolean {
  if (!value?.trim() || value.trim().toLowerCase() === "unknown") return false
  return !Number.isNaN(Date.parse(value))
}

function requiredGap(workflowId: "T02", field: string, entity: string, reason: string): SourceGap {
  return {
    id: `gap_${workflowId.toLowerCase()}_required_${field}_${entity}`.replace(/[^A-Za-z0-9_./-]/g, "_"),
    workflowId,
    sourceId: "greenhouse",
    field,
    reason,
    blocksCutover: true,
  }
}

function buildPipelineDiscrepancies(
  runId: string,
  rows: readonly PipelineStageRow[],
  legacyRows: readonly LegacyPipelineEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: pipelineModuleDefinition.capabilityId,
      workflowId: "T02",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy Q04-Q09 may contain a populated value for this field.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByApplication = new Map(legacyRows.map((row) => [row.application_id, row]))
  for (const row of rows) {
    const legacy = legacyByApplication.get(row.application_id)
    if (!legacy) continue
    if (legacy.stage_name && normalizePipelineStage(legacy.stage_name) !== row.stage_name) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: pipelineModuleDefinition.capabilityId,
          workflowId: "T02",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `application:${row.application_id}`,
          field: "stage_name",
          modernValueSummary: `Greenhouse-derived stage ${row.stage_name}`,
          legacyValueSummary: `Legacy pipeline stage ${legacy.stage_name}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (legacy.week_bucket && legacy.week_bucket !== row.week_bucket) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: pipelineModuleDefinition.capabilityId,
          workflowId: "T02",
          class: "stale_mapping",
          severity: "warning",
          entityKey: `application:${row.application_id}`,
          field: "week_bucket",
          modernValueSummary: `Greenhouse-derived week ${row.week_bucket}`,
          legacyValueSummary: `Legacy pipeline week ${legacy.week_bucket}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}
