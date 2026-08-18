import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

import { getDeliverableAutomationSeed } from "./automation-seed-matrix"
import { buildRunArtifact, type RunArtifact } from "./runs"
import { assertPublicSafe } from "./safe-public-output"
import {
  assertKnownWorkflowIds,
  assertNonEmptyString,
  validateId,
  type ArtifactFormat,
} from "./substrate"

export const DEFAULT_LOCAL_ARTIFACT_ROOT = ".recruiting-ops-artifacts"

export interface LocalArtifactWriteInput {
  rootDir: string
  workflowId: string
  /**
   * Deliverable (output-contract sourceContractId) this artifact renders. Row PII posture
   * is resolved from the governed automation seed matrix, never from caller opinion;
   * absent/unknown ids fail closed to the strict public_safe posture.
   */
  deliverableId?: string
  runId: string
  format: ArtifactFormat
  fileName?: string
  schemaVersion: string
  content: string
  rows: readonly unknown[]
  sourceRefs: readonly string[]
  publicSummary: Record<string, unknown>
}

export function allowsPersonIdentifyingRows(deliverableId: string | undefined): boolean {
  if (!deliverableId) return false
  return getDeliverableAutomationSeed(deliverableId).piiPolicy === "internal_review_identifiers"
}

export async function writeLocalArtifact(input: LocalArtifactWriteInput): Promise<RunArtifact> {
  const artifactPath = resolveLocalArtifactPath(input)
  const artifactDir = artifactPath.slice(0, artifactPath.lastIndexOf("/"))

  assertPublicSafe(input.publicSummary, `${input.workflowId}.artifactPublicSummary`)
  await mkdir(artifactDir, { recursive: true })
  await writeFile(artifactPath, input.content, "utf8")

  return buildRunArtifact({
    artifactId: `${workflowSlug(input.workflowId)}_${input.format}_${input.runId}`,
    runId: input.runId,
    workflowId: input.workflowId,
    format: input.format,
    path: artifactPath,
    rowCount: input.rows.length,
    schemaVersion: input.schemaVersion,
    sourceRefs: input.sourceRefs,
    publicSummary: {
      ...input.publicSummary,
      format: input.format,
      rowCount: input.rows.length,
    },
    rows: input.rows,
  })
}

export function resolveLocalArtifactPath(input: {
  rootDir: string
  workflowId: string
  runId: string
  format: ArtifactFormat
  fileName?: string
}): string {
  assertNonEmptyString(input.rootDir, "rootDir")
  assertKnownWorkflowIds([input.workflowId], "workflowId")
  validateId(input.runId, "runId")

  const slug = workflowSlug(input.workflowId)
  const fileName = input.fileName ?? `${slug}-${input.runId}.${input.format}`
  if (basename(fileName) !== fileName || fileName.includes("..")) {
    throw new Error(`Unsafe artifact file name: ${fileName}`)
  }

  return join(input.rootDir, slug, input.runId, fileName)
}

function workflowSlug(workflowId: string): string {
  return workflowId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}
