import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { resolveTeam } from "../dimensions/recruiter-team-hod"
import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { CommandCenterMode, SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type OwnershipViewType = "job" | "recruiter"

export interface GreenhouseOwnershipFact {
  jobId: string
  recruiterName?: string
  sourcerName?: string
  podName?: string
  openingsCount: number
  observedAt?: string
}

export interface LegacyOwnershipEvidenceRow {
  view_type?: OwnershipViewType
  job_id?: string
  recruiter_name?: string
  openings_count?: number
}

export interface OwnershipRow {
  view_type: OwnershipViewType
  job_id: string
  recruiter_name: string | null
  sourcer_name: string | null
  pod_name: string | null
  openings_count: number
  workload_count: number
}

export interface RunOwnershipModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  /** Honest run mode; defaults to "fixture" for fixture-driven tests. */
  mode?: CommandCenterMode
  greenhouseFacts: readonly GreenhouseOwnershipFact[]
  /** Boundary-level mapping gaps: source records the read adapter could not turn into facts. */
  adapterSourceGaps?: readonly SourceGap[]
  /** Governed roster (migration 018); compiled fixture config when absent. */
  roster?: readonly RecruiterTeamHodEntry[]
  legacyRows?: readonly LegacyOwnershipEvidenceRow[]
}

