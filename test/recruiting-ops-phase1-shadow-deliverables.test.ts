import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { getDeliverableAutomationSeed } from "../lib/recruiting-ops/automation-seed-matrix"
import { createLocalPiiFingerprint } from "../lib/recruiting-ops/checksums"
import { evaluateDeliveryGates } from "../lib/recruiting-ops/delivery-gates"
import {
  ownershipCapacityShadowDefinition,
  runOwnershipCapacityShadow,
} from "../lib/recruiting-ops/modules/ownership-capacity-shadow"
import {
  scorecardAccountabilityShadowDefinition,
  runScorecardAccountabilityShadow,
} from "../lib/recruiting-ops/modules/scorecard-accountability-shadow"
import { assertPublicSafe } from "../lib/recruiting-ops/safe-public-output"
import type { GreenhouseRpsFact } from "../lib/recruiting-ops/modules/t05-rps"
import type { GreenhouseOwnershipFact } from "../lib/recruiting-ops/modules/t09-ownership"

const fixtureRoot = join(process.cwd(), "test", "fixtures", "recruiting-ops")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-phase1-shadow-"))
  roots.push(root)
  return root
}

function readFixture<T>(fileName: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, fileName), "utf8")) as T
}

function rpsFacts(): GreenhouseRpsFact[] {
  return readFixture("greenhouse-rps.json")
}

function ownershipFacts(): GreenhouseOwnershipFact[] {
  return readFixture("greenhouse-ownership.json")
}

const scorecardRecipientFingerprint = createLocalPiiFingerprint("scorecard_fixture_alpha", "test_recipient")
const ownershipRecipientFingerprint = createLocalPiiFingerprint("ownership_fixture_alpha", "test_recipient")

