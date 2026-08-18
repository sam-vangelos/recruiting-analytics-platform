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
import type { DeliverableReadinessState } from "../autonomy"
import type { SourceEvidenceRef } from "../substrate"
import {
  normalizeRpsRows,
  type GreenhouseRpsFact,
  type RpsRow,
} from "./t05-rps"
import type { RecruitingOpsModuleDefinition, RecruitingOpsModuleResult } from "./types"
import { finalizeModuleResult } from "./types"

export interface ScorecardAccountabilityShadowScope {
  recipientFingerprint: string
  jobIds: readonly string[]
}

export interface RunScorecardAccountabilityShadowInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  greenhouseFacts: readonly GreenhouseRpsFact[]
  scorecardScope: ScorecardAccountabilityShadowScope
  priorPayloadFingerprintsInWindow?: readonly string[]
}

export interface ScorecardAccountabilityShadowResult extends RecruitingOpsModuleResult<RpsRow> {
  gateEvaluation: DeliveryGateEvaluationResult
  deliveryLedgerEntry: LocalDeliveryLedgerEntry
  deliveryLedgerPath: string
}

export const scorecardAccountabilityShadowDefinition = {
  moduleId: "scorecard-accountability-shadow",
  workflowId: "T05",
  capabilityId: "scorecard_accountability",
  title: "Scorecard accountability shadow deliverable",
  sourceIds: ["greenhouse"],
  queryIds: [],
  legacyArtifactIds: [],
  outputContractIds: ["rps_tracking_sheet"],
} as const satisfies RecruitingOpsModuleDefinition

const outputContract = concreteOutputContracts.find((contract) => contract.sourceContractId === "rps_tracking_sheet")!
if (!outputContract) throw new Error("Missing RPS concrete output contract")

const autonomyContract = getDeliverableAutomationSeed("rps_tracking_sheet")

export async function runScorecardAccountabilityShadow(
  input: RunScorecardAccountabilityShadowInput
): Promise<ScorecardAccountabilityShadowResult> {
  const runId = buildRunId(scorecardAccountabilityShadowDefinition.workflowId, input.startedAt)
  const scopedJobIds = new Set(input.scorecardScope.jobIds)
  const scopedFacts = input.greenhouseFacts.filter((fact) => scopedJobIds.has(fact.jobId))
  const normalizedRows = normalizeRpsRows(scopedFacts)
  const sourceGaps = buildScorecardShadowSourceGaps(input, normalizedRows)
  const sourceObservedAt = latestScopedSourceObservedAt(scopedFacts, (fact) => fact.scheduledAt)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: "greenhouse_fixture_scorecard_accountability_shadow",
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Fixture-backed Greenhouse-style interview and scorecard facts scoped to scorecard accountability shadow output.",
    },
  ]
  const publicSummary = {
    deliverableId: "rps_tracking_sheet",
    workflowId: scorecardAccountabilityShadowDefinition.workflowId,
    moduleId: scorecardAccountabilityShadowDefinition.moduleId,
    normalizedRowCount: normalizedRows.length,
    missingScorecardCount: normalizedRows.filter((row) => row.scorecard_status === "missing").length,
    mismatchCount: normalizedRows.filter((row) => row.match_mismatch === "mismatch").length,
    sourceGapCount: sourceGaps.length,
  }

  const jsonArtifact = await writeJsonArtifact({
    rootDir: input.rootDir,
    deliverableId: outputContract.sourceContractId,
    workflowId: scorecardAccountabilityShadowDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    generatedAt: input.generatedAt,
    fileName: `scorecard-accountability-shadow-${runId}.json`,
  })
  const csvArtifact = await writeCsvArtifact({
    rootDir: input.rootDir,
    deliverableId: outputContract.sourceContractId,
    workflowId: scorecardAccountabilityShadowDefinition.workflowId,
    runId,
    schemaVersion: outputContract.schemaVersion,
    rows: normalizedRows,
    sourceRefs: sourceRefs.map((ref) => ref.id),
    publicSummary,
    columns: outputContract.columns.map((column) => ({ key: column.key, label: column.label })),
    fileName: `scorecard-accountability-shadow-${runId}.csv`,
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
            "Scorecard accountability scoped rows do not include a source-observed scheduled timestamp.",
        }),
    recipientFingerprint: input.scorecardScope.recipientFingerprint,
    payloadFingerprint: createLocalPiiFingerprint(normalizedRows, "rps_tracking_sheet_payload"),
    templateHash: createPayloadFingerprint(outputContract.columns.map((column) => column.key)),
    recipientScopeRuleId: "recruiter_scoped_visibility",
    recipientScopePass: normalizedRows.length > 0 && normalizedRows.every((row) => scopedJobIds.has(row.job_id)),
    recipientScopeReason: "Every scorecard accountability row must belong to the recruiter-scoped job set.",
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
    workflowId: scorecardAccountabilityShadowDefinition.workflowId,
    capabilityId: scorecardAccountabilityShadowDefinition.capabilityId,
    moduleId: scorecardAccountabilityShadowDefinition.moduleId,
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
    definition: scorecardAccountabilityShadowDefinition,
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

function buildScorecardShadowSourceGaps(
  input: RunScorecardAccountabilityShadowInput,
  rows: readonly RpsRow[]
): SourceGap[] {
  const gaps: SourceGap[] = []
  if (!isSupportedFingerprint(input.scorecardScope.recipientFingerprint)) {
    gaps.push({
      id: "gap_t05_shadow_recipient_fingerprint",
      workflowId: "T05",
      sourceId: "greenhouse",
      field: "recipientFingerprint",
      reason: "Scorecard accountability shadow output requires a fingerprinted recipient identity.",
      blocksCutover: true,
    })
  }
  if (input.scorecardScope.jobIds.length === 0) {
    gaps.push({
      id: "gap_t05_shadow_job_scope",
      workflowId: "T05",
      sourceId: "greenhouse",
      field: "jobIds",
      reason: "Scorecard accountability shadow output requires at least one scoped job ID.",
      blocksCutover: true,
    })
  }
  if (rows.length === 0) {
    gaps.push({
      id: "gap_t05_shadow_scorecard_rows",
      workflowId: "T05",
      sourceId: "greenhouse",
      field: "scorecardRows",
      reason: "No scorecard accountability rows were produced for the scoped job set.",
      blocksCutover: true,
    })
  }
  for (const row of rows) {
    if (row.interview_stage === "unknown") {
      gaps.push({
        id: `gap_t05_shadow_interview_stage_${row.application_id}`,
        workflowId: "T05",
        sourceId: "greenhouse",
        field: "interview_stage",
        reason: "Interview taxonomy is unresolved for a scorecard accountability shadow row.",
        blocksCutover: true,
      })
    }
    if (row.scorecard_status === "unknown") {
      gaps.push({
        id: `gap_t05_shadow_scorecard_status_${row.application_id}`,
        workflowId: "T05",
        sourceId: "greenhouse",
        field: "scorecard_status",
        reason: "Scorecard status mapping is unresolved for a scorecard accountability shadow row.",
        blocksCutover: true,
      })
    }
  }
  return gaps
}

function readinessFor(sourceGaps: readonly SourceGap[]): DeliverableReadinessState {
  if (sourceGaps.some((gap) => gap.blocksCutover)) return "blocked"
  if (sourceGaps.length > 0) return "ready_with_warnings"
  return "ready_for_delivery"
}
