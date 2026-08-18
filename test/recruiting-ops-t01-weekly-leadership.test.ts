import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  deriveWeeklyLeadershipRows,
  runWeeklyLeadershipModule,
  weeklyLeadershipModuleDefinition,
} from "../lib/recruiting-ops/modules/t01-weekly-leadership"
import type { PipelineStageRow } from "../lib/recruiting-ops/modules/t02-pipeline"
import type { RpsRow } from "../lib/recruiting-ops/modules/t05-rps"
import type { FinalOfferRow } from "../lib/recruiting-ops/modules/t07-final-offer"
import type { OwnershipRow } from "../lib/recruiting-ops/modules/t09-ownership"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t01-"))
  roots.push(root)
  return root
}

const pipelineRows: PipelineStageRow[] = [
  {
    application_id: "app_1",
    job_id: "job_1",
    req_id: "890",
    stage_name: "application_review",
    core_stage: "Application Review",
    core_stage_order: 1,
    stage_changed_at: "2026-06-18T10:00:00.000Z",
    week_bucket: "2026-06-15",
    dedupe_key: "app_1|job_1|890|application_review|2026-06-15",
  },
  {
    application_id: "app_2",
    job_id: "job_1",
    req_id: "890",
    stage_name: "recruiter_screen",
    core_stage: "Recruiter Phone Screen",
    core_stage_order: 3,
    stage_changed_at: "2026-06-19T10:00:00.000Z",
    week_bucket: "2026-06-15",
    dedupe_key: "app_2|job_1|890|recruiter_screen|2026-06-15",
  },
]

const finalOfferRows: FinalOfferRow[] = [
  {
    application_id: "app_3",
    job_id: "job_1",
    offer_id: "offer_1",
    offer_status: "accepted",
    month_bucket: "2026-06",
    recruiter_name: "Recruiter One",
    sourcer_name: "Sourcer One",
    team_name: "Engineering",
    hod_name: "HOD One",
  },
]

const rpsRows: RpsRow[] = [
  {
    application_id: "app_2",
    job_id: "job_1",
    interview_id: "interview_1",
    interview_stage: "rps",
    scorecard_status: "missing",
    week_bucket: "2026-06-15",
    interviewer_name: "Interviewer One",
    submitter_name: "Interviewer One",
    team_name: null,
    match_mismatch: "match",
    overall_recommendation: null,
  },
]

const ownershipRows: OwnershipRow[] = [
  {
    view_type: "job",
    job_id: "job_1",
    recruiter_name: "Recruiter One",
    sourcer_name: "Sourcer One",
    pod_name: "Pod A",
    openings_count: 2,
    workload_count: 2,
  },
]

describe("T01 weekly leadership rollup module", () => {
  test("declares the expected workflow, query, artifact, and output contracts", () => {
    expect(weeklyLeadershipModuleDefinition).toEqual({
      moduleId: "t01-weekly-leadership",
      workflowId: "T01",
      capabilityId: "structured_hiring_status",
      title: "T01 weekly leadership rollup",
      sourceIds: ["greenhouse", "looker_sql_runner", "google_sheets", "google_apps_script"],
      queryIds: ["Q01", "Q02", "Q03"],
      legacyArtifactIds: ["legacy_q01_q03_weekly_recruitment"],
      outputContractIds: ["weekly_recruitment_sheet"],
    })
  })

  test("composes leadership rows from prior module facts", () => {
    expect(
      deriveWeeklyLeadershipRows({
        weekBucket: "2026-06-15",
        finalOfferRows,
        rpsRows,
        pipelineRows,
        ownershipRows,
      })
    ).toEqual([
      {
        job_id: "job_1",
        req_status: "active",
        pipeline_count: 2,
        offer_count: 1,
        rps_missing_count: 1,
        openings_count: 2,
        recruiter_name: "Recruiter One",
        week_bucket: "2026-06-15",
        billable: null,
        priority: null,
        role_type: null,
        job_health: null,
        job_progress: null,
        comments: null,
      },
    ])
  })

  test("carries human-owned manual leadership fields when supplied, null otherwise", () => {
    const [row] = deriveWeeklyLeadershipRows({
      weekBucket: "2026-06-15",
      finalOfferRows,
      rpsRows,
      pipelineRows,
      ownershipRows,
      manualFields: [
        { job_id: "job_1", billable: "Billable", priority: "P0", job_health: "Green", job_progress: "On track" },
      ],
    })
    expect(row.billable).toBe("Billable")
    expect(row.priority).toBe("P0")
    expect(row.job_health).toBe("Green")
    expect(row.job_progress).toBe("On track")
    // Unsupplied manual fields stay null — the rollup never invents leadership judgment.
    expect(row.role_type).toBeNull()
    expect(row.comments).toBeNull()
  })

  test("runs locally and writes leadership-safe JSON/CSV artifacts", async () => {
    const result = await runWeeklyLeadershipModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T21:00:00.000Z",
      generatedAt: "2026-06-24T21:01:00.000Z",
      weekBucket: "2026-06-15",
      finalOfferRows,
      rpsRows,
      pipelineRows,
      ownershipRows,
      legacyRows: [
        {
          job_id: "job_1",
          pipeline_count: 2,
          offer_count: 1,
          week_bucket: "2026-06-15",
        },
      ],
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(1)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Job ID,Req status,Pipeline count,Offer count,RPS missing count,Openings,Recruiter,Week"
    )
  })

  test("classifies Q01-Q03 differences as evidence review items", async () => {
    const result = await runWeeklyLeadershipModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T22:00:00.000Z",
      generatedAt: "2026-06-24T22:01:00.000Z",
      weekBucket: "2026-06-15",
      finalOfferRows,
      rpsRows,
      pipelineRows,
      ownershipRows,
      legacyRows: [
        {
          job_id: "job_1",
          pipeline_count: 1,
          offer_count: 0,
          week_bucket: "2026-06-08",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "business_definition_open",
      "stale_mapping",
    ])
  })

  test("records ownership source gaps without blocking local leadership render", async () => {
    const result = await runWeeklyLeadershipModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T23:00:00.000Z",
      generatedAt: "2026-06-24T23:01:00.000Z",
      weekBucket: "2026-06-15",
      finalOfferRows: [],
      rpsRows: [],
      pipelineRows,
      ownershipRows: [],
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows[0]).toMatchObject({
      job_id: "job_1",
      req_status: "ownership_open",
      recruiter_name: null,
    })
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(1)
  })
})
