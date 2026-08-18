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
export type FinalOfferStatus = "created" | "approved" | "sent" | "accepted" | "declined" | "unknown"

export interface GreenhouseFinalOfferFact {
  applicationId: string
  jobId: string
  offerId: string
  status: string
  createdAt: string
  recruiterName?: string
  sourcerName?: string
  teamName?: string
  hodName?: string
}

export interface LegacyFinalOfferEvidenceRow {
  application_id: string
  offer_status?: string
  month_bucket?: string
}

export interface FinalOfferRow {
  application_id: string
  job_id: string
  offer_id: string
  offer_status: FinalOfferStatus
  month_bucket: string
  /**
   * Offer creation timestamp (Greenhouse createdAt). Lets weekly consumers attribute a
   * monthly-grain offer to exactly one week (SHADOW-MODULES-1); optional because legacy
   * evidence rows only carry month_bucket.
   */
  offer_created_at?: string | null
  recruiter_name: string | null
  sourcer_name: string | null
  team_name: string | null
  hod_name: string | null
}

export interface RunFinalOfferModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  /** Honest run mode; defaults to "fixture" for fixture-driven tests. */
  mode?: CommandCenterMode
  greenhouseFacts: readonly GreenhouseFinalOfferFact[]
  /** Boundary-level mapping gaps: source records the read adapter could not turn into facts. */
  adapterSourceGaps?: readonly SourceGap[]
  /** Governed roster (migration 018); compiled fixture config when absent. */
  roster?: readonly RecruiterTeamHodEntry[]
  legacyRows?: readonly LegacyFinalOfferEvidenceRow[]
}

