import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  normalizeRpsRows,
  normalizeRpsStage,
  normalizeScorecardStatus,
  rpsModuleDefinition,
  runRpsModule,
  type GreenhouseRpsFact,
} from "../lib/recruiting-ops/modules/t05-rps"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t05-"))
  roots.push(root)
  return root
}

const completeFacts: GreenhouseRpsFact[] = [
  {
    applicationId: "app_5",
    jobId: "job_5",
    interviewId: "interview_5",
    stageName: "Recruiter Phone Screen",
    scheduledAt: "2026-06-17T17:00:00.000Z",
    scorecardStatus: "submitted",
    // "Avery Collins" is in the recruiter→team fixture config; submitter == interviewer => match.
    interviewerName: "Avery Collins",
    submitterName: "Avery Collins",
    overallRecommendation: "strong_yes",
  },
]

describe("T05 RPS module", () => {
  test("declares the expected workflow, source, query, artifact, and output contracts", () => {
    expect(rpsModuleDefinition).toEqual({
      moduleId: "t05-rps",
      workflowId: "T05",
      capabilityId: "scorecard_accountability",
      title: "T05 RPS / scorecard accountability",
      sourceIds: ["greenhouse", "looker_sql_runner", "google_sheets"],
      queryIds: ["Q11"],
      legacyArtifactIds: ["legacy_q11_rps_tracking"],
      outputContractIds: ["rps_tracking_sheet"],
    })
  })

  test("normalizes Greenhouse-style interview and scorecard facts", () => {
    expect(normalizeRpsStage("RPS")).toBe("rps")
    expect(normalizeRpsStage("Technical Interview")).toBe("technical")
    expect(normalizeRpsStage("On-site")).toBe("onsite")
    expect(normalizeRpsStage("Custom Stage")).toBe("unknown")
    expect(normalizeScorecardStatus("complete")).toBe("submitted")
    expect(normalizeScorecardStatus("not submitted")).toBe("missing")
    expect(normalizeScorecardStatus("strange")).toBe("unknown")

    expect(normalizeRpsRows(completeFacts)).toEqual([
      {
        application_id: "app_5",
        job_id: "job_5",
        interview_id: "interview_5",
        interview_stage: "rps",
        scorecard_status: "submitted",
        week_bucket: "2026-06-15",
        interviewer_name: "Avery Collins",
        submitter_name: "Avery Collins",
        team_name: "Team Avery",
        match_mismatch: "match",
        overall_recommendation: "strong_yes",
      },
    ])
  })

  test("runs locally and writes JSON/CSV artifacts without external access", async () => {
    const result = await runRpsModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T11:00:00.000Z",
      generatedAt: "2026-06-24T11:01:00.000Z",
      greenhouseFacts: completeFacts,
      legacyRows: [
        {
          application_id: "app_5",
          interview_stage: "phone screen",
          scorecard_status: "submitted",
          week_bucket: "2026-06-15",
        },
      ],
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(1)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "json")!.path, "utf8")).toContain(
      "\"scorecard_status\":\"submitted\""
    )
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Application ID,Job ID,Interview ID,Interview stage,Scorecard status,Week,Interviewer"
    )
  })

  test("classifies legacy Q11 differences as evidence review items", async () => {
    const result = await runRpsModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T12:00:00.000Z",
      generatedAt: "2026-06-24T12:01:00.000Z",
      greenhouseFacts: completeFacts,
      legacyRows: [
        {
          application_id: "app_5",
          interview_stage: "technical",
          scorecard_status: "missing",
          week_bucket: "2026-06-08",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "business_definition_open",
      "stale_mapping",
    ])
    expect(result.run.discrepancySummary.byClass.business_definition_open).toBe(2)
    expect(result.run.discrepancySummary.byClass.stale_mapping).toBe(1)
  })

  test("blocks cutover when interview taxonomy or scorecard status mapping is open", async () => {
    const result = await runRpsModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T13:00:00.000Z",
      generatedAt: "2026-06-24T13:01:00.000Z",
      greenhouseFacts: [
        {
          ...completeFacts[0],
          stageName: "Custom Stage",
          scorecardStatus: "strange",
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.sourceGaps.filter((gap) => gap.blocksCutover)).toHaveLength(2)
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(2)
  })

  test("drops malformed required identity facts instead of emitting unknown grouping keys", async () => {
    const result = await runRpsModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T13:15:00.000Z",
      generatedAt: "2026-06-24T13:16:00.000Z",
      greenhouseFacts: [
        {
          applicationId: "unknown",
          jobId: "",
          interviewId: "unknown",
          stageName: "Recruiter Phone Screen",
          scheduledAt: "unknown",
          scorecardStatus: "submitted",
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.normalizedRows).toEqual([])
    expect(result.sourceGaps.map((gap) => gap.field).sort()).toEqual([
      "application_id",
      "interview_id",
      "job_id",
      "scheduled_at",
    ])
    expect(JSON.stringify(result.normalizedRows)).not.toContain("unknown")
  })
})
