import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  createFixtureGreenhouseReadBoundary,
  type GreenhouseFixtureFacts,
  type GreenhouseReadBoundary,
} from "../lib/recruiting-ops/extractors/greenhouse-read-boundary"
import type { SourceGap } from "../lib/recruiting-ops/runs"
import {
  runLocalCommandCenterWorkflow,
  type LocalWorkflowLegacyEvidence,
} from "../lib/recruiting-ops/workflow-runner"

const fixtureRoot = join(process.cwd(), "test", "fixtures", "recruiting-ops")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-runner-"))
  roots.push(root)
  return root
}

function readFixture<T>(fileName: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, fileName), "utf8")) as T
}

function readGreenhouseFixtures(): GreenhouseFixtureFacts {
  return {
    finalOffers: readFixture("greenhouse-final-offers.json"),
    rps: readFixture("greenhouse-rps.json"),
    pipeline: readFixture("greenhouse-pipeline.json"),
    ownership: readFixture("greenhouse-ownership.json"),
  }
}

describe("recruiting ops local workflow runner", () => {
  test("runs high-signal modules in dependency order and writes local artifacts only", async () => {
    const rootDir = tempRoot()
    const result = await runLocalCommandCenterWorkflow({
      rootDir,
      startedAt: "2026-06-24T23:30:00.000Z",
      generatedAt: "2026-06-24T23:31:00.000Z",
      weekBucket: "2026-06-15",
      greenhouse: createFixtureGreenhouseReadBoundary(readGreenhouseFixtures()),
      legacyEvidence: readFixture<LocalWorkflowLegacyEvidence>("legacy-evidence.json"),
    })

    expect(result.moduleOrder).toEqual(["T07", "T05", "T02", "T03", "T09", "T01"])
    expect(result.artifacts).toHaveLength(12)
    expect(Object.values(result.runs).map((moduleResult) => moduleResult.run.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ])

    for (const artifact of result.artifacts) {
      expect(relative(rootDir, artifact.path).startsWith("..")).toBe(false)
      expect(existsSync(artifact.path)).toBe(true)
    }

    expect(result.runs.T01.normalizedRows).toEqual([
      {
        job_id: "job_fixture_1",
        req_status: "active",
        pipeline_count: 2,
        offer_count: 1,
        rps_missing_count: 1,
        openings_count: 2,
        recruiter_name: "Avery Collins",
        week_bucket: "2026-06-15",
        billable: null,
        priority: null,
        role_type: null,
        job_health: null,
        job_progress: null,
        comments: null,
      },
    ])
    expect(result.publicSummary).toEqual({
      moduleCount: 6,
      artifactCount: 12,
      runStatuses: {
        T07: "succeeded",
        T05: "succeeded",
        T02: "succeeded",
        T03: "succeeded",
        T09: "succeeded",
        T01: "succeeded",
      },
      totalDiscrepancies: 0,
    })
  })

  // Regression lock for the first-light fail-open seam: adapter-level mapping gaps
  // must reach the module runs. A boundary that reports dropped source records has
  // to flip the affected modules to blocked — 5000 dropped applications can never
  // again read as a clean succeeded run with 0 gaps.
  test("adapter-level source gaps surface in module runs and block them", async () => {
    const facts = readGreenhouseFixtures()
    const adapterGap = (workflowId: string, index: number): SourceGap => ({
      id: `gap_harvest_${workflowId.toLowerCase()}_required_field_record_${index}`,
      workflowId,
      sourceId: "greenhouse",
      field: "required_field",
      reason: "Source record could not be mapped into a fact.",
      blocksCutover: true,
    })
    const boundary: GreenhouseReadBoundary = {
      sourceAdapter: "greenhouse_v3_read",
      async fetchFinalOfferFacts() {
        return { facts: facts.finalOffers, sourceGaps: [adapterGap("T07", 0)] }
      },
      async fetchRpsFacts() {
        return { facts: facts.rps, sourceGaps: [adapterGap("T05", 0)] }
      },
      async fetchPipelineStageFacts() {
        return { facts: facts.pipeline, sourceGaps: [adapterGap("T02", 0), adapterGap("T02", 1)] }
      },
      async fetchOwnershipFacts() {
        return { facts: facts.ownership, sourceGaps: [adapterGap("T09", 0)] }
      },
    }

    const result = await runLocalCommandCenterWorkflow({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T23:30:00.000Z",
      generatedAt: "2026-06-24T23:31:00.000Z",
      weekBucket: "2026-06-15",
      greenhouse: boundary,
    })

    for (const workflowId of ["T07", "T05", "T02", "T09"] as const) {
      const moduleRun = result.runs[workflowId]
      expect(moduleRun.run.status).toBe("blocked")
      expect(moduleRun.sourceGaps.some((gap) => gap.id.startsWith("gap_harvest_"))).toBe(true)
    }
    expect(result.runs.T02.sourceGaps.filter((gap) => gap.id.startsWith("gap_harvest_"))).toHaveLength(2)
    // Adapter gaps also register as discrepancies, so the drop is visible in the tallies.
    expect(result.runs.T02.discrepancies.length).toBeGreaterThanOrEqual(2)
  })
})
