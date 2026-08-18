import { getDeliverableAutomationSeed } from "../automation-seed-matrix"
import { createLocalPiiFingerprint, createPayloadFingerprint, isSupportedFingerprint } from "../checksums"
import { teamIdForTeamName } from "../dimensions/recruiter-team-hod"
import {
  appendLocalDeliveryLedgerEntry,
  collectShadowLedgerHistory,
  type LocalDeliveryLedgerEntry,
} from "../delivery-ledger"
import { evaluateDeliveryGates, type DeliveryGateEvaluationResult } from "../delivery-gates"
import { concreteOutputContracts } from "../output-contracts"
import { writeCsvArtifact } from "../renderers/csv"
import { writeJsonArtifact } from "../renderers/json"
import { buildCommandCenterRun, buildRunId, type SourceGap } from "../runs"
import { latestScopedSourceObservedAt } from "../source-freshness"
import type { DeliverableReadinessState } from "../autonomy"
import type { SourceEvidenceRef } from "../substrate"
import {
  normalizeOwnershipRows,
  type GreenhouseOwnershipFact,
  type OwnershipRow,
} from "./t09-ownership"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"

export interface OwnershipCapacityShadowScope {
  recipientFingerprint: string
  teamName: string
}

export interface RunOwnershipCapacityShadowInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  greenhouseFacts: readonly GreenhouseOwnershipFact[]
  ownershipScope: OwnershipCapacityShadowScope
  priorPayloadFingerprintsInWindow?: readonly string[]
}

export interface OwnershipCapacityShadowResult extends RecruitingOpsModuleResult<OwnershipRow> {
  gateEvaluation: DeliveryGateEvaluationResult
  deliveryLedgerEntry: LocalDeliveryLedgerEntry
  deliveryLedgerPath: string
}

export const ownershipCapacityShadowDefinition = {
  moduleId: "ownership-capacity-shadow",
  workflowId: "T09",
  capabilityId: "ownership_capacity_management",
  title: "Ownership capacity shadow deliverable",
  sourceIds: ["greenhouse"],
  queryIds: [],
  legacyArtifactIds: [],
  outputContractIds: ["role_assignment_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "role_assignment_sheet")!
if (!outputContract) throw new Error("Missing ownership concrete output contract")

const autonomyContract = getDeliverableAutomationSeed("role_assignment_sheet")

export async function runOwnershipCapacityShadow(
  input: RunOwnershipCapacityShadowInput
): Promise<OwnershipCapacityShadowResult> {
  const runId = buildRunId(ownershipCapacityShadowDefinition.workflowId, input.startedAt)
  const normalizedRows = scopedOwnershipRows(normalizeOwnershipRows(input.greenhouseFacts), input.ownershipScope.teamName)
  const sourceGaps = buildOwnershipCapacityShadowSourceGaps(input, normalizedRows)
  const scopedJobIds = new Set(
    normalizedRows.filter((row) => row.view_type === "job").map((row) => row.job_id)
  )
  const sourceObservedAt = latestScopedSourceObservedAt(
    input.greenhouseFacts.filter((fact) => scopedJobIds.has(fact.jobId)),
    (fact) => fact.observedAt
  )
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "greenhouse_fixture_ownership_capacity_shadow",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Fixture-backed Greenhouse-style ownership facts scoped to ownership capacity shadow output.",
    },
  ]
  // Team display labels are person-derived ("Team Avery"); public summaries carry the
  // config teamId slug instead (P1 value-driven redaction made the label a violation).
  const scopeTeamId = teamIdForTeamName(input.ownershipScope.teamName)
  const publicSummary = {
    deliverableId: "role_assignment_sheet",
    workflowId: ownershipCapacityShadowDefinition.workflowId,
    moduleId: ownershipCapacityShadowDefinition.moduleId,
    teamId: scopeTeamId,
    normalizedRowCount: normalizedRows.length,
    jobRowCount: normalizedRows.filter((row) => row.view_type === "job").length,
    recruiterRowCount: normalizedRows.filter((row) => row.view_type === "recruiter").length,
    totalOpenings: normalizedRows
      .filter((row) => row.view_type === "job")
      .reduce((sum, row) => sum + row.openings_count, 0),
    sourceGapCount: sourceGaps.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: ownershipCapacityShadowDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
    fileName: `ownership-capacity-shadow-${runId}.json`,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: ownershipCapacityShadowDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
    fileName: `ownership-capacity-shadow-${runId}.csv`,
  })
  // P3/SHADOW-MODULES-6: trust and idempotency inputs come from the module's OWN ledger
  // history, not caller-supplied constants. Caller-supplied fingerprints extend the window.
  const ledgerHistory = await collectShadowLedgerHistory({
    rootDir: input.rootDir,
    deliverableId: autonomyContract.deliverableId,
    evaluatedAt: input.generatedAt,
    windowMinutes: autonomyContract.freshnessTtlMinutes,
    extraPriorPayloadFingerprints: input.priorPayloadFingerprintsInWindow,
  })
  const gateEvaluation = evaluateDeliveryGates({
    contract: autonomyContract,
    runId,
    commandCenterMode: "shadow",
    requestedDeliveryMode: "shadow",
    autonomyState: "shadow",
    readinessState: readinessFor(sourceGaps),
    evaluatedAt: input.generatedAt,
    sourceObservedAt,
    ...(sourceObservedAt
      ? {}
      : {
          freshnessNotApplicableReason:
            "Ownership source facts do not include a source-observed timestamp; freshness is not inferred from generatedAt.",
        }),
    recipientFingerprint: input.ownershipScope.recipientFingerprint,
    payloadFingerprint: createLocalPiiFingerprint(normalizedRows, "role_assignment_sheet_payload"),
    templateHash: createPayloadFingerprint(outputContract.columns.map((column) => column.key)),
    recipientScopeRuleId: "team_scoped_visibility",
    recipientScopePass: normalizedRows.length > 0 && scopedRowsMatchTeam(normalizedRows, input.ownershipScope.teamName),
    recipientScopeReason: "Every ownership capacity row must belong to the team-scoped audience.",
    publicSummary,
    artifactIds: [jsonArtifact.artifactId, csvArtifact.artifactId],
    gateEvidenceRefs: sourceRefs.map((ref) => ref.id),
    blockingDiscrepancyCount: 0,
    businessDefinitionOpenCount: 0,
    blockingSourceGapCount: sourceGaps.filter((gap) => gap.blocksCutover).length,
    priorPayloadFingerprintsInWindow: ledgerHistory.priorPayloadFingerprintsInWindow,
    shadowRunsCompleted: ledgerHistory.priorCleanShadowRuns + 1,
    cleanShadowRuns: ledgerHistory.priorCleanShadowRuns + (sourceGaps.length === 0 ? 1 : 0),
    killSwitches: [],
    externalDeliveryAdapterApproved: false,
  })
  const ledgerAppend = await appendLocalDeliveryLedgerEntry({
    rootDir: input.rootDir,
    entry: gateEvaluation.deliveryLogEntry,
  })
  const run = buildCommandCenterRun({
    workflowId: ownershipCapacityShadowDefinition.workflowId,
    capabilityId: ownershipCapacityShadowDefinition.capabilityId,
    moduleId: ownershipCapacityShadowDefinition.moduleId,
    mode: "shadow",
    status: sourceGaps.some((gap) => gap.blocksCutover) ? "blocked" : "succeeded",
    startedAt: input.startedAt,
    completedAt: input.generatedAt,
    sourceRefs,
    legacyArtifactRefs: [],
    normalizedRows,
    artifactRefs: [jsonArtifact, csvArtifact],
    sourceGaps,
    discrepancies: [],
    publicSummary,
  })
  const result = finalizeModuleResult({
    definition: ownershipCapacityShadowDefinition,
    normalizedRows,
    artifacts: [jsonArtifact, csvArtifact],
    discrepancies: [],
    sourceGaps,
    run,
  })

  return {
    ...result,
    gateEvaluation,
    deliveryLedgerEntry: gateEvaluation.deliveryLogEntry,
    deliveryLedgerPath: ledgerAppend.path,
  }
}

