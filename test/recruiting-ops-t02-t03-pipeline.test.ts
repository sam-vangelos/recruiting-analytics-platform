import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  normalizePipelineRows,
  normalizePipelineStage,
  pipelineModuleDefinition,
  runPipelineModule,
  type GreenhousePipelineStageFact,
} from "../lib/recruiting-ops/modules/t02-pipeline"
import {
  deriveProgressRows,
  progressModuleDefinition,
  runProgressModule,
} from "../lib/recruiting-ops/modules/t03-progress"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t02-t03-"))
  roots.push(root)
  return root
}

const pipelineFacts: GreenhousePipelineStageFact[] = [
  {
    applicationId: "app_201",
    jobId: "job_890",
    reqId: "890",
    stageName: "Application Review",
    stageChangedAt: "2026-06-18T10:00:00.000Z",
  },
  {
    applicationId: "app_202",
    jobId: "job_890",
    reqId: "890",
    stageName: "Recruiter Phone Screen",
    stageChangedAt: "2026-06-19T10:00:00.000Z",
  },
]

describe("T02/T03 pipeline and progress modules", () => {
  test("declare the expected workflow, query, artifact, and output contracts", () => {
    expect(pipelineModuleDefinition).toMatchObject({
      moduleId: "t02-pipeline",
      workflowId: "T02",
      queryIds: ["Q04", "Q05", "Q06", "Q07", "Q08", "Q09"],
      legacyArtifactIds: ["legacy_q04_q09_pipeline_family"],
      outputContractIds: ["role_pipeline_sheets"],
    })
    expect(progressModuleDefinition).toMatchObject({
      moduleId: "t03-progress",
      workflowId: "T03",
      queryIds: [],
      outputContractIds: ["weekly_progress_sheet"],
    })
  })

  test("normalizes Greenhouse-style stage movement facts", () => {
    expect(normalizePipelineStage("Application Review")).toBe("application_review")
    expect(normalizePipelineStage("Phone Screen")).toBe("recruiter_screen")
    expect(normalizePipelineStage("Technical Interview")).toBe("technical")
    expect(normalizePipelineStage("Offer")).toBe("offer")
    expect(normalizePipelineStage("Mystery Stage")).toBe("unknown")

    expect(normalizePipelineRows(pipelineFacts)).toEqual([
      {
        application_id: "app_201",
        job_id: "job_890",
        req_id: "890",
        stage_name: "application_review",
        core_stage: "Application Review",
        core_stage_order: 1,
        stage_changed_at: "2026-06-18T10:00:00.000Z",
        week_bucket: "2026-06-15",
        dedupe_key: "app_201|job_890|890|application_review|2026-06-15",
      },
      {
        application_id: "app_202",
        job_id: "job_890",
        req_id: "890",
        stage_name: "recruiter_screen",
        core_stage: "Recruiter Phone Screen",
        core_stage_order: 3,
        stage_changed_at: "2026-06-19T10:00:00.000Z",
        week_bucket: "2026-06-15",
        dedupe_key: "app_202|job_890|890|recruiter_screen|2026-06-15",
      },
    ])
  })

  test("runs T02 locally and writes JSON/CSV artifacts", async () => {
    const result = await runPipelineModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T14:00:00.000Z",
      generatedAt: "2026-06-24T14:01:00.000Z",
      greenhouseFacts: pipelineFacts,
      legacyRows: [
        {
          application_id: "app_201",
          stage_name: "Application Review",
          week_bucket: "2026-06-15",
        },
      ],
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(2)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Application ID,Job ID,Req ID,Stage,Core stage,Stage changed at,Week,Dedupe key"
    )
  })

  test("derives T03 progress rows from T02 pipeline rows", async () => {
    const pipelineRows = normalizePipelineRows(pipelineFacts)

    expect(deriveProgressRows(pipelineRows)).toEqual([
      {
        req_group: "req_890",
        stage_name: "application_review",
        core_stage: "Application Review",
        movement_count: 1,
        week_bucket: "2026-06-15",
      },
      {
        req_group: "req_890",
        stage_name: "recruiter_screen",
        core_stage: "Recruiter Phone Screen",
        movement_count: 1,
        week_bucket: "2026-06-15",
      },
    ])

    const result = await runProgressModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T15:00:00.000Z",
      generatedAt: "2026-06-24T15:01:00.000Z",
      pipelineRows,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(2)
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Req group,Stage,Core stage,Movement count,Week"
    )
  })

  test("classifies legacy pipeline differences as evidence review items", async () => {
    const result = await runPipelineModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T16:00:00.000Z",
      generatedAt: "2026-06-24T16:01:00.000Z",
      greenhouseFacts: [pipelineFacts[0]],
      legacyRows: [
        {
          application_id: "app_201",
          stage_name: "Offer",
          week_bucket: "2026-06-08",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "stale_mapping",
    ])
  })

  test("blocks cutover when stage taxonomy or timestamp normalization is open", async () => {
    const result = await runPipelineModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T17:00:00.000Z",
      generatedAt: "2026-06-24T17:01:00.000Z",
      greenhouseFacts: [
        {
          ...pipelineFacts[0],
          stageName: "Mystery Stage",
          stageChangedAt: "not-a-date",
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.sourceGaps.filter((gap) => gap.blocksCutover)).toHaveLength(1)
    expect(result.discrepancies.every((discrepancy) => discrepancy.severity === "blocking")).toBe(true)
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(1)
  })

  test("drops malformed required identity facts instead of emitting unknown grouping keys", async () => {
    const result = await runPipelineModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T17:15:00.000Z",
      generatedAt: "2026-06-24T17:16:00.000Z",
      greenhouseFacts: [
        {
          applicationId: "unknown",
          jobId: "",
          reqId: "unknown",
          stageName: "Application Review",
          stageChangedAt: "unknown",
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.normalizedRows).toEqual([])
    expect(result.sourceGaps.map((gap) => gap.field).sort()).toEqual([
      "application_id",
      "job_id",
      "req_id",
      "stage_changed_at",
    ])
    expect(JSON.stringify(result.normalizedRows)).not.toContain("unknown")
  })

  test("does not false-block canonical substages that the legacy keyword classifier calls unknown", async () => {
    const result = await runPipelineModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T17:30:00.000Z",
      generatedAt: "2026-06-24T17:31:00.000Z",
      greenhouseFacts: [
        {
          ...pipelineFacts[0],
          applicationId: "app_sourced",
          stageName: "Sourced",
        },
      ],
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows[0]).toMatchObject({
      application_id: "app_sourced",
      stage_name: "unknown",
      core_stage: "Sourced",
      core_stage_order: 2,
    })
    expect(result.sourceGaps.some((gap) => gap.field === "stage_name" || gap.field === "core_stage")).toBe(false)
  })

  test("flags an unmapped active substage as a non-blocking core_stage gap; a terminal stage is null without a gap", async () => {
    const result = await runPipelineModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T18:00:00.000Z",
      generatedAt: "2026-06-24T18:01:00.000Z",
      greenhouseFacts: [
        // Active operational class ("recruiter_screen" via "phone") but a substage absent from the taxonomy.
        { applicationId: "app_x", jobId: "job_890", reqId: "890", stageName: "Phone Screen Round Zero", stageChangedAt: "2026-06-18T10:00:00.000Z" },
        // Terminal stage: NULL core_stage by design — not a defect, no gap.
        { applicationId: "app_y", jobId: "job_890", reqId: "890", stageName: "Hired", stageChangedAt: "2026-06-18T10:00:00.000Z" },
      ],
    })

    const active = result.normalizedRows.find((row) => row.application_id === "app_x")!
    const terminal = result.normalizedRows.find((row) => row.application_id === "app_y")!
    const coreStageGap = result.sourceGaps.find((gap) => gap.field === "core_stage")
    expect(active.core_stage).toBeNull()
    expect(coreStageGap).toMatchObject({ blocksCutover: false })
    expect(result.discrepancies.find((discrepancy) => discrepancy.field === "core_stage")?.severity).toBe("warning")
    expect(terminal.core_stage).toBeNull()
    expect(result.sourceGaps.some((gap) => gap.id.includes("core_stage_app_y"))).toBe(false)
    expect(result.run.status).toBe("succeeded")
  })
})