export const ownershipModuleDefinition = {
  moduleId: "t09-ownership",
  workflowId: "T09",
  capabilityId: "ownership_capacity_management",
  title: "T09 ownership and recruiter workload",
  sourceIds: ["greenhouse", "looker_sql_runner", "google_sheets"],
  queryIds: ["Q13", "Q14"],
  legacyArtifactIds: ["legacy_q13_q14_role_assignment"],
  outputContractIds: ["role_assignment_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "role_assignment_sheet")!
if (!outputContract) throw new Error("Missing ownership concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_q13_q14_role_assignment")!
if (!legacyArtifact) throw new Error("Missing ownership legacy artifact")

export function normalizeOwnershipRows(
  facts: readonly GreenhouseOwnershipFact[],
  roster?: readonly RecruiterTeamHodEntry[]
): OwnershipRow[] {
  const jobRows = facts.filter(hasRequiredOwnershipFactIdentity).map((fact) => {
    // Pod = the recruiter's team, derived through the shared recruiter→team dimension.
    // Unresolved attribution is NULL, never "unmapped".
    const team = resolveTeam({ recruiterName: fact.recruiterName }, roster)
    return {
      view_type: "job" as const,
      job_id: fact.jobId,
      recruiter_name: fact.recruiterName?.trim() || null,
      sourcer_name: fact.sourcerName?.trim() || null,
      pod_name: team.team_name,
      openings_count: fact.openingsCount,
      workload_count: fact.openingsCount,
    }
  })
  const byRecruiter = new Map<string | null, OwnershipRow>()

  for (const row of jobRows) {
    const current = byRecruiter.get(row.recruiter_name) ?? {
      view_type: "recruiter" as const,
      job_id: "all",
      recruiter_name: row.recruiter_name,
      sourcer_name: null,
      pod_name: null,
      openings_count: 0,
      workload_count: 0,
    }
    byRecruiter.set(row.recruiter_name, {
      ...current,
      openings_count: current.openings_count + row.openings_count,
      workload_count: current.workload_count + 1,
    })
  }

  return [...jobRows, ...byRecruiter.values()]
}

export async function runOwnershipModule(
  input: RunOwnershipModuleInput
): Promise<RecruitingOpsModuleResult<OwnershipRow>> {
  const runId = buildRunId(ownershipModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizeOwnershipRows(input.greenhouseFacts, input.roster)
  const sourceGaps = [
    ...(input.adapterSourceGaps ?? []),
    ...buildOwnershipSourceGaps(input.greenhouseFacts, normalizedRows, input.roster),
  ]
  const discrepancies = buildOwnershipDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "greenhouse_t09_ownership_facts",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Greenhouse-style job ownership and workload facts for T09.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Q13/Q14 role assignment legacy evidence artifacts.",
      artifactId: legacyArtifact.id,
      queryId: "Q13",
    },
  ]
  const publicSummary = {
    workflowId: ownershipModuleDefinition.workflowId,
    moduleId: ownershipModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: ownershipModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: ownershipModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: ownershipModuleDefinition.workflowId,
    capabilityId: ownershipModuleDefinition.capabilityId,
    moduleId: ownershipModuleDefinition.moduleId,
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
    definition: ownershipModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

function buildOwnershipSourceGaps(
  facts: readonly GreenhouseOwnershipFact[],
  rows: readonly OwnershipRow[],
  roster?: readonly RecruiterTeamHodEntry[]
): SourceGap[] {
  const gaps: SourceGap[] = buildRequiredOwnershipSourceGaps(facts)
  for (const fact of facts.filter(hasRequiredOwnershipFactIdentity)) {
    if (!fact.recruiterName) {
      gaps.push({
        id: `gap_t09_recruiter_${fact.jobId}`,
        workflowId: "T09",
        sourceId: "greenhouse",
        field: "recruiter_name",
        reason: "Recruiter owner is missing from Greenhouse ownership fact.",
        blocksCutover: true,
      })
    }
    if (resolveTeam({ recruiterName: fact.recruiterName }, roster).status !== "resolved") {
      gaps.push({
        id: `gap_t09_pod_${fact.jobId}`,
        workflowId: "T09",
        sourceId: "greenhouse",
        field: "pod_name",
        reason: "Recruiter→team (pod) mapping is unresolved for this job.",
        blocksCutover: false,
      })
    }
    if (fact.openingsCount < 0) {
      gaps.push({
        id: `gap_t09_openings_${fact.jobId}`,
        workflowId: "T09",
        sourceId: "greenhouse",
        field: "openings_count",
        reason: "Opening count cannot be negative.",
        blocksCutover: true,
      })
    }
  }
  if (rows.length === 0) {
    gaps.push({
      id: "gap_t09_no_rows",
      workflowId: "T09",
      sourceId: "greenhouse",
      field: "ownershipRows",
      reason: "No ownership rows were produced.",
      blocksCutover: true,
    })
  }
  return gaps
}

function buildRequiredOwnershipSourceGaps(facts: readonly GreenhouseOwnershipFact[]): SourceGap[] {
  const gaps: SourceGap[] = []
  facts.forEach((fact, index) => {
    if (!isUsableId(fact.jobId)) {
      gaps.push(
        requiredGap(
          "job_id",
          `source_${index}`,
          "Job ID is required before ownership rows can be grouped or deduped."
        )
      )
    }
  })
  return gaps
}

function hasRequiredOwnershipFactIdentity(fact: GreenhouseOwnershipFact): boolean {
  return isUsableId(fact.jobId)
}

function isUsableId(value: string): boolean {
  return Boolean(value?.trim()) && value.trim().toLowerCase() !== "unknown"
}

function requiredGap(field: string, entity: string, reason: string): SourceGap {
  return {
    id: `gap_t09_required_${field}_${entity}`.replace(/[^A-Za-z0-9_./-]/g, "_"),
    workflowId: "T09",
    sourceId: "greenhouse",
    field,
    reason,
    blocksCutover: true,
  }
}

function buildOwnershipDiscrepancies(
  runId: string,
  rows: readonly OwnershipRow[],
  legacyRows: readonly LegacyOwnershipEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: ownershipModuleDefinition.capabilityId,
      workflowId: "T09",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy Q13/Q14 may contain a populated value for this field.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByJob = new Map(legacyRows.filter((row) => row.job_id).map((row) => [row.job_id, row]))
  for (const row of rows.filter((item) => item.view_type === "job")) {
    const legacy = legacyByJob.get(row.job_id)
    if (!legacy) continue
    if (legacy.recruiter_name && legacy.recruiter_name !== row.recruiter_name) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: ownershipModuleDefinition.capabilityId,
          workflowId: "T09",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `job:${row.job_id}`,
          field: "recruiter_name",
          modernValueSummary: "Greenhouse-derived recruiter differs from legacy owner.",
          legacyValueSummary: "Legacy Q13/Q14 recruiter differs from current owner.",
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (typeof legacy.openings_count === "number" && legacy.openings_count !== row.openings_count) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: ownershipModuleDefinition.capabilityId,
          workflowId: "T09",
          class: "stale_mapping",
          severity: "warning",
          entityKey: `job:${row.job_id}`,
          field: "openings_count",
          modernValueSummary: `Greenhouse-derived openings ${row.openings_count}`,
          legacyValueSummary: `Legacy Q13/Q14 openings ${legacy.openings_count}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}