function scopedOwnershipRows(rows: readonly OwnershipRow[], teamName: string): OwnershipRow[] {
  const jobRows = rows.filter((row) => row.view_type === "job" && row.pod_name === teamName)
  const scopedRecruiters = new Set(jobRows.map((row) => row.recruiter_name).filter(isString))
  const recruiterRows = rows.filter(
    (row) => row.view_type === "recruiter" && row.recruiter_name !== null && scopedRecruiters.has(row.recruiter_name)
  )
  return [...jobRows, ...recruiterRows]
}

function buildOwnershipCapacityShadowSourceGaps(
  input: RunOwnershipCapacityShadowInput,
  rows: readonly OwnershipRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (!isSupportedFingerprint(input.ownershipScope.recipientFingerprint)) {
    gaps.push({
      id: "gap_t09_shadow_recipient_fingerprint",
      workflowId: "T09",
      sourceId: "greenhouse",
      field: "recipientFingerprint",
      reason: "Ownership capacity shadow output requires a fingerprinted recipient identity.",
      blocksCutover: true,
    })
  }
  if (!input.ownershipScope.teamName.trim()) {
    gaps.push({
      id: "gap_t09_shadow_team_scope",
      workflowId: "T09",
      sourceId: "greenhouse",
      field: "teamName",
      reason: "Ownership capacity shadow output requires a non-empty team scope.",
      blocksCutover: true,
    })
  } else if (teamIdForTeamName(input.ownershipScope.teamName) === null) {
    gaps.push({
      id: "gap_t09_shadow_team_scope_unmapped",
      workflowId: "T09",
      sourceId: "greenhouse",
      field: "teamName",
      reason: "Team scope has no teamId mapping in the recruiter-team-hod config; public summaries cannot carry the person-derived label.",
      blocksCutover: true,
    })
  }
  if (rows.length === 0) {
    gaps.push({
      id: "gap_t09_shadow_ownership_rows",
      workflowId: "T09",
      sourceId: "greenhouse",
      field: "ownershipRows",
      reason: "No ownership capacity rows were produced for the team-scoped audience.",
      blocksCutover: true,
    })
  }
  return gaps
}

function scopedRowsMatchTeam(rows: readonly OwnershipRow[], teamName: string): boolean {
  const jobRows = rows.filter((row) => row.view_type === "job")
  const scopedRecruiters = new Set(jobRows.map((row) => row.recruiter_name).filter(isString))
  return rows.every((row) => {
    if (row.view_type === "job") return row.pod_name === teamName
    return row.recruiter_name !== null && scopedRecruiters.has(row.recruiter_name)
  })
}

function isString(value: string | null): value is string {
  return value !== null
}

function readinessFor(sourceGaps: readonly SourceGap[]): DeliverableReadinessState {
  if (sourceGaps.some((gap) => gap.blocksCutover)) return "blocked"
  if (sourceGaps.length > 0) return "ready_with_warnings"
  return "ready_for_delivery"
}
