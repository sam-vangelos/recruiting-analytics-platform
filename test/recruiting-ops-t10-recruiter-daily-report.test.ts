import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  deriveRecruiterDailyResumeGateRow,
  recruiterDailyDailyReportModuleDefinition,
  runRecruiterDailyDailyReportModule,
} from "../lib/recruiting-ops/modules/t10-recruiter-daily-report"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t10-"))
  roots.push(root)
  return root
}

describe("T10 recruiter daily dormant report module", () => {
  test("declares the expected workflow, query, artifact, and output contracts", () => {
    expect(recruiterDailyDailyReportModuleDefinition).toEqual({
      moduleId: "t10-recruiter-daily-report",
      workflowId: "T10",
      capabilityId: "automation_custody",
      title: "T10 Recruiter Daily Report",
      sourceIds: ["looker_sql_runner", "google_sheets", "google_apps_script"],
      queryIds: ["Q15"],
      legacyArtifactIds: ["legacy_q15_recruiter_daily_report"],
      outputContractIds: ["recruiter_daily_sheet"],
    })
  })

  test("keeps the dormant report blocked by default while preserving the template state", () => {
    expect(
      deriveRecruiterDailyResumeGateRow({
        lastRunDate: "2026-05-01T12:00:00.000Z",
        templatePreserved: true,
        resumeRequested: false,
      })
    ).toEqual({
      gate_id: "recruiter_daily_resume_gate",
      status: "dormant",
      last_run_date: "2026-05-01",
      template_preserved: true,
      resume_requested: false,
      reason: "T10 is marked Stop/dormant; preserve Q15 and template but do not execute.",
      next_gate: "Ask the operator for explicit resume approval and current consumer before any run.",
    })
  })

  test("runs locally and writes a resume-gate artifact", async () => {
    const result = await runRecruiterDailyDailyReportModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:04:00.000Z",
      generatedAt: "2026-06-25T00:05:00.000Z",
      lastRunDate: "2026-05-01T12:00:00.000Z",
      templatePreserved: true,
      resumeRequested: false,
    })

    expect(result.run.status).toBe("blocked")
    expect(result.normalizedRows[0].status).toBe("dormant")
    expect(result.run.discrepancySummary.byClass.intentional_modernization).toBe(1)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Gate ID,Status,Last run date,Template preserved,Resume requested,Reason,Next gate"
    )
  })

  test("allows ready-for-review only after explicit resume and template preservation", async () => {
    const result = await runRecruiterDailyDailyReportModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:06:00.000Z",
      generatedAt: "2026-06-25T00:07:00.000Z",
      lastRunDate: "2026-05-01",
      templatePreserved: true,
      resumeRequested: true,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows[0]).toMatchObject({
      status: "ready_for_review",
      resume_requested: true,
      template_preserved: true,
    })
    expect(result.discrepancies).toHaveLength(0)
  })

  test("classifies legacy gate differences without reviving the report", async () => {
    const result = await runRecruiterDailyDailyReportModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:08:00.000Z",
      generatedAt: "2026-06-25T00:09:00.000Z",
      lastRunDate: "2026-05-01",
      templatePreserved: true,
      resumeRequested: true,
      legacyRows: [
        {
          gate_id: "recruiter_daily_resume_gate",
          status: "dormant",
          last_run_date: "2026-04-01",
        },
      ],
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "intentional_modernization",
      "stale_mapping",
    ])
  })

  test("blocks resume when the template has not been preserved", async () => {
    const result = await runRecruiterDailyDailyReportModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:10:00.000Z",
      generatedAt: "2026-06-25T00:11:00.000Z",
      templatePreserved: false,
      resumeRequested: true,
    })

    expect(result.run.status).toBe("blocked")
    expect(result.normalizedRows[0]).toMatchObject({
      status: "resume_requested",
      template_preserved: false,
    })
    expect(result.sourceGaps[0]).toMatchObject({
      field: "template_preserved",
      blocksCutover: true,
    })
  })
})
