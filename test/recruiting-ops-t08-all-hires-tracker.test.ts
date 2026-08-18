import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  allHiresTrackerModuleDefinition,
  deriveAllHiresTrackerRows,
  runAllHiresTrackerModule,
  type AllHiresAutomationFact,
  type GreenhouseHireFact,
} from "../lib/recruiting-ops/modules/t08-all-hires-tracker"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t08-"))
  roots.push(root)
  return root
}

const hireFacts: GreenhouseHireFact[] = [
  {
    applicationId: "app_hired_1",
    jobId: "job_1",
    hiredAt: "2026-06-20T16:00:00.000Z",
    recruiterName: "Recruiter One",
  },
]

const healthyAutomationFacts: AllHiresAutomationFact[] = [
  {
    scriptId: "all_hires_script",
    scriptName: "All Hires Tracker",
    owner: "Service Owner",
    triggerStatus: "enabled",
    lastRunAt: "2026-06-24T15:00:00.000Z",
    lastSuccessAt: "2026-06-24T15:01:00.000Z",
    custodyStatus: "captured",
  },
]

describe("T08 All Hires Tracker module", () => {
  test("declares the expected workflow, artifact, and output contracts", () => {
    expect(allHiresTrackerModuleDefinition).toEqual({
      moduleId: "t08-all-hires-tracker",
      workflowId: "T08",
      capabilityId: "offer_and_hire_lifecycle_intelligence",
      title: "T08 All Hires Tracker",
      sourceIds: ["greenhouse", "google_sheets", "google_apps_script"],
      queryIds: [],
      legacyArtifactIds: ["legacy_all_hires_apps_script"],
      outputContractIds: ["all_hires_sheet"],
    })
  })

  test("derives local hire and automation health rows", () => {
    expect(
      deriveAllHiresTrackerRows({
        greenhouseHireFacts: hireFacts,
        automationFacts: healthyAutomationFacts,
      })
    ).toEqual([
      {
        row_type: "automation_health",
        entity_id: "all_hires_script",
        status: "enabled",
        event_date: "2026-06-24T15:01:00.000Z",
        owner: "Service Owner",
        source_system: "google_apps_script",
        custody_status: "captured",
        review_required: false,
      },
      {
        row_type: "hire_event",
        entity_id: "app_hired_1",
        status: "hired",
        event_date: "2026-06-20T16:00:00.000Z",
        owner: "Recruiter One",
        source_system: "greenhouse",
        custody_status: "not_applicable",
        review_required: false,
      },
    ])
  })

  test("runs locally and writes All Hires monitor JSON/CSV artifacts", async () => {
    const result = await runAllHiresTrackerModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T23:56:00.000Z",
      generatedAt: "2026-06-24T23:57:00.000Z",
      greenhouseHireFacts: hireFacts,
      automationFacts: healthyAutomationFacts,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(2)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Row type,Entity ID,Status,Event date,Owner,Source system,Custody status,Review required"
    )
  })

  test("classifies legacy All Hires evidence differences", async () => {
    const result = await runAllHiresTrackerModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T23:58:00.000Z",
      generatedAt: "2026-06-24T23:59:00.000Z",
      greenhouseHireFacts: hireFacts,
      automationFacts: healthyAutomationFacts,
      legacyRows: [
        {
          entity_id: "app_hired_1",
          status: "pending",
          event_date: "2026-06-19T16:00:00.000Z",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "stale_mapping",
    ])
  })

  test("records null owner gaps for hire and automation rows without blocking cutover", async () => {
    const result = await runAllHiresTrackerModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T23:59:10.000Z",
      generatedAt: "2026-06-24T23:59:20.000Z",
      greenhouseHireFacts: [{ ...hireFacts[0], recruiterName: "   " }],
      automationFacts: [{ ...healthyAutomationFacts[0], owner: "   " }],
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows.map((row) => [row.row_type, row.owner])).toEqual([
      ["automation_health", null],
      ["hire_event", null],
    ])
    expect(result.sourceGaps.map((gap) => [gap.field, gap.blocksCutover]).sort()).toEqual([
      ["owner", false],
      ["owner", false],
    ])
    expect(result.discrepancies.map((discrepancy) => discrepancy.severity)).toEqual(["warning", "warning"])
  })

  test("blocks cutover when Apps Script custody or trigger evidence is missing", async () => {
    const noAutomation = await runAllHiresTrackerModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:00:00.000Z",
      generatedAt: "2026-06-25T00:01:00.000Z",
      greenhouseHireFacts: hireFacts,
      automationFacts: [],
    })
    const riskyAutomation = await runAllHiresTrackerModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:02:00.000Z",
      generatedAt: "2026-06-25T00:03:00.000Z",
      greenhouseHireFacts: hireFacts,
      automationFacts: [
        {
          ...healthyAutomationFacts[0],
          triggerStatus: "enabled",
          custodyStatus: "credential_reissue_required",
        },
      ],
    })

    expect(noAutomation.run.status).toBe("blocked")
    expect(noAutomation.run.discrepancySummary.byClass.source_gap).toBe(1)
    expect(riskyAutomation.run.status).toBe("blocked")
    expect(riskyAutomation.sourceGaps[0]).toMatchObject({
      field: "custodyStatus",
      blocksCutover: true,
    })
  })
})
