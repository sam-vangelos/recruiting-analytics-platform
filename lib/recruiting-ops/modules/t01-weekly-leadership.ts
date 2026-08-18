import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { CommandCenterMode, SourceEvidenceRef } from "../substrate"
import type { FinalOfferRow } from "./t07-final-offer"
import type { OwnershipRow } from "./t09-ownership"
import type { PipelineStageRow } from "./t02-pipeline"
import type { RpsRow } from "./t05-rps"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export interface LegacyWeeklyLeadershipEvidenceRow {
  job_id: string
  pipeline_count?: number
  offer_count?: number
  week_bucket?: string
}

export interface WeeklyLeadershipRow {
  job_id: string
  req_status: string
  pipeline_count: number
  offer_count: number
  rps_missing_count: number
  openings_count: number
  recruiter_name: string | null
  week_bucket: string
  // Human-owned leadership fields (legacy "manual prioritization/status" columns).
  // The structured rollup carries them; it never invents them — null until a human fills them.
  billable: string | null
  priority: string | null
  role_type: string | null
  job_health: string | null
  job_progress: string | null
  comments: string | null
}

export interface ManualLeadershipFields {
  job_id: string
  billable?: string
  priority?: string
  role_type?: string
  job_health?: string
  job_progress?: string
  comments?: string
}

export interface RunWeeklyLeadershipModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  /** Honest run mode; defaults to "fixture" for fixture-driven tests. */
  mode?: CommandCenterMode
  weekBucket: string
  finalOfferRows: readonly FinalOfferRow[]
  rpsRows: readonly RpsRow[]
  pipelineRows: readonly PipelineStageRow[]
  ownershipRows: readonly OwnershipRow[]
  manualFields?: readonly ManualLeadershipFields[]
  legacyRows?: readonly LegacyWeeklyLeadershipEvidenceRow[]
}

