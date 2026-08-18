import { getDeliverableAutomationSeed } from "../automation-seed-matrix"
import { createLocalPiiFingerprint, createPayloadFingerprint, isSupportedFingerprint } from "../checksums"
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
import type { SourceEvidenceRef } from "../substrate"
import { deriveProgressRows, type ProgressRow } from "./t03-progress"
import { normalizePipelineRows, type GreenhousePipelineStageFact } from "./t02-pipeline"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"

export interface RecruiterWeeklyReqProgressScope {
  recipientFingerprint: string
  reqIds: readonly string[]
}

export interface RunRecruiterWeeklyReqProgressShadowInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  greenhouseFacts: readonly GreenhousePipelineStageFact[]
  recruiterScope: RecruiterWeeklyReqProgressScope
  priorPayloadFingerprintsInWindow?: readonly string[]
}

export interface RecruiterWeeklyReqProgressShadowResult extends RecruitingOpsModuleResult<ProgressRow> {
  gateEvaluation: DeliveryGateEvaluationResult
  deliveryLedgerEntry: LocalDeliveryLedgerEntry
  deliveryLedgerPath: string
}

export const recruiterWeeklyReqProgressShadowDefinition = {
  moduleId: "recruiter-weekly-req-progress-shadow",
  workflowId: "T03",
  capabilityId: "pipeline_movement_intelligence",
  title: "Recruiter-scoped weekly req progress shadow deliverable",
  sourceIds: ["greenhouse"],
  queryIds: [],
  legacyArtifactIds: [],
  outputContractIds: ["weekly_progress_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "weekly_progress_sheet")!
if (!outputContract) throw new Error("Missing weekly progress concrete output contract")

const autonomyContract = getDeliverableAutomationSeed("weekly_progress_sheet")

export async function runRecruiterWeeklyReqProgressShadow(
  input: RunRecruiterWeeklyReqProgressShadowInput
): Promise<RecruiterWeeklyReqProgressShadowResult> {
  const runId = buildRunId(recruiterWeeklyReqProgressShadowDefinition.workflowId, input.startedAt)
  const scopedFacts = input.greenhouseFacts.filter((fact) => input.recruiterScope.reqIds.includes(fact.reqId))
  const pipelineRows = normalizePipelineRows(scopedFacts)
  const normalizedRows = deriveProgressRows(pipelineRows)
  const sourceGaps = buildShadowSourceGaps(input, normalizedRows)
  const sourceObservedAt = latestScopedSourceObservedAt(pipelineRows, (row) => row.stage_changed_at)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "greenhouse_fixture_recruiter_weekly_req_progress",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Fixture-backed Greenhouse-style stage facts scoped to recruiter weekly req progress.",
    },
  ]
  const publicSummary = {
    deliverableId: "weekly_progress_sheet",
    workflowId: recruiterWeeklyReqProgressShadowDefinition.workflowId,
    moduleId: recruiterWeeklyReqProgressShadowDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    sourceGapCount: sourceGaps.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    workflowId: recruiterWeeklyReqProgressShadowDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
    fileName: `recruiter-weekly-req-progress-${runId}.json`,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    workflowId: recruiterWeeklyReqProgressShadowDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
    fileName: `recruiter-weekly-req-progress-${runId}.csv`,
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
    readinessState: sourceGaps.some((gap) => gap.blocksCutover) ? "blocked" : "ready_for_delivery",
    evaluatedAt: input.generatedAt,
    sourceObservedAt,
    ...(sourceObservedAt
      ? {}
      : {
          freshnessNotApplicableReason:
            "Recruiter weekly req progress scoped rows do not include a source-observed stage timestamp.",
        }),
    recipientFingerprint: input.recruiterScope.recipientFingerprint,
    payloadFingerprint: createLocalPiiFingerprint(normalizedRows, "weekly_progress_sheet_payload"),
    templateHash: createPayloadFingerprint(outputContract.columns.map((column) => column.key)),
    recipientScopeRuleId: "recruiter_scoped_visibility",
    recipientScopePass: normalizedRows.every((row) => scopedReqGroups(input.recruiterScope.reqIds).has(row.req_group)),
    recipientScopeReason: "Every progress row must belong to the recruiter-scoped req set.",
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
    workflowId: recruiterWeeklyReqProgressShadowDefinition.workflowId,
    capabilityId: recruiterWeeklyReqProgressShadowDefinition.capabilityId,
    moduleId: recruiterWeeklyReqProgressShadowDefinition.moduleId,
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
    definition: recruiterWeeklyReqProgressShadowDefinition,
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

function buildShadowSourceGaps(
  input: RunRecruiterWeeklyReqProgressShadowInput,
  rows: readonly ProgressRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  const scopedFacts = input.greenhouseFacts.filter((fact) => input.recruiterScope.reqIds.includes(fact.reqId))
  scopedFacts.forEach((fact, index) => {
    for (const [field, value] of [
      ["application_id", fact.applicationId],
      ["job_id", fact.jobId],
      ["req_id", fact.reqId],
    ] as const) {
      if (!isUsableSourceId(value)) {
        gaps.push(requiredScopedGap(field, `source_${index}`, `${field} is required before weekly progress rows can be grouped or deduped.`))
      }
    }
    if (!isUsableSourceTimestamp(fact.stageChangedAt)) {
      gaps.push(
        requiredScopedGap(
          "stage_changed_at",
          fact.applicationId || `source_${index}`,
          "Stage movement timestamp is required before weekly progress freshness can be evaluated."
        )
      )
    }
  })
  if (!isSupportedFingerprint(input.recruiterScope.recipientFingerprint)) {
    gaps.push({
      id: "gap_t03_shadow_recipient_fingerprint",
      workflowId: "T03",
      sourceId: "greenhouse",
      field: "recipientFingerprint",
      reason: "Recruiter weekly req progress requires a fingerprinted recipient identity.",
      blocksCutover: true,
    })
  }
  if (input.recruiterScope.reqIds.length === 0) {
    gaps.push({
      id: "gap_t03_shadow_req_scope",
      workflowId: "T03",
      sourceId: "greenhouse",
      field: "reqIds",
      reason: "Recruiter weekly req progress requires at least one scoped req ID.",
      blocksCutover: true,
    })
  }
  if (rows.length === 0) {
    gaps.push({
      id: "gap_t03_shadow_progress_rows",
      workflowId: "T03",
      sourceId: "greenhouse",
      field: "progressRows",
      reason: "No weekly req progress rows were produced for the recruiter-scoped req set.",
      blocksCutover: true,
    })
  }
  return gaps
}

function isUsableSourceId(value: string): boolean {
  return Boolean(value?.trim()) && value.trim().toLowerCase() !== "unknown"
}

function isUsableSourceTimestamp(value: string): boolean {
  if (!value?.trim() || value.trim().toLowerCase() === "unknown") return false
  return !Number.isNaN(Date.parse(value))
}

function requiredScopedGap(field: string, entity: string, reason: string): SourceGap {
  return {
    id: `gap_t03_shadow_required_${field}_${entity}`.replace(/[^A-Za-z0-9_./-]/g, "_"),
    workflowId: "T03",
    sourceId: "greenhouse",
    field,
    reason,
    blocksCutover: true,
  }
}

function scopedReqGroups(reqIds: readonly string[]): ReadonlySet<string> {
  return new Set(reqIds.map((reqId) => `req_${reqId}`))
}