describe("Phase 1 fixture-backed shadow deliverables", () => {
  test("declares capability-bound scorecard and ownership shadow modules", () => {
    expect(scorecardAccountabilityShadowDefinition).toMatchObject({
      moduleId: "scorecard-accountability-shadow",
      workflowId: "T05",
      capabilityId: "scorecard_accountability",
      outputContractIds: ["rps_tracking_sheet"],
    })
    expect(ownershipCapacityShadowDefinition).toMatchObject({
      moduleId: "ownership-capacity-shadow",
      workflowId: "T09",
      capabilityId: "ownership_capacity_management",
      outputContractIds: ["role_assignment_sheet"],
    })
  })

  test("scorecard accountability shadow run writes artifacts and a local JSONL ledger entry", async () => {
    const result = await runScorecardAccountabilityShadow({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T13:00:00.000Z",
      generatedAt: "2026-06-24T13:01:00.000Z",
      greenhouseFacts: rpsFacts(),
      scorecardScope: {
        recipientFingerprint: scorecardRecipientFingerprint,
        jobIds: ["job_fixture_1"],
      },
    })

    expect(result.run.mode).toBe("shadow")
    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(1)
    expect(result.normalizedRows[0]).toMatchObject({
      job_id: "job_fixture_1",
      interview_stage: "rps",
      scorecard_status: "missing",
    })
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    for (const artifact of result.artifacts) expect(existsSync(artifact.path)).toBe(true)
    expect(existsSync(result.deliveryLedgerPath)).toBe(true)

    const ledgerRows = readFileSync(result.deliveryLedgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0]).toMatchObject({
      eventType: "shadow_run",
      deliverableId: "rps_tracking_sheet",
      capabilityId: "scorecard_accountability",
      status: "shadowed",
      deliveryMechanism: "local_jsonl",
      recipientFingerprint: scorecardRecipientFingerprint,
    })
    expect(JSON.stringify(ledgerRows[0])).not.toMatch(/@|candidate_email|phone/i)
  })

  test("ownership capacity shadow run writes artifacts and a local JSONL ledger entry", async () => {
    const result = await runOwnershipCapacityShadow({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T14:00:00.000Z",
      generatedAt: "2026-06-24T14:01:00.000Z",
      greenhouseFacts: ownershipFacts(),
      ownershipScope: {
        recipientFingerprint: ownershipRecipientFingerprint,
        teamName: "Team Avery",
      },
    })

    expect(result.run.mode).toBe("shadow")
    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(2)
    expect(result.run.publicSummary).toMatchObject({
      deliverableId: "role_assignment_sheet",
      teamId: "team_avery",
      jobRowCount: 1,
      recruiterRowCount: 1,
      totalOpenings: 2,
    })
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    for (const artifact of result.artifacts) expect(existsSync(artifact.path)).toBe(true)
    expect(existsSync(result.deliveryLedgerPath)).toBe(true)

    const ledgerRows = readFileSync(result.deliveryLedgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0]).toMatchObject({
      eventType: "shadow_run",
      deliverableId: "role_assignment_sheet",
      capabilityId: "ownership_capacity_management",
      status: "shadowed",
      deliveryMechanism: "local_jsonl",
      recipientFingerprint: ownershipRecipientFingerprint,
    })
    expect(JSON.stringify(ledgerRows[0])).not.toMatch(/@|candidate_email|phone/i)
  })

  test("ownership freshness uses source-observed timestamps and blocks stale shadow data", async () => {
    const staleFacts = ownershipFacts().map((fact) => ({
      ...fact,
      observedAt: "2026-06-01T00:00:00.000Z",
    }))
    const result = await runOwnershipCapacityShadow({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T14:30:00.000Z",
      generatedAt: "2026-06-24T14:31:00.000Z",
      greenhouseFacts: staleFacts,
      ownershipScope: {
        recipientFingerprint: ownershipRecipientFingerprint,
        teamName: "Team Avery",
      },
    })
    const freshness = result.gateEvaluation.gateResults.find((gate) => gate.gateId === "freshness")

    expect(freshness).toMatchObject({
      gateId: "freshness",
      status: "fail",
    })
    expect(result.gateEvaluation.failedGateIds).toContain("freshness")
    expect(result.gateEvaluation.verdict).toBe("blocked")
    expect(result.deliveryLedgerEntry.status).toBe("blocked")
  })

  test("readiness does not authorize production delivery for Phase 1 shadow outputs", async () => {
    const result = await runScorecardAccountabilityShadow({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T15:00:00.000Z",
      generatedAt: "2026-06-24T15:01:00.000Z",
      greenhouseFacts: rpsFacts(),
      scorecardScope: {
        recipientFingerprint: scorecardRecipientFingerprint,
        jobIds: ["job_fixture_1"],
      },
    })
    const autoResult = evaluateDeliveryGates({
      contract: getDeliverableAutomationSeed("rps_tracking_sheet"),
      runId: result.run.runId,
      commandCenterMode: "local",
      requestedDeliveryMode: "auto_delivery",
      autonomyState: "auto_eligible",
      readinessState: "ready_for_delivery",
      evaluatedAt: "2026-06-24T15:01:00.000Z",
      sourceObservedAt: "2026-06-18T17:00:00.000Z",
      recipientFingerprint: scorecardRecipientFingerprint,
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

  test("public summaries are PII-safe and payload fingerprints are deterministic", async () => {
    const firstScorecard = await runScorecardAccountabilityShadow({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T16:00:00.000Z",
      generatedAt: "2026-06-24T16:01:00.000Z",
      greenhouseFacts: rpsFacts(),
      scorecardScope: {
        recipientFingerprint: scorecardRecipientFingerprint,
        jobIds: ["job_fixture_1"],
      },
    })
    const secondScorecard = await runScorecardAccountabilityShadow({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T16:00:00.000Z",
      generatedAt: "2026-06-24T16:01:00.000Z",
      greenhouseFacts: rpsFacts(),
      scorecardScope: {
        recipientFingerprint: scorecardRecipientFingerprint,
        jobIds: ["job_fixture_1"],
      },
    })
    const ownership = await runOwnershipCapacityShadow({
      rootDir: tempRoot(),
      startedAt: "2026-06-24T16:30:00.000Z",
      generatedAt: "2026-06-24T16:31:00.000Z",
      greenhouseFacts: ownershipFacts(),
      ownershipScope: {
        recipientFingerprint: ownershipRecipientFingerprint,
        teamName: "Team Avery",
      },
    })

    expect(() => assertPublicSafe(firstScorecard.run.publicSummary)).not.toThrow()
    expect(() => assertPublicSafe(firstScorecard.deliveryLedgerEntry.publicSummary)).not.toThrow()
    expect(() => assertPublicSafe(ownership.run.publicSummary)).not.toThrow()
    expect(() => assertPublicSafe(ownership.deliveryLedgerEntry.publicSummary)).not.toThrow()
    expect(firstScorecard.deliveryLedgerEntry.payloadFingerprint).toBe(
      secondScorecard.deliveryLedgerEntry.payloadFingerprint
    )
  })
})
