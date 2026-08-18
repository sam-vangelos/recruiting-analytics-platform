import { describe, expect, test, vi } from "vitest"

// REGRESSION LOCK — the CERTIFY half of the renderers' redact-then-certify seam.
// The seam is belt-and-suspenders: redaction produces the delivered rows, and
// assertPublicSafe over those exact rows guards against redactor/inspector divergence.
// This test defeats redaction on purpose and proves the certification still refuses
// to render leaking bytes — deleting the assert call in either renderer must fail here.
vi.mock("../lib/recruiting-ops/safe-public-output", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/recruiting-ops/safe-public-output")>()
  return {
    ...actual,
    // Neutered redactor: passes person names straight through.
    redactForPublicValue: (value: unknown) => value,
  }
})

import { renderCsvArtifact } from "../lib/recruiting-ops/renderers/csv"
import { renderJsonArtifact } from "../lib/recruiting-ops/renderers/json"

const rows: ReadonlyArray<Record<string, unknown>> = [
  { job_id: "job_1", owner: "Avery Collins", scorecard_status: "missing" },
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

describe("render certify belt: certification refuses leaking bytes even when redaction fails", () => {
  test("renderCsvArtifact throws when redaction is defeated", () => {
    expect(() =>
      renderCsvArtifact({
        ...baseInput,
        columns: [
          { key: "job_id", label: "Job ID" },
          { key: "owner", label: "Owner" },
          { key: "scorecard_status", label: "Scorecard Status" },
        ],
      })
    ).toThrow("not public-safe")
  })

  test("renderJsonArtifact throws when redaction is defeated", () => {
    expect(() =>
      renderJsonArtifact({
        ...baseInput,
        generatedAt: "2026-06-26T00:00:00.000Z",
      })
    ).toThrow("not public-safe")
  })
})
