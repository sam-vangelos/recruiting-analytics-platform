import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  derivePipelineGraphRows,
  pipelineGraphModuleDefinition,
  runPipelineGraphModule,
} from "../lib/recruiting-ops/modules/t04-pipeline-graph"
import type { PipelineStageRow } from "../lib/recruiting-ops/modules/t02-pipeline"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t04-"))
  roots.push(root)
  return root
}

const pipelineRows: PipelineStageRow[] = [
  {
    application_id: "app_1",
    job_id: "job_890",
    req_id: "890",
    stage_name: "application_review",
    core_stage: "Application Review",
    core_stage_order: 1,
    stage_changed_at: "2026-06-16T10:00:00.000Z",
    week_bucket: "2026-06-15",
    dedupe_key: "app_1|job_890|890|application_review|2026-06-15",
  },
  {
    application_id: "app_2",
    job_id: "job_890",
    req_id: "890",
    stage_name: "recruiter_screen",
    core_stage: "Recruiter Phone Screen",
    core_stage_order: 3,
    stage_changed_at: "2026-06-18T10:00:00.000Z",
    week_bucket: "2026-06-15",
    dedupe_key: "app_2|job_890|890|recruiter_screen|2026-06-15",
  },
  {
    application_id: "app_3",
    job_id: "job_890",
    req_id: "890",
    stage_name: "recruiter_screen",
    core_stage: "Recruiter Phone Screen",
    core_stage_order: 3,
    stage_changed_at: "2026-06-19T10:00:00.000Z",
    week_bucket: "2026-06-15",
    dedupe_key: "app_3|job_890|890|recruiter_screen|2026-06-15",
  },
]

describe("T04 FDL pipeline graph module", () => {
  test("declares the expected workflow, query, artifact, and output contracts", () => {
    expect(pipelineGraphModuleDefinition).toEqual({
      moduleId: "t04-pipeline-graph",
      workflowId: "T04",
      capabilityId: "pipeline_movement_intelligence",
      title: "T04 FDL Pipeline Graph",
      sourceIds: ["greenhouse", "looker_sql_runner", "google_sheets"],
      queryIds: ["Q10"],
      legacyArtifactIds: ["legacy_q10_pipeline_graph"],
      outputContractIds: ["pipeline_graph_sheet"],
    })
  })

  test("derives chart data from T02 pipeline rows", () => {
    expect(derivePipelineGraphRows(pipelineRows)).toEqual([
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
    ])
  })

  test("runs locally and writes graph-safe JSON/CSV artifacts", async () => {
    const result = await runPipelineGraphModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T23:40:00.000Z",
      generatedAt: "2026-06-24T23:41:00.000Z",
      pipelineRows,
      legacyRows: [
        {
          req_group: "req_890",
          stage_name: "application_review",
          movement_count: 1,
          week_bucket: "2026-06-15",
        },
      ],
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(2)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Req group,Week,Stage,Stage order,Core stage,Core stage order,Movement count,Total movements,Movement share"
    )
  })

  test("classifies Q10 graph differences as evidence review items", async () => {
    const result = await runPipelineGraphModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T23:42:00.000Z",
      generatedAt: "2026-06-24T23:43:00.000Z",
      pipelineRows,
      legacyRows: [
        {
          req_group: "req_890",
          stage_name: "recruiter_screen",
          movement_count: 1,
          week_bucket: "2026-06-15",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class)).toEqual(["business_definition_open"])
    expect(result.run.discrepancySummary.byClass.business_definition_open).toBe(1)
  })

  test("blocks cutover when upstream T02 stage or week mapping is unresolved", async () => {
    const result = await runPipelineGraphModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T23:44:00.000Z",
      generatedAt: "2026-06-24T23:45:00.000Z",
      pipelineRows: [
        {
          ...pipelineRows[0],
          stage_name: "unknown",
          week_bucket: "unknown",
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.sourceGaps).toHaveLength(1)
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(1)
  })
})
