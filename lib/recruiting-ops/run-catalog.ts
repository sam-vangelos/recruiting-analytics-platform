import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

import { createLocalPiiFingerprint, createStableChecksum } from "./checksums"
import {
  validateLocalDeliveryLedgerEntry,
  type LocalDeliveryLedgerEntry,
  type LocalDeliveryLedgerEventType,
} from "./delivery-ledger"
import {
  validateDeliveryGateResult,
  type DeliveryGateId,
  type DeliveryGateResultStatus,
  type DeliveryLogStatus,
  type DeliverableAutonomyState,
  type DeliverableLane,
  type DeliverableReadinessState,
} from "./autonomy"
import {
  validateDiscrepancy,
  type Discrepancy,
  type DiscrepancyResolutionStatus,
  type DiscrepancySeverity,
} from "./discrepancies"
import {
  summarizeActionProposalForPublic,
  validateActionProposal,
  type ActionProposal,
  type ActionProposalApprovalState,
  type ActionProposalRiskTier,
  type ActionProposalTargetSystem,
  type ActionProposalType,
} from "./action-proposals"
import { assertPublicSafe, redactPublicText } from "./safe-public-output"
import {
  summarizeRunForPublic,
  validateCommandCenterRun,
  validateSourceGap,
  type CommandCenterRun,
} from "./runs"
import {
  assertKnownWorkflowIds,
  assertKnownDiscrepancyClass,
  assertNonEmptyString,
  validateId,
  type ArtifactFormat,
  type CommandCenterMode,
  type DiscrepancyClass,
  type RunStatus,
  type ValidationSummary,
} from "./substrate"

export interface LocalRunCatalog {
  catalogId: string
  generatedAt: string
  runs: readonly LocalRunCatalogRunEntry[]
  artifacts: readonly LocalRunCatalogArtifactEntry[]
  deliveryLogs: readonly LocalRunCatalogDeliveryLogEntry[]
  gateResults: readonly LocalRunCatalogGateResultEntry[]
  discrepancies: readonly LocalRunCatalogDiscrepancyEntry[]
  sourceGaps: readonly LocalRunCatalogSourceGapEntry[]
  actionProposals: readonly LocalRunCatalogActionProposalEntry[]
  publicSummary: Record<string, unknown>
}

export interface LocalRunCatalogInput {
  generatedAt: string
  runs: readonly CommandCenterRun[]
  deliveryLedgerEntries: readonly LocalDeliveryLedgerEntry[]
  discrepancies?: readonly Discrepancy[]
  actionProposals?: readonly ActionProposal[]
}

export interface LocalRunCatalogRunEntry {
  runId: string
  workflowId: string
  capabilityId: string
  moduleId: string
  mode: CommandCenterMode
  status: RunStatus
  startedAt: string
  completedAt?: string
  artifactIds: readonly string[]
  deliveryLogIds: readonly string[]
  sourceGapIds: readonly string[]
  discrepancyIds: readonly string[]
  actionProposalIds: readonly string[]
  publicSummary: Record<string, unknown>
}

export interface LocalRunCatalogArtifactEntry {
  artifactId: string
  runId: string
  workflowId: string
  capabilityId: string
  format: ArtifactFormat
  path: string
  rowCount: number
  checksum: string
  schemaVersion: string
  sourceRefs: readonly string[]
  publicSummary: Record<string, unknown>
}

export interface LocalRunCatalogDeliveryLogEntry {
  deliveryLogId: string
  eventType: LocalDeliveryLedgerEventType
  runId: string
  capabilityId: string
  deliverableId: string
  lane: DeliverableLane
  autonomyState: DeliverableAutonomyState
  readinessState: DeliverableReadinessState
  status: DeliveryLogStatus
  deliveryMechanism: "local_jsonl" | "supabase_table"
  recipientFingerprint: string
  payloadFingerprint: string
  artifactIds: readonly string[]
  gateResultIds: readonly string[]
  createdAt: string
  createdBy: string
  publicSummary: Record<string, unknown>
}

export interface LocalRunCatalogGateResultEntry {
  gateResultId: string
  deliveryLogId: string
  runId: string
  capabilityId: string
  deliverableId: string
  gateId: DeliveryGateId
  status: DeliveryGateResultStatus
  reason: string
  evidenceRefs: readonly string[]
}

