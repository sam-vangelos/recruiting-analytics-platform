import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "vitest"

import * as RecOps from "../lib/recruiting-ops"
import { capabilityForModule, requiredCapabilityIds } from "../lib/recruiting-ops/capabilities"
import { buildAdminActionProposals } from "../lib/recruiting-ops/modules/s-admin-action-queues"
import { finalizeModuleResult } from "../lib/recruiting-ops/modules/types"
import type { RecruitingOpsModuleDefinition } from "../lib/recruiting-ops/modules/types"
import { requiredWorkflowIds } from "../lib/recruiting-ops/registries"
import type { CommandCenterRun, RunArtifact, SourceGap } from "../lib/recruiting-ops/runs"
import type { Discrepancy } from "../lib/recruiting-ops/discrepancies"

function looksLikeModuleDefinition(value: unknown): value is RecruitingOpsModuleDefinition {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.moduleId === "string" &&
    typeof obj.workflowId === "string" &&
    Array.isArray(obj.outputContractIds) &&
    Array.isArray(obj.queryIds)
  )
}

function collectModuleDefinitions(): RecruitingOpsModuleDefinition[] {
  const found = new Map<string, RecruitingOpsModuleDefinition>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || !value || typeof value !== "object") return
    if (looksLikeModuleDefinition(value)) {
      found.set(value.moduleId, value)
      return
    }
    for (const nested of Object.values(value as Record<string, unknown>)) visit(nested, depth + 1)
  }
  for (const exported of Object.values(RecOps)) visit(exported, 0)
  return [...found.values()]
}

const MODULES_DIR = join(__dirname, "..", "lib", "recruiting-ops", "modules")

function moduleImplementationFiles(): string[] {
  return readdirSync(MODULES_DIR)
    .filter((name) => name.endsWith(".ts") && name !== "types.ts")
    .sort()
}

const definition: RecruitingOpsModuleDefinition = {
  moduleId: "fixture-module",
  capabilityId: "scorecard_accountability",
  workflowId: "T05",
  title: "fixture",
  sourceIds: ["greenhouse"],
  queryIds: ["Q11"],
  legacyArtifactIds: ["legacy_q11_rps_tracking"],
  outputContractIds: ["rps_tracking_sheet"],
}

describe("capability binding on module-produced records", () => {
  test("finalizeModuleResult stamps capabilityId on run, source gaps, discrepancies, and artifacts", () => {
    const run = { runId: "r1", workflowId: "T05", moduleId: "fixture-module" } as unknown as CommandCenterRun
    const sourceGaps = [{ id: "g1", workflowId: "T05" } as unknown as SourceGap]
    const discrepancies = [{ id: "d1", workflowId: "T05" } as unknown as Discrepancy]
    const artifacts = [{ artifactId: "a1", workflowId: "T05" } as unknown as RunArtifact]

    const result = finalizeModuleResult({
      definition,
      normalizedRows: [{ x: 1 }],
      artifacts,
      discrepancies,
      sourceGaps,
      run,
    })

    expect(result.run.capabilityId).toBe("scorecard_accountability")
    for (const gap of result.sourceGaps) expect(gap.capabilityId).toBe("scorecard_accountability")
    for (const discrepancy of result.discrepancies) expect(discrepancy.capabilityId).toBe("scorecard_accountability")
    for (const artifact of result.artifacts) expect(artifact.capabilityId).toBe("scorecard_accountability")
  })

  test("admin action proposals carry the capability that produced them", () => {
    const proposals = buildAdminActionProposals(
      [
        {
          workflowId: "S01",
          targetReference: "req-1234",
          targetSystem: "greenhouse",
          actionType: "requisition_open",
          actor: "Jordan",
          reason: "Open the requisition once the approval evidence is attached.",
          riskTier: "medium",
          approvalState: "needs_review",
          evidenceRefs: ["evidence-1"],
          proposedPayload: { req: "1234" },
          createdAt: "2026-06-24T00:00:00.000Z",
        },
      ],
      "requisition_lifecycle_control"
    )

    expect(proposals).toHaveLength(1)
    expect(proposals[0].capabilityId).toBe("requisition_lifecycle_control")
  })

  test("every runnable module routes its result through finalizeModuleResult", () => {
    const offenders: string[] = []
    for (const file of moduleImplementationFiles()) {
      const text = readFileSync(join(MODULES_DIR, file), "utf8")
      if (!text.includes("RecruitingOpsModuleResult")) continue
      if (!text.includes("finalizeModuleResult(")) offenders.push(file)
    }
    expect(offenders, `modules bypassing finalizeModuleResult: ${offenders.join(", ")}`).toEqual([])
  })

  test("every runnable module binds a capabilityId (literal or positional)", () => {
    const offenders: string[] = []
    for (const file of moduleImplementationFiles()) {
      const text = readFileSync(join(MODULES_DIR, file), "utf8")
      if (!text.includes("RecruitingOpsModuleDefinition")) continue
      // `capabilityId: "x"` literal, or a shorthand `capabilityId,` fed positionally through a config factory.
      if (!/\bcapabilityId\s*[,:]/.test(text)) offenders.push(file)
    }
    expect(offenders, `modules not binding a capabilityId: ${offenders.join(", ")}`).toEqual([])
  })

  test("the admin queue threads its capability into proposals", () => {
    const text = readFileSync(join(MODULES_DIR, "s-admin-action-queues.ts"), "utf8")
    expect(text).toMatch(/buildAdminActionProposals\(\s*scopedActionRequests,\s*cfg\.definition\.capabilityId\s*\)/)
  })

  test("every module definition binds to the capability that owns it", () => {
    const definitions = collectModuleDefinitions()
    const coveredWorkflowIds = new Set(definitions.map((definition) => definition.workflowId))
    for (const workflowId of requiredWorkflowIds) {
      expect(coveredWorkflowIds.has(workflowId), workflowId).toBe(true)
    }
    for (const definition of definitions) {
      expect(requiredCapabilityIds, definition.moduleId).toContain(definition.capabilityId)
      expect(capabilityForModule(definition.moduleId)?.capabilityId, definition.moduleId).toBe(definition.capabilityId)
    }
  })
})
