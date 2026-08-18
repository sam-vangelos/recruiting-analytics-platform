import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { resolveLocalArtifactPath } from "../lib/recruiting-ops/local-artifacts"
import { renderCsvArtifact, writeCsvArtifact } from "../lib/recruiting-ops/renderers/csv"
import { renderJsonArtifact, writeJsonArtifact } from "../lib/recruiting-ops/renderers/json"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-artifacts-"))
  roots.push(root)
  return root
}

const baseArtifactInput = {
  rootDir: "",
  workflowId: "T07",
  runId: "t07_20260624070000000",
  schemaVersion: "1.0.0",
  rows: [
    {
      application_id: "app_1",
      job_id: "job_1",
      offer_status: "created",
      month_bucket: "2026-06",
    },
  ],
  sourceRefs: ["greenhouse_fixture_t07"],
  publicSummary: {
    workflowId: "T07",
    rowCount: 1,
  },
}

describe("recruiting ops local artifacts and renderers", () => {
  test("renders deterministic JSON artifacts", () => {
    const content = renderJsonArtifact({
      ...baseArtifactInput,
      generatedAt: "2026-06-24T07:00:00.000Z",
    })

    expect(JSON.parse(content)).toEqual({
      generatedAt: "2026-06-24T07:00:00.000Z",
      rowCount: 1,
      rows: baseArtifactInput.rows,
      runId: "t07_20260624070000000",
      schemaVersion: "1.0.0",
      workflowId: "T07",
    })
  })

  test("writes JSON artifacts to a temporary directory and returns a manifest", async () => {
    const rootDir = tempRoot()
    const manifest = await writeJsonArtifact({
      ...baseArtifactInput,
      rootDir,
      generatedAt: "2026-06-24T07:00:00.000Z",
    })

    expect(manifest).toMatchObject({
      artifactId: "t07_json_t07_20260624070000000",
      workflowId: "T07",
      format: "json",
      rowCount: 1,
      schemaVersion: "1.0.0",
    })
    expect(readFileSync(manifest.path, "utf8")).toContain("\"workflowId\":\"T07\"")
  })

  test("renders and writes CSV artifacts with stable column order and escaping", async () => {
    const rootDir = tempRoot()
    const csvInput = {
      ...baseArtifactInput,
      rootDir,
      rows: [
        {
          application_id: "app_1",
          offer_status: "created, pending",
        },
      ],
      columns: [
        { key: "application_id", label: "Application ID" },
        { key: "offer_status", label: "Offer Status" },
      ],
    }

    expect(renderCsvArtifact(csvInput)).toBe('Application ID,Offer Status\napp_1,"created, pending"\n')

    const manifest = await writeCsvArtifact(csvInput)
    expect(manifest.format).toBe("csv")
    expect(readFileSync(manifest.path, "utf8")).toBe('Application ID,Offer Status\napp_1,"created, pending"\n')
  })

  test("redacts unsafe public rows before writing local artifacts", async () => {
    // Redact-then-certify seam (RENDER-payload-pii): unsafe row content never reaches
    // the artifact bytes — it is redacted at render time and the redacted projection is
    // certified strict before writing.
    const manifest = await writeJsonArtifact({
      ...baseArtifactInput,
      rootDir: tempRoot(),
      generatedAt: "2026-06-24T07:00:00.000Z",
      rows: [
        {
          candidate_email: "person@example.com",
        },
      ],
    })

    const content = readFileSync(manifest.path, "utf8")
    expect(content).not.toContain("person@example.com")
    expect(content).toContain("[REDACTED]")
  })

  test("rejects unsafe file names and slugs workflow IDs for paths", () => {
    expect(
      resolveLocalArtifactPath({
        rootDir: "/tmp/example",
        workflowId: "T20/T21",
        runId: "t20_t21_20260624070000000",
        format: "json",
      })
    ).toContain("/t20_t21/t20_t21_20260624070000000/t20_t21-t20_t21_20260624070000000.json")

    expect(() =>
      resolveLocalArtifactPath({
        rootDir: "/tmp/example",
        workflowId: "T07",
        runId: "t07_20260624070000000",
        format: "json",
        fileName: "../bad.json",
      })
    ).toThrow("Unsafe artifact file name")
  })
})
