import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  normalizeOwnershipRows,
  ownershipModuleDefinition,
  runOwnershipModule,
  type GreenhouseOwnershipFact,
} from "../lib/recruiting-ops/modules/t09-ownership"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t09-"))
  roots.push(root)
  return root
}

const ownershipFacts: GreenhouseOwnershipFact[] = [
  // "Avery Collins" is in the recruiter→team fixture config, so pod resolves to Team Avery.
  {
    jobId: "job_1",
    recruiterName: "Avery Collins",
    sourcerName: "Sourcer One",
    openingsCount: 2,
  },
  {
    jobId: "job_2",
    recruiterName: "Avery Collins",
    sourcerName: "Sourcer Two",
    openingsCount: 1,
  },
]

describe("T09 ownership/workload module", () => {
  test("declares the expected workflow, query, artifact, and output contracts", () => {
    expect(ownershipModuleDefinition).toEqual({
      moduleId: "t09-ownership",
      workflowId: "T09",
      capabilityId: "ownership_capacity_management",
      title: "T09 ownership and recruiter workload",
      sourceIds: ["greenhouse", "looker_sql_runner", "google_sheets"],
      queryIds: ["Q13", "Q14"],
      legacyArtifactIds: ["legacy_q13_q14_role_assignment"],
      outputContractIds: ["role_assignment_sheet"],
    })
  })

  test("normalizes job ownership and recruiter workload rows", () => {
    expect(normalizeOwnershipRows(ownershipFacts)).toEqual([
      {
        view_type: "job",
        job_id: "job_1",
        recruiter_name: "Avery Collins",
        sourcer_name: "Sourcer One",
        pod_name: "Team Avery",
        openings_count: 2,
        workload_count: 2,
      },
      {
        view_type: "job",
        job_id: "job_2",
        recruiter_name: "Avery Collins",
        sourcer_name: "Sourcer Two",
        pod_name: "Team Avery",
        openings_count: 1,
        workload_count: 1,
      },
      {
        view_type: "recruiter",
        job_id: "all",
        recruiter_name: "Avery Collins",
        sourcer_name: null,
        pod_name: null,
        openings_count: 3,
        workload_count: 2,
      },
    ])
  })

  test("runs locally and writes JSON/CSV artifacts without external access", async () => {
    const result = await runOwnershipModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T18:00:00.000Z",
      generatedAt: "2026-06-24T18:01:00.000Z",
      greenhouseFacts: ownershipFacts,
      legacyRows: [
        {
          view_type: "job",
          job_id: "job_1",
          recruiter_name: "Avery Collins",
          openings_count: 2,
        },
      ],
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(3)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "View type,Job ID,Recruiter,Sourcer,Pod,Openings,Workload count"
    )
  })

  test("classifies legacy Q13/Q14 differences as evidence review items", async () => {
    const result = await runOwnershipModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T19:00:00.000Z",
      generatedAt: "2026-06-24T19:01:00.000Z",
      greenhouseFacts: [ownershipFacts[0]],
      legacyRows: [
        {
          view_type: "job",
          job_id: "job_1",
          recruiter_name: "Recruiter Two",
          openings_count: 5,
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "stale_mapping",
    ])
  })

  test("blocks cutover when recruiter ownership is missing", async () => {
    const result = await runOwnershipModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T20:00:00.000Z",
      generatedAt: "2026-06-24T20:01:00.000Z",
      greenhouseFacts: [
        {
          jobId: "job_missing",
          openingsCount: 1,
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.sourceGaps.some((gap) => gap.field === "recruiter_name" && gap.blocksCutover)).toBe(true)
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(2)
  })

  test("drops malformed required job IDs instead of emitting unknown grouping keys", async () => {
    const result = await runOwnershipModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T20:15:00.000Z",
      generatedAt: "2026-06-24T20:16:00.000Z",
      greenhouseFacts: [
        {
          jobId: "unknown",
          recruiterName: "Avery Collins",
          openingsCount: 1,
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.normalizedRows).toEqual([])
    expect(result.sourceGaps.map((gap) => gap.field).sort()).toEqual(["job_id", "ownershipRows"])
    expect(JSON.stringify(result.normalizedRows)).not.toContain("unknown")
  })
})
