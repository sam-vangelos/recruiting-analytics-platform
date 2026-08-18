import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  deriveHandoffReadinessStatus,
  handoffPreparationModuleDefinition,
  normalizeHandoffReadinessRows,
  normalizeSamSignoffStatus,
  runHandoffPreparationModule,
  type HandoffReadinessFact,
  type SamSignoffFact,
} from "../lib/recruiting-ops/modules/t20-t21-handoff-preparation"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t20-t21-"))
  roots.push(root)
  return root
}

const readinessFacts: HandoffReadinessFact[] = [
  {
    areaId: "workflow_coverage",
    areaName: "Workflow coverage",
    category: "workflow",
    status: "ready",
    owner: "Jordan",
    evidenceIds: ["t01", "t07", "t19"],
    blockerCount: 0,
    acceptanceRequired: true,
  },
]

const samSignoffs: SamSignoffFact[] = [
  {
    areaId: "workflow_coverage",
    status: "signed off",
    signedAt: "2026-06-25T04:00:00.000Z",
  },
]

describe("T20/T21 handoff preparation module", () => {
  test("declares the expected workflow, artifact, and output contracts", () => {
    expect(handoffPreparationModuleDefinition).toEqual({
      moduleId: "t20-t21-handoff-preparation",
      workflowId: "T20/T21",
      capabilityId: "transition_readiness_control",
      title: "T20/T21 the operator Handoff Preparation",
      sourceIds: ["google_sheets", "google_docs"],
      queryIds: [],
      legacyArtifactIds: ["legacy_handoff_readiness_tracker"],
      outputContractIds: ["handoff_readiness_dashboard"],
    })
  })

  test("normalizes readiness facts into accepted dashboard rows", () => {
    expect(normalizeHandoffReadinessRows({ readinessFacts, samSignoffs })).toEqual([
      {
        area_id: "workflow_coverage",
        area_name: "Workflow coverage",
        category: "workflow",
        readiness_status: "accepted",
        sam_signoff_status: "accepted",
        owner: "Jordan",
        evidence_count: 3,
        blocker_count: 0,
        acceptance_required: true,
        next_gate: "Preserve evidence package; do not cut over or retire without explicit approval.",
        review_required: false,
      },
    ])
  })

  test("derives readiness status from evidence, blockers, and the operator signoff", () => {
    expect(normalizeSamSignoffStatus("signed off")).toBe("accepted")
    expect(normalizeSamSignoffStatus("waiting")).toBe("pending")
    expect(deriveHandoffReadinessStatus({ ...readinessFacts[0], evidenceIds: [] }, "accepted")).toBe(
      "needs_evidence"
    )
    expect(deriveHandoffReadinessStatus({ ...readinessFacts[0], blockerCount: 1 }, "accepted")).toBe("blocked")
    expect(deriveHandoffReadinessStatus(readinessFacts[0], "pending")).toBe("ready")
  })

  test("runs locally and writes handoff readiness JSON/CSV artifacts", async () => {
    const result = await runHandoffPreparationModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T04:10:00.000Z",
      generatedAt: "2026-06-25T04:11:00.000Z",
      readinessFacts,
      samSignoffs,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.run.runId).toContain("t20_t21")
    expect(result.normalizedRows).toHaveLength(1)
    expect(result.normalizedRows[0].readiness_status).toBe("accepted")
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Area ID,Area name,Category,Readiness status,the operator signoff status,Owner,Evidence count,Blocker count,Acceptance required,Next gate,Review required"
    )
  })

  test("classifies legacy readiness state differences", async () => {
    const result = await runHandoffPreparationModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T04:12:00.000Z",
      generatedAt: "2026-06-25T04:13:00.000Z",
      readinessFacts,
      samSignoffs,
      legacyRows: [
        {
          area_id: "workflow_coverage",
          readiness_status: "ready",
          sam_signoff_status: "pending",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class)).toEqual([
      "business_definition_open",
      "business_definition_open",
    ])
  })

  test("blocks closeout when evidence, blockers, or the operator signoff are unresolved", async () => {
    const result = await runHandoffPreparationModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T04:14:00.000Z",
      generatedAt: "2026-06-25T04:15:00.000Z",
      readinessFacts: [
        {
          ...readinessFacts[0],
          owner: "",
          evidenceIds: [],
          blockerCount: 1,
        },
      ],
      samSignoffs: [],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.sourceGaps.map((gap) => gap.field).sort()).toEqual([
      "blocker_count",
      "evidence_count",
      "owner",
      "sam_signoff_status",
    ])
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(4)
  })
})
