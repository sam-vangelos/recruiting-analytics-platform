import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { resolveTeam } from "../dimensions/recruiter-team-hod"
import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import type { InterviewStageTaxonomyEntry } from "../dimensions/types"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { CommandCenterMode, SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type RpsInterviewStage = "rps" | "technical" | "onsite" | "unknown"
export type RpsScorecardStatus = "submitted" | "pending" | "missing" | "unknown"
export type RpsMatchMismatch = "match" | "mismatch" | "unknown"

export interface GreenhouseRpsFact {
  applicationId: string
  jobId: string
  interviewId: string
  stageName: string
  scheduledAt: string
  scorecardStatus: string
  interviewerName?: string
  submitterName?: string
  overallRecommendation?: string
}

export interface LegacyRpsEvidenceRow {
  application_id: string
  interview_stage?: string
  scorecard_status?: string
  week_bucket?: string
}

export interface RpsRow {
  application_id: string
  job_id: string
  interview_id: string
  interview_stage: RpsInterviewStage
  scorecard_status: RpsScorecardStatus
  week_bucket: string
  interviewer_name: string | null
  submitter_name: string | null
  team_name: string | null
  match_mismatch: RpsMatchMismatch
  overall_recommendation: string | null
}

export interface RunRpsModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  /** Honest run mode; defaults to "fixture" for fixture-driven tests. */
  mode?: CommandCenterMode
  greenhouseFacts: readonly GreenhouseRpsFact[]
  /** Boundary-level mapping gaps: source records the read adapter could not turn into facts. */
  adapterSourceGaps?: readonly SourceGap[]
  /** Governed roster (migration 018); compiled fixture config when absent. */
  roster?: readonly RecruiterTeamHodEntry[]
  /** Governed stage-label classification (migration 018); heuristics when absent. */
  interviewStageTaxonomy?: readonly InterviewStageTaxonomyEntry[]
  legacyRows?: readonly LegacyRpsEvidenceRow[]
}

