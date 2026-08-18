import { buildActionProposal } from "./action-proposals"
import { deliverableAutomationSeedMatrix } from "./automation-seed-matrix"
import { type DeliverableAutonomyState, type DeliverableLane } from "./autonomy"
import { capabilityRegistry, type CapabilityRegistryRow } from "./capabilities"
import { createLocalPiiFingerprint, createPayloadFingerprint } from "./checksums"
import { evaluateDeliveryGates } from "./delivery-gates"
import { buildDiscrepancy } from "./discrepancies"
import { legacyArtifactRegistry } from "./legacy-artifact-registry"
import { concreteOutputContracts } from "./output-contracts"
import { requiredWorkflowIds, workflowRegistry, type WorkflowRegistryRow } from "./registries"
import {
  buildLocalRunCatalog,
  filterCatalogGateResults,
  type LocalRunCatalog,
  type LocalRunCatalogActionProposalEntry,
  type LocalRunCatalogDeliveryLogEntry,
  type LocalRunCatalogGateResultEntry,
  type LocalRunCatalogRunEntry,
} from "./run-catalog"
import {
  buildCommandCenterRun,
  buildRunArtifact,
  buildRunId,
  type CommandCenterRun,
  type RunArtifact,
  type SourceGap,
} from "./runs"
import type { ArtifactFormat, SourceEvidenceRef } from "./substrate"

export type ConsoleWorkflowImplementationStatus = "local_ready" | "registered_only"
export type ConsoleLedgerStatus = "schema_ready" | "adapter_disabled"

export interface ConsoleMetric {
  label: string
  value: number
  detail: string
  tone: "neutral" | "success" | "warning"
}

export interface ConsoleWorkflowRow {
  id: string
  title: string
  category: WorkflowRegistryRow["category"]
  priority: WorkflowRegistryRow["priority"]
  cadence: WorkflowRegistryRow["cadence"]
  implementationStatus: ConsoleWorkflowImplementationStatus
  sourceCount: number
  outputCount: number
  nextGate: string
}

export interface ConsoleLedgerPanel {
  tableName: string
  label: string
  status: ConsoleLedgerStatus
  detail: string
}

export interface ConsoleCapabilityRow {
  capabilityId: string
  outcome: string
  durability: CapabilityRegistryRow["durability"]
  sunsetState?: CapabilityRegistryRow["sunsetState"]
  primaryAudience: string
  consumptionPurpose: string
  humanGate: string
  workflowCount: number
  moduleCount: number
  deliverableCount: number
}

export interface RecruitingOpsConsoleData {
  generatedAt: string
  metrics: readonly ConsoleMetric[]
  automation: ConsoleAutomationControlPlaneData
  capabilityRows: readonly ConsoleCapabilityRow[]
  workflowRows: readonly ConsoleWorkflowRow[]
  ledgerPanels: readonly ConsoleLedgerPanel[]
  boundaries: {
    productionWritesEnabled: false
    liveGreenhouseWritesEnabled: false
    externalNetworkCallsEnabled: false
    broadPiiPersistenceEnabled: false
    uiMutationControlsEnabled: false
    externalDeliveryAdapterApproved: false
  }
  counts: {
    capabilityCount: number
    durableCapabilityCount: number
    transitionalCapabilityCount: number
    requiredWorkflowCount: number
    localReadyWorkflowCount: number
    legacyArtifactCount: number
    outputContractCount: number
    actionQueueCount: number
    productionOutputWriteCount: number
  }
}

export interface ConsoleAutomationControlPlaneData {
  catalogId: string
  catalogGeneratedAt: string
  /**
   * Catalog provenance, displayed on every console surface. "fixture" = synthetic runs
   * rebuilt per request — NO real shadow run has executed; an operator must never read
   * the fixture catalog as observed runtime state. Durable runs replace this in C2.
   */
  catalogProvenance: {
    mode: "fixture"
    detail: string
  }
  laneRows: readonly ConsoleAutomationLaneRow[]
  recentRuns: readonly LocalRunCatalogRunEntry[]
  deliveryLogs: readonly LocalRunCatalogDeliveryLogEntry[]
  gateFailures: readonly LocalRunCatalogGateResultEntry[]
  actionProposals: readonly LocalRunCatalogActionProposalEntry[]
  counts: {
    catalogRunCount: number
    catalogArtifactCount: number
    catalogDeliveryLogCount: number
    failedGateCount: number
    actionProposalCount: number
    autoDeliveryAuthorizedCount: number
    externalDeliveryAttemptCount: 0
  }
}

