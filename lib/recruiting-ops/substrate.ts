import {
  DISCREPANCY_CLASSES,
  getOutputContract,
  getQuery,
  getSource,
  getWorkflow,
  outputContractRegistry,
  queryRegistry,
  scriptAssetRegistry,
  sourceRegistry,
  workflowRegistry,
  type DiscrepancyClass,
  type OutputContractRegistryRow,
  type ProvenanceReference,
  type SourceAdapter,
  type SourceRegistryRow,
  type WorkflowRegistryRow,
} from "./registries"

export type CommandCenterMode = "fixture" | "local" | "shadow" | "production_disabled"
export type ArtifactFormat = "json" | "csv" | "xlsx"
export type RunStatus = "planned" | "running" | "succeeded" | "failed" | "blocked"

export interface SourceEvidenceRef {
  id: string
  sourceId: string
  adapter: SourceAdapter
  label: string
  artifactId?: string
  queryId?: string
  checksum?: string
}

export interface ValidationIssue {
  path: string
  message: string
}

export interface ValidationSummary {
  ok: true
  id: string
  checked: readonly string[]
}

export function validateId(id: string, label = "id"): void {
  if (!id.trim()) throw new Error(`${label} is required`)
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(id)) {
    throw new Error(`${label} has invalid characters: ${id}`)
  }
}

export function assertNonEmptyString(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`)
}

export function assertNonEmptyArray<T>(value: readonly T[], label: string): void {
  if (value.length === 0) throw new Error(`${label} must not be empty`)
}

export function assertKnownWorkflowIds(workflowIds: readonly string[], label = "workflowIds"): void {
  assertNonEmptyArray(workflowIds, label)
  for (const workflowId of workflowIds) getWorkflow(workflowId)
}

export function assertKnownQueryIds(queryIds: readonly string[], label = "queryIds"): void {
  for (const queryId of queryIds) getQuery(queryId)
}

export function assertKnownSourceIds(sourceIds: readonly string[], label = "sourceIds"): void {
  assertNonEmptyArray(sourceIds, label)
  for (const sourceId of sourceIds) getSource(sourceId)
}

export function assertKnownOutputContractIds(outputContractIds: readonly string[], label = "outputContractIds"): void {
  for (const outputContractId of outputContractIds) getOutputContract(outputContractId)
}

export function assertKnownScriptAssetIds(scriptAssetIds: readonly string[], label = "scriptAssetIds"): void {
  const known = new Set(scriptAssetRegistry.map((row) => row.id))
  for (const scriptAssetId of scriptAssetIds) {
    if (!known.has(scriptAssetId)) throw new Error(`Unknown ${label}: ${scriptAssetId}`)
  }
}

export function assertKnownDiscrepancyClass(value: string): asserts value is DiscrepancyClass {
  if (!DISCREPANCY_CLASSES.includes(value as DiscrepancyClass)) {
    throw new Error(`Unknown discrepancy class: ${value}`)
  }
}

export function assertProvenance(provenance: readonly ProvenanceReference[], label = "provenance"): void {
  assertNonEmptyArray(provenance, label)
  for (const [index, item] of provenance.entries()) {
    assertNonEmptyString(item.label, `${label}[${index}].label`)
    assertNonEmptyString(item.source, `${label}[${index}].source`)
    assertNonEmptyString(item.detail, `${label}[${index}].detail`)
  }
}

export function assertBlockersAndGate(row: { id: string; blockers: readonly string[]; nextGate: string }): void {
  assertNonEmptyArray(row.blockers, `${row.id}.blockers`)
  assertNonEmptyString(row.nextGate, `${row.id}.nextGate`)
}

export function assertProductionDisabled(value: boolean, label: string): void {
  if (value) throw new Error(`${label} must keep production writes disabled`)
}

export function validateEvidenceRefs(refs: readonly SourceEvidenceRef[], label = "sourceRefs"): void {
  assertNonEmptyArray(refs, label)
  for (const ref of refs) {
    validateId(ref.id, `${label}.id`)
    getSource(ref.sourceId)
    assertNonEmptyString(ref.label, `${label}.${ref.id}.label`)
    if (ref.queryId) getQuery(ref.queryId)
  }
}

export function registryCoverageSummary(): {
  sources: number
  workflows: number
  queries: number
  outputContracts: number
  scriptAssets: number
} {
  return {
    sources: sourceRegistry.length,
    workflows: workflowRegistry.length,
    queries: queryRegistry.length,
    outputContracts: outputContractRegistry.length,
    scriptAssets: scriptAssetRegistry.length,
  }
}

export type { DiscrepancyClass, OutputContractRegistryRow, ProvenanceReference, SourceRegistryRow, WorkflowRegistryRow }
