import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  deriveEltRecruitingUpdateRows,
  eltRecruitingUpdateModuleDefinition,
  runEltRecruitingUpdateModule,
} from "../lib/recruiting-ops/modules/t06-elt-recruiting-updates"
import type { PipelineGraphRow } from "../lib/recruiting-ops/modules/t04-pipeline-graph"
import type { WeeklyLeadershipRow } from "../lib/recruiting-ops/modules/t01-weekly-leadership"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t06-"))
  roots.push(root)
  return root
}

const manualFieldsNull = {
  billable: null,
  priority: null,
  role_type: null,
  job_health: null,
  job_progress: null,
  comments: null,
}

const weeklyLeadershipRows: WeeklyLeadershipRow[] = [
  {
    job_id: "job_1",
    req_status: "active",
    pipeline_count: 2,
    offer_count: 1,
    rps_missing_count: 1,
    openings_count: 2,
    recruiter_name: "Recruiter One",
    week_bucket: "2026-06-15",
    ...manualFieldsNull,
  },
  {
    job_id: "job_2",
    req_status: "ownership_open",
    pipeline_count: 1,
    offer_count: 0,
    rps_missing_count: 0,
    openings_count: 0,
    recruiter_name: null,
    week_bucket: "2026-06-15",
    ...manualFieldsNull,
  },
]

const pipelineGraphRows: PipelineGraphRow[] = [
  {
    req_group: "req_890",
    week_bucket: "2026-06-15",
    stage_name: "application_review",
    stage_order: 10,
    core_stage: "Application Review",
    core_stage_order: 1,
    movement_count: 1,
    total_movement_count: 3,
    movement_share: 0.3333,
  },
  {
    req_group: "req_890",
    week_bucket: "2026-06-15",
    stage_name: "recruiter_screen",
    stage_order: 20,
    core_stage: "Recruiter Phone Screen",
    core_stage_order: 3,
    movement_count: 2,
    total_movement_count: 3,
    movement_share: 0.6667,
  },
]

describe("T06 ELT recruiting updates module", () => {
  test("declares the expected workflow, artifact, and output contracts", () => {
    expect(eltRecruitingUpdateModuleDefinition).toEqual({
      moduleId: "t06-elt-recruiting-updates",
      workflowId: "T06",
      capabilityId: "stakeholder_narrative_generation",
      title: "T06 ELT Recruiting Updates",
      sourceIds: ["google_docs", "google_sheets"],
      queryIds: [],
      legacyArtifactIds: ["legacy_elt_recruiting_update_doc"],
      outputContractIds: ["elt_recruiting_doc"],
    })
  })

  test("derives deterministic human-review draft sections from command-center facts", () => {
    expect(
      deriveEltRecruitingUpdateRows({
        weekBucket: "2026-06-15",
        weeklyLeadershipRows,
        pipelineGraphRows,
      })
    ).toEqual([
      {
        section_id: "pipeline_health",
        section_title: "Pipeline health",
        week_bucket: "2026-06-15",
        metric_key: "pipeline_count",
        metric_value: 3,
        narrative_draft:
          "Pipeline activity shows 3 weekly stage movements across tracked roles; graph data covers 3 movements.",
        human_review_required: true,
        source_workflow_ids: "T01|T04",
      },
      {
        section_id: "offer_activity",
        section_title: "Offer activity",
        week_bucket: "2026-06-15",
        metric_key: "offer_count",
        metric_value: 1,
        narrative_draft: "Offer lifecycle activity shows 1 final-offer events for the reporting period.",
        human_review_required: true,
        source_workflow_ids: "T01|T07",
      },
      {
        section_id: "scorecard_accountability",
        section_title: "Scorecard accountability",
        week_bucket: "2026-06-15",
        metric_key: "rps_missing_count",
        metric_value: 1,
        narrative_draft: "RPS accountability review has 1 missing scorecard item(s) requiring follow-up.",
        human_review_required: true,
        source_workflow_ids: "T01|T05",
      },
      {
        section_id: "ownership_coverage",
        section_title: "Ownership coverage",
        week_bucket: "2026-06-15",
        metric_key: "ownership_open_count",
        metric_value: 1,
        narrative_draft: "Ownership coverage has 1 tracked role(s) with open ownership mapping review.",
        human_review_required: true,
        source_workflow_ids: "T01|T09",
      },
    ])
  })

  test("runs locally and writes ELT doc-section JSON/CSV artifacts", async () => {
    const result = await runEltRecruitingUpdateModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T23:50:00.000Z",
      generatedAt: "2026-06-24T23:51:00.000Z",
      weekBucket: "2026-06-15",
      weeklyLeadershipRows,
      pipelineGraphRows,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(4)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Section ID,Section title,Week,Metric key,Metric value,Narrative draft,Human review required,Source workflows"
    )
  })

  test("classifies legacy ELT doc differences without treating legacy prose as truth", async () => {
    const result = await runEltRecruitingUpdateModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T23:52:00.000Z",
      generatedAt: "2026-06-24T23:53:00.000Z",
      weekBucket: "2026-06-15",
      weeklyLeadershipRows,
      pipelineGraphRows,
      legacyRows: [
        {
          section_id: "pipeline_health",
          metric_value: 99,
          narrative_draft: "Legacy manually authored text.",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "intentional_modernization",
    ])
  })

  test("blocks cutover when upstream leadership rows are missing", async () => {
    const result = await runEltRecruitingUpdateModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T23:54:00.000Z",
      generatedAt: "2026-06-24T23:55:00.000Z",
      weekBucket: "2026-06-15",
      weeklyLeadershipRows: [],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.normalizedRows).toHaveLength(0)
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(1)
  })
})
