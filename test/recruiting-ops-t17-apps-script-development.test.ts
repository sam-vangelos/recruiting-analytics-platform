import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  appsScriptDevelopmentModuleDefinition,
  normalizeAppsScriptAssetRegistryRows,
  normalizeAppsScriptCredentialPosture,
  normalizeAppsScriptExportStatus,
  runAppsScriptDevelopmentModule,
  type AppsScriptAssetCustodyFact,
} from "../lib/recruiting-ops/modules/t17-apps-script-development"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t17-"))
  roots.push(root)
  return root
}

const assetFacts: AppsScriptAssetCustodyFact[] = [
  {
    assetId: "weekly_recruitment_apps_script",
    workflowId: "T01",
    projectName: "Weekly Recruitment Report",
    exportStatus: "exported",
    triggerStatus: "documented",
    scopeStatus: "reviewed",
    credentialPosture: "service_owned",
    owner: "Jordan",
    capturedAt: "2026-06-25T02:00:00.000Z",
  },
  {
    assetId: "role_pipeline_apps_script",
    workflowId: "T02",
    projectName: "Role Pipeline Reports",
    exportStatus: "exported",
    triggerStatus: "documented",
    scopeStatus: "reviewed",
    credentialPosture: "service_owned",
    owner: "Jordan",
    capturedAt: "2026-06-25T02:01:00.000Z",
  },
  {
    assetId: "all_hires_apps_script",
    workflowId: "T08",
    projectName: "All Hires Tracker",
    exportStatus: "exported",
    triggerStatus: "documented",
    scopeStatus: "reviewed",
    credentialPosture: "service_owned",
    owner: "Jordan",
    capturedAt: "2026-06-25T02:02:00.000Z",
  },
  {
    assetId: "recruiter_daily_apps_script",
    workflowId: "T10",
    projectName: "Recruiter Daily Report Control",
    exportStatus: "reference_only",
    triggerStatus: "disabled",
    scopeStatus: "not_applicable",
    credentialPosture: "not_secret_bearing",
    owner: "Jordan",
    capturedAt: "2026-06-25T02:03:00.000Z",
  },
]

describe("T17 Apps Script development module", () => {
  test("declares the expected workflow, artifact, and output contracts", () => {
    expect(appsScriptDevelopmentModuleDefinition).toEqual({
      moduleId: "t17-apps-script-development",
      workflowId: "T17",
      capabilityId: "automation_custody",
      title: "T17 Apps Script Development",
      sourceIds: ["google_apps_script", "google_sheets"],
      queryIds: [],
      legacyArtifactIds: ["legacy_apps_script_asset_registry"],
      outputContractIds: ["apps_script_asset_registry"],
    })
  })

  test("normalizes Apps Script asset custody rows from registered assets", () => {
    const rows = normalizeAppsScriptAssetRegistryRows({ assetFacts })
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({
      asset_id: "all_hires_apps_script",
      workflow_id: "T08",
      export_status: "captured",
      trigger_status: "captured",
      scope_status: "captured",
      custody_posture: "service_owned",
      review_required: false,
    })
    expect(rows[3]).toMatchObject({
      asset_id: "weekly_recruitment_apps_script",
      workflow_id: "T01",
      review_required: false,
    })
  })

  test("normalizes common Apps Script custody labels", () => {
    expect(normalizeAppsScriptExportStatus("needs export")).toBe("export_required")
    expect(normalizeAppsScriptExportStatus("dormant reference")).toBe("reference_only")
    expect(normalizeAppsScriptCredentialPosture("departing owner")).toBe("personal_or_departing_risk")
    expect(normalizeAppsScriptCredentialPosture("service identity")).toBe("service_owned")
  })

  test("runs locally and writes Apps Script registry JSON/CSV artifacts", async () => {
    const result = await runAppsScriptDevelopmentModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T02:10:00.000Z",
      generatedAt: "2026-06-25T02:11:00.000Z",
      assetFacts,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(4)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Asset ID,Workflow ID,Project name,Export status,Trigger status,Scope status,Custody posture,Owner,Captured at,Rotation required,Review required,Blocker reason"
    )
  })

  test("flags a secret-bearing credential for rotation and blocks preserve/export", async () => {
    const result = await runAppsScriptDevelopmentModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T02:20:00.000Z",
      generatedAt: "2026-06-25T02:21:00.000Z",
      // The all-hires Apps Script ships a cleartext OAuth secret under a departing owner.
      assetFacts: [{ ...assetFacts[2], credentialPosture: "departing owner" }],
    })

    const row = result.normalizedRows.find((item) => item.asset_id === "all_hires_apps_script")!
    expect(row.rotation_required).toBe(true)
    expect(row.blocker_reason).toContain("rotated to a service identity")
    expect(result.run.status).toBe("blocked")
    expect(
      result.sourceGaps.some((gap) => gap.field === "credential_rotation" && gap.blocksCutover)
    ).toBe(true)
  })

  test("classifies legacy Apps Script custody differences", async () => {
    const result = await runAppsScriptDevelopmentModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T02:12:00.000Z",
      generatedAt: "2026-06-25T02:13:00.000Z",
      assetFacts,
      legacyRows: [
        {
          asset_id: "weekly_recruitment_apps_script",
          export_status: "export_required",
          scope_status: "redaction_required",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "stale_mapping",
    ])
  })

  test("blocks cutover when registered assets or safe custody evidence are missing", async () => {
    const result = await runAppsScriptDevelopmentModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T02:14:00.000Z",
      generatedAt: "2026-06-25T02:15:00.000Z",
      assetFacts: [
        {
          ...assetFacts[0],
          exportStatus: "needs export",
          triggerStatus: "owner required",
          scopeStatus: "rotation required",
          credentialPosture: "departing owner",
          owner: "",
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.sourceGaps.some((gap) => gap.id === "gap_t17_registered_asset_role_pipeline_apps_script")).toBe(true)
    expect(result.sourceGaps.some((gap) => gap.reason.includes("credential ownership remains unsafe"))).toBe(true)
    expect(result.run.discrepancySummary.byClass.source_gap).toBeGreaterThan(4)
  })
})
