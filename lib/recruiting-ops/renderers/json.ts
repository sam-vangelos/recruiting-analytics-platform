import { stableSerialize } from "../checksums"
import { allowsPersonIdentifyingRows, writeLocalArtifact, type LocalArtifactWriteInput } from "../local-artifacts"
import { assertPublicSafe, redactForPublicValue } from "../safe-public-output"

export interface JsonArtifactInput extends Omit<LocalArtifactWriteInput, "format" | "content"> {
  generatedAt: string
}

export function renderJsonArtifact(input: JsonArtifactInput): string {
  // Delivery-render seam: row PII posture comes from the deliverable's governed contract
  // (seed-matrix piiPolicy), resolved fail-closed — no/unknown deliverableId means the
  // strict public_safe posture. In both postures the rendered rows are re-certified
  // against the SAME posture, so the certified object IS the delivered object.
  const allowIdentifiers = allowsPersonIdentifyingRows(input.deliverableId)
  const deliveredRows = allowIdentifiers
    ? input.rows
    : input.rows.map((row) => redactForPublicValue(row))
  assertPublicSafe(
    deliveredRows,
    `${input.workflowId}.jsonRows`,
    allowIdentifiers ? { allowPersonIdentifyingFields: true } : {}
  )
  return `${stableSerialize({
    generatedAt: input.generatedAt,
    rowCount: input.rows.length,
    rows: deliveredRows,
    runId: input.runId,
    schemaVersion: input.schemaVersion,
    workflowId: input.workflowId,
  })}\n`
}

export async function writeJsonArtifact(input: JsonArtifactInput) {
  return writeLocalArtifact({
    ...input,
    format: "json",
    content: renderJsonArtifact(input),
  })
}
