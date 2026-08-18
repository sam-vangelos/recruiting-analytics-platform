import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  createFixtureGreenhouseReadBoundary,
  type GreenhouseFixtureFacts,
} from "../lib/recruiting-ops/extractors/greenhouse-read-boundary"
import { persistWorkflowRuns, type RunStoreDatabaseClient } from "../lib/recruiting-ops/run-store"
import {
  runLocalCommandCenterWorkflow,
  type LocalCommandCenterWorkflowResult,
} from "../lib/recruiting-ops/workflow-runner"

const fixtureRoot = join(process.cwd(), "test", "fixtures", "recruiting-ops")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-store-"))
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

class FakeRunStoreClient implements RunStoreDatabaseClient {
  readonly tables = new Map<string, Record<string, unknown>[]>()

  async selectRunChecksums(runId: string) {
    const runs = this.tables.get("recruiting_ops_runs") ?? []
    const run = runs.find((row) => row.run_id === runId)
    if (!run) return null
    return {
      input_checksum: String(run.input_checksum),
      normalized_checksum: String(run.normalized_checksum),
      children_checksum: run.children_checksum == null ? null : String(run.children_checksum),
    }
  }

  async insertRows(table: string, rows: readonly Record<string, unknown>[]) {
    const existing = this.tables.get(table) ?? []
    this.tables.set(table, [...existing, ...rows])
  }

  async deleteRun(runId: string) {
    for (const [table, rows] of this.tables) {
      this.tables.set(
        table,
        rows.filter((row) => row.run_id !== runId)
      )
    }
  }

  async selectChildRowCounts(runId: string) {
    const count = (table: string) =>
      (this.tables.get(table) ?? []).filter((row) => row.run_id === runId).length
    return {
      evidenceRefs: count("recruiting_ops_run_evidence_refs"),
      artifacts: count("recruiting_ops_run_artifacts"),
      sourceGaps: count("recruiting_ops_source_gaps"),
      discrepancies: count("recruiting_ops_discrepancies"),
    }
  }

  rowCount(table: string): number {
    return (this.tables.get(table) ?? []).length
  }
}

async function runFixtureWorkflow(mode?: "local"): Promise<LocalCommandCenterWorkflowResult> {
  return runLocalCommandCenterWorkflow({
    rootDir: tempRoot(),
    startedAt: "2026-06-24T23:30:00.000Z",
    generatedAt: "2026-06-24T23:31:00.000Z",
    weekBucket: "2026-06-15",
    greenhouse: createFixtureGreenhouseReadBoundary(readGreenhouseFixtures()),
    ...(mode ? { mode } : {}),
  })
}