export interface ConsoleAutomationLaneRow {
  lane: DeliverableLane
  label: string
  href: string
  deliverableCount: number
  autoEligibleDeliverableCount: number
  shadowStateCount: number
  reviewRequiredCount: number
  neverAutoCount: number
  shadowDeliveryLogCount: number
  blockedOrPausedDeliveryLogCount: number
  failedGateCount: number
  actionProposalCount: number
  externalAdapterApproved: false
}

export interface ConsoleAutomationDeliverableRow {
  deliverableId: string
  capabilityId: string
  lane: DeliverableLane
  initialAutonomyState: DeliverableAutonomyState
  autoEligibility: string
  shadowRunRequirement: number
  recipientScopeRuleIds: readonly string[]
  readinessStatesAllowed: readonly string[]
  piiPolicy: string
  freshnessTtlMinutes: number
  blockedReason?: string
  neverAutoReason?: string
}

export interface RecruitingOpsLaneConsoleData {
  generatedAt: string
  lane: ConsoleAutomationLaneRow
  deliverables: readonly ConsoleAutomationDeliverableRow[]
  runs: readonly LocalRunCatalogRunEntry[]
  deliveryLogs: readonly LocalRunCatalogDeliveryLogEntry[]
  gateFailures: readonly LocalRunCatalogGateResultEntry[]
  actionProposals: readonly LocalRunCatalogActionProposalEntry[]
  boundaries: RecruitingOpsConsoleData["boundaries"]
}

const implementedWorkflowIds = new Set<string>([
  "T01",
  "T02",
  "T03",
  "T04",
  "T05",
  "T06",
  "T07",
  "T08",
  "T09",
  "T10",
  "T12",
  "T13",
  "T14",
  "T15",
  "T16",
  "T17",
  "T18",
  "T19",
  "T20/T21",
  "S01",
  "S02",
  "S03",
  "S04",
  "S05",
  "S06",
  "S07",
  "E01",
])

export function getRecruitingOpsConsoleData(generatedAt = new Date().toISOString()): RecruitingOpsConsoleData {
  const capabilityRows = capabilityRegistry.map(toConsoleCapabilityRow)
  const durableCapabilityCount = capabilityRows.filter((row) => row.durability === "durable").length
  const transitionalCapabilityCount = capabilityRows.filter((row) => row.durability === "transitional").length
  const workflowRows = workflowRegistry.map(toConsoleWorkflowRow)
  const localReadyWorkflowCount = workflowRows.filter((row) => row.implementationStatus === "local_ready").length
  const productionOutputWriteCount = concreteOutputContracts.filter((contract) => contract.productionWriteEnabled).length
  const actionQueueCount = concreteOutputContracts.filter((contract) => contract.renderer === "admin_queue").length
  const catalog = buildConsoleLocalRunCatalog(generatedAt)
  const automation = toConsoleAutomationControlPlaneData(catalog)

  return {
    generatedAt,
    metrics: [
      {
        label: "CAPABILITIES",
        value: capabilityRows.length,
        detail: `${durableCapabilityCount} durable · ${transitionalCapabilityCount} transitional`,
        tone: "neutral",
      },
      {
        label: "DELIVERABLES",
        value: concreteOutputContracts.length,
        detail: `${productionOutputWriteCount} production writers`,
        tone: productionOutputWriteCount === 0 ? "success" : "warning",
      },
      {
        label: "ACTION QUEUES",
        value: actionQueueCount,
        detail: "dry-run proposal surfaces",
        tone: "success",
      },
      {
        label: "LEGACY COVERAGE",
        value: workflowRows.length,
        detail: `${localReadyWorkflowCount}/${requiredWorkflowIds.length} workflows mapped`,
        tone: localReadyWorkflowCount === requiredWorkflowIds.length ? "success" : "warning",
      },
    ],
    automation,
    capabilityRows,
    workflowRows,
    ledgerPanels: [
      {
        tableName: "recruiting_ops_runs",
        label: "Run Ledger",
        status: "schema_ready",
        detail: "Run metadata, checksums, row counts, and public summaries.",
      },
      {
        tableName: "recruiting_ops_run_evidence_refs",
        label: "Evidence Ledger",
        status: "schema_ready",
        detail: "Source refs, adapters, labels, and legacy artifact links.",
      },
      {
        tableName: "recruiting_ops_discrepancies",
        label: "Discrepancies",
        status: "schema_ready",
        detail: "Classified differences and owner resolution status.",
      },
      {
        tableName: "recruiting_ops_action_proposals",
        label: "Action Proposals",
        status: "schema_ready",
        detail: "Dry-run actions with redacted summaries and no live execution.",
      },
      {
        tableName: "supabase_adapter",
        label: "Persistence Adapter",
        status: "adapter_disabled",
        detail: "No database read/write adapter is enabled in this non-production gate.",
      },
    ],
    boundaries: {
      productionWritesEnabled: false,
      liveGreenhouseWritesEnabled: false,
      externalNetworkCallsEnabled: false,
      broadPiiPersistenceEnabled: false,
      uiMutationControlsEnabled: false,
      externalDeliveryAdapterApproved: false,
    },
    counts: {
      capabilityCount: capabilityRows.length,
      durableCapabilityCount,
      transitionalCapabilityCount,
      requiredWorkflowCount: requiredWorkflowIds.length,
      localReadyWorkflowCount,
      legacyArtifactCount: legacyArtifactRegistry.length,
      outputContractCount: concreteOutputContracts.length,
      actionQueueCount,
      productionOutputWriteCount,
    },
  }
}