export interface LocalRunCatalogDiscrepancyEntry {
  id: string
  runId: string
  workflowId: string
  capabilityId: string
  class: DiscrepancyClass
  severity: DiscrepancySeverity
  entityKey: string
  field: string
  modernValueSummary: string
  legacyValueSummary: string
  evidenceRefs: readonly string[]
  resolutionStatus: DiscrepancyResolutionStatus
  ownerFingerprint: string
}

export interface LocalRunCatalogSourceGapEntry {
  id: string
  runId: string
  workflowId: string
  capabilityId: string
  sourceId: string
  field: string
  reason: string
  blocksCutover: boolean
}

export interface LocalRunCatalogActionProposalEntry {
  proposalId: string
  workflowId: string
  capabilityId: string
  targetSystem: ActionProposalTargetSystem
  actionType: ActionProposalType
  riskTier: ActionProposalRiskTier
  approvalState: ActionProposalApprovalState
  evidenceRefs: readonly string[]
  evidenceRunIds: readonly string[]
  payloadFingerprint: string
  redactedPayloadSummary: Record<string, unknown>
  createdAt: string
  noLiveExecution: true
  publicSummary: Record<string, unknown>
}

export interface LocalRunCatalogRunFilter {
  capabilityId?: string
  workflowId?: string
  mode?: CommandCenterMode
  status?: RunStatus
  deliverableId?: string
}

export interface LocalRunCatalogGateFilter {
  capabilityId?: string
  deliverableId?: string
  gateId?: DeliveryGateId
  status?: DeliveryGateResultStatus
}

export interface LocalRunCatalogActionProposalFilter {
  capabilityId?: string
  workflowId?: string
  approvalState?: ActionProposalApprovalState
  riskTier?: ActionProposalRiskTier
}

export interface LocalRunCatalogLineage {
  run: LocalRunCatalogRunEntry
  artifacts: readonly LocalRunCatalogArtifactEntry[]
  deliveryLogs: readonly LocalRunCatalogDeliveryLogEntry[]
  gateResults: readonly LocalRunCatalogGateResultEntry[]
  discrepancies: readonly LocalRunCatalogDiscrepancyEntry[]
  sourceGaps: readonly LocalRunCatalogSourceGapEntry[]
  actionProposals: readonly LocalRunCatalogActionProposalEntry[]
}

export interface LocalRunCatalogWriteInput {
  rootDir: string
  catalog: LocalRunCatalog
  fileName?: string
}

export interface LocalRunCatalogWriteResult {
  path: string
  bytesWritten: number
  catalogId: string
}

