import { describe, expect, test } from "vitest"

import { renderCsvArtifact } from "../lib/recruiting-ops/renderers/csv"
import { renderJsonArtifact } from "../lib/recruiting-ops/renderers/json"

// REGRESSION LOCK — RENDER-payload-pii (was test/red/render-payload-pii.red.test.ts).
// (the internal control-plane excavation audit (2026-06-26), net-new high + SHADOW-MODULES-4.)
//
// The delivery-render redaction seam: rendered artifact CONTENT is produced from the
// redacted projection and then certified STRICT, so the certified object IS the
// delivered object. Person names must never appear in delivered bytes.

const NAME = "Avery Collins"

const rows: ReadonlyArray<Record<string, unknown>> = [
  { job_id: "job_1", owner: NAME, scorecard_status: "missing" },
]

const baseInput = {
  rootDir: "/unused-for-pure-render",
  workflowId: "T05",
  runId: "T05-2026-06-26T00-00-00-000Z",
  schemaVersion: "v1",
  rows,
  sourceRefs: ["greenhouse_fixture"],
  publicSummary: { normalizedRowCount: rows.length },
}

describe("RENDER-payload-pii: delivered artifact content must not leak cleartext person names", () => {
  test("renderCsvArtifact omits the person name from the delivered CSV body", () => {
    const csv = renderCsvArtifact({
      ...baseInput,
      columns: [
        { key: "job_id", label: "Job ID" },
        { key: "owner", label: "Owner" },
        { key: "scorecard_status", label: "Scorecard Status" },
      ],
    })
    expect(csv).not.toContain(NAME)
  })

  test("renderJsonArtifact omits the person name from the delivered JSON body", () => {
    const json = renderJsonArtifact({
      ...baseInput,
      generatedAt: "2026-06-26T00:00:00.000Z",
    })
    expect(json).not.toContain(NAME)
  })

  test("redacted CSV keeps non-person columns intact and marks the redacted cell in place", () => {
    const csv = renderCsvArtifact({
      ...baseInput,
      columns: [
        { key: "job_id", label: "Job ID" },
        { key: "owner", label: "Owner" },
        { key: "scorecard_status", label: "Scorecard Status" },
      ],
    })
    // Exact row: the redaction marker must land under the Owner column, not merely
    // appear somewhere in the blob.
    expect(csv.split("\n")[1]).toBe("job_1,[REDACTED],missing")
  })

  test("null original values render as empty cells, never as redaction markers", () => {
    const csv = renderCsvArtifact({
      ...baseInput,
      rows: [{ job_id: "job_2", owner: null, scorecard_status: "submitted" }],
      columns: [
        { key: "job_id", label: "Job ID" },
        { key: "owner", label: "Owner" },
        { key: "scorecard_status", label: "Scorecard Status" },
      ],
    })
    // "We hid a value" and "there was never a value" must stay distinguishable.
    expect(csv.split("\n")[1]).toBe("job_2,,submitted")
  })
})