export function getRecruitingOpsLaneConsoleData(
  lane: DeliverableLane,
  generatedAt = new Date().toISOString()
): RecruitingOpsLaneConsoleData {
  const data = getRecruitingOpsConsoleData(generatedAt)
  const laneRow = data.automation.laneRows.find((row) => row.lane === lane)
  if (!laneRow) throw new Error(`Unknown automation lane: ${lane}`)
  const deliverableIds = new Set(deliverableAutomationSeedMatrix.filter((row) => row.lane === lane).map((row) => row.deliverableId))
  const deliveryLogs = data.automation.deliveryLogs.filter((entry) => deliverableIds.has(entry.deliverableId))
  const runIds = new Set(deliveryLogs.map((entry) => entry.runId))

  return {
    generatedAt: data.generatedAt,
    lane: laneRow,
    deliverables: deliverableAutomationSeedMatrix.filter((row) => row.lane === lane).map((row) => ({
      deliverableId: row.deliverableId,
      capabilityId: row.capabilityId,
      lane: row.lane,
      initialAutonomyState: row.initialAutonomyState,
      autoEligibility: row.autoEligibility,
      shadowRunRequirement: row.shadowRunRequirement,
      recipientScopeRuleIds: row.recipientScopeRuleIds,
      readinessStatesAllowed: row.readinessStatesAllowed,
      piiPolicy: row.piiPolicy,
      freshnessTtlMinutes: row.freshnessTtlMinutes,
      blockedReason: row.blockedReason,
      neverAutoReason: row.neverAutoReason,
    })),
    runs: data.automation.recentRuns.filter((run) => runIds.has(run.runId)),
    deliveryLogs,
    gateFailures: data.automation.gateFailures.filter((entry) => deliverableIds.has(entry.deliverableId)),
    actionProposals: lane === "action_proposal" ? data.automation.actionProposals : [],
    boundaries: data.boundaries,
  }
}

function toConsoleCapabilityRow(row: CapabilityRegistryRow): ConsoleCapabilityRow {
  const primaryAudience = row.audiences[0]
  return {
    capabilityId: row.capabilityId,
    outcome: row.outcome,
    durability: row.durability,
    sunsetState: row.sunsetState,
    primaryAudience: primaryAudience?.audience ?? "",
    consumptionPurpose: primaryAudience?.consumptionPurpose ?? "",
    humanGate: row.humanGates[0] ?? primaryAudience?.humanGate ?? "",
    workflowCount: row.workflowIds.length,
    moduleCount: row.moduleIds.length,
    deliverableCount: row.deliverableIds.length,
  }
}

function toConsoleWorkflowRow(row: WorkflowRegistryRow): ConsoleWorkflowRow {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    priority: row.priority,
    cadence: row.cadence,
    implementationStatus: implementedWorkflowIds.has(row.id) ? "local_ready" : "registered_only",
    sourceCount: row.sourceIds.length,
    outputCount: row.outputContractIds.length,
    nextGate: row.nextGate,
  }
}