export const weeklyLeadershipModuleDefinition = {
  moduleId: "t01-weekly-leadership",
  workflowId: "T01",
  capabilityId: "structured_hiring_status",
  title: "T01 weekly leadership rollup",
  sourceIds: ["greenhouse", "looker_sql_runner", "google_sheets", "google_apps_script"],
  queryIds: ["Q01", "Q02", "Q03"],
  legacyArtifactIds: ["legacy_q01_q03_weekly_recruitment"],
  outputContractIds: ["weekly_recruitment_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "weekly_recruitment_sheet")!
if (!outputContract) throw new Error("Missing weekly leadership concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_q01_q03_weekly_recruitment")!
if (!legacyArtifact) throw new Error("Missing weekly leadership legacy artifact")

export function deriveWeeklyLeadershipRows(input: {
  weekBucket: string
  finalOfferRows: readonly FinalOfferRow[]
  rpsRows: readonly RpsRow[]
  pipelineRows: readonly PipelineStageRow[]
  ownershipRows: readonly OwnershipRow[]
  manualFields?: readonly ManualLeadershipFields[]
}): WeeklyLeadershipRow[] {
  const jobIds = new Set<string>()
  input.pipelineRows.forEach((row) => jobIds.add(row.job_id))
  input.finalOfferRows.forEach((row) => jobIds.add(row.job_id))
  input.rpsRows.forEach((row) => jobIds.add(row.job_id))
  input.ownershipRows.filter((row) => row.view_type === "job").forEach((row) => jobIds.add(row.job_id))

  const manualByJob = new Map((input.manualFields ?? []).map((manual) => [manual.job_id, manual]))

  return [...jobIds].sort().map((jobId) => {
    const ownership = input.ownershipRows.find((row) => row.view_type === "job" && row.job_id === jobId)
    const pipelineRows = input.pipelineRows.filter((row) => row.job_id === jobId && row.week_bucket === input.weekBucket)
    const offerRows = input.finalOfferRows.filter((row) => row.job_id === jobId && offerBelongsToWeek(row, input.weekBucket))
    const rpsRows = input.rpsRows.filter((row) => row.job_id === jobId && row.week_bucket === input.weekBucket)
    const manual = manualByJob.get(jobId)

    return {
      job_id: jobId,
      req_status: ownership ? "active" : "ownership_open",
      pipeline_count: pipelineRows.length,
      offer_count: offerRows.length,
      rps_missing_count: rpsRows.filter((row) => row.scorecard_status === "missing").length,
      openings_count: ownership?.openings_count ?? 0,
      recruiter_name: ownership?.recruiter_name ?? null,
      week_bucket: input.weekBucket,
      billable: manual?.billable ?? null,
      priority: manual?.priority ?? null,
      role_type: manual?.role_type ?? null,
      job_health: manual?.job_health ?? null,
      job_progress: manual?.job_progress ?? null,
      comments: manual?.comments ?? null,
    }
  })
}

const WEEK_SPAN_MS = 7 * 24 * 60 * 60 * 1000

/**
 * SHADOW-MODULES-1: a monthly-grain offer must count in exactly ONE week bucket, never in
 * every week of its month (the legacy slice(0,7) filter replicated each offer into all
 * 4-5 weekly rollups). Attribution: the offer's creation timestamp when present;
 * otherwise the deterministic mid-month anchor (the 15th), which any aligned weekly
 * partition of a month contains exactly once. Unparseable inputs attribute nowhere —
 * conservative under-counting over double-counting.
 */
function offerBelongsToWeek(row: FinalOfferRow, weekBucket: string): boolean {
  const weekStartMs = Date.parse(`${weekBucket}T00:00:00.000Z`)
  if (Number.isNaN(weekStartMs)) return false
  // `||` (not `??`): a blank offer_created_at must fall back to the anchor, never
  // Date.parse("") → NaN → attributed to zero weeks forever.
  const anchor = row.offer_created_at || `${row.month_bucket}-15T00:00:00.000Z`
  const anchorMs = Date.parse(anchor)
  if (Number.isNaN(anchorMs)) return false
  return anchorMs >= weekStartMs && anchorMs < weekStartMs + WEEK_SPAN_MS
}

export async function runWeeklyLeadershipModule(
  input: RunWeeklyLeadershipModuleInput
): Promise<RecruitingOpsModuleResult<WeeklyLeadershipRow>> {
  const runId = buildRunId(weeklyLeadershipModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = deriveWeeklyLeadershipRows(input)
  const sourceGaps = buildWeeklyLeadershipSourceGaps(normalizedRows)
  const discrepancies = buildWeeklyLeadershipDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "t01_composed_module_facts",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "T01 rollup composed from T07, T05, T02/T03, and T09 facts.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Q01-Q03 weekly recruitment legacy evidence artifacts.",
      artifactId: legacyArtifact.id,
      queryId: "Q01",
    },
  ]
  const publicSummary = {
    workflowId: weeklyLeadershipModuleDefinition.workflowId,
    moduleId: weeklyLeadershipModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    totalPipelineCount: normalizedRows.reduce((sum, row) => sum + row.pipeline_count, 0),
    totalOfferCount: normalizedRows.reduce((sum, row) => sum + row.offer_count, 0),
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: weeklyLeadershipModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: weeklyLeadershipModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: weeklyLeadershipModuleDefinition.workflowId,
    capabilityId: weeklyLeadershipModuleDefinition.capabilityId,
    moduleId: weeklyLeadershipModuleDefinition.moduleId,
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
    definition: weeklyLeadershipModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

function buildWeeklyLeadershipSourceGaps(rows: readonly WeeklyLeadershipRow[]): SourceGap[] {
  return rows
    .filter((row) => row.req_status === "ownership_open")
    .map((row) => ({
      id: `gap_t01_ownership_${row.job_id}_${row.week_bucket}`,
      workflowId: "T01",
      sourceId: "greenhouse",
      field: "recruiter_name",
      reason: "Leadership rollup has activity for a job without a confirmed ownership row.",
      blocksCutover: false,
    }))
}

function buildWeeklyLeadershipDiscrepancies(
  runId: string,
  rows: readonly WeeklyLeadershipRow[],
  legacyRows: readonly LegacyWeeklyLeadershipEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: weeklyLeadershipModuleDefinition.capabilityId,
      workflowId: "T01",
      class: "source_gap",
      severity: "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy Q01-Q03 may contain ownership fields for this job.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByJob = new Map(legacyRows.map((row) => [row.job_id, row]))
  for (const row of rows) {
    const legacy = legacyByJob.get(row.job_id)
    if (!legacy) continue
    if (typeof legacy.pipeline_count === "number" && legacy.pipeline_count !== row.pipeline_count) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: weeklyLeadershipModuleDefinition.capabilityId,
          workflowId: "T01",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `job:${row.job_id}`,
          field: "pipeline_count",
          modernValueSummary: `Composed module pipeline count ${row.pipeline_count}`,
          legacyValueSummary: `Legacy Q01-Q03 pipeline count ${legacy.pipeline_count}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (typeof legacy.offer_count === "number" && legacy.offer_count !== row.offer_count) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: weeklyLeadershipModuleDefinition.capabilityId,
          workflowId: "T01",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `job:${row.job_id}`,
          field: "offer_count",
          modernValueSummary: `Composed module offer count ${row.offer_count}`,
          legacyValueSummary: `Legacy Q01-Q03 offer count ${legacy.offer_count}`,
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
          capabilityId: weeklyLeadershipModuleDefinition.capabilityId,
          workflowId: "T01",
          class: "stale_mapping",
          severity: "warning",
          entityKey: `job:${row.job_id}`,
          field: "week_bucket",
          modernValueSummary: `Composed module week ${row.week_bucket}`,
          legacyValueSummary: `Legacy Q01-Q03 week ${legacy.week_bucket}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}