describe("recruiting ops durable run store", () => {
  test("persists every module run with capability provenance and runId-scoped gap ids", async () => {
    const result = await runFixtureWorkflow()
    const client = new FakeRunStoreClient()

    const summaries = await persistWorkflowRuns(result, client)

    expect(summaries.map((summary) => summary.outcome)).toEqual(Array(6).fill("persisted"))
    expect(client.rowCount("recruiting_ops_runs")).toBe(6)
    expect(client.rowCount("recruiting_ops_run_artifacts")).toBe(12)
    expect(client.rowCount("recruiting_ops_run_evidence_refs")).toBeGreaterThanOrEqual(6)

    const runs = client.tables.get("recruiting_ops_runs")!
    for (const run of runs) {
      expect(String(run.capability_id)).not.toBe("")
      expect(run.capability_id).toBeDefined()
      expect(["fixture", "local", "shadow"]).toContain(run.mode)
    }
    // Persisted gap ids are runId-scoped so identical adapter gap ids from
    // different runs can never collide on the primary key.
    for (const gap of client.tables.get("recruiting_ops_source_gaps") ?? []) {
      expect(String(gap.id)).toContain("__")
      expect(String(gap.id).startsWith(String(gap.run_id))).toBe(true)
    }
  })

  test("re-persisting the same result is an idempotent no-op", async () => {
    const result = await runFixtureWorkflow()
    const client = new FakeRunStoreClient()

    await persistWorkflowRuns(result, client)
    const second = await persistWorkflowRuns(result, client)

    expect(second.map((summary) => summary.outcome)).toEqual(Array(6).fill("already_persisted"))
    expect(client.rowCount("recruiting_ops_runs")).toBe(6)
    expect(client.rowCount("recruiting_ops_run_artifacts")).toBe(12)
  })

  test("a torn run (row present, children missing) is detected on re-persist, never frozen as a no-op", async () => {
    const result = await runFixtureWorkflow()
    const client = new FakeRunStoreClient()
    await persistWorkflowRuns(result, client)

    // Simulate a prior persist that died after the run insert: strip one run's
    // artifact children while its checksums still match.
    const artifacts = client.tables.get("recruiting_ops_run_artifacts")!
    const victimRunId = String(client.tables.get("recruiting_ops_runs")![0].run_id)
    client.tables.set(
      "recruiting_ops_run_artifacts",
      artifacts.filter((row) => row.run_id !== victimRunId)
    )

    await expect(persistWorkflowRuns(result, client)).rejects.toThrow(/TORN children/)
  })

  test("the same runId with different checksums throws instead of overwriting history", async () => {
    const result = await runFixtureWorkflow()
    const client = new FakeRunStoreClient()
    await persistWorkflowRuns(result, client)

    const runs = client.tables.get("recruiting_ops_runs")!
    runs[0].normalized_checksum = "tampered"
    await expect(persistWorkflowRuns(result, client)).rejects.toThrow(/different checksums/)
  })

  test("the same runId with different gap/discrepancy CONTENT throws — parent checksums alone cannot coalesce it", async () => {
    const result = await runFixtureWorkflow()
    const client = new FakeRunStoreClient()
    await persistWorkflowRuns(result, client)

    // Parent checksums (inputs, normalized rows) match; only the child
    // checksum differs — exactly the silent-coalesce path the lens flagged.
    const runs = client.tables.get("recruiting_ops_runs")!
    runs[0].children_checksum = "sha256:tampered-child-content"
    await expect(persistWorkflowRuns(result, client)).rejects.toThrow(/different source-gap\/discrepancy content/)
  })

  test("runs persist their legacy-artifact lineage", async () => {
    const result = await runFixtureWorkflow()
    const client = new FakeRunStoreClient()
    await persistWorkflowRuns(result, client)

    const runs = client.tables.get("recruiting_ops_runs")!
    const t07 = runs.find((row) => row.workflow_id === "T07")!
    expect(t07.legacy_artifact_refs).toEqual(["legacy_q12_final_offer"])
    expect(String(t07.children_checksum)).toMatch(/^[0-9a-f]{64}$/)
  })

  test("database errors propagate loudly", async () => {
    const result = await runFixtureWorkflow()
    const failing: RunStoreDatabaseClient = {
      async selectRunChecksums() {
        return null
      },
      async selectChildRowCounts() {
        return { evidenceRefs: 0, artifacts: 0, sourceGaps: 0, discrepancies: 0 }
      },
      async insertRows() {
        throw new Error("permission denied for table recruiting_ops_runs")
      },
      async deleteRun() {},
    }
    await expect(persistWorkflowRuns(result, failing)).rejects.toThrow(/permission denied/)
  })

  test("a failed child insert compensates by deleting the run row — no partial runs", async () => {
    const result = await runFixtureWorkflow()
    const client = new FakeRunStoreClient()
    const deleted: string[] = []
    const failingOnArtifacts: RunStoreDatabaseClient = {
      selectRunChecksums: (runId) => client.selectRunChecksums(runId),
      selectChildRowCounts: (runId) => client.selectChildRowCounts(runId),
      async insertRows(table, rows) {
        if (table === "recruiting_ops_run_artifacts") {
          throw new Error("duplicate key value violates unique constraint")
        }
        await client.insertRows(table, rows)
      },
      async deleteRun(runId) {
        deleted.push(runId)
        await client.deleteRun(runId)
      },
    }

    await expect(persistWorkflowRuns(result, failingOnArtifacts)).rejects.toThrow(/duplicate key/)
    // The failed module's run row was compensated away — a partial persist
    // (run row present, gaps missing) would read as a clean zero-gap run.
    expect(deleted.length).toBeGreaterThanOrEqual(1)
    const runs = client.tables.get("recruiting_ops_runs") ?? []
    for (const runId of deleted) {
      expect(runs.some((row) => row.run_id === runId)).toBe(false)
    }
  })

  test("duplicate record ids within one run are rejected with the offending ids", async () => {
    const result = await runFixtureWorkflow()
    const t07 = result.runs.T07
    const duplicateGap = {
      id: "gap_t07_owner_collision",
      workflowId: "T07",
      capabilityId: t07.run.capabilityId,
      sourceId: "greenhouse",
      field: "owner",
      reason: "Two records were issued the same gap id — a grain bug.",
      blocksCutover: true,
    }
    const tampered = {
      run: {
        ...t07.run,
        sourceGaps: [...t07.run.sourceGaps, duplicateGap, duplicateGap],
      },
      discrepancies: t07.discrepancies,
    }
    const client = new FakeRunStoreClient()
    await expect(
      persistWorkflowRuns(
        { ...result, runs: { ...result.runs, T07: tampered as unknown as typeof t07 } },
        client
      )
    ).rejects.toThrow(/duplicate source gap id.*gap_t07_owner_collision/)
  })

  test("run mode threads honestly from the runner into persisted history", async () => {
    const result = await runFixtureWorkflow("local")
    const client = new FakeRunStoreClient()
    await persistWorkflowRuns(result, client)

    const runs = client.tables.get("recruiting_ops_runs")!
    expect(runs.map((run) => run.mode)).toEqual(Array(6).fill("local"))

    // And the default stays fixture for fixture-driven tests.
    const fixtureResult = await runFixtureWorkflow()
    expect(Object.values(fixtureResult.runs).map((moduleResult) => moduleResult.run.mode)).toEqual(
      Array(6).fill("fixture")
    )
  })
})