export const rpsModuleDefinition = {
  moduleId: "t05-rps",
  workflowId: "T05",
  capabilityId: "scorecard_accountability",
  title: "T05 RPS / scorecard accountability",
  sourceIds: ["greenhouse", "looker_sql_runner", "google_sheets"],
  queryIds: ["Q11"],
  legacyArtifactIds: ["legacy_q11_rps_tracking"],
  outputContractIds: ["rps_tracking_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "rps_tracking_sheet")!
if (!outputContract) throw new Error("Missing RPS concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_q11_rps_tracking")!
if (!legacyArtifact) throw new Error("Missing RPS legacy artifact")

export interface RpsGovernedDimensions {
  roster?: readonly RecruiterTeamHodEntry[]
  interviewStageTaxonomy?: readonly InterviewStageTaxonomyEntry[]
}

export function normalizeRpsRows(
  facts: readonly GreenhouseRpsFact[],
  dimensions: RpsGovernedDimensions = {}
): RpsRow[] {
  return facts.filter(hasRequiredRpsFactIdentity).map((fact) => {
    // Screening team is the scorecard submitter's team, via the shared dimension
    // (governed roster when supplied, compiled fixture config otherwise).
    const team = resolveTeam({ recruiterName: fact.submitterName }, dimensions.roster)
    return {
      application_id: fact.applicationId,
      job_id: fact.jobId,
      interview_id: fact.interviewId,
      interview_stage: normalizeRpsStage(fact.stageName, dimensions.interviewStageTaxonomy),
      scorecard_status: normalizeScorecardStatus(fact.scorecardStatus),
      week_bucket: weekBucket(fact.scheduledAt),
      interviewer_name: fact.interviewerName?.trim() || null,
      submitter_name: fact.submitterName?.trim() || null,
      team_name: team.team_name,
      match_mismatch: computeMatchMismatch(fact.submitterName, fact.interviewerName),
      overall_recommendation: fact.overallRecommendation?.trim() || null,
    }
  })
}

/**
 * Did the scorecard submitter also conduct the interview? Requires a real same-person
 * comparison: full normalized name equality. The legacy query's first-name fuzz collapsed
 * two different people sharing a first name into "match" (SHADOW-MODULES-7) — a false
 * accountability signal; the whole point of match_mismatch is catching a submitter
 * rubber-stamping someone else's interview. Legitimate name variants surface as
 * mismatches for human adjudication, never as silent matches.
 */
export function computeMatchMismatch(
  submitter: string | undefined,
  interviewer: string | undefined
): RpsMatchMismatch {
  const s = normalizePersonNameForComparison(submitter)
  const i = normalizePersonNameForComparison(interviewer)
  if (!s || !i) return "unknown"
  return s === i ? "match" : "mismatch"
}

function normalizePersonNameForComparison(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? ""
}

export async function runRpsModule(input: RunRpsModuleInput): Promise<RecruitingOpsModuleResult<RpsRow>> {
  const runId = buildRunId(rpsModuleDefinition.workflowId, input.startedAt)
  const dimensions: RpsGovernedDimensions = {
    roster: input.roster,
    interviewStageTaxonomy: input.interviewStageTaxonomy,
  }
  const normalizedRows = normalizeRpsRows(input.greenhouseFacts, dimensions)
  const sourceGaps = [
    ...(input.adapterSourceGaps ?? []),
    ...buildRpsSourceGaps(input.greenhouseFacts, normalizedRows),
  ]
  const discrepancies = buildRpsDiscrepancies(
    runId,
    normalizedRows,
    input.legacyRows ?? [],
    sourceGaps,
    input.interviewStageTaxonomy
  )
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "greenhouse_t05_scorecard_facts",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Greenhouse-style interview and scorecard facts for T05.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Q11 RPS tracking legacy evidence artifact.",
      artifactId: legacyArtifact.id,
      queryId: "Q11",
    },
  ]
  const publicSummary = {
    workflowId: rpsModuleDefinition.workflowId,
    moduleId: rpsModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    missingScorecards: normalizedRows.filter((row) => row.scorecard_status === "missing").length,
    mismatchCount: normalizedRows.filter((row) => row.match_mismatch === "mismatch").length,
    screeningVolumeByTeam: countScreeningByTeam(normalizedRows),
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    deliverableId: outputContract.sourceContractId,
    workflowId: rpsModuleDefinition.workflowId,
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
    workflowId: rpsModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: rpsModuleDefinition.workflowId,
    capabilityId: rpsModuleDefinition.capabilityId,
    moduleId: rpsModuleDefinition.moduleId,
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
    definition: rpsModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

function countScreeningByTeam(rows: readonly RpsRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    // Aggregate bucket label; "unresolved" counts rows whose submitter→team is a defect.
    const key = row.team_name ?? "unresolved"
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

// interview_stage is which interview ROUND (for scorecard accountability) — a distinct
// concept from the pipeline core_stage dimension (resolveStage), so T05 does not consume it.
export function normalizeRpsStage(
  stageName: string,
  taxonomy?: readonly InterviewStageTaxonomyEntry[]
): RpsInterviewStage {
  const normalized = stageName.trim().toLowerCase()
  // A governed taxonomy row (exact label match) wins over the heuristics —
  // org-specific slot labels ("CodePair Interview") classify by policy, not guess.
  const governed = taxonomy?.find((entry) => entry.stageLabel.trim().toLowerCase() === normalized)
  if (governed) return governed.stageClass
  if (normalized.includes("rps") || normalized.includes("phone")) return "rps"
  if (normalized.includes("technical")) return "technical"
  if (normalized.includes("onsite") || normalized.includes("on-site")) return "onsite"
  return "unknown"
}

export function normalizeScorecardStatus(status: string): RpsScorecardStatus {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["submitted", "complete", "completed"].includes(normalized)) return "submitted"
  if (["pending", "scheduled", "awaiting"].includes(normalized)) return "pending"
  if (["missing", "not_submitted", "no_scorecard"].includes(normalized)) return "missing"
  return "unknown"
}

function weekBucket(dateValue: string): string {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return "unknown"
  const day = date.getUTCDay()
  const diffToMonday = (day + 6) % 7
  date.setUTCDate(date.getUTCDate() - diffToMonday)
  return date.toISOString().slice(0, 10)
}

function buildRpsSourceGaps(facts: readonly GreenhouseRpsFact[], rows: readonly RpsRow[]): SourceGap[] {
  const gaps: SourceGap[] = buildRequiredRpsSourceGaps(facts)
  rows.forEach((row, index) => {
    if (row.interview_stage === "unknown") {
      gaps.push({
        id: `gap_t05_interview_stage_${row.interview_id}`,
        workflowId: "T05",
        sourceId: "greenhouse",
        field: "interview_stage",
        reason: `Interview taxonomy is open for source stage ${facts[index]?.stageName ?? "missing"}.`,
        blocksCutover: true,
      })
    }
    if (row.scorecard_status === "unknown") {
      gaps.push({
        id: `gap_t05_scorecard_status_${row.interview_id}`,
        workflowId: "T05",
        sourceId: "greenhouse",
        field: "scorecard_status",
        reason: `Scorecard status mapping is open for source status ${facts[index]?.scorecardStatus ?? "missing"}.`,
        blocksCutover: true,
      })
    }
    if (row.week_bucket === "unknown") {
      gaps.push({
        id: `gap_t05_week_bucket_${row.interview_id}`,
        workflowId: "T05",
        sourceId: "greenhouse",
        field: "week_bucket",
        reason: "Scheduled timestamp could not be converted into a week bucket.",
        blocksCutover: true,
      })
    }
  })
  return gaps
}

function buildRequiredRpsSourceGaps(facts: readonly GreenhouseRpsFact[]): SourceGap[] {
  const gaps: SourceGap[] = []
  facts.forEach((fact, index) => {
    for (const [field, value] of [
      ["application_id", fact.applicationId],
      ["job_id", fact.jobId],
      ["interview_id", fact.interviewId],
    ] as const) {
      if (!isUsableId(value)) {
        gaps.push(requiredGap("T05", field, `source_${index}`, `${field} is required before RPS rows can be grouped or deduped.`))
      }
    }
    if (!isUsableTimestamp(fact.scheduledAt)) {
      gaps.push(
        requiredGap(
          "T05",
          "scheduled_at",
          fact.applicationId || `source_${index}`,
          "Scheduled timestamp is required before RPS rows can be rendered."
        )
      )
    }
  })
  return gaps
}

function hasRequiredRpsFactIdentity(fact: GreenhouseRpsFact): boolean {
  return (
    isUsableId(fact.applicationId) &&
    isUsableId(fact.jobId) &&
    isUsableId(fact.interviewId) &&
    isUsableTimestamp(fact.scheduledAt)
  )
}

function isUsableId(value: string): boolean {
  return Boolean(value?.trim()) && value.trim().toLowerCase() !== "unknown"
}

function isUsableTimestamp(value: string): boolean {
  if (!value?.trim() || value.trim().toLowerCase() === "unknown") return false
  return !Number.isNaN(Date.parse(value))
}

function requiredGap(workflowId: "T05", field: string, entity: string, reason: string): SourceGap {
  return {
    id: `gap_${workflowId.toLowerCase()}_required_${field}_${entity}`.replace(/[^A-Za-z0-9_./-]/g, "_"),
    workflowId,
    sourceId: "greenhouse",
    field,
    reason,
    blocksCutover: true,
  }
}

function buildRpsDiscrepancies(
  runId: string,
  rows: readonly RpsRow[],
  legacyRows: readonly LegacyRpsEvidenceRow[],
  sourceGaps: readonly SourceGap[],
  interviewStageTaxonomy?: readonly InterviewStageTaxonomyEntry[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: rpsModuleDefinition.capabilityId,
      workflowId: "T05",
      class: "source_gap",
      severity: "blocking",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy Q11 may contain a populated value for this field.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByApplication = new Map(legacyRows.map((row) => [row.application_id, row]))
  for (const row of rows) {
    const legacy = legacyByApplication.get(row.application_id)
    if (!legacy) continue
    if (legacy.interview_stage && normalizeRpsStage(legacy.interview_stage, interviewStageTaxonomy) !== row.interview_stage) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: rpsModuleDefinition.capabilityId,
          workflowId: "T05",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `application:${row.application_id}`,
          field: "interview_stage",
          modernValueSummary: `Greenhouse-derived stage ${row.interview_stage}`,
          legacyValueSummary: `Legacy Q11 stage ${legacy.interview_stage}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (legacy.scorecard_status && normalizeScorecardStatus(legacy.scorecard_status) !== row.scorecard_status) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: rpsModuleDefinition.capabilityId,
          workflowId: "T05",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `application:${row.application_id}`,
          field: "scorecard_status",
          modernValueSummary: `Greenhouse-derived status ${row.scorecard_status}`,
          legacyValueSummary: `Legacy Q11 status ${legacy.scorecard_status}`,
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
          capabilityId: rpsModuleDefinition.capabilityId,
          workflowId: "T05",
          class: "stale_mapping",
          severity: "warning",
          entityKey: `application:${row.application_id}`,
          field: "week_bucket",
          modernValueSummary: `Greenhouse-derived week ${row.week_bucket}`,
          legacyValueSummary: `Legacy Q11 week ${legacy.week_bucket}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}
