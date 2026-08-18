import { buildDiscrepancy, type Discrepancy } from "../discrepancies"
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import type { SourceEvidenceRef } from "../substrate"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"
export type AllHiresRowType = "hire_event" | "automation_health"
export type AllHiresAutomationStatus = "enabled" | "disabled" | "unknown"
export type AllHiresCustodyStatus = "captured" | "export_required" | "credential_reissue_required" | "unknown" | "not_applicable"

export interface GreenhouseHireFact {
  applicationId: string
  jobId: string
  hiredAt: string
  recruiterName?: string
}

export interface AllHiresAutomationFact {
  scriptId: string
  scriptName: string
  owner: string
  triggerStatus: AllHiresAutomationStatus
  lastRunAt?: string
  lastSuccessAt?: string
  custodyStatus: AllHiresCustodyStatus
}

export interface LegacyAllHiresEvidenceRow {
  entity_id: string
  status?: string
  event_date?: string
}

export interface AllHiresTrackerRow {
  row_type: AllHiresRowType
  entity_id: string
  status: string
  event_date: string
  owner: string | null
  source_system: "greenhouse" | "google_apps_script"
  custody_status: AllHiresCustodyStatus
  review_required: boolean
}

export interface RunAllHiresTrackerModuleInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  greenhouseHireFacts: readonly GreenhouseHireFact[]
  automationFacts: readonly AllHiresAutomationFact[]
  legacyRows?: readonly LegacyAllHiresEvidenceRow[]
}

export const allHiresTrackerModuleDefinition = {
  moduleId: "t08-all-hires-tracker",
  workflowId: "T08",
  capabilityId: "offer_and_hire_lifecycle_intelligence",
  title: "T08 All Hires Tracker",
  sourceIds: ["greenhouse", "google_sheets", "google_apps_script"],
  queryIds: [],
  legacyArtifactIds: ["legacy_all_hires_apps_script"],
  outputContractIds: ["all_hires_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "all_hires_sheet")!
if (!outputContract) throw new Error("Missing all hires concrete output contract")

const legacyArtifact = legacyArtifactRegistry.find((artifact) => artifact.id === "legacy_all_hires_apps_script")!
if (!legacyArtifact) throw new Error("Missing all hires legacy artifact")

export function deriveAllHiresTrackerRows(input: {
  greenhouseHireFacts: readonly GreenhouseHireFact[]
  automationFacts: readonly AllHiresAutomationFact[]
}): AllHiresTrackerRow[] {
  const hireRows = input.greenhouseHireFacts.map((fact) => ({
    row_type: "hire_event" as const,
    entity_id: fact.applicationId,
    status: "hired",
    event_date: normalizeTimestamp(fact.hiredAt),
    owner: fact.recruiterName?.trim() || null,
    source_system: "greenhouse" as const,
    custody_status: "not_applicable" as const,
    review_required: false,
  }))
  const automationRows = input.automationFacts.map((fact) => ({
    row_type: "automation_health" as const,
    entity_id: fact.scriptId,
    status: fact.triggerStatus,
    event_date: normalizeTimestamp(fact.lastSuccessAt ?? fact.lastRunAt ?? "unknown"),
    owner: fact.owner.trim() || null,
    source_system: "google_apps_script" as const,
    custody_status: fact.custodyStatus,
    review_required: fact.triggerStatus !== "enabled" || fact.custodyStatus !== "captured",
  }))

  return [...hireRows, ...automationRows].sort((a, b) =>
    [a.row_type, a.entity_id].join("|").localeCompare([b.row_type, b.entity_id].join("|"))
  )
}

export async function runAllHiresTrackerModule(
  input: RunAllHiresTrackerModuleInput
): Promise<RecruitingOpsModuleResult<AllHiresTrackerRow>> {
  const runId = buildRunId(allHiresTrackerModuleDefinition.workflowId, input.startedAt)
  const normalizedRows = deriveAllHiresTrackerRows(input)
  const sourceGaps = buildAllHiresSourceGaps(input.automationFacts, normalizedRows)
  const discrepancies = buildAllHiresDiscrepancies(runId, normalizedRows, input.legacyRows ?? [], sourceGaps)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "greenhouse_t08_hire_facts",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Greenhouse-style hire facts for the All Hires monitor.",
    },
    {
      id: legacyArtifact.id,
      sourceId: legacyArtifact.sourceId,
      adapter: "legacy_artifact",
      label: "All Hires Apps Script custody and trigger evidence.",
      artifactId: legacyArtifact.id,
    },
  ]
  const publicSummary = {
    workflowId: allHiresTrackerModuleDefinition.workflowId,
    moduleId: allHiresTrackerModuleDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    hireEventCount: normalizedRows.filter((row) => row.row_type === "hire_event").length,
    automationHealthCount: normalizedRows.filter((row) => row.row_type === "automation_health").length,
    reviewRequiredCount: normalizedRows.filter((row) => row.review_required).length,
    sourceGapCount: sourceGaps.length,
    discrepancyCount: discrepancies.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    deliverableId: outputContract.sourceContractId,
    workflowId: allHiresTrackerModuleDefinition.workflowId,
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
    workflowId: allHiresTrackerModuleDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
  })
  const run = buildCommandCenterRun({
    workflowId: allHiresTrackerModuleDefinition.workflowId,
    capabilityId: allHiresTrackerModuleDefinition.capabilityId,
    moduleId: allHiresTrackerModuleDefinition.moduleId,
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
    definition: allHiresTrackerModuleDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies,
    sourceGaps,
    run,
  })
}

