import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { PipelineGraphRow } from "./t04-pipeline-graph"
import type { WeeklyLeadershipRow } from "./t01-weekly-leadership"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export interface LegacyEltRecruitingUpdateEvidenceRow {
  section_id: string
  week_bucket?: string
  metric_value?: number
  narrative_draft?: string
}

export interface EltRecruitingUpdateRow {
  section_id: string
  section_title: string
  week_bucket: string
  metric_key: string
  metric_value: number
  narrative_draft: string
  human_review_required: true
  source_workflow_ids: string
}

export interface RunEltRecruitingUpdateModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  weekBucket: string
  weeklyLeadershipRows: readonly WeeklyLeadershipRow[]
  pipelineGraphRows?: readonly PipelineGraphRow[]
  legacyRows?: readonly LegacyEltRecruitingUpdateEvidenceRow[]
}

export const eltRecruitingUpdateModuleDefinition = {
  moduleId: "t06-elt-recruiting-updates",
  workflowId: "T06",
  capabilityId: "stakeholder_narrative_generation",
  title: "T06 ELT Recruiting Updates",
  sourceIds: ["google_docs", "google_sheets"],
  queryIds: [],
  legacyArtifactIds: ["legacy_elt_recruiting_update_doc"],
  outputContractIds: ["elt_recruiting_doc"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "elt_recruiting_doc")!
if (!outputContract) throw new Error("Missing ELT recruiting doc concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_elt_recruiting_update_doc")!
if (!legacyArtifact) throw new Error("Missing ELT recruiting update legacy artifact")

export function deriveEltRecruitingUpdateRows(input: {
  weekBucket: string
  weeklyLeadershipRows: readonly WeeklyLeadershipRow[]
  pipelineGraphRows?: readonly PipelineGraphRow[]
}): EltRecruitingUpdateRow[] {
  if (input.weeklyLeadershipRows.length === 0) return []

  const totalPipeline = input.weeklyLeadershipRows.reduce((sum, row) => sum + row.pipeline_count, 0)
  const totalOffers = input.weeklyLeadershipRows.reduce((sum, row) => sum + row.offer_count, 0)
  const totalMissingScorecards = input.weeklyLeadershipRows.reduce((sum, row) => sum + row.rps_missing_count, 0)
  const ownershipOpenCount = input.weeklyLeadershipRows.filter((row) => row.req_status === "ownership_open").length
  const graphMovements = input.pipelineGraphRows?.reduce((sum, row) => sum + row.movement_count, 0) ?? totalPipeline

  return [
    sectionRow({
      sectionId: "pipeline_health",
      sectionTitle: "Pipeline health",
      weekBucket: input.weekBucket,
      metricKey: "pipeline_count",
      metricValue: totalPipeline,
      narrativeDraft: `Pipeline activity shows ${totalPipeline} weekly stage movements across tracked roles; graph data covers ${graphMovements} movements.`,
      sourceWorkflowIds: "T01|T04",
    }),
    sectionRow({
      sectionId: "offer_activity",
      sectionTitle: "Offer activity",
      weekBucket: input.weekBucket,
      metricKey: "offer_count",
      metricValue: totalOffers,
      narrativeDraft: `Offer lifecycle activity shows ${totalOffers} final-offer events for the reporting period.`,
      sourceWorkflowIds: "T01|T07",
    }),
    sectionRow({
      sectionId: "scorecard_accountability",
      sectionTitle: "Scorecard accountability",
      weekBucket: input.weekBucket,
      metricKey: "rps_missing_count",
      metricValue: totalMissingScorecards,
      narrativeDraft: `RPS accountability review has ${totalMissingScorecards} missing scorecard item(s) requiring follow-up.`,
      sourceWorkflowIds: "T01|T05",
    }),
    sectionRow({
      sectionId: "ownership_coverage",
      sectionTitle: "Ownership coverage",
      weekBucket: input.weekBucket,
      metricKey: "ownership_open_count",
      metricValue: ownershipOpenCount,
      narrativeDraft: `Ownership coverage has ${ownershipOpenCount} tracked role(s) with open ownership mapping review.`,
      sourceWorkflowIds: "T01|T09",
    }),
  ]
}

export async function runEltRecruitingUpdateModule(
  input: RunEltRecruitingUpdateModuleInput
): Promise<RecruitingOpsModuleResult<EltRecruitingUpdateRow>> {
  const runId = buildRunId(eltRecruitingUpdateModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = deriveEltRecruitingUpdateRows(input)
  const sourceGaps = buildEltRecruitingUpdateSourceGaps(input.weekBucket, input.weeklyLeadershipRows)
  const discrepancies = buildEltRecruitingUpdateDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "t01_t04_rows_for_t06",
      sourceId: "google_sheets",
      adapter: "local_renderer",
      label: "T06 local narrative draft composed from T01 leadership rows and optional T04 graph rows.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Legacy ELT recruiting update doc section evidence.",
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: eltRecruitingUpdateModuleDefinition.workflowId,
    moduleId: eltRecruitingUpdateModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    humanReviewRequired: true,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: eltRecruitingUpdateModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: eltRecruitingUpdateModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: eltRecruitingUpdateModuleDefinition.workflowId,
    capabilityId: eltRecruitingUpdateModuleDefinition.capabilityId,
    moduleId: eltRecruitingUpdateModuleDefinition.moduleId,
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
    definition: eltRecruitingUpdateModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

function sectionRow(input: {
  sectionId: string
  sectionTitle: string
  weekBucket: string
  metricKey: string
  metricValue: number
  narrativeDraft: string
  sourceWorkflowIds: string
}): EltRecruitingUpdateRow {
  return {
    section_id: input.sectionId,
    section_title: input.sectionTitle,
    week_bucket: input.weekBucket,
    metric_key: input.metricKey,
    metric_value: input.metricValue,
    narrative_draft: input.narrativeDraft,
    human_review_required: true,
    source_workflow_ids: input.sourceWorkflowIds,
  }
}

function buildEltRecruitingUpdateSourceGaps(
  weekBucket: string,
  weeklyLeadershipRows: readonly WeeklyLeadershipRow[]
): SourceGap[] {
  if (weeklyLeadershipRows.length > 0) return []
  return [
    {
      id: `gap_t06_weekly_leadership_${weekBucket}`,
      workflowId: "T06",
      sourceId: "google_sheets",
      field: "weeklyLeadershipRows",
      reason: "T06 narrative draft requires T01 weekly leadership rows before local rendering.",
      blocksCutover: true,
    },
  ]
}

function buildEltRecruitingUpdateDiscrepancies(
  runId: string,
  rows: readonly EltRecruitingUpdateRow[],
  legacyRows: readonly LegacyEltRecruitingUpdateEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: eltRecruitingUpdateModuleDefinition.capabilityId,
      workflowId: "T06",
      class: "source_gap",
      severity: "blocking",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy ELT doc may contain a manually assembled section for this week.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyBySection = new Map(legacyRows.map((row) => [row.section_id, row]))
  for (const row of rows) {
    const legacy = legacyBySection.get(row.section_id)
    if (!legacy) continue
    if (typeof legacy.metric_value === "number" && legacy.metric_value !== row.metric_value) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: eltRecruitingUpdateModuleDefinition.capabilityId,
          workflowId: "T06",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `section:${row.section_id}`,
          field: "metric_value",
          modernValueSummary: `Command-center metric value ${row.metric_value}`,
          legacyValueSummary: `Legacy ELT doc metric value ${legacy.metric_value}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (legacy.narrative_draft && legacy.narrative_draft !== row.narrative_draft) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: eltRecruitingUpdateModuleDefinition.capabilityId,
          workflowId: "T06",
          class: "intentional_modernization",
          severity: "info",
          entityKey: `section:${row.section_id}`,
          field: "narrative_draft",
          modernValueSummary: "Command-center generated deterministic draft text for human review.",
          legacyValueSummary: "Legacy ELT doc contains manually authored narrative text.",
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}
