import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  LOCAL_DELIVERY_LEDGER_MECHANISM,
  appendLocalDeliveryLedgerEntry,
  buildDeliveryLogId,
  collectShadowLedgerHistory,
  type LocalDeliveryLedgerEntry,
} from "../lib/recruiting-ops/delivery-ledger"

/**
 * REGRESSION LOCK (was RED SPEC) — P8 / SAFETY-GATES-7: delivery ledger append integrity.
 *
 * The append path (`appendLocalDeliveryLedgerEntry`) writes one JSONL line per call
 * with no read of prior entries. Consequently:
 *   (1) Re-appending the SAME entry (same deliveryLogId) produces a duplicate line —
 *       the append is non-idempotent.
 *   (2) An entry whose `correctionOf` references a deliveryLogId that was never written
 *       is accepted silently — referential integrity is only enforced by the opt-in
 *       `validateDeliveryLedgerLineage`, which the write path never calls.
 *
 * Both should be guarded ON THE WRITE PATH after the fix. These assertions encode the
 * post-fix contract and FAIL on HEAD by AssertionError.
 */

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-ledger-integrity-red-"))
  roots.push(root)
  return root
}

const baseEntry: LocalDeliveryLedgerEntry = {
  deliveryLogId: buildDeliveryLogId("weekly_progress_sheet", "t03_20260625070000000", "shadow_run"),
  eventType: "shadow_run",
  capabilityId: "pipeline_movement_intelligence",
  deliverableId: "weekly_progress_sheet",
  runId: "t03_20260625070000000",
  lane: "auto_delivery",
  autonomyState: "shadow",
  readinessState: "ready_for_delivery",
  recipientFingerprint: "sha256:recipient_weekly_progress",
  payloadFingerprint: "sha256:payload_weekly_progress",
  gateResults: [
    {
      gateId: "mode",
      status: "pass",
      reason: "Fixture shadow run is local-only.",
      evidenceRefs: ["fixture_weekly_progress"],
    },
  ],
  status: "shadowed",
  deliveryMechanism: LOCAL_DELIVERY_LEDGER_MECHANISM,
  artifactIds: ["artifact_weekly_progress_json"],
  publicSummary: {
    deliverableId: "weekly_progress_sheet",
    status: "shadowed",
    rowCount: 2,
  },
  createdAt: "2026-06-25T07:00:00.000Z",
  createdBy: "system",
}

describe("P8 delivery ledger append integrity", () => {
  test("append is idempotent on deliveryLogId — a duplicate append must not write a second line", async () => {
    const rootDir = tempRoot()

    const first = await appendLocalDeliveryLedgerEntry({ rootDir, entry: baseEntry })
    await appendLocalDeliveryLedgerEntry({ rootDir, entry: baseEntry })

    const lines = readFileSync(first.path, "utf8").trim().split("\n").filter(Boolean)
    const matching = lines.filter((line) => {
      try {
        return (JSON.parse(line) as { deliveryLogId?: string }).deliveryLogId === baseEntry.deliveryLogId
      } catch {
        return false
      }
    })

    // Post-fix contract: at most one ledger line per deliveryLogId.
    expect(matching).toHaveLength(1)
  })

  test("a duplicate deliveryLogId with DIFFERENT content throws instead of silently dropping the write", async () => {
    // Content-aware idempotency: a same-startedAt retry over changed inputs produces the
    // same deliveryLogId with a different payload — silently no-op'ing that write would
    // tell the caller fresh data was recorded when it was not.
    const rootDir = tempRoot()
    await appendLocalDeliveryLedgerEntry({ rootDir, entry: baseEntry })

    await expect(
      appendLocalDeliveryLedgerEntry({
        rootDir,
        entry: { ...baseEntry, payloadFingerprint: "sha256:payload_weekly_progress_CHANGED" },
      })
    ).rejects.toThrow(/already recorded with different content/)
  })

  test("append enforces correctionOf referential integrity — a dangling correction must throw", async () => {
    const rootDir = tempRoot()

    const danglingCorrection: LocalDeliveryLedgerEntry = {
      ...baseEntry,
      deliveryLogId: buildDeliveryLogId("weekly_progress_sheet", "t03_20260625070000000", "correction"),
      eventType: "correction",
      status: "correction_recorded",
      correctionOf: "delivery_weekly_progress_sheet_shadow_run_never_appended",
    }

    // Post-fix contract: appending a correction whose original was never written must be rejected.
    await expect(
      appendLocalDeliveryLedgerEntry({ rootDir, entry: danglingCorrection })
    ).rejects.toThrow(/correctionOf|unknown ledger entry/)
  })

  test("collectShadowLedgerHistory fails loud on invalid window inputs and corrupt createdAt", async () => {
    const rootDir = tempRoot()
    await appendLocalDeliveryLedgerEntry({ rootDir, entry: baseEntry })

    await expect(
      collectShadowLedgerHistory({
        rootDir,
        deliverableId: "weekly_progress_sheet",
        evaluatedAt: "2026-06-25T08:00:00.000Z",
        windowMinutes: Number.NaN,
      })
    ).rejects.toThrow(/finite non-negative windowMinutes/)

    await expect(
      collectShadowLedgerHistory({
        rootDir,
        deliverableId: "weekly_progress_sheet",
        evaluatedAt: "2026-06-25T08:00:00.000Z",
        windowMinutes: -10,
      })
    ).rejects.toThrow(/finite non-negative windowMinutes/)

    // Corrupt createdAt on an authorized entry must throw, never silently shrink the window.
    const corrupt = { ...baseEntry, deliveryLogId: buildDeliveryLogId("weekly_progress_sheet", "t03_20260625090000000", "shadow_run"), runId: "t03_20260625090000000", createdAt: "not-a-timestamp" }
    const path = join(rootDir, "deliveries", "weekly_progress_sheet", "weekly_progress_sheet.jsonl")
    appendFileSync(path, `${JSON.stringify(corrupt)}\n`)
    await expect(
      collectShadowLedgerHistory({
        rootDir,
        deliverableId: "weekly_progress_sheet",
        evaluatedAt: "2026-06-25T08:00:00.000Z",
        windowMinutes: 60,
      })
    ).rejects.toThrow(/Corrupt delivery ledger createdAt/)
  })
})