function buildAllHiresSourceGaps(
  automationFacts: readonly AllHiresAutomationFact[],
  rows: readonly AllHiresTrackerRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (automationFacts.length === 0) {
    gaps.push({
      id: "gap_t08_apps_script_custody_missing",
      workflowId: "T08",
      sourceId: "google_apps_script",
      field: "automationFacts",
      reason: "All Hires monitor requires Apps Script trigger and custody evidence.",
      blocksCutover: true,
    })
  }
  for (const row of rows) {
    if (row.owner === null) {
      gaps.push({
        id: `gap_t08_owner_${row.entity_id}`,
        workflowId: "T08",
        sourceId: row.source_system,
        field: "owner",
        reason: `${row.row_type === "hire_event" ? "Hire event recruiter" : "All Hires automation owner"} is unmapped for ${row.entity_id}.`,
        blocksCutover: false,
      })
    }
  }
  for (const row of rows.filter((item) => item.row_type === "automation_health" && item.review_required)) {
    gaps.push({
      id: `gap_t08_automation_${row.entity_id}`,
      workflowId: "T08",
      sourceId: "google_apps_script",
      field: row.status !== "enabled" ? "triggerStatus" : "custodyStatus",
      reason: "All Hires automation is not yet under a captured, enabled, non-departing ownership posture.",
      blocksCutover: true,
    })
  }
  return gaps
}

function buildAllHiresDiscrepancies(
  runId: string,
  rows: readonly AllHiresTrackerRow[],
  legacyRows: readonly LegacyAllHiresEvidenceRow[],
  sourceGaps: readonly SourceGap[]
): Discrepancy[] {
  const discrepancies = sourceGaps.map((gap) =>
    buildDiscrepancy({
      runId,
      capabilityId: allHiresTrackerModuleDefinition.capabilityId,
      workflowId: "T08",
      class: "source_gap",
      severity: gap.blocksCutover ? "blocking" : "warning",
      entityKey: `source_gap:${gap.id}`,
      field: gap.field,
      modernValueSummary: gap.reason,
      legacyValueSummary: "Legacy All Hires script may still be running under departing-person credentials.",
      evidenceRefs: [legacyArtifact.id],
      resolutionStatus: "open",
      owner: "Jordan",
    })
  )

  const legacyByEntity = new Map(legacyRows.map((row) => [row.entity_id, row]))
  for (const row of rows) {
    const legacy = legacyByEntity.get(row.entity_id)
    if (!legacy) continue
    if (legacy.status && legacy.status !== row.status) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: allHiresTrackerModuleDefinition.capabilityId,
          workflowId: "T08",
          class: "business_definition_open",
          severity: "warning",
          entityKey: `${row.row_type}:${row.entity_id}`,
          field: "status",
          modernValueSummary: `Command-center status ${row.status}`,
          legacyValueSummary: `Legacy All Hires status ${legacy.status}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
    if (legacy.event_date && legacy.event_date !== row.event_date) {
      discrepancies.push(
        buildDiscrepancy({
          runId,
          capabilityId: allHiresTrackerModuleDefinition.capabilityId,
          workflowId: "T08",
          class: "stale_mapping",
          severity: "warning",
          entityKey: `${row.row_type}:${row.entity_id}`,
          field: "event_date",
          modernValueSummary: `Command-center event date ${row.event_date}`,
          legacyValueSummary: `Legacy All Hires event date ${legacy.event_date}`,
          evidenceRefs: [legacyArtifact.id],
          resolutionStatus: "needs_owner",
          owner: "Jordan",
        })
      )
    }
  }

  return discrepancies
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "unknown"
  return date.toISOString()
}
