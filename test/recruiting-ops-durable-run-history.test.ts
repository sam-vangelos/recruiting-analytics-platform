import { describe, expect, test } from "vitest"

import { mapDurableRunRow } from "../lib/recruiting-ops/durable-run-history"

describe("durable run history projection", () => {
  test("maps a runs-table row into the public-safe console shape", () => {
    const row = {
      run_id: "t02_20260702234533227",
      workflow_id: "T02",
      capability_id: "pipeline_movement_intelligence",
      mode: "local",
      status: "succeeded",
      started_at: "2026-07-02T23:45:33.227Z",
      normalized_row_count: 7702,
      public_summary: {
        workflowId: "T02",
        sourceGapCount: 0,
        discrepancyCount: 0,
      },
    }
    expect(mapDurableRunRow(row)).toEqual({
      runId: "t02_20260702234533227",
      workflowId: "T02",
      capabilityId: "pipeline_movement_intelligence",
      mode: "local",
      status: "succeeded",
      startedAt: "2026-07-02T23:45:33.227Z",
      normalizedRowCount: 7702,
      sourceGapCount: 0,
      discrepancyCount: 0,
    })
  })

  test("missing summary counts project as zero, never NaN", () => {
    const mapped = mapDurableRunRow({
      run_id: "r",
      workflow_id: "T07",
      capability_id: "c",
      mode: "shadow",
      status: "blocked",
      started_at: "2026-07-02T00:00:00.000Z",
      normalized_row_count: 3,
      public_summary: null,
    })
    expect(mapped.sourceGapCount).toBe(0)
    expect(mapped.discrepancyCount).toBe(0)
  })
})
