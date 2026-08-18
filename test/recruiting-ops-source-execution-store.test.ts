import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

import { createPayloadFingerprint } from "../lib/recruiting-ops/checksums"
import {
  claimSourceExecution,
  COMPRESSED_SOURCE_PAYLOAD_SCHEMA_VERSION,
  completeSourceExecution,
  readCompletedSourceExecution,
  type SourceExecutionDatabaseClient,
  type SourceExecutionRecord,
} from "../lib/recruiting-ops/source-execution-store"

class FakeSourceExecutionClient implements SourceExecutionDatabaseClient {
  readonly rows = new Map<string, SourceExecutionRecord>()

  async claim(input: { sourceExecutionId: string; ownerToken: string; leaseSeconds: number }) {
    const existing = this.rows.get(input.sourceExecutionId)
    if (existing?.status === "running" && existing.ownerToken === input.ownerToken) return existing
    if ([...this.rows.values()].some((row) => row.status === "running")) return null
    const acquiredAt = "2026-07-15T20:00:00.000Z"
    const row: SourceExecutionRecord = {
      sourceExecutionId: input.sourceExecutionId,
      ownerToken: input.ownerToken,
      status: "running",
      acquiredAt,
      leasedUntil: new Date(Date.parse(acquiredAt) + input.leaseSeconds * 1000).toISOString(),
      completedAt: null,
      sourceGeneratedAt: null,
      sourceFingerprint: null,
      sourceCounts: null,
      publicDiagnostics: {},
      sourcePayload: null,
      sourcePayloadSchemaVersion: null,
      sourcePayloadChecksum: null,
    }
    this.rows.set(row.sourceExecutionId, row)
    return row
  }

  async complete(input: Parameters<SourceExecutionDatabaseClient["complete"]>[0]) {
    const current = this.rows.get(input.sourceExecutionId)
    if (!current || current.status !== "running" || current.ownerToken !== input.ownerToken) {
      throw new Error("completion rejected")
    }
    const completed: SourceExecutionRecord = {
      ...current,
      ...input,
      status: "completed",
      completedAt: "2026-07-15T20:02:00.000Z",
    }
    this.rows.set(completed.sourceExecutionId, completed)
    return completed
  }

  async fail(input: Parameters<SourceExecutionDatabaseClient["fail"]>[0]) {
    const current = this.rows.get(input.sourceExecutionId)
    if (!current || current.status !== "running" || current.ownerToken !== input.ownerToken) {
      throw new Error("failure rejected")
    }
    const failed = { ...current, status: "failed" as const, publicDiagnostics: input.publicDiagnostics }
    this.rows.set(failed.sourceExecutionId, failed)
    return failed
  }

  async heartbeat(input: { sourceExecutionId: string; ownerToken: string; leaseSeconds: number }) {
    const current = this.rows.get(input.sourceExecutionId)
    return current?.status === "running" && current.ownerToken === input.ownerToken
  }

  async reapStale() {
    return 0
  }

  async selectCompleted(sourceExecutionId: string) {
    const row = this.rows.get(sourceExecutionId)
    return row?.status === "completed" ? row : null
  }
}

const hmacFingerprint = `hmac-sha256:${"a".repeat(64)}`

