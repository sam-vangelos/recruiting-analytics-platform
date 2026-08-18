import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  normalizePowerBiDashboardRows,
  normalizePowerBiRefreshStatus,
  powerBiDashboardMonitoringModuleDefinition,
  runPowerBiDashboardMonitoringModule,
  type PowerBiDashboardFact,
} from "../lib/recruiting-ops/modules/t13-power-bi-dashboard-monitoring"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t13-"))
  roots.push(root)
  return root
}

const dashboardFacts: PowerBiDashboardFact[] = [
  {
    dashboardId: "pbi_1",
    dashboardTitle: "Recruiting Overview",
    workspaceName: "TA Ops",
    refreshStatus: "Succeeded",
    lastRefreshAt: "2026-06-24T12:00:00.000Z",
    owner: "Owner One",
  },
  {
    dashboardId: "pbi_2",
    dashboardTitle: "RLS Review",
    workspaceName: "TA Ops",
    refreshStatus: "Failed",
    lastRefreshAt: "2026-06-23T12:00:00.000Z",
    owner: "Owner Two",
  },
]

describe("T13 Power BI dashboard monitoring module", () => {
  test("declares the expected workflow, artifact, and output contracts", () => {
    expect(powerBiDashboardMonitoringModuleDefinition).toEqual({
      moduleId: "t13-power-bi-dashboard-monitoring",
      workflowId: "T13",
      capabilityId: "external_artifact_monitoring",
      title: "T13 Power BI Dashboard Monitoring",
      sourceIds: ["power_bi"],
      queryIds: [],
      legacyArtifactIds: ["legacy_power_bi_dashboard_registry"],
      outputContractIds: ["power_bi_dashboard_alerts"],
    })
  })

  test("normalizes dashboard refresh facts into alert triage rows", () => {
    expect(normalizePowerBiRefreshStatus("healthy")).toBe("succeeded")
    expect(normalizePowerBiRefreshStatus("error")).toBe("failed")
    expect(normalizePowerBiRefreshStatus("late")).toBe("stale")
    expect(normalizePowerBiRefreshStatus("custom")).toBe("unknown")

    expect(normalizePowerBiDashboardRows(dashboardFacts)).toEqual([
      {
        dashboard_id: "pbi_1",
        dashboard_title: "Recruiting Overview",
        workspace_name: "TA Ops",
        refresh_status: "succeeded",
        last_refresh_at: "2026-06-24T12:00:00.000Z",
        owner: "Owner One",
        alert_severity: "none",
        triage_required: false,
      },
      {
        dashboard_id: "pbi_2",
        dashboard_title: "RLS Review",
        workspace_name: "TA Ops",
        refresh_status: "failed",
        last_refresh_at: "2026-06-23T12:00:00.000Z",
        owner: "Owner Two",
        alert_severity: "critical",
        triage_required: true,
      },
    ])
  })

  test("runs locally and writes dashboard alert JSON/CSV artifacts", async () => {
    const result = await runPowerBiDashboardMonitoringModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:20:00.000Z",
      generatedAt: "2026-06-25T00:21:00.000Z",
      dashboardFacts,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(2)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Dashboard ID,Dashboard title,Workspace,Refresh status,Last refresh at,Owner,Alert severity,Triage required"
    )
  })

  test("classifies legacy Power BI alert differences", async () => {
    const result = await runPowerBiDashboardMonitoringModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:22:00.000Z",
      generatedAt: "2026-06-25T00:23:00.000Z",
      dashboardFacts,
      legacyRows: [
        {
          dashboard_id: "pbi_2",
          refresh_status: "succeeded",
          alert_severity: "none",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "stale_mapping",
    ])
  })

  test("blocks cutover when inventory is missing or refresh status taxonomy is open", async () => {
    const missingInventory = await runPowerBiDashboardMonitoringModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:24:00.000Z",
      generatedAt: "2026-06-25T00:25:00.000Z",
      dashboardFacts: [],
    })
    const unknownStatus = await runPowerBiDashboardMonitoringModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:26:00.000Z",
      generatedAt: "2026-06-25T00:27:00.000Z",
      dashboardFacts: [
        {
          dashboardId: "pbi_unknown",
          dashboardTitle: "Unknown Dashboard",
          workspaceName: "TA Ops",
          refreshStatus: "custom",
        },
      ],
    })

    expect(missingInventory.run.status).toBe("blocked")
    expect(missingInventory.run.discrepancySummary.byClass.source_gap).toBe(1)
    expect(unknownStatus.run.status).toBe("blocked")
    expect(unknownStatus.sourceGaps.map((gap) => gap.field).sort()).toEqual(["owner", "refresh_status"])
  })
})
