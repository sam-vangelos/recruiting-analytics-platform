import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  finalOfferModuleDefinition,
  normalizeFinalOfferRows,
  normalizeOfferStatus,
  runFinalOfferModule,
  type GreenhouseFinalOfferFact,
} from "../lib/recruiting-ops/modules/t07-final-offer"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t07-"))
  roots.push(root)
  return root
}

const completeFacts: GreenhouseFinalOfferFact[] = [
  {
    applicationId: "app_1",
    jobId: "job_1",
    offerId: "offer_1",
    status: "accepted",
    createdAt: "2026-06-15T12:00:00.000Z",
    // "Avery Collins" is in the recruiter→team fixture config, so team/HOD resolve.
    recruiterName: "Avery Collins",
    sourcerName: "Sourcer One",
  },
]

describe("T07 Final Offer module", () => {
  test("declares the expected workflow, source, query, artifact, and output contracts", () => {
    expect(finalOfferModuleDefinition).toEqual({
      moduleId: "t07-final-offer",
      workflowId: "T07",
      capabilityId: "offer_and_hire_lifecycle_intelligence",
      title: "T07 Final Offer / offer lifecycle",
      sourceIds: ["greenhouse", "looker_sql_runner", "google_sheets"],
      queryIds: ["Q12"],
      legacyArtifactIds: ["legacy_q12_final_offer"],
      outputContractIds: ["final_offer_sheet"],
    })
  })

  test("normalizes Greenhouse-style offer facts into the local output shape", () => {
    expect(normalizeOfferStatus("approval complete")).toBe("approved")
    expect(normalizeOfferStatus("extended")).toBe("sent")
    expect(normalizeOfferStatus("signed")).toBe("accepted")
    expect(normalizeOfferStatus("rescinded")).toBe("declined")
    expect(normalizeOfferStatus("custom state")).toBe("unknown")

    expect(normalizeFinalOfferRows(completeFacts)).toEqual([
      {
        application_id: "app_1",
        job_id: "job_1",
        offer_id: "offer_1",
        offer_status: "accepted",
        month_bucket: "2026-06",
        offer_created_at: "2026-06-15T12:00:00.000Z",
        recruiter_name: "Avery Collins",
        sourcer_name: "Sourcer One",
        // Derived through the shared recruiter→team dimension, not from a raw fact field.
        team_name: "Team Avery",
        hod_name: "Avery Collins",
      },
    ])
  })

  test("an unresolved recruiter yields NULL team attribution and a source gap, never a sentinel", async () => {
    const result = await runFinalOfferModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T11:00:00.000Z",
      generatedAt: "2026-06-24T11:01:00.000Z",
      greenhouseFacts: [{ ...completeFacts[0], recruiterName: "Nobody McNoteam" }],
    })

    const [row] = result.normalizedRows
    expect(row.team_name).toBeNull()
    expect(row.hod_name).toBeNull()
    expect(result.sourceGaps.some((gap) => gap.field === "team_name")).toBe(true)
    expect(result.sourceGaps.some((gap) => gap.field === "hod_name")).toBe(true)
  })

  test("runs locally and writes JSON/CSV artifacts without external access", async () => {
    const result = await runFinalOfferModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T08:00:00.000Z",
      generatedAt: "2026-06-24T08:01:00.000Z",
      greenhouseFacts: completeFacts,
      legacyRows: [
        {
          application_id: "app_1",
          offer_status: "accepted",
          month_bucket: "2026-06",
        },
      ],
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.run.workflowId).toBe("T07")
    expect(result.normalizedRows).toHaveLength(1)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "json")!.path, "utf8")).toContain(
      "\"offer_status\":\"accepted\""
    )
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Application ID,Job ID,Offer ID,Offer status,Month,Recruiter"
    )
  })

  test("classifies legacy Q12 differences instead of treating them as truth", async () => {
    const result = await runFinalOfferModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T09:00:00.000Z",
      generatedAt: "2026-06-24T09:01:00.000Z",
      greenhouseFacts: completeFacts,
      legacyRows: [
        {
          application_id: "app_1",
          offer_status: "declined",
          month_bucket: "2026-05",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "stale_mapping",
    ])
    expect(result.run.discrepancySummary.byClass.business_definition_open).toBe(1)
    expect(result.run.discrepancySummary.byClass.stale_mapping).toBe(1)
  })

  test("blocks cutover when Greenhouse status mapping is open", async () => {
    const result = await runFinalOfferModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T10:00:00.000Z",
      generatedAt: "2026-06-24T10:01:00.000Z",
      greenhouseFacts: [
        {
          ...completeFacts[0],
          status: "custom state",
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.sourceGaps.some((gap) => gap.field === "offer_status" && gap.blocksCutover)).toBe(true)
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(1)
  })

  test("drops malformed required identity facts instead of emitting unknown grouping keys", async () => {
    const result = await runFinalOfferModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T10:15:00.000Z",
      generatedAt: "2026-06-24T10:16:00.000Z",
      greenhouseFacts: [
        {
          applicationId: "unknown",
          jobId: "",
          offerId: "unknown",
          status: "accepted",
          createdAt: "unknown",
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.normalizedRows).toEqual([])
    expect(result.sourceGaps.map((gap) => gap.field).sort()).toEqual([
      "application_id",
      "created_at",
      "job_id",
      "offer_id",
    ])
    expect(JSON.stringify(result.normalizedRows)).not.toContain("unknown")
  })
})