export function buildLocalRunCatalog(input: LocalRunCatalogInput): LocalRunCatalog {
  assertNonEmptyString(input.generatedAt, "localRunCatalog.generatedAt")
  const runs = sortBy(input.runs.map((run) => {
    validateCommandCenterRun(run)
    return run
  }), (run) => run.runId)
  const deliveryLedgerEntries = sortBy(input.deliveryLedgerEntries.map(validateLocalDeliveryLedgerEntry), (entry) => entry.deliveryLogId)
  const discrepancies = sortBy((input.discrepancies ?? []).map((discrepancy) => {
    validateDiscrepancy(discrepancy)
    return discrepancy
  }), (discrepancy) => discrepancy.id)
  const actionProposals = sortBy((input.actionProposals ?? []).map((proposal) => {
    validateActionProposal(proposal)
    return proposal
  }), (proposal) => proposal.proposalId)

  const artifacts = sortBy(
    runs.flatMap((run) => run.artifactRefs.map((artifact): LocalRunCatalogArtifactEntry => ({
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      workflowId: artifact.workflowId,
      capabilityId: artifact.capabilityId ?? run.capabilityId,
      format: artifact.format,
      path: artifact.path,
      rowCount: artifact.rowCount,
      checksum: artifact.checksum,
      schemaVersion: artifact.schemaVersion,
      sourceRefs: artifact.sourceRefs,
      publicSummary: artifact.publicSummary,
    }))),
    (artifact) => artifact.artifactId
  )
  const sourceGaps = sortBy(
    runs.flatMap((run) => run.sourceGaps.map((gap): LocalRunCatalogSourceGapEntry => ({
      id: gap.id,
      runId: run.runId,
      workflowId: gap.workflowId,
      capabilityId: gap.capabilityId ?? run.capabilityId,
      sourceId: gap.sourceId,
      field: gap.field,
      reason: gap.reason,
      blocksCutover: gap.blocksCutover,
    }))),
    (gap) => gap.id
  )
  const gateResults = sortBy(
    deliveryLedgerEntries.flatMap((entry) => entry.gateResults.map((gate): LocalRunCatalogGateResultEntry => ({
      gateResultId: `${entry.deliveryLogId}_${gate.gateId}`,
      deliveryLogId: entry.deliveryLogId,
      runId: entry.runId,
      capabilityId: entry.capabilityId,
      deliverableId: entry.deliverableId,
      gateId: gate.gateId,
      status: gate.status,
      reason: gate.reason,
      evidenceRefs: gate.evidenceRefs,
    }))),
    (gate) => gate.gateResultId
  )
  const deliveryLogs = sortBy(
    deliveryLedgerEntries.map((entry): LocalRunCatalogDeliveryLogEntry => ({
      deliveryLogId: entry.deliveryLogId,
      eventType: entry.eventType,
      runId: entry.runId,
      capabilityId: entry.capabilityId,
      deliverableId: entry.deliverableId,
      lane: entry.lane,
      autonomyState: entry.autonomyState,
      readinessState: entry.readinessState,
      status: entry.status,
      deliveryMechanism: entry.deliveryMechanism,
      recipientFingerprint: entry.recipientFingerprint,
      payloadFingerprint: entry.payloadFingerprint,
      artifactIds: entry.artifactIds,
      gateResultIds: gateResults.filter((gate) => gate.deliveryLogId === entry.deliveryLogId).map((gate) => gate.gateResultId),
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
      publicSummary: entry.publicSummary,
    })),
    (entry) => entry.deliveryLogId
  )
  const discrepancyEntries = discrepancies.map((discrepancy): LocalRunCatalogDiscrepancyEntry => ({
    id: discrepancy.id,
    runId: discrepancy.runId,
    workflowId: discrepancy.workflowId,
    capabilityId: discrepancy.capabilityId ?? getRunCapabilityId(runs, discrepancy.runId),
    class: discrepancy.class,
    severity: discrepancy.severity,
    entityKey: discrepancy.entityKey,
    field: discrepancy.field,
    modernValueSummary: redactPublicText(discrepancy.modernValueSummary),
    legacyValueSummary: redactPublicText(discrepancy.legacyValueSummary),
    evidenceRefs: discrepancy.evidenceRefs,
    resolutionStatus: discrepancy.resolutionStatus,
    ownerFingerprint: createLocalPiiFingerprint(discrepancy.owner, "discrepancy_owner"),
  }))
  const actionProposalEntries = actionProposals.map((proposal): LocalRunCatalogActionProposalEntry => {
    const publicSummary = summarizeActionProposalForPublic(proposal)
    const evidenceRunIds = runs.filter((run) => actionProposalAppliesToRun(proposal, run)).map((run) => run.runId)
    return {
      proposalId: proposal.proposalId,
      workflowId: proposal.workflowId,
      capabilityId: proposal.capabilityId,
      targetSystem: proposal.targetSystem,
      actionType: proposal.actionType,
      riskTier: proposal.riskTier,
      approvalState: proposal.approvalState,
      evidenceRefs: proposal.evidenceRefs,
      evidenceRunIds,
      payloadFingerprint: proposal.payloadFingerprint,
      redactedPayloadSummary: proposal.redactedPayloadSummary,
      createdAt: proposal.createdAt,
      noLiveExecution: proposal.noLiveExecution,
      publicSummary,
    }
  })
  const runEntries = runs.map((run): LocalRunCatalogRunEntry => ({
    runId: run.runId,
    workflowId: run.workflowId,
    capabilityId: run.capabilityId,
    moduleId: run.moduleId,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    artifactIds: artifacts.filter((artifact) => artifact.runId === run.runId).map((artifact) => artifact.artifactId),
    deliveryLogIds: deliveryLogs.filter((entry) => entry.runId === run.runId).map((entry) => entry.deliveryLogId),
    sourceGapIds: sourceGaps.filter((gap) => gap.runId === run.runId).map((gap) => gap.id),
    discrepancyIds: discrepancyEntries.filter((discrepancy) => discrepancy.runId === run.runId).map((discrepancy) => discrepancy.id),
    actionProposalIds: actionProposalEntries.filter((proposal) => proposal.evidenceRunIds.includes(run.runId)).map((proposal) => proposal.proposalId),
    publicSummary: summarizeRunForPublic(run),
  }))
  const publicSummary = buildCatalogPublicSummary({
    runs: runEntries,
    artifacts,
    deliveryLogs,
    gateResults,
    discrepancies: discrepancyEntries,
    sourceGaps,
    actionProposals: actionProposalEntries,
  })
  const catalogId = `catalog_${createStableChecksum({
    generatedAt: input.generatedAt,
    runs: runEntries.map((run) => run.runId),
    deliveryLogs: deliveryLogs.map((entry) => entry.deliveryLogId),
    actionProposals: actionProposalEntries.map((proposal) => proposal.proposalId),
  }).slice(7, 23)}`
  const catalog = {
    catalogId,
    generatedAt: input.generatedAt,
    runs: runEntries,
    artifacts,
    deliveryLogs,
    gateResults,
    discrepancies: discrepancyEntries,
    sourceGaps,
    actionProposals: actionProposalEntries,
    publicSummary,
  }
  validateLocalRunCatalog(catalog)
  return catalog
}

