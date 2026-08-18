import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { createLocalPiiFingerprint } from "../lib/recruiting-ops/checksums"
import { runOwnershipCapacityShadow } from "../lib/recruiting-ops/modules/ownership-capacity-shadow"
import { runRecruiterWeeklyReqProgressShadow } from "../lib/recruiting-ops/modules/recruiter-weekly-req-progress-shadow"
import { runScorecardAccountabilityShadow } from "../lib/recruiting-ops/modules/scorecard-accountability-shadow"
import type { GreenhousePipelineStageFact } from "../lib/recruiting-ops/modules/t02-pipeline"
import type { GreenhouseRpsFact } from "../lib/recruiting-ops/modules/t05-rps"
import type { GreenhouseOwnershipFact } from "../lib/recruiting-ops/modules/t09-ownership"

// REGRESSION LOCK (was RED SPEC) — population P3: trust/idempotency inputs are caller-supplied constants,
// never read back from the module's own delivery ledger.
// (the internal control-plane excavation audit (2026-06-26) §3 P3, SHADOW-MODULES-6.)
//
// recruiter-weekly-req-progress-shadow.ts hardcodes the idempotency window:
//   priorPayloadFingerprintsInWindow: input.priorPayloadFingerprintsInWindow ?? []
// and never reads the ledger it just appended to. The idempotency GATE is correct in
// isolation (delivery-gates.ts evaluateIdempotencyGate). The defect is at the CALL SITE:
// no prior-fingerprint window is ever sourced from history, so a duplicate delivery is
// never caught. This spec targets the module/run, NOT evaluateDeliveryGates.
//
// FIX (P3): before evaluation, the module must read its own ledger (same rootDir +
// deliverableId), collect payloadFingerprints already authorized/shadowed in the cadence
// window, and feed them as priorPayloadFingerprintsInWindow. Then a second identical run
// into the same ledger root is idempotency-blocked.
//
// Type-valid (uses only existing exported members) and FAILS on HEAD by AssertionError:
// on HEAD the second run is authorized_for_shadow and the ledger holds two shadowed entries
// for the same payloadFingerprint.

const fixtureRoot = join(process.cwd(), "test", "fixtures", "recruiting-ops")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-red-shadow-idempotency-"))
  roots.push(root)
  return root
}

function pipelineFacts(): GreenhousePipelineStageFact[] {
  return JSON.parse(readFileSync(join(fixtureRoot, "greenhouse-pipeline.json"), "utf8")) as GreenhousePipelineStageFact[]
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

describe("P3: a duplicate shadow delivery into the same ledger must be idempotency-blocked", () => {
  test("second identical run is blocked and the ledger does not authorize the same payload twice", async () => {
    const rootDir = tempRoot()

    const first = await runRecruiterWeeklyReqProgressShadow({ ...baseInput, rootDir })
    const second = await runRecruiterWeeklyReqProgressShadow({ ...baseInput, rootDir })

    // The two runs render identical payloads (deterministic fingerprint), so the second
    // is a duplicate delivery within the cadence window.
    expect(second.deliveryLedgerEntry.payloadFingerprint).toBe(first.deliveryLedgerEntry.payloadFingerprint)

    // Call-site contract after the fix: the second run must catch the collision.
    const idempotencyBlocked =
      second.gateEvaluation.failedGateIds.includes("idempotency") ||
      second.gateEvaluation.verdict === "blocked" ||
      second.gateEvaluation.verdict === "paused"
    expect(idempotencyBlocked).toBe(true)

    // Independent ledger-file check: the same payloadFingerprint must not be authorized
    // (shadowed) twice. Read both runs back off disk.
    const fingerprint = first.deliveryLedgerEntry.payloadFingerprint
    const ledgerLines = readFileSync(first.deliveryLedgerPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { status: string; payloadFingerprint: string })

    const authorizedShadowEntriesForPayload = ledgerLines.filter(
      (row) => row.payloadFingerprint === fingerprint && row.status === "shadowed"
    )
    expect(authorizedShadowEntriesForPayload.length).toBeLessThanOrEqual(1)
  })

  // The P3 fix is a CLASS fix across all three shadow modules; each one is locked here
  // (a lens verified that reverting the unlocked modules left the whole suite green).

  test("ownership shadow: second identical run into the same ledger root is idempotency-blocked", async () => {
    const rootDir = tempRoot()
    const facts = JSON.parse(
      readFileSync(join(fixtureRoot, "greenhouse-ownership.json"), "utf8")
    ) as GreenhouseOwnershipFact[]
    const input = {
      rootDir,
      startedAt: "2026-06-24T14:00:00.000Z",
      generatedAt: "2026-06-24T14:01:00.000Z",
      greenhouseFacts: facts,
      ownershipScope: {
        recipientFingerprint: createLocalPiiFingerprint("ownership_fixture_alpha", "test_recipient"),
        teamName: "Team Avery",
      },
    }

    const first = await runOwnershipCapacityShadow(input)
    const second = await runOwnershipCapacityShadow({ ...input, startedAt: "2026-06-24T14:05:00.000Z" })

    expect(second.deliveryLedgerEntry.payloadFingerprint).toBe(first.deliveryLedgerEntry.payloadFingerprint)
    expect(
      second.gateEvaluation.failedGateIds.includes("idempotency") ||
        second.gateEvaluation.verdict === "blocked" ||
        second.gateEvaluation.verdict === "paused"
    ).toBe(true)
  })

  test("scorecard shadow: second identical run into the same ledger root is idempotency-blocked", async () => {
    const rootDir = tempRoot()
    const facts = JSON.parse(
      readFileSync(join(fixtureRoot, "greenhouse-rps.json"), "utf8")
    ) as GreenhouseRpsFact[]
    const input = {
      rootDir,
      startedAt: "2026-06-24T13:00:00.000Z",
      generatedAt: "2026-06-24T13:01:00.000Z",
      greenhouseFacts: facts,
      scorecardScope: {
        recipientFingerprint: createLocalPiiFingerprint("scorecard_fixture_alpha", "test_recipient"),
        jobIds: ["job_fixture_1"],
      },
    }

    const first = await runScorecardAccountabilityShadow(input)
    const second = await runScorecardAccountabilityShadow({ ...input, startedAt: "2026-06-24T13:05:00.000Z" })

    expect(second.deliveryLedgerEntry.payloadFingerprint).toBe(first.deliveryLedgerEntry.payloadFingerprint)
    expect(
      second.gateEvaluation.failedGateIds.includes("idempotency") ||
        second.gateEvaluation.verdict === "blocked" ||
        second.gateEvaluation.verdict === "paused"
    ).toBe(true)
  })
})
