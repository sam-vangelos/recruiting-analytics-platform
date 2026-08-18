import { allowsPersonIdentifyingRows, writeLocalArtifact, type LocalArtifactWriteInput } from "../local-artifacts"
import { assertPublicSafe, redactForPublicValue } from "../safe-public-output"

export interface CsvColumn {
  key: string
  label: string
}

export interface CsvArtifactInput extends Omit<LocalArtifactWriteInput, "format" | "content"> {
  columns: readonly CsvColumn[]
}

export function renderCsvArtifact(input: CsvArtifactInput): string {
  if (input.columns.length === 0) throw new Error("CSV columns must not be empty")
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
    `${input.workflowId}.csvRows`,
    allowIdentifiers ? { allowPersonIdentifyingFields: true } : {}
  )

  const header = input.columns.map((column) => escapeCsvValue(column.label)).join(",")
  const rows = deliveredRows.map((row, index) => {
    const record = row as Record<string, unknown>
    const original = input.rows[index] as Record<string, unknown> | undefined
    return input.columns
      .map((column) => {
        // Redaction renames person-identifying keys; keep the column aligned with an
        // explicit marker — but only where the original row actually carried a value
        // (null/undefined originals render as empty cells exactly as before).
        const originalValue = original ? original[column.key] : undefined
        const value =
          record[column.key] !== undefined
            ? record[column.key]
            : originalValue !== undefined && originalValue !== null
              ? "[REDACTED]"
              : undefined
        return escapeCsvValue(value)
      })
      .join(",")
  })

  return [header, ...rows].join("\n") + "\n"
}

export async function writeCsvArtifact(input: CsvArtifactInput) {
  return writeLocalArtifact({
    ...input,
    format: "csv",
    content: renderCsvArtifact(input),
  })
}

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  const text = String(value)
  if (!/[",\n\r]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}
