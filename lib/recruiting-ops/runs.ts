import { createStableChecksum } from "./checksums"
import { summarizeDiscrepancies, type Discrepancy, type DiscrepancySummary } from "./discrepancies"
import { assertPublicSafe } from "./safe-public-output"
import {
  assertKnownWorkflowIds,
  assertNonEmptyString,
  validateEvidenceRefs,
  validateId,
  type ArtifactFormat,
  type CommandCenterMode,
  type RunStatus,
  type SourceEvidenceRef,
  type ValidationSummary,
} from "./substrate"

export interface SourceGap {
  id: string
  workflowId: string
  capabilityId?: string
  sourceId: string
  field: string
  reason: string
  blocksCutover: boolean
}

export interface RunArtifact {
  artifactId: string
  runId: string
  workflowId: string
  capabilityId?: string
  format: ArtifactFormat
  path: string
  rowCount: number
  checksum: string
  schemaVersion: string
  sourceRefs: readonly string[]
  publicSummary: Record<string, unknown>
}

export interface CommandCenterRun {
  runId: string
  workflowId: string
  /** Capability-first provenance — required on every run before persistence. */
  capabilityId: string
  moduleId: string
  mode: CommandCenterMode
  status: RunStatus
  startedAt: string
  completedAt?: string
  sourceRefs: readonly SourceEvidenceRef[]
  legacyArtifactRefs: readonly string[]
  inputChecksum: string
  normalizedRowCount: number
  normalizedChecksum: string
  artifactRefs: readonly RunArtifact[]
  sourceGaps: readonly SourceGap[]
  discrepancySummary: DiscrepancySummary
  publicSummary: Record<string, unknown>
}

export function buildRunId(workflowId: string, timestampIso: string): string {
  assertKnownWorkflowIds([workflowId], "workflowId")
  return `${workflowId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${timestampIso.replace(/[^0-9]/g, "")}`
}

export function buildRunArtifact(input: Omit<RunArtifact, "checksum"> & { rows: readonly unknown[] }): RunArtifact {
  const artifact = {
    artifactId: input.artifactId,
    runId: input.runId,
    workflowId: input.workflowId,
    format: input.format,
    path: input.path,
    rowCount: input.rowCount,
    checksum: createStableChecksum(input.rows),
    schemaVersion: input.schemaVersion,
    sourceRefs: input.sourceRefs,
    publicSummary: input.publicSummary,
  }
  validateRunArtifact(artifact)
  return artifact
}

export function buildCommandCenterRun(input: {
  workflowId: string
  capabilityId: string
  moduleId: string
  mode: CommandCenterMode
  status: RunStatus
  startedAt: string
  completedAt?: string
  sourceRefs: readonly SourceEvidenceRef[]
  legacyArtifactRefs: readonly string[]
  normalizedRows: readonly unknown[]
  artifactRefs: readonly RunArtifact[]
  sourceGaps: readonly SourceGap[]
  discrepancies: readonly Discrepancy[]
  publicSummary: Record<string, unknown>
}): CommandCenterRun {
  const runId = buildRunId(input.workflowId, input.startedAt)
  const run = {
    runId,
    workflowId: input.workflowId,
    capabilityId: input.capabilityId,
    moduleId: input.moduleId,
    mode: input.mode,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    sourceRefs: input.sourceRefs,
    legacyArtifactRefs: input.legacyArtifactRefs,
    inputChecksum: createStableChecksum(input.sourceRefs),
    normalizedRowCount: input.normalizedRows.length,
    normalizedChecksum: createStableChecksum(input.normalizedRows),
    // Stamp the capability onto every nested record so persistence never sees an
    // unattributed artifact or source gap.
    artifactRefs: input.artifactRefs.map((artifact) => ({ ...artifact, capabilityId: input.capabilityId })),
    sourceGaps: input.sourceGaps.map((gap) => ({ ...gap, capabilityId: input.capabilityId })),
    discrepancySummary: summarizeDiscrepancies(input.discrepancies),
    publicSummary: input.publicSummary,
  }
  validateCommandCenterRun(run)
  return run
}

export function validateRunArtifact(artifact: RunArtifact): ValidationSummary {
  validateId(artifact.artifactId, "runArtifact.artifactId")
  validateId(artifact.runId, `${artifact.artifactId}.runId`)
  assertKnownWorkflowIds([artifact.workflowId], `${artifact.artifactId}.workflowId`)
  assertNonEmptyString(artifact.path, `${artifact.artifactId}.path`)
  assertNonEmptyString(artifact.checksum, `${artifact.artifactId}.checksum`)
  if (artifact.rowCount < 0) throw new Error(`${artifact.artifactId}.rowCount cannot be negative`)
  assertPublicSafe(artifact.publicSummary, `${artifact.artifactId}.publicSummary`)
  return { ok: true, id: artifact.artifactId, checked: ["id", "workflow", "path", "checksum", "publicSafety"] }
}

export function validateCommandCenterRun(run: CommandCenterRun): ValidationSummary {
  validateId(run.runId, "run.runId")
  assertKnownWorkflowIds([run.workflowId], `${run.runId}.workflowId`)
  assertNonEmptyString(run.capabilityId, `${run.runId}.capabilityId`)
  assertNonEmptyString(run.moduleId, `${run.runId}.moduleId`)
  assertNonEmptyString(run.startedAt, `${run.runId}.startedAt`)
  validateEvidenceRefs(run.sourceRefs, `${run.runId}.sourceRefs`)
  assertNonEmptyString(run.inputChecksum, `${run.runId}.inputChecksum`)
  assertNonEmptyString(run.normalizedChecksum, `${run.runId}.normalizedChecksum`)
  if (run.normalizedRowCount < 0) throw new Error(`${run.runId}.normalizedRowCount cannot be negative`)
  for (const artifact of run.artifactRefs) validateRunArtifact(artifact)
  for (const gap of run.sourceGaps) validateSourceGap(gap)
  assertPublicSafe(run.publicSummary, `${run.runId}.publicSummary`)
  return {
    ok: true,
    id: run.runId,
    checked: ["id", "workflow", "sourceRefs", "checksums", "artifacts", "sourceGaps", "publicSafety"],
  }
}

export function validateSourceGap(gap: SourceGap): ValidationSummary {
  validateId(gap.id, "sourceGap.id")
  assertKnownWorkflowIds([gap.workflowId], `${gap.id}.workflowId`)
  assertNonEmptyString(gap.sourceId, `${gap.id}.sourceId`)
  assertNonEmptyString(gap.field, `${gap.id}.field`)
  assertNonEmptyString(gap.reason, `${gap.id}.reason`)
  return { ok: true, id: gap.id, checked: ["id", "workflow", "source", "field", "reason"] }
}

export function summarizeRunForPublic(run: CommandCenterRun): Record<string, unknown> {
  const summary = {
    runId: run.runId,
    workflowId: run.workflowId,
    mode: run.mode,
    status: run.status,
    normalizedRowCount: run.normalizedRowCount,
    artifactCount: run.artifactRefs.length,
    sourceGapCount: run.sourceGaps.length,
    discrepancySummary: run.discrepancySummary,
  }
  assertPublicSafe(summary, `${run.runId}.summary`)
  return summary
}