export const finalOfferModuleDefinition = {
  moduleId: "t07-final-offer",
  workflowId: "T07",
  capabilityId: "offer_and_hire_lifecycle_intelligence",
  title: "T07 Final Offer / offer lifecycle",
  sourceIds: ["greenhouse", "looker_sql_runner", "google_sheets"],
  queryIds: ["Q12"],
  legacyArtifactIds: ["legacy_q12_final_offer"],
  outputContractIds: ["final_offer_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "final_offer_sheet")!
if (!outputContract) throw new Error("Missing final offer concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_q12_final_offer")!
if (!legacyArtifact) throw new Error("Missing final offer legacy artifact")

export function normalizeFinalOfferRows(
  facts: readonly GreenhouseFinalOfferFact[],
  roster?: readonly RecruiterTeamHodEntry[]
): FinalOfferRow[] {
  return facts.filter(hasRequiredFinalOfferFactIdentity).map((fact) => {
    // Team/HOD are derived through the shared recruiter→team dimension, not trusted
    // from a raw fact field. Unresolved attribution is a NULL defect, never "unmapped".
    const team = resolveTeam({ recruiterName: fact.recruiterName }, roster)
    return {
      application_id: fact.applicationId,
      job_id: fact.jobId,
      offer_id: fact.offerId,
      offer_status: normalizeOfferStatus(fact.status),
      month_bucket: monthBucket(fact.createdAt),
      offer_created_at: fact.createdAt,
      recruiter_name: fact.recruiterName?.trim() || null,
      sourcer_name: fact.sourcerName?.trim() || null,
      team_name: team.team_name,
      hod_name: team.hod_name,
    }
  })
}

export async function runFinalOfferModule(
  input: RunFinalOfferModuleInput
): Promise<RecruitingOpsModuleResult<FinalOfferRow>> {
  const runId = buildRunId(finalOfferModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = normalizeFinalOfferRows(input.greenhouseFacts, input.roster)
  const sourceGaps = [
    ...(input.adapterSourceGaps ?? []),
    ...buildFinalOfferSourceGaps(input.greenhouseFacts, normalizedRows),
  ]
  const discrepancies = buildFinalOfferDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "greenhouse_t07_offer_facts",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Greenhouse-style offer lifecycle facts for T07.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "Q12 final offer legacy evidence artifact.",
      artifactId: legacyArtifact.id,
      queryId: "Q12",
    },
  ]
  const publicSummary = {
    workflowId: finalOfferModuleDefinition.workflowId,
    moduleId: finalOfferModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    deliverableId: outputContract.sourceContractId,
    workflowId: finalOfferModuleDefinition.workflowId,
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
    workflowId: finalOfferModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: finalOfferModuleDefinition.workflowId,
    capabilityId: finalOfferModuleDefinition.capabilityId,
    moduleId: finalOfferModuleDefinition.moduleId,
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
    definition: finalOfferModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

export function normalizeOfferStatus(status: string): FinalOfferStatus {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["created", "draft"].includes(normalized)) return "created"
  if (["approved", "approval_complete"].includes(normalized)) return "approved"
  if (["sent", "extended"].includes(normalized)) return "sent"
  if (["accepted", "signed"].includes(normalized)) return "accepted"
  if (["declined", "rejected", "rescinded"].includes(normalized)) return "declined"
  return "unknown"
}

function monthBucket(dateValue: string): string {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return "unknown"
  return date.toISOString().slice(0, 7)
}

function buildFinalOfferSourceGaps(
  facts: readonly GreenhouseFinalOfferFact[],
  rows: readonly FinalOfferRow[]
): SourceGap[] {
  const gaps: SourceGap[] = buildRequiredFinalOfferSourceGaps(facts)
  rows.forEach((row, index) => {
    if (row.offer_status === "unknown") {
      gaps.push({
        id: `gap_t07_offer_status_${row.offer_id}`,
        workflowId: "T07",
        sourceId: "greenhouse",
        field: "offer_status",
        reason: `Offer status mapping is open for source status ${facts[index]?.status ?? "missing"}.`,
        blocksCutover: true,
      })
    }
    for (const field of ["recruiter_name", "sourcer_name", "team_name", "hod_name"] as const) {
      if (row[field] === null) {
        gaps.push({
          id: `gap_t07_${field}_${row.offer_id}`,
          workflowId: "T07",
          sourceId: "greenhouse",
          field,
          reason: `${field} is unresolved for this offer row (no confirmed recruiter→team mapping).`,
          blocksCutover: false,
        })
      }
    }
  })
  return gaps
}

function buildRequiredFinalOfferSourceGaps(facts: readonly GreenhouseFinalOfferFact[]): SourceGap[] {
  const gaps: SourceGap[] = []
  facts.forEach((fact, index) => {
    for (const [field, value] of [
      ["application_id", fact.applicationId],
      ["job_id", fact.jobId],
      ["offer_id", fact.offerId],
    ] as const) {
      if (!isUsableId(value)) {
        gaps.push(requiredGap("T07", field, `source_${index}`, `${field} is required before final-offer rows can be grouped or deduped.`))
      }
    }
    if (!isUsableTimestamp(fact.createdAt)) {
      gaps.push(
        requiredGap(
          "T07",
          "created_at",
          fact.applicationId || `source_${index}`,
          "Offer creation timestamp is required before final-offer rows can be rendered."
        )
      )
    }
  })
  return gaps
}

function hasRequiredFinalOfferFactIdentity(fact: GreenhouseFinalOfferFact): boolean {
  return (
    isUsableId(fact.applicationId) &&
    isUsableId(fact.jobId) &&
    isUsableId(fact.offerId) &&
    isUsableTimestamp(fact.createdAt)
  )
}

function isUsableId(value: string): boolean {
  return Boolean(value?.trim()) && value.trim().toLowerCase() !== "unknown"
}

function isUsableTimestamp(value: string): boolean {
  if (!value?.trim() || value.trim().toLowerCase() === "unknown") return false
  return !Number.isNaN(Date.parse(value))
}

function requiredGap(workflowId: "T07", field: string, entity: string, reason: string): SourceGap {
  return {
    id: `gap_${workflowId.toLowerCase()}_required_${field}_${entity}`.replace(/[^A-Za-z0-9_./-]/g, "_"),
    workflowId,
    sourceId: "greenhouse",
    field,
    reason,
    blocksCutover: true,
  }
}

function buildFinalOfferDiscrepancies(
  runId: string,
  rows: readonly FinalOfferRow[],
  legacyRows: readonly LegacyFinalOfferEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: finalOfferModuleDefinition.capabilityId,
      workflowId: "T07",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `application:${gap.id.split("_").at(-1) ?? "unknown"}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy Q12 may contain a populated value for this field.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByApplication = new Map(legacyRows.map((row) => [row.application_id, row]))
  for (const row of rows) {
    const legacy = legacyByApplication.get(row.application_id)
    if (!legacy) continue
    if (legacy.offer_status && normalizeOfferStatus(legacy.offer_status) !== row.offer_status) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: finalOfferModuleDefinition.capabilityId,
          workflowId: "T07",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `application:${row.application_id}`,
          field: "offer_status",
          modernValueSummary: `Greenhouse-derived status ${row.offer_status}`,
          legacyValueSummary: `Legacy Q12 status ${legacy.offer_status}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (legacy.month_bucket && legacy.month_bucket !== row.month_bucket) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: finalOfferModuleDefinition.capabilityId,
          workflowId: "T07",
          class: "stale_mapping",
          severity: "warning",
          entityKey: `application:${row.application_id}`,
          field: "month_bucket",
          modernValueSummary: `Greenhouse-derived month ${row.month_bucket}`,
          legacyValueSummary: `Legacy Q12 month ${legacy.month_bucket}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}
