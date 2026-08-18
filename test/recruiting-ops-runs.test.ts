import { describe, expect, test } from "vitest"

import { buildDiscrepancy } from "../lib/recruiting-ops/discrepancies"
import {
  buildCommandCenterRun,
  buildRunArtifact,
  buildRunId,
  summarizeRunForPublic,
  validateCommandCenterRun,
} from "../lib/recruiting-ops/runs"

const sourceRefs = [
  {
    id: "greenhouse_fixture_t07",
    sourceId: "greenhouse",
    adapter: "greenhouse_v3_read",
    label: "Greenhouse fixture for T07",
  },
] as const

describe("recruiting ops run and evidence ledger", () => {
  test("builds deterministic run ids", () => {
    expect(buildRunId("T07", "2026-06-24T07:00:00.000Z")).toBe("t07_20260624070000000")
  })

  test("builds local run artifacts and run ledgers", () => {
    const startedAt = "2026-06-24T07:00:00.000Z"
    const runId = buildRunId("T07", startedAt)
    const artifact = buildRunArtifact({
      artifactId: "artifact_t07_json",
      runId,
      workflowId: "T07",
      format: "json",
      path: ".recruiting-ops-artifacts/t07/run.json",
      rowCount: 1,
      schemaVersion: "1.0.0",
      sourceRefs: ["greenhouse_fixture_t07"],
      publicSummary: { workflowId: "T07", rowCount: 1 },
      rows: [{ application_id: "app_1", offer_status: "created" }],
    })
    const discrepancy = buildDiscrepancy({
      runId,
      capabilityId: "offer_and_hire_lifecycle_intelligence",
      workflowId: "T07",
      class: "source_gap",
      severity: "warning",
      entityKey: "application:app_1",
      field: "team_mapping",
      modernValueSummary: "mapping open",
      legacyValueSummary: "legacy artifact contains team label",
      evidenceRefs: ["legacy_q12_final_offer"],
      resolutionStatus: "open",
      owner: "Jordan",
    })
    const run = buildCommandCenterRun({
      workflowId: "T07",
      capabilityId: "offer_and_hire_lifecycle_intelligence",
      moduleId: "t07-final-offer",
      mode: "fixture",
      status: "succeeded",
      startedAt,
      completedAt: "2026-06-24T07:01:00.000Z",
      sourceRefs,
      legacyArtifactRefs: ["legacy_q12_final_offer"],
      normalizedRows: [{ application_id: "app_1", offer_status: "created" }],
      artifactRefs: [artifact],
      sourceGaps: [
        {
          id: "gap_t07_team_mapping",
          workflowId: "T07",
          sourceId: "greenhouse",
          field: "team_mapping",
          reason: "mapping registry not confirmed",
          blocksCutover: true,
        },
      ],
      discrepancies: [discrepancy],
      publicSummary: { workflowId: "T07", normalizedRowCount: 1 },
    })

    expect(validateCommandCenterRun(run).ok).toBe(true)
    expect(run.discrepancySummary.byClass.source_gap).toBe(1)
    expect(summarizeRunForPublic(run)).toMatchObject({
      workflowId: "T07",
      mode: "fixture",
      normalizedRowCount: 1,
      artifactCount: 1,
      sourceGapCount: 1,
    })
  })

  test("rejects public-unsafe run summaries", () => {
    expect(() =>
      buildCommandCenterRun({
        workflowId: "T07",
        capabilityId: "offer_and_hire_lifecycle_intelligence",
        moduleId: "t07-final-offer",
        mode: "fixture",
        status: "succeeded",
        startedAt: "2026-06-24T07:00:00.000Z",
        sourceRefs,
        legacyArtifactRefs: [],
        normalizedRows: [],
        artifactRefs: [],
        sourceGaps: [],
        discrepancies: [],
        publicSummary: { candidate_email: "person@example.com" },
      })
    ).toThrow("not public-safe")
  })
})
