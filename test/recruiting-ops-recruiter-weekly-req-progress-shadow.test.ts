import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { getDeliverableAutomationSeed } from "../lib/recruiting-ops/automation-seed-matrix"
import { createLocalPiiFingerprint } from "../lib/recruiting-ops/checksums"
import { evaluateDeliveryGates } from "../lib/recruiting-ops/delivery-gates"
import {
  recruiterWeeklyReqProgressShadowDefinition,
  runRecruiterWeeklyReqProgressShadow,
} from "../lib/recruiting-ops/modules/recruiter-weekly-req-progress-shadow"
import { assertPublicSafe } from "../lib/recruiting-ops/safe-public-output"
import type { GreenhousePipelineStageFact } from "../lib/recruiting-ops/modules/t02-pipeline"

const fixtureRoot = join(process.cwd(), "test", "fixtures", "recruiting-ops")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-shadow-progress-"))
  roots.push(root)
  return root
}

function readFixture<T>(fileName: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, fileName), "utf8")) as T
}

function pipelineFacts(): GreenhousePipelineStageFact[] {
  return readFixture("greenhouse-pipeline.json")
}

const baseInput = {
  startedAt: "2026-06-24T12:00:00.000Z",
  generatedAt: "2026-06-24T12:01:00.000Z",
  greenhouseFacts: pipelineFacts(),
  recruiterScope: {
    recipientFingerprint: createLocalPiiFingerprint("recruiter_fixture_alpha", "test_recipient"),
    reqIds: ["890"],
  },
}

describe("recruiter weekly req progress shadow deliverable", () => {
  test("declares a capability-bound local shadow module", () => {
    expect(recruiterWeeklyReqProgressShadowDefinition).toMatchObject({
      moduleId: "recruiter-weekly-req-progress-shadow",
      workflowId: "T03",
      capabilityId: "pipeline_movement_intelligence",
      outputContractIds: ["weekly_progress_sheet"],
    })
  })

  test("fixture run produces local JSON/CSV artifacts and a JSONL shadow delivery log", async () => {
    const result = await runRecruiterWeeklyReqProgressShadow({
      ...baseInput,
      rootDir: tempRoot(),
    })

    expect(result.run.mode).toBe("shadow")
    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toEqual([
      {
        req_group: "req_890",
        stage_name: "application_review",
        core_stage: "Application Review",
        movement_count: 1,
        week_bucket: "2026-06-15",
      },
      {
        req_group: "req_890",
        stage_name: "recruiter_screen",
        core_stage: "Recruiter Phone Screen",
        movement_count: 1,
        week_bucket: "2026-06-15",
      },
    ])
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    for (const artifact of result.artifacts) expect(existsSync(artifact.path)).toBe(true)
    expect(existsSync(result.deliveryLedgerPath)).toBe(true)

    const ledgerRows = readFileSync(result.deliveryLedgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0]).toMatchObject({
      eventType: "shadow_run",
      deliverableId: "weekly_progress_sheet",
      capabilityId: "pipeline_movement_intelligence",
      status: "shadowed",
      deliveryMechanism: "local_jsonl",
      recipientFingerprint: baseInput.recruiterScope.recipientFingerprint,
    })
    expect(JSON.stringify(ledgerRows[0])).not.toMatch(/@|candidate_email|phone/i)
  })

  test("gate evaluator authorizes shadow but not production delivery", async () => {
    const result = await runRecruiterWeeklyReqProgressShadow({
      ...baseInput,
      rootDir: tempRoot(),
    })
    const autoResult = evaluateDeliveryGates({
      contract: getDeliverableAutomationSeed("weekly_progress_sheet"),
      runId: result.run.runId,
      commandCenterMode: "local",
      requestedDeliveryMode: "auto_delivery",
      autonomyState: "auto_eligible",
      readinessState: "ready_for_delivery",
      evaluatedAt: baseInput.generatedAt,
      sourceObservedAt: "2026-06-18T10:00:00.000Z",
      recipientFingerprint: baseInput.recruiterScope.recipientFingerprint,
      payloadFingerprint: result.deliveryLedgerEntry.payloadFingerprint,
      templateHash: "sha256:template",
      approvedTemplateHash: "sha256:template",
      recipientScopeRuleId: "recruiter_scoped_visibility",
      recipientScopePass: true,
      publicSummary: result.run.publicSummary,
      artifactIds: result.artifacts.map((artifact) => artifact.artifactId),
      gateEvidenceRefs: result.run.sourceRefs.map((ref) => ref.id),
      blockingDiscrepancyCount: 0,
      businessDefinitionOpenCount: 0,
      blockingSourceGapCount: 0,
      priorPayloadFingerprintsInWindow: [],
      shadowRunsCompleted: 1,
      cleanShadowRuns: 1,
      killSwitches: [],
      externalDeliveryAdapterApproved: false,
    })

    expect(result.gateEvaluation.verdict).toBe("authorized_for_shadow")
    expect(autoResult.verdict).toBe("paused")
    expect(autoResult.failedGateIds).toContain("boundary")
  })

  test("public summaries are PII-safe and payload fingerprinting is deterministic", async () => {
    const first = await runRecruiterWeeklyReqProgressShadow({
      ...baseInput,
      rootDir: tempRoot(),
    })
    const second = await runRecruiterWeeklyReqProgressShadow({
      ...baseInput,
      rootDir: tempRoot(),
    })

    expect(() => assertPublicSafe(first.run.publicSummary)).not.toThrow()
    expect(() => assertPublicSafe(first.deliveryLedgerEntry.publicSummary)).not.toThrow()
    expect(first.deliveryLedgerEntry.payloadFingerprint).toMatch(/^hmac-sha256:/)
    expect(first.deliveryLedgerEntry.payloadFingerprint).toBe(second.deliveryLedgerEntry.payloadFingerprint)
  })

  test("uses only scoped payload rows for freshness so unrelated fresh rows cannot rescue stale output", async () => {
    const result = await runRecruiterWeeklyReqProgressShadow({
      ...baseInput,
      rootDir: tempRoot(),
      generatedAt: "2026-06-24T12:01:00.000Z",
      greenhouseFacts: [
        {
          applicationId: "app_stale",
          jobId: "job_890",
          reqId: "890",
          stageName: "Application Review",
          stageChangedAt: "2026-06-01T10:00:00.000Z",
        },
        {
          applicationId: "app_fresh_unrelated",
          jobId: "job_999",
          reqId: "999",
          stageName: "Application Review",
          stageChangedAt: "2026-06-24T12:00:00.000Z",
        },
      ],
    })

    expect(result.normalizedRows).toHaveLength(1)
    expect(result.gateEvaluation.gateResults.find((gate) => gate.gateId === "freshness")).toMatchObject({
      status: "fail",
    })
    expect(result.gateEvaluation.verdict).toBe("blocked")
  })

  test("fails freshness when scoped source timestamps are missing — the contract requires freshness even in shadow (P2)", async () => {
    const result = await runRecruiterWeeklyReqProgressShadow({
      ...baseInput,
      rootDir: tempRoot(),
      greenhouseFacts: [
        {
          applicationId: "app_missing_time",
          jobId: "job_890",
          reqId: "890",
          stageName: "Application Review",
          stageChangedAt: "",
        },
      ],
    })

    expect(result.normalizedRows).toEqual([])
    expect(result.sourceGaps.some((gap) => gap.field === "stage_changed_at")).toBe(true)
    expect(result.gateEvaluation.gateResults.find((gate) => gate.gateId === "freshness")).toMatchObject({
      status: "fail",
    })
    expect(result.gateEvaluation.failedGateIds).toContain("freshness")
  })
})
