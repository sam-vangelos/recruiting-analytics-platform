import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  LOCAL_DELIVERY_LEDGER_MECHANISM,
  appendLocalDeliveryLedgerEntry,
  buildDeliveryLogId,
  resolveLocalDeliveryLedgerPath,
  validateDeliveryLedgerLineage,
  validateLocalDeliveryLedgerEntry,
  type LocalDeliveryLedgerEntry,
} from "../lib/recruiting-ops/delivery-ledger"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-delivery-ledger-"))
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

describe("recruiting ops local delivery ledger", () => {
  test("appends a valid shadow entry as one JSONL record", async () => {
    const result = await appendLocalDeliveryLedgerEntry({
      rootDir: tempRoot(),
      entry: baseEntry,
    })

    expect(result.deliveryMechanism).toBe("local_jsonl")
    expect(result.bytesWritten).toBeGreaterThan(0)
    const lines = readFileSync(result.path, "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      deliveryLogId: baseEntry.deliveryLogId,
      deliverableId: "weekly_progress_sheet",
      lane: "auto_delivery",
      autonomyState: "shadow",
      readinessState: "ready_for_delivery",
      status: "shadowed",
      deliveryMechanism: "local_jsonl",
    })
  })

  test("requires recipient and payload fingerprints", () => {
    expect(() =>
      validateLocalDeliveryLedgerEntry({
        ...baseEntry,
        recipientFingerprint: "",
      })
    ).toThrow("recipientFingerprint is required")

    expect(() =>
      validateLocalDeliveryLedgerEntry({
        ...baseEntry,
        payloadFingerprint: "payload_without_hash_prefix",
      })
    ).toThrow("payloadFingerprint must be a supported fingerprint")
  })

  test("keeps authorization statuses separate from delivery attempt and result statuses", () => {
    const reviewAuthorization: LocalDeliveryLedgerEntry = {
      ...baseEntry,
      deliveryLogId: buildDeliveryLogId("weekly_progress_sheet", "t03_20260625070000000", "delivery_authorization"),
      eventType: "delivery_authorization",
      status: "authorized_for_review",
    }
    const autoAuthorization: LocalDeliveryLedgerEntry = {
      ...reviewAuthorization,
      status: "authorized_for_auto_delivery",
    }
    const attempted: LocalDeliveryLedgerEntry = {
      ...baseEntry,
      deliveryLogId: buildDeliveryLogId("weekly_progress_sheet", "t03_20260625070000000", "delivery_attempt"),
      eventType: "delivery_attempt",
      status: "delivery_attempted",
    }
    const delivered: LocalDeliveryLedgerEntry = {
      ...attempted,
      status: "delivered",
    }
    const withheld: LocalDeliveryLedgerEntry = {
      ...attempted,
      status: "withheld",
    }
    const failed: LocalDeliveryLedgerEntry = {
      ...attempted,
      status: "failed",
    }

    for (const entry of [reviewAuthorization, autoAuthorization, attempted, delivered, withheld, failed]) {
      expect(validateLocalDeliveryLedgerEntry(entry).status).toBe(entry.status)
    }
    expect(() =>
      validateLocalDeliveryLedgerEntry({
        ...reviewAuthorization,
        status: "delivered",
      })
    ).toThrow("delivery_authorization cannot use delivery status delivered")
    expect(() =>
      validateLocalDeliveryLedgerEntry({
        ...attempted,
        status: "authorized_for_auto_delivery",
      })
    ).toThrow("delivery_attempt cannot use delivery status authorized_for_auto_delivery")
  })

  test("rejects PII-bearing public summaries", () => {
    expect(() =>
      validateLocalDeliveryLedgerEntry({
        ...baseEntry,
        publicSummary: {
          candidate_email: "person@example.com",
        },
      })
    ).toThrow("publicSummary is not public-safe")
  })

  test("keeps ledger paths local and rejects unsafe file names", () => {
    const rootDir = tempRoot()
    expect(
      resolveLocalDeliveryLedgerPath({
        rootDir,
        entry: baseEntry,
      })
    ).toContain("/deliveries/weekly_progress_sheet/weekly_progress_sheet.jsonl")

    expect(() =>
      resolveLocalDeliveryLedgerPath({
        rootDir: "https://example.com/deliveries",
        entry: baseEntry,
      })
    ).toThrow("local filesystem path")

    expect(() =>
      resolveLocalDeliveryLedgerPath({
        rootDir,
        entry: baseEntry,
        fileName: "../bad.jsonl",
      })
    ).toThrow("Unsafe delivery ledger file name")
  })

  test("validates correctionOf/supersededBy lineage referential integrity within a batch", () => {
    const correction: LocalDeliveryLedgerEntry = {
      ...baseEntry,
      deliveryLogId: buildDeliveryLogId("weekly_progress_sheet", "t03_20260625070000000", "correction"),
      eventType: "correction",
      status: "correction_recorded",
      correctionOf: baseEntry.deliveryLogId,
    }

    expect(validateDeliveryLedgerLineage([baseEntry, correction])).toEqual({ ok: true, count: 2 })
    expect(() =>
      validateDeliveryLedgerLineage([{ ...correction, correctionOf: "delivery_missing_entry" }])
    ).toThrow("references unknown ledger entry")
  })
})
