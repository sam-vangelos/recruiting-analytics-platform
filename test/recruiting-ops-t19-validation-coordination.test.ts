import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  deriveValidationStatus,
  normalizeAttestationStatus,
  normalizeValidationSignoffRows,
  runValidationCoordinationModule,
  validationCoordinationModuleDefinition,
  type OwnerAttestationFact,
  type ValidationTargetFact,
} from "../lib/recruiting-ops/modules/t19-validation-coordination"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t19-"))
  roots.push(root)
  return root
}

const validationTargets: ValidationTargetFact[] = [
  {
    targetId: "t07_shadow_run",
    workflowId: "T07",
    moduleId: "t07-final-offer",
    runId: "t07_20260625030000000",
    owner: "Jordan",
    evidenceIds: ["artifact_1", "disc_1"],
    openDiscrepancyCount: 0,
    blockingCount: 0,
    sourceGapCount: 0,
  },
]

const attestations: OwnerAttestationFact[] = [
  {
    targetId: "t07_shadow_run",
    owner: "Jordan",
    status: "signed off",
    attestedAt: "2026-06-25T03:20:00.000Z",
  },
]

describe("T19 validation coordination module", () => {
  test("declares the expected workflow, artifact, and output contracts", () => {
    expect(validationCoordinationModuleDefinition).toEqual({
      moduleId: "t19-validation-coordination",
      workflowId: "T19",
      capabilityId: "transition_readiness_control",
      title: "T19 Validation Coordination",
      sourceIds: ["slack", "google_sheets"],
      queryIds: [],
      legacyArtifactIds: ["legacy_validation_coordination_log"],
      outputContractIds: ["validation_signoff_log"],
    })
  })

  test("normalizes validation targets into signoff rows", () => {
    expect(normalizeValidationSignoffRows({ validationTargets, attestations })).toEqual([
      {
        target_id: "t07_shadow_run",
        workflow_id: "T07",
        run_id: "t07_20260625030000000",
        validation_status: "accepted",
        attestation_status: "accepted",
        owner: "Jordan",
        evidence_count: 2,
        open_discrepancy_count: 0,
        blocking_count: 0,
        source_gap_count: 0,
        next_gate: "Ready for next gated module or shadow-run evidence package.",
        review_required: false,
      },
    ])
  })

  test("derives validation status from evidence, blockers, and attestation", () => {
    expect(normalizeAttestationStatus("signed off")).toBe("accepted")
    expect(normalizeAttestationStatus("waiting")).toBe("pending")
    expect(deriveValidationStatus({ ...validationTargets[0], evidenceIds: [] }, "accepted")).toBe("missing_evidence")
    expect(deriveValidationStatus({ ...validationTargets[0], blockingCount: 1 }, "accepted")).toBe("blocked")
    expect(deriveValidationStatus({ ...validationTargets[0], openDiscrepancyCount: 1 }, "pending")).toBe("needs_review")
  })

  test("runs locally and writes validation JSON/CSV artifacts", async () => {
    const result = await runValidationCoordinationModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T03:30:00.000Z",
      generatedAt: "2026-06-25T03:31:00.000Z",
      validationTargets,
      attestations,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(1)
    expect(result.normalizedRows[0].validation_status).toBe("accepted")
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Target ID,Workflow ID,Run ID,Validation status,Attestation status,Owner,Evidence count,Open discrepancies,Blocking count,Source gaps,Next gate,Review required"
    )
  })

  test("classifies legacy validation state differences", async () => {
    const result = await runValidationCoordinationModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T03:32:00.000Z",
      generatedAt: "2026-06-25T03:33:00.000Z",
      validationTargets,
      attestations,
      legacyRows: [
        {
          target_id: "t07_shadow_run",
          validation_status: "needs_review",
          attestation_status: "pending",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class)).toEqual([
      "business_definition_open",
      "business_definition_open",
    ])
  })

  test("blocks cutover when evidence or owner attestation is missing", async () => {
    const result = await runValidationCoordinationModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T03:34:00.000Z",
      generatedAt: "2026-06-25T03:35:00.000Z",
      validationTargets: [
        {
          ...validationTargets[0],
          owner: "",
          evidenceIds: [],
        },
      ],
      attestations: [],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.sourceGaps.map((gap) => gap.field).sort()).toEqual([
      "attestation_status",
      "evidence_count",
      "owner",
    ])
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(3)
  })
})
