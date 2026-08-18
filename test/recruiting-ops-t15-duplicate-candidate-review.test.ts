import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  duplicateCandidateReviewModuleDefinition,
  normalizeDuplicateCandidateReviewRows,
  runDuplicateCandidateReviewModule,
  type DuplicateAutomationCustodyFact,
  type DuplicateCandidateCaseFact,
} from "../lib/recruiting-ops/modules/t15-duplicate-candidate-review"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t15-"))
  roots.push(root)
  return root
}

const duplicateCases: DuplicateCandidateCaseFact[] = [
  {
    caseId: "dup_1",
    primaryApplicationId: "app_1",
    duplicateApplicationId: "app_2",
    confidence: 0.92,
    matchSignals: ["same_job", "same_identity_hash"],
    owner: "Jordan",
  },
]

const capturedCustody: DuplicateAutomationCustodyFact[] = [
  {
    workflowId: "duplicate_candidate_n8n",
    workflowExportStatus: "captured",
    mailgunCredentialStatus: "captured",
    owner: "Jordan",
  },
]

describe("T15 duplicate candidate review module", () => {
  test("declares the expected workflow, artifact, and output contracts", () => {
    expect(duplicateCandidateReviewModuleDefinition).toEqual({
      moduleId: "t15-duplicate-candidate-review",
      workflowId: "T15",
      capabilityId: "candidate_identity_resolution",
      title: "T15 Duplicate Candidate Check Agent",
      sourceIds: ["greenhouse", "n8n", "mailgun"],
      queryIds: [],
      legacyArtifactIds: ["legacy_duplicate_candidate_n8n_workflow"],
      outputContractIds: ["duplicate_candidate_review_queue"],
    })
  })

  test("normalizes duplicate cases into review queue rows without contact fields", () => {
    expect(
      normalizeDuplicateCandidateReviewRows({
        duplicateCases,
        custodyFacts: capturedCustody,
      })
    ).toEqual([
      {
        case_id: "dup_1",
        primary_application_id: "app_1",
        duplicate_application_id: "app_2",
        confidence: 0.92,
        match_signals: "same_job|same_identity_hash",
        review_status: "ready_for_owner",
        custody_status: "captured",
        owner: "Jordan",
        review_required: true,
      },
    ])
  })

  test("runs locally and writes duplicate review JSON/CSV artifacts", async () => {
    const result = await runDuplicateCandidateReviewModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:34:00.000Z",
      generatedAt: "2026-06-25T00:35:00.000Z",
      duplicateCases,
      custodyFacts: capturedCustody,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(1)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Case ID,Primary application ID,Duplicate application ID,Confidence,Match signals,Review status,Custody status,Owner,Review required"
    )
  })

  test("classifies legacy duplicate workflow differences", async () => {
    const result = await runDuplicateCandidateReviewModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:36:00.000Z",
      generatedAt: "2026-06-25T00:37:00.000Z",
      duplicateCases,
      custodyFacts: capturedCustody,
      legacyRows: [
        {
          case_id: "dup_1",
          review_status: "needs_review",
          confidence: 0.7,
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "stale_mapping",
    ])
  })

  test("blocks cutover when duplicate evidence or n8n/Mailgun custody is missing", async () => {
    const missingCases = await runDuplicateCandidateReviewModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:38:00.000Z",
      generatedAt: "2026-06-25T00:39:00.000Z",
      duplicateCases: [],
      custodyFacts: capturedCustody,
    })
    const missingCustody = await runDuplicateCandidateReviewModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:40:00.000Z",
      generatedAt: "2026-06-25T00:41:00.000Z",
      duplicateCases,
      custodyFacts: [
        {
          ...capturedCustody[0],
          workflowExportStatus: "export_required",
        },
      ],
    })

    expect(missingCases.run.status).toBe("blocked")
    expect(missingCases.run.discrepancySummary.byClass.source_gap).toBe(1)
    expect(missingCustody.run.status).toBe("blocked")
    expect(missingCustody.sourceGaps[0]).toMatchObject({
      field: "custody_status",
      blocksCutover: true,
    })
  })
})