export function validateLocalRunCatalog(catalog: LocalRunCatalog): ValidationSummary {
  validateId(catalog.catalogId, "localRunCatalog.catalogId")
  assertNonEmptyString(catalog.generatedAt, `${catalog.catalogId}.generatedAt`)
  const runIds = new Set(catalog.runs.map((run) => run.runId))
  const artifactIds = new Set(catalog.artifacts.map((artifact) => artifact.artifactId))
  const deliveryLogIds = new Set(catalog.deliveryLogs.map((entry) => entry.deliveryLogId))
  const gateResultIds = new Set(catalog.gateResults.map((gate) => gate.gateResultId))
  assertNoDuplicates(runIds, catalog.runs.length, "runId")
  assertNoDuplicates(artifactIds, catalog.artifacts.length, "artifactId")
  assertNoDuplicates(deliveryLogIds, catalog.deliveryLogs.length, "deliveryLogId")
  assertNoDuplicates(gateResultIds, catalog.gateResults.length, "gateResultId")

  for (const run of catalog.runs) validateCatalogRun(run, deliveryLogIds, artifactIds)
  for (const artifact of catalog.artifacts) validateCatalogArtifact(artifact, runIds)
  for (const entry of catalog.deliveryLogs) validateCatalogDeliveryLog(entry, runIds, artifactIds, gateResultIds)
  for (const gate of catalog.gateResults) validateCatalogGateResult(gate, deliveryLogIds)
  for (const discrepancy of catalog.discrepancies) validateCatalogDiscrepancy(discrepancy, runIds)
  for (const gap of catalog.sourceGaps) validateCatalogSourceGap(gap, runIds)
  for (const proposal of catalog.actionProposals) validateCatalogActionProposal(proposal, runIds)
  assertPublicSafe(catalog.publicSummary, `${catalog.catalogId}.publicSummary`)
  return { ok: true, id: catalog.catalogId, checked: ["ids", "lineage", "publicSafety"] }
}

export function filterCatalogRuns(
  catalog: LocalRunCatalog,
  filter: LocalRunCatalogRunFilter = {}
): readonly LocalRunCatalogRunEntry[] {
  validateLocalRunCatalog(catalog)
  return catalog.runs.filter((run) => {
    if (filter.capabilityId && run.capabilityId !== filter.capabilityId) return false
    if (filter.workflowId && run.workflowId !== filter.workflowId) return false
    if (filter.mode && run.mode !== filter.mode) return false
    if (filter.status && run.status !== filter.status) return false
    if (filter.deliverableId) {
      return catalog.deliveryLogs.some((entry) => entry.runId === run.runId && entry.deliverableId === filter.deliverableId)
    }
    return true
  })
}

export function filterCatalogGateResults(
  catalog: LocalRunCatalog,
  filter: LocalRunCatalogGateFilter = {}
): readonly LocalRunCatalogGateResultEntry[] {
  validateLocalRunCatalog(catalog)
  return catalog.gateResults.filter((gate) => {
    if (filter.capabilityId && gate.capabilityId !== filter.capabilityId) return false
    if (filter.deliverableId && gate.deliverableId !== filter.deliverableId) return false
    if (filter.gateId && gate.gateId !== filter.gateId) return false
    if (filter.status && gate.status !== filter.status) return false
    return true
  })
}