describe("reporting source-execution store", () => {
  test("one active lease rejects overlap and a same-owner claim is idempotent", async () => {
    const client = new FakeSourceExecutionClient()
    const first = await claimSourceExecution({ sourceExecutionId: "execution-1", ownerToken: "owner-1" }, client)
    expect(first.outcome).toBe("acquired")

    const retry = await claimSourceExecution({ sourceExecutionId: "execution-1", ownerToken: "owner-1" }, client)
    expect(retry.outcome).toBe("acquired")

    const overlap = await claimSourceExecution({ sourceExecutionId: "execution-2", ownerToken: "owner-2" }, client)
    expect(overlap).toEqual({ outcome: "overlap_rejected" })
  })

  test("completion persists a replayable payload and reads reject checksum drift", async () => {
    const client = new FakeSourceExecutionClient()
    await claimSourceExecution({ sourceExecutionId: "execution-1", ownerToken: "owner-1" }, client)
    const payload = { schemaVersion: 1, facts: [{ reqId: "890" }] }
    await expect(completeSourceExecution(
      {
        sourceExecutionId: "execution-1",
        ownerToken: "owner-2",
        sourceGeneratedAt: "2026-07-15T20:01:00.000Z",
        sourceFingerprint: hmacFingerprint,
        sourceCounts: { facts: 1 },
        publicDiagnostics: { truncationDetected: false },
        sourcePayload: payload,
        sourcePayloadSchemaVersion: 1,
      },
      client
    )).rejects.toThrow(/completion rejected/)

    const completed = await completeSourceExecution(
      {
        sourceExecutionId: "execution-1",
        ownerToken: "owner-1",
        sourceGeneratedAt: "2026-07-15T20:01:00.000Z",
        sourceFingerprint: hmacFingerprint,
        sourceCounts: { facts: 1 },
        publicDiagnostics: { truncationDetected: false },
        sourcePayload: payload,
        sourcePayloadSchemaVersion: 1,
      },
      client
    )
    expect(completed.sourcePayloadChecksum).toBe(createPayloadFingerprint(payload))
    expect(await readCompletedSourceExecution("execution-1", client)).toEqual(completed)

    client.rows.set("execution-1", { ...completed, sourcePayload: { ...payload, facts: [] } })
    await expect(readCompletedSourceExecution("execution-1", client)).rejects.toThrow(/checksum mismatch/)
  })

  test("compressed payloads stay replayable and fail closed on corrupt encoded bytes", async () => {
    const client = new FakeSourceExecutionClient()
    await claimSourceExecution({ sourceExecutionId: "execution-3", ownerToken: "owner-1" }, client)
    const payload = {
      schemaVersion: 3,
      facts: Array.from({ length: 2_000 }, (_, index) => ({ reqId: String(index % 10), stage: "Interview" })),
    }
    const completed = await completeSourceExecution({
      sourceExecutionId: "execution-3",
      ownerToken: "owner-1",
      sourceGeneratedAt: "2026-07-15T20:01:00.000Z",
      sourceFingerprint: hmacFingerprint,
      sourceCounts: { facts: payload.facts.length },
      publicDiagnostics: { truncationDetected: false },
      sourcePayload: payload,
      sourcePayloadSchemaVersion: COMPRESSED_SOURCE_PAYLOAD_SCHEMA_VERSION,
    }, client)
    const persisted = client.rows.get("execution-3")!
    const envelope = persisted.sourcePayload as Record<string, unknown>

    expect(completed.sourcePayload).toEqual(payload)
    expect(await readCompletedSourceExecution("execution-3", client)).toEqual(completed)
    expect(envelope.encoding).toBe("gzip-base64")
    expect(JSON.stringify(envelope).length).toBeLessThan(JSON.stringify(payload).length / 2)
    expect(persisted.sourcePayloadChecksum).toBe(createPayloadFingerprint(envelope))

    const data = String(envelope.data)
    const corrupted = { ...envelope, data: `${data[0] === "A" ? "B" : "A"}${data.slice(1)}` }
    client.rows.set("execution-3", {
      ...persisted,
      sourcePayload: corrupted,
      sourcePayloadChecksum: createPayloadFingerprint(corrupted),
    })
    await expect(readCompletedSourceExecution("execution-3", client)).rejects.toThrow(
      /compressed payload could not be decoded/
    )
  })

  test("migration uses a row lease, immutable completion, and service-role-only RPCs", () => {
    const sql = readFileSync(
      "supabase/migrations/023_recruiting_ops_source_execution.sql",
      "utf8"
    ).toLowerCase()
    expect(sql).toContain("where status = 'running'")
    expect(sql).toContain("on conflict do nothing")
    expect(sql).toContain("completed source executions are immutable")
    expect(sql).toContain("source_payload jsonb")
    expect(sql).toContain("source_payload_checksum text")
    expect(sql).toContain("revoke all on function")
    expect(sql).toContain("to service_role")
    expect(sql).not.toContain("advisory_lock")
  })

  test("adoption preserves the orphan array diagnostics while allowing new object claims", () => {
    const sql = readFileSync(
      "supabase/migrations/025_recruiting_ops_source_diagnostics_adoption.sql",
      "utf8"
    ).toLowerCase()
    expect(sql).toContain("public_diagnostics")
    expect(sql).toContain("drop constraint if exists recruiting_ops_source_executions_public_diagnostics_check")
    expect(sql).toContain("jsonb_typeof(public_diagnostics) in ('object', 'array')")
    expect(sql).not.toContain("pg_constraint")
    expect(sql).not.toContain("update public.recruiting_ops_source_executions")
  })
})