function toConsoleAutomationControlPlaneData(catalog: LocalRunCatalog): ConsoleAutomationControlPlaneData {
  const gateFailures = filterCatalogGateResults(catalog).filter((gate) => gate.status === "fail")
  return {
    catalogId: catalog.catalogId,
    catalogGeneratedAt: catalog.generatedAt,
    catalogProvenance: {
      mode: "fixture",
      detail:
        "Synthetic fixture catalog rebuilt on every request — no real shadow run has executed. Durable run history replaces this when persistence activates (C2).",
    },
    laneRows: automationLanes().map((lane) => toAutomationLaneRow(lane, catalog, gateFailures)),
    recentRuns: catalog.runs,
    deliveryLogs: catalog.deliveryLogs,
    gateFailures,
    actionProposals: catalog.actionProposals,
    counts: {
      catalogRunCount: catalog.runs.length,
      catalogArtifactCount: catalog.artifacts.length,
      catalogDeliveryLogCount: catalog.deliveryLogs.length,
      failedGateCount: gateFailures.length,
      actionProposalCount: catalog.actionProposals.length,
      autoDeliveryAuthorizedCount: 0,
      externalDeliveryAttemptCount: 0,
    },
  }
}

function toAutomationLaneRow(
  lane: DeliverableLane,
  catalog: LocalRunCatalog,
  gateFailures: readonly LocalRunCatalogGateResultEntry[]
): ConsoleAutomationLaneRow {
  const deliverables = deliverableAutomationSeedMatrix.filter((row) => row.lane === lane)
  const deliverableIds = new Set(deliverables.map((row) => row.deliverableId))
  const laneDeliveryLogs = catalog.deliveryLogs.filter((entry) => deliverableIds.has(entry.deliverableId))

  return {
    lane,
    label: automationLaneLabel(lane),
    href: `/recruiting-ops/lane/${lane}`,
    deliverableCount: deliverables.length,
    autoEligibleDeliverableCount: deliverables.filter((row) => row.autoEligibility === "candidate").length,
    shadowStateCount: deliverables.filter((row) => row.initialAutonomyState === "shadow").length,
    reviewRequiredCount: deliverables.filter((row) => row.initialAutonomyState === "review_required").length,
    neverAutoCount: deliverables.filter((row) => row.autoEligibility === "never_auto").length,
    shadowDeliveryLogCount: laneDeliveryLogs.filter((entry) => entry.eventType === "shadow_run").length,
    blockedOrPausedDeliveryLogCount: laneDeliveryLogs.filter((entry) => entry.status === "blocked" || entry.status === "paused").length,
    failedGateCount: gateFailures.filter((gate) => deliverableIds.has(gate.deliverableId)).length,
    actionProposalCount: lane === "action_proposal" ? catalog.actionProposals.length : 0,
    externalAdapterApproved: false,
  }
}