export function filterCatalogActionProposals(
  catalog: LocalRunCatalog,
  filter: LocalRunCatalogActionProposalFilter = {}
): readonly LocalRunCatalogActionProposalEntry[] {
  validateLocalRunCatalog(catalog)
  return catalog.actionProposals.filter((proposal) => {
    if (filter.capabilityId && proposal.capabilityId !== filter.capabilityId) return false
    if (filter.workflowId && proposal.workflowId !== filter.workflowId) return false
    if (filter.approvalState && proposal.approvalState !== filter.approvalState) return false
    if (filter.riskTier && proposal.riskTier !== filter.riskTier) return false
    return true
  })
}

export function getCatalogRunLineage(catalog: LocalRunCatalog, runId: string): LocalRunCatalogLineage {
  validateLocalRunCatalog(catalog)
  validateId(runId, "runId")
  const run = catalog.runs.find((entry) => entry.runId === runId)
  if (!run) throw new Error(`Unknown catalog run: ${runId}`)
  const deliveryLogs = catalog.deliveryLogs.filter((entry) => entry.runId === runId)
  const deliveryLogIds = new Set(deliveryLogs.map((entry) => entry.deliveryLogId))
  return {
    run,
    artifacts: catalog.artifacts.filter((artifact) => artifact.runId === runId),
    deliveryLogs,
    gateResults: catalog.gateResults.filter((gate) => deliveryLogIds.has(gate.deliveryLogId)),
    discrepancies: catalog.discrepancies.filter((discrepancy) => discrepancy.runId === runId),
    sourceGaps: catalog.sourceGaps.filter((gap) => gap.runId === runId),
    actionProposals: catalog.actionProposals.filter((proposal) => proposal.evidenceRunIds.includes(runId)),
  }
}

export async function writeLocalRunCatalog(input: LocalRunCatalogWriteInput): Promise<LocalRunCatalogWriteResult> {
  validateLocalRunCatalog(input.catalog)
  const catalogPath = resolveLocalRunCatalogPath(input)
  const catalogDir = catalogPath.slice(0, catalogPath.lastIndexOf("/"))
  const content = `${JSON.stringify(input.catalog, null, 2)}\n`
  await mkdir(catalogDir, { recursive: true })
  await writeFile(catalogPath, content, "utf8")
  return {
    path: catalogPath,
    bytesWritten: Buffer.byteLength(content, "utf8"),
    catalogId: input.catalog.catalogId,
  }
}

export async function readLocalRunCatalog(input: {
  rootDir: string
  fileName?: string
}): Promise<LocalRunCatalog> {
  const catalogPath = resolveLocalRunCatalogPath(input)
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as LocalRunCatalog
  validateLocalRunCatalog(catalog)
  return catalog
}

export function resolveLocalRunCatalogPath(input: { rootDir: string; fileName?: string }): string {
  assertLocalRoot(input.rootDir)
  const fileName = input.fileName ?? "run-catalog.json"
  if (basename(fileName) !== fileName || fileName.includes("..") || !fileName.endsWith(".json")) {
    throw new Error(`Unsafe run catalog file name: ${fileName}`)
  }
  return join(input.rootDir, "catalogs", fileName)
}

function validateCatalogRun(
  run: LocalRunCatalogRunEntry,
  deliveryLogIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>
): void {
  validateId(run.runId, "catalog.run.runId")
  assertKnownWorkflowIds([run.workflowId], `${run.runId}.workflowId`)
  assertNonEmptyString(run.capabilityId, `${run.runId}.capabilityId`)
  assertNonEmptyString(run.moduleId, `${run.runId}.moduleId`)
  assertNonEmptyString(run.startedAt, `${run.runId}.startedAt`)
  for (const artifactId of run.artifactIds) assertKnownReference(artifactId, artifactIds, `${run.runId}.artifactIds`)
  for (const deliveryLogId of run.deliveryLogIds) {
    assertKnownReference(deliveryLogId, deliveryLogIds, `${run.runId}.deliveryLogIds`)
  }
  assertPublicSafe(run.publicSummary, `${run.runId}.publicSummary`)
}

