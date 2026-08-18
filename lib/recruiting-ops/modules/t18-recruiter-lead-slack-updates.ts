import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export interface RecruiterLeadUpdateFact {
  leadId: string
  leadName: string
  reqGroup: string
  weekBucket: string
  movementCount: number
  stalledCount: number
  offerCount: number
  targetChannelLabel?: string
  sourceWorkflowIds?: readonly string[]
}

export interface LegacyRecruiterLeadSlackEvidenceRow {
  lead_id: string
  movement_count?: number
  stalled_count?: number
  offer_count?: number
}

export interface RecruiterLeadSlackDraftRow {
  lead_id: string
  lead_name: string | null
  target_channel_label: string
  req_group: string
  week_bucket: string
  movement_count: number
  stalled_count: number
  offer_count: number
  draft_body: string
  source_workflow_ids: string
  human_send_required: boolean
  review_required: boolean
}

export interface RunRecruiterLeadSlackUpdatesModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  updateFacts: readonly RecruiterLeadUpdateFact[]
  legacyRows?: readonly LegacyRecruiterLeadSlackEvidenceRow[]
}

export const recruiterLeadSlackUpdatesModuleDefinition = {
  moduleId: "t18-recruiter-lead-slack-updates",
  workflowId: "T18",
  capabilityId: "stakeholder_narrative_generation",
  title: "T18 Recruiter Lead Slack Updates",
  sourceIds: ["slack", "google_sheets"],
  queryIds: [],
  legacyArtifactIds: ["legacy_recruiter_lead_slack_update_pattern"],
  outputContractIds: ["recruiter_lead_slack_draft"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find(
  (contract) => contract.sourceContractId === "recruiter_lead_slack_draft"
)!
if (!outputContract) throw new Error("Missing recruiter lead Slack draft concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find(
  (artifact) => artifact.id === "legacy_recruiter_lead_slack_update_pattern"
)!
if (!legacyArtifact) throw new Error("Missing recruiter lead Slack update legacy artifact")

export function normalizeRecruiterLeadSlackDraftRows(input: {
  updateFacts: readonly RecruiterLeadUpdateFact[]
}): RecruiterLeadSlackDraftRow[] {
  return input.updateFacts
    .map((fact) => {
      const sourceWorkflowIds = fact.sourceWorkflowIds?.length ? fact.sourceWorkflowIds.join("|") : ""
      const reviewRequired =
        fact.leadName.trim().length === 0 ||
        fact.reqGroup.trim().length === 0 ||
        fact.weekBucket.trim().length === 0 ||
        sourceWorkflowIds.length === 0 ||
        fact.movementCount < 0 ||
        fact.stalledCount < 0 ||
        fact.offerCount < 0
      return {
        lead_id: fact.leadId,
        lead_name: fact.leadName.trim() || null,
        target_channel_label: fact.targetChannelLabel?.trim() || "human_selected",
        req_group: fact.reqGroup,
        week_bucket: fact.weekBucket,
        movement_count: fact.movementCount,
        stalled_count: fact.stalledCount,
        offer_count: fact.offerCount,
        draft_body: buildDraftBody(fact),
        source_workflow_ids: sourceWorkflowIds,
        human_send_required: true,
        review_required: reviewRequired,
      }
    })
    .sort((a, b) => [a.week_bucket, a.req_group, a.lead_id].join("|").localeCompare([b.week_bucket, b.req_group, b.lead_id].join("|")))
}

export async function runRecruiterLeadSlackUpdatesModule(
  input: RunRecruiterLeadSlackUpdatesModuleInput
): Promise<RecruitingOpsModuleResult<RecruiterLeadSlackDraftRow>> {
  const runId = buildRunId(recruiterLeadSlackUpdatesModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizeRecruiterLeadSlackDraftRows(input)
  const sourceGaps = buildRecruiterLeadSlackSourceGaps(input.updateFacts, normalizedRows)
  const discrepancies = buildRecruiterLeadSlackDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "t18_source_pipeline_progress",
      sourceId: "google_sheets",
      adapter: "local_renderer",
      label: "T02/T03-style pipeline and progress facts used for recruiter lead update drafts.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Legacy recruiter lead Slack update examples and recipient rules.",
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: recruiterLeadSlackUpdatesModuleDefinition.workflowId,
    moduleId: recruiterLeadSlackUpdatesModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    reviewRequiredCount: normalizedRows.filter((row) => row.review_required).length,
    humanSendRequiredCount: normalizedRows.filter((row) => row.human_send_required).length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: recruiterLeadSlackUpdatesModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: recruiterLeadSlackUpdatesModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: recruiterLeadSlackUpdatesModuleDefinition.workflowId,
    capabilityId: recruiterLeadSlackUpdatesModuleDefinition.capabilityId,
    moduleId: recruiterLeadSlackUpdatesModuleDefinition.moduleId,
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
    definition: recruiterLeadSlackUpdatesModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

export function buildDraftBody(fact: RecruiterLeadUpdateFact): string {
  const lead = fact.leadName.trim() || "Recruiting lead"
  const source = fact.sourceWorkflowIds?.length ? ` Source: ${fact.sourceWorkflowIds.join(", ")}.` : ""
  return [
    `${lead}: ${fact.reqGroup} update for ${fact.weekBucket}.`,
    `${fact.movementCount} stage movements, ${fact.stalledCount} stalled items, ${fact.offerCount} offers.`,
    "Please review before sending.",
    source,
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

function buildRecruiterLeadSlackSourceGaps(
  updateFacts: readonly RecruiterLeadUpdateFact[],
  rows: readonly RecruiterLeadSlackDraftRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (updateFacts.length === 0) {
    gaps.push({
      id: "gap_t18_update_facts_missing",
      workflowId: "T18",
      sourceId: "google_sheets",
      field: "updateFacts",
      reason: "Recruiter lead draft updates require T02/T03-style pipeline/progress facts.",
      blocksCutover: true,
    })
  }
  for (const row of rows) {
    if (row.source_workflow_ids.length === 0) {
      gaps.push({
        id: `gap_t18_source_workflows_${row.lead_id}`,
        workflowId: "T18",
        sourceId: "google_sheets",
        field: "source_workflow_ids",
        reason: `Source workflow lineage is missing for recruiter lead ${row.lead_id}.`,
        blocksCutover: true,
      })
    }
    if (row.lead_name === null) {
      gaps.push({
        id: `gap_t18_lead_name_${row.lead_id}`,
        workflowId: "T18",
        sourceId: "slack",
        field: "lead_name",
        reason: `Recruiter lead name is unmapped for ${row.lead_id}.`,
        blocksCutover: false,
      })
    }
    if (row.movement_count < 0 || row.stalled_count < 0 || row.offer_count < 0) {
      gaps.push({
        id: `gap_t18_negative_metrics_${row.lead_id}`,
        workflowId: "T18",
        sourceId: "google_sheets",
        field: "metrics",
        reason: `Recruiter lead metrics contain a negative value for ${row.lead_id}.`,
        blocksCutover: true,
      })
    }
  }
  return gaps
}

function buildRecruiterLeadSlackDiscrepancies(
  runId: string,
  rows: readonly RecruiterLeadSlackDraftRow[],
  legacyRows: readonly LegacyRecruiterLeadSlackEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: recruiterLeadSlackUpdatesModuleDefinition.capabilityId,
      workflowId: "T18",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy Slack examples or source sheets may contain this evidence.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByLead = new Map(legacyRows.map((row) => [row.lead_id, row]))
  for (const row of rows) {
    const legacy = legacyByLead.get(row.lead_id)
    if (!legacy) continue
    for (const field of ["movement_count", "stalled_count", "offer_count"] as const) {
      if (legacy[field] !== undefined && legacy[field] !== row[field]) {
        discrepancies.push(
          buildDiscrepancy({
            runId,
            capabilityId: recruiterLeadSlackUpdatesModuleDefinition.capabilityId,
            workflowId: "T18",
            class: "business_definition_open",
            severity: "warning",
            entityKey: row.lead_id,
            field,
            modernValueSummary: String(row[field]),
            legacyValueSummary: String(legacy[field]),
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
