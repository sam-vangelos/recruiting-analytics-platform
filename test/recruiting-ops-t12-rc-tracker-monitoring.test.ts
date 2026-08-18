import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  normalizeRcStatus,
  normalizeRcTrackerRows,
  rcTrackerMonitoringModuleDefinition,
  runRcTrackerMonitoringModule,
  type RcTrackerSourceRow,
} from "../lib/recruiting-ops/modules/t12-rc-tracker-monitoring"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t12-"))
  roots.push(root)
  return root
}

const sourceRows: RcTrackerSourceRow[] = [
  {
    rcId: "rc_1",
    status: "On Track",
    owner: "Owner One",
    lastUpdatedAt: "2026-06-24T12:00:00.000Z",
  },
  {
    rcId: "rc_2",
    status: "Blocked",
    owner: "Owner Two",
    lastUpdatedAt: "2026-06-24T13:00:00.000Z",
    exceptionReason: "Awaiting owner response.",
  },
]

describe("T12 RC Tracker monitoring module", () => {
  test("declares the expected workflow, artifact, and output contracts", () => {
    expect(rcTrackerMonitoringModuleDefinition).toEqual({
      moduleId: "t12-rc-tracker-monitoring",
      workflowId: "T12",
      capabilityId: "external_artifact_monitoring",
      title: "T12 RC Tracker Monitoring",
      sourceIds: ["google_sheets"],
      queryIds: [],
      legacyArtifactIds: ["legacy_rc_tracker_sheet"],
      outputContractIds: ["rc_tracker_sheet"],
    })
  })

  test("normalizes tracker rows into exception and follow-up flags", () => {
    expect(normalizeRcStatus("healthy")).toBe("on_track")
    expect(normalizeRcStatus("watch")).toBe("at_risk")
    expect(normalizeRcStatus("stuck")).toBe("blocked")
    expect(normalizeRcStatus("custom")).toBe("unknown")

    expect(normalizeRcTrackerRows(sourceRows)).toEqual([
      {
        rc_id: "rc_1",
        status: "on_track",
        owner: "Owner One",
        last_updated_at: "2026-06-24T12:00:00.000Z",
        exception_flag: false,
        exception_reason: "",
        follow_up_required: false,
      },
      {
        rc_id: "rc_2",
        status: "blocked",
        owner: "Owner Two",
        last_updated_at: "2026-06-24T13:00:00.000Z",
        exception_flag: true,
        exception_reason: "Awaiting owner response.",
        follow_up_required: true,
      },
    ])
  })

  test("runs locally and writes RC monitor JSON/CSV artifacts", async () => {
    const result = await runRcTrackerMonitoringModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:12:00.000Z",
      generatedAt: "2026-06-25T00:13:00.000Z",
      sourceRows,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(2)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "RC ID,Status,Owner,Last updated at,Exception flag,Exception reason,Follow-up required"
    )
  })

  test("classifies legacy RC tracker differences", async () => {
    const result = await runRcTrackerMonitoringModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:14:00.000Z",
      generatedAt: "2026-06-25T00:15:00.000Z",
      sourceRows,
      legacyRows: [
        {
          rc_id: "rc_2",
          status: "on track",
          exception_flag: false,
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "stale_mapping",
    ])
  })

  test("blocks cutover when source rows are missing or status taxonomy is open", async () => {
    const missingRows = await runRcTrackerMonitoringModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:16:00.000Z",
      generatedAt: "2026-06-25T00:17:00.000Z",
      sourceRows: [],
    })
    const unknownStatus = await runRcTrackerMonitoringModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:18:00.000Z",
      generatedAt: "2026-06-25T00:19:00.000Z",
      sourceRows: [
        {
          rcId: "rc_unknown",
          status: "custom",
          lastUpdatedAt: "2026-06-24T12:00:00.000Z",
        },
      ],
    })

    expect(missingRows.run.status).toBe("blocked")
    expect(missingRows.run.discrepancySummary.byClass.source_gap).toBe(1)
    expect(unknownStatus.run.status).toBe("blocked")
    expect(unknownStatus.sourceGaps.map((gap) => gap.field).sort()).toEqual(["owner", "status"])
  })
})