function validateCatalogArtifact(artifact: LocalRunCatalogArtifactEntry, runIds: ReadonlySet<string>): void {
  validateId(artifact.artifactId, "catalog.artifact.artifactId")
  validateId(artifact.runId, `${artifact.artifactId}.runId`)
  assertKnownReference(artifact.runId, runIds, `${artifact.artifactId}.runId`)
  assertKnownWorkflowIds([artifact.workflowId], `${artifact.artifactId}.workflowId`)
  assertNonEmptyString(artifact.capabilityId, `${artifact.artifactId}.capabilityId`)
  assertNonEmptyString(artifact.path, `${artifact.artifactId}.path`)
  assertNonEmptyString(artifact.checksum, `${artifact.artifactId}.checksum`)
  assertNonEmptyString(artifact.schemaVersion, `${artifact.artifactId}.schemaVersion`)
  if (artifact.rowCount < 0) throw new Error(`${artifact.artifactId}.rowCount cannot be negative`)
  assertPublicSafe(artifact.publicSummary, `${artifact.artifactId}.publicSummary`)
}

function validateCatalogDeliveryLog(
  entry: LocalRunCatalogDeliveryLogEntry,
  runIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>,
  gateResultIds: ReadonlySet<string>
): void {
  validateId(entry.deliveryLogId, "catalog.deliveryLog.deliveryLogId")
  assertKnownReference(entry.runId, runIds, `${entry.deliveryLogId}.runId`)
  assertNonEmptyString(entry.capabilityId, `${entry.deliveryLogId}.capabilityId`)
  validateId(entry.deliverableId, `${entry.deliveryLogId}.deliverableId`)
  assertNonEmptyString(entry.recipientFingerprint, `${entry.deliveryLogId}.recipientFingerprint`)
  assertNonEmptyString(entry.payloadFingerprint, `${entry.deliveryLogId}.payloadFingerprint`)
  for (const artifactId of entry.artifactIds) assertKnownReference(artifactId, artifactIds, `${entry.deliveryLogId}.artifactIds`)
  for (const gateResultId of entry.gateResultIds) {
    assertKnownReference(gateResultId, gateResultIds, `${entry.deliveryLogId}.gateResultIds`)
  }
  assertPublicSafe(entry.publicSummary, `${entry.deliveryLogId}.publicSummary`)
}

function validateCatalogGateResult(gate: LocalRunCatalogGateResultEntry, deliveryLogIds: ReadonlySet<string>): void {
  validateId(gate.gateResultId, "catalog.gateResult.gateResultId")
  assertKnownReference(gate.deliveryLogId, deliveryLogIds, `${gate.gateResultId}.deliveryLogId`)
  validateDeliveryGateResult({
    gateId: gate.gateId,
    status: gate.status,
    reason: gate.reason,
    evidenceRefs: gate.evidenceRefs,
  })
}

function validateCatalogDiscrepancy(discrepancy: LocalRunCatalogDiscrepancyEntry, runIds: ReadonlySet<string>): void {
  validateId(discrepancy.id, "catalog.discrepancy.id")
  assertKnownReference(discrepancy.runId, runIds, `${discrepancy.id}.runId`)
  assertKnownWorkflowIds([discrepancy.workflowId], `${discrepancy.id}.workflowId`)
  assertKnownDiscrepancyClass(discrepancy.class)
  assertNonEmptyString(discrepancy.capabilityId, `${discrepancy.id}.capabilityId`)
  assertNonEmptyString(discrepancy.entityKey, `${discrepancy.id}.entityKey`)
  assertNonEmptyString(discrepancy.field, `${discrepancy.id}.field`)
  assertNonEmptyString(discrepancy.modernValueSummary, `${discrepancy.id}.modernValueSummary`)
  assertNonEmptyString(discrepancy.legacyValueSummary, `${discrepancy.id}.legacyValueSummary`)
  assertNonEmptyString(discrepancy.ownerFingerprint, `${discrepancy.id}.ownerFingerprint`)
  if (discrepancy.evidenceRefs.length === 0) throw new Error(`${discrepancy.id}.evidenceRefs must not be empty`)
  assertPublicSafe(
    {
      entityKey: discrepancy.entityKey,
      field: discrepancy.field,
      modernValueSummary: discrepancy.modernValueSummary,
      legacyValueSummary: discrepancy.legacyValueSummary,
      ownerFingerprint: discrepancy.ownerFingerprint,
    },
    `${discrepancy.id}.publicSummary`
  )
}