function buildConsoleLocalRunCatalog(generatedAt: string): LocalRunCatalog {
  const weekly = buildCatalogFixtureRun({
    workflowId: "T03",
    capabilityId: "pipeline_movement_intelligence",
    moduleId: "recruiter-weekly-req-progress-shadow",
    deliverableId: "weekly_progress_sheet",
    startedAt: "2026-06-24T12:00:00.000Z",
    completedAt: "2026-06-24T12:01:00.000Z",
    sourceObservedAt: "2026-06-18T10:00:00.000Z",
    recipientFingerprint: createLocalPiiFingerprint("recruiter_fixture_alpha", "console_recipient"),
    recipientScopeRuleId: "recruiter_scoped_visibility",
    normalizedRows: [
      { req_group: "req_890", stage_name: "application_review", movement_count: 1, week_bucket: "2026-06-15" },
      { req_group: "req_890", stage_name: "recruiter_screen", movement_count: 1, week_bucket: "2026-06-15" },
    ],
    sourceGaps: [],
    publicSummary: {
      deliverableId: "weekly_progress_sheet",
      normalizedRowCount: 2,
      sourceGapCount: 0,
    },
    recipientScopePass: true,
  })
  const scorecard = buildCatalogFixtureRun({
    workflowId: "T05",
    capabilityId: "scorecard_accountability",
    moduleId: "scorecard-accountability-shadow",
    deliverableId: "rps_tracking_sheet",
    startedAt: "2026-06-24T13:00:00.000Z",
    completedAt: "2026-06-24T13:01:00.000Z",
    sourceObservedAt: "2026-06-18T17:00:00.000Z",
    recipientFingerprint: createLocalPiiFingerprint("scorecard_fixture_alpha", "console_recipient"),
    recipientScopeRuleId: "recruiter_scoped_visibility",
    normalizedRows: [],
    sourceGaps: [
      {
        id: "gap_t05_shadow_job_scope",
        workflowId: "T05",
        sourceId: "greenhouse",
        field: "jobIds",
        reason: "Scorecard accountability shadow output requires at least one scoped job ID.",
        blocksCutover: true,
      },
      {
        id: "gap_t05_shadow_scorecard_rows",
        workflowId: "T05",
        sourceId: "greenhouse",
        field: "scorecardRows",
        reason: "No scorecard accountability rows were produced for the scoped job set.",
        blocksCutover: true,
      },
    ],
    publicSummary: {
      deliverableId: "rps_tracking_sheet",
      normalizedRowCount: 0,
      missingScorecardCount: 0,
      sourceGapCount: 2,
    },
    recipientScopePass: false,
  })
  const ownership = buildCatalogFixtureRun({
    workflowId: "T09",
    capabilityId: "ownership_capacity_management",
    moduleId: "ownership-capacity-shadow",
    deliverableId: "role_assignment_sheet",
    startedAt: "2026-06-24T14:00:00.000Z",
    completedAt: "2026-06-24T14:01:00.000Z",
    sourceObservedAt: "2026-06-24T14:00:00.000Z",
    recipientFingerprint: createLocalPiiFingerprint("ownership_fixture_alpha", "console_recipient"),
    recipientScopeRuleId: "team_scoped_visibility",
    normalizedRows: [
      { view_type: "job", job_id: "job_fixture_1", recruiter_name: "Avery Collins", pod_name: "Team Avery", openings_count: 2 },
      { view_type: "recruiter", recruiter_name: "Avery Collins", pod_name: "Team Avery", openings_count: 2 },
    ],
    sourceGaps: [],
    publicSummary: {
      deliverableId: "role_assignment_sheet",
      teamScope: "Fixture team",
      normalizedRowCount: 2,
      totalOpenings: 2,
      sourceGapCount: 0,
    },
    recipientScopePass: true,
  })
  const discrepancy = buildDiscrepancy({
    runId: ownership.run.runId,
    workflowId: "T09",
    capabilityId: "ownership_capacity_management",
    class: "stale_mapping",
    severity: "warning",
    entityKey: "job_fixture_1",
    field: "recruiter_name",
    modernValueSummary: "Fixture owner [REDACTED]",
    legacyValueSummary: "Legacy owner unmapped",
    evidenceRefs: [ownership.sourceRefs[0].id],
    resolutionStatus: "needs_owner",
    owner: "Jordan",
  })
  const actionProposal = buildActionProposal({
    workflowId: "T09",
    capabilityId: "ownership_capacity_management",
    targetSystem: "greenhouse",
    targetReference: "job_fixture_1",
    actionType: "requisition_update",
    actor: "recops_operator",
    reason: "Fixture ownership update requires manual review.",
    riskTier: "medium",
    approvalState: "needs_review",
    evidenceRefs: [ownership.run.runId],
    createdAt: "2026-06-24T14:02:00.000Z",
    proposedPayload: {
      field: "recruiter",
      ownerEmail: "avery@example.com",
      ownerLabel: "Avery Collins",
    },
  })

  return buildLocalRunCatalog({
    generatedAt,
    runs: [weekly.run, scorecard.run, ownership.run],
    deliveryLedgerEntries: [weekly.deliveryLogEntry, scorecard.deliveryLogEntry, ownership.deliveryLogEntry],
    discrepancies: [discrepancy],
    actionProposals: [actionProposal],
  })
}