function validateCatalogSourceGap(gap: LocalRunCatalogSourceGapEntry, runIds: ReadonlySet<string>): void {
  validateId(gap.runId, `${gap.id}.runId`)
  assertKnownReference(gap.runId, runIds, `${gap.id}.runId`)
  validateSourceGap(gap)
}

function validateCatalogActionProposal(proposal: LocalRunCatalogActionProposalEntry, runIds: ReadonlySet<string>): void {
  validateId(proposal.proposalId, "catalog.actionProposal.proposalId")
  assertKnownWorkflowIds([proposal.workflowId], `${proposal.proposalId}.workflowId`)
  assertNonEmptyString(proposal.capabilityId, `${proposal.proposalId}.capabilityId`)
  assertNonEmptyString(proposal.payloadFingerprint, `${proposal.proposalId}.payloadFingerprint`)
  if (!proposal.noLiveExecution) throw new Error(`${proposal.proposalId} must remain dry-run only`)
  for (const runId of proposal.evidenceRunIds) assertKnownReference(runId, runIds, `${proposal.proposalId}.evidenceRunIds`)
  assertPublicSafe(proposal.redactedPayloadSummary, `${proposal.proposalId}.redactedPayloadSummary`)
  assertPublicSafe(proposal.publicSummary, `${proposal.proposalId}.publicSummary`)
}

function buildCatalogPublicSummary(input: {
  runs: readonly LocalRunCatalogRunEntry[]
  artifacts: readonly LocalRunCatalogArtifactEntry[]
  deliveryLogs: readonly LocalRunCatalogDeliveryLogEntry[]
  gateResults: readonly LocalRunCatalogGateResultEntry[]
  discrepancies: readonly LocalRunCatalogDiscrepancyEntry[]
  sourceGaps: readonly LocalRunCatalogSourceGapEntry[]
  actionProposals: readonly LocalRunCatalogActionProposalEntry[]
}): Record<string, unknown> {
  const summary = {
    runCount: input.runs.length,
    artifactCount: input.artifacts.length,
    deliveryLogCount: input.deliveryLogs.length,
    gateResultCount: input.gateResults.length,
    failedGateCount: input.gateResults.filter((gate) => gate.status === "fail").length,
    sourceGapCount: input.sourceGaps.length,
    blockingSourceGapCount: input.sourceGaps.filter((gap) => gap.blocksCutover).length,
    discrepancyCount: input.discrepancies.length,
    blockingDiscrepancyCount: input.discrepancies.filter((discrepancy) => discrepancy.severity === "blocking").length,
    actionProposalCount: input.actionProposals.length,
    openActionProposalCount: input.actionProposals.filter((proposal) => proposal.approvalState === "needs_review").length,
    runStatusCounts: countBy(input.runs, (run) => run.status),
    deliveryStatusCounts: countBy(input.deliveryLogs, (entry) => entry.status),
  }
  assertPublicSafe(summary, "localRunCatalog.publicSummary")
  return summary
}

function getRunCapabilityId(runs: readonly CommandCenterRun[], runId: string): string {
  const run = runs.find((item) => item.runId === runId)
  if (!run) throw new Error(`Discrepancy references unknown run: ${runId}`)
  return run.capabilityId
}

function actionProposalAppliesToRun(proposal: ActionProposal, run: CommandCenterRun): boolean {
  if (proposal.evidenceRefs.includes(run.runId)) return true
  return run.sourceRefs.some((ref) => proposal.evidenceRefs.includes(ref.id))
}

function assertKnownReference(value: string, knownValues: ReadonlySet<string>, label: string): void {
  validateId(value, label)
  if (!knownValues.has(value)) throw new Error(`${label} references unknown catalog entry: ${value}`)
}

function assertNoDuplicates(set: ReadonlySet<string>, originalLength: number, label: string): void {
  if (set.size !== originalLength) throw new Error(`Duplicate ${label} in local run catalog`)
}

function assertLocalRoot(rootDir: string): void {
  assertNonEmptyString(rootDir, "rootDir")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rootDir)) {
    throw new Error("Run catalog rootDir must be a local filesystem path")
  }
}

function sortBy<T>(items: readonly T[], getKey: (item: T) => string): T[] {
  return [...items].sort((a, b) => getKey(a).localeCompare(getKey(b)))
}

function countBy<T>(items: readonly T[], getKey: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = getKey(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}