function buildCatalogFixtureRun(input: {
  workflowId: string
  capabilityId: string
  moduleId: string
  deliverableId: string
  startedAt: string
  completedAt: string
  sourceObservedAt: string
  recipientFingerprint: string
  recipientScopeRuleId: string
  recipientScopePass: boolean
  normalizedRows: readonly Record<string, unknown>[]
  sourceGaps: readonly SourceGap[]
  publicSummary: Record<string, unknown>
}): {
  run: CommandCenterRun
  deliveryLogEntry: ReturnType<typeof evaluateDeliveryGates>["deliveryLogEntry"]
  sourceRefs: readonly SourceEvidenceRef[]
} {
  const runId = buildRunId(input.workflowId, input.startedAt)
  const sourceRefs: SourceEvidenceRef[] = [
    {
      id: `${input.workflowId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_catalog_fixture_source`,
      sourceId: "greenhouse",
      adapter: "greenhouse_v3_read",
      label: "Local fixture evidence for the read-only automation control-plane catalog.",
    },
  ]
  const artifacts = buildCatalogArtifacts({
    runId,
    workflowId: input.workflowId,
    rows: input.normalizedRows,
    sourceRefs,
    publicSummary: input.publicSummary,
  })
  const run = buildCommandCenterRun({
    workflowId: input.workflowId,
    capabilityId: input.capabilityId,
    moduleId: input.moduleId,
    mode: "shadow",
    status: input.sourceGaps.some((gap) => gap.blocksCutover) ? "blocked" : "succeeded",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    sourceRefs,
    legacyArtifactRefs: [],
    normalizedRows: input.normalizedRows,
    artifactRefs: artifacts,
    sourceGaps: input.sourceGaps,
    discrepancies: [],
    publicSummary: input.publicSummary,
  })
  const contract = deliverableAutomationSeedMatrix.find((row) => row.deliverableId === input.deliverableId)
  if (!contract) throw new Error(`Missing automation seed for ${input.deliverableId}`)
  const gateEvaluation = evaluateDeliveryGates({
    contract,
    runId,
    commandCenterMode: "shadow",
    requestedDeliveryMode: "shadow",
    autonomyState: "shadow",
    readinessState: input.sourceGaps.some((gap) => gap.blocksCutover) ? "blocked" : "ready_for_delivery",
    evaluatedAt: input.completedAt,
    sourceObservedAt: input.sourceObservedAt,
    recipientFingerprint: input.recipientFingerprint,
    payloadFingerprint: createLocalPiiFingerprint(input.normalizedRows, "console_catalog_payload"),
    templateHash: createPayloadFingerprint({ deliverableId: input.deliverableId, renderer: "console_catalog_fixture" }),
    recipientScopeRuleId: input.recipientScopeRuleId,
    recipientScopePass: input.recipientScopePass,
    recipientScopeReason: "Read-only catalog fixture recipient scope evaluation.",
    publicSummary: input.publicSummary,
    artifactIds: artifacts.map((artifact) => artifact.artifactId),
    gateEvidenceRefs: sourceRefs.map((ref) => ref.id),
    blockingDiscrepancyCount: 0,
    businessDefinitionOpenCount: 0,
    blockingSourceGapCount: input.sourceGaps.filter((gap) => gap.blocksCutover).length,
    priorPayloadFingerprintsInWindow: [],
    shadowRunsCompleted: 1,
    cleanShadowRuns: input.sourceGaps.length === 0 ? 1 : 0,
    killSwitches: [],
    externalDeliveryAdapterApproved: false,
    createdBy: "console_fixture",
  })

  return { run, deliveryLogEntry: gateEvaluation.deliveryLogEntry, sourceRefs }
}

function buildCatalogArtifacts(input: {
  runId: string
  workflowId: string
  rows: readonly Record<string, unknown>[]
  sourceRefs: readonly SourceEvidenceRef[]
  publicSummary: Record<string, unknown>
}): RunArtifact[] {
  return (["json", "csv"] as const satisfies readonly ArtifactFormat[]).map((format) =>
    buildRunArtifact({
      artifactId: `${input.workflowId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${format}_${input.runId}`,
      runId: input.runId,
      workflowId: input.workflowId,
      format,
      path: `.recruiting-ops-artifacts/${input.workflowId.toLowerCase()}/${input.runId}/catalog-fixture.${format}`,
      rowCount: input.rows.length,
      schemaVersion: "console-catalog.v1",
      sourceRefs: input.sourceRefs.map((ref) => ref.id),
      publicSummary: input.publicSummary,
      rows: input.rows,
    })
  )
}

function automationLanes(): readonly DeliverableLane[] {
  return ["auto_delivery", "review_assisted", "action_proposal"]
}

function automationLaneLabel(lane: DeliverableLane): string {
  return {
    auto_delivery: "Auto Delivery",
    review_assisted: "Review Assisted",
    action_proposal: "Action Proposal",
  }[lane]
}
