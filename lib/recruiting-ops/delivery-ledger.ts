import { appendFile, mkdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"

import { getDeliverableAutomationSeed } from "./automation-seed-matrix"
import { isSupportedFingerprint } from "./checksums"
import {
  validateDeliveryLogEntry,
  type DeliveryGateResult,
  type DeliveryLogEntry,
} from "./autonomy"
import { assertPublicSafe } from "./safe-public-output"
import {
  assertNonEmptyString,
  validateId,
  type ValidationSummary,
} from "./substrate"

/**
 * Local delivery ledger guarantees (Phase 0, P8-hardened):
 * - Local-only: `rootDir` must be a filesystem path; URL roots are rejected by `assertLocalRoot`.
 * - Append-only in practice: entries are written only through `appendLocalDeliveryLedgerEntry`,
 *   which appends at most one JSONL line per call and never truncates or rewrites the file.
 * - Idempotent on `deliveryLogId`: the append path reads the existing file first; re-appending
 *   an already-recorded id is a no-op (bytesWritten 0), never a duplicate line.
 * - Lineage referential integrity IS enforced on append: `correctionOf` / `supersededBy` must
 *   reference an already-written entry in the same ledger file, or the append throws.
 *   `validateDeliveryLedgerLineage` remains for validating in-memory batches.
 * - NOT tamper-evident: there is no signing, sequence number, or hash chain, so a local file
 *   owner can still rewrite history out of band. Treat the ledger as a local audit aid, not proof.
 * - Single-process assumption: read-then-append is not atomic across concurrent writers; a
 *   durable store with real uniqueness constraints replaces this in C2.
 */
export const LOCAL_DELIVERY_LEDGER_MECHANISM = "local_jsonl" as const
/** Durable twin (migration 019): same entry contract, persisted to Supabase. */
export const DURABLE_DELIVERY_LEDGER_MECHANISM = "supabase_table" as const
export const DELIVERY_LEDGER_MECHANISMS = [LOCAL_DELIVERY_LEDGER_MECHANISM, DURABLE_DELIVERY_LEDGER_MECHANISM] as const
export type DeliveryLedgerMechanism = (typeof DELIVERY_LEDGER_MECHANISMS)[number]

export type LocalDeliveryLedgerEventType =
  | "shadow_run"
  | "delivery_authorization"
  | "delivery_attempt"
  | "gate_failure"
  | "auto_pause"
  | "correction"
  | "manual_execution_attestation"
  | "kill_switch"

export interface LocalDeliveryLedgerEntry extends DeliveryLogEntry {
  eventType: LocalDeliveryLedgerEventType
  deliveryMechanism: DeliveryLedgerMechanism
  artifactIds: readonly string[]
  publicSummary: Record<string, unknown>
}

export interface LocalDeliveryLedgerAppendInput {
  rootDir: string
  entry: LocalDeliveryLedgerEntry
  fileName?: string
}

export interface LocalDeliveryLedgerAppendResult {
  path: string
  bytesWritten: number
  deliveryLogId: string
  deliveryMechanism: typeof LOCAL_DELIVERY_LEDGER_MECHANISM
}

export function buildDeliveryLogId(deliverableId: string, runId: string, eventType: LocalDeliveryLedgerEventType): string {
  validateId(deliverableId, "deliverableId")
  validateId(runId, "runId")
  return `delivery_${slug(deliverableId)}_${slug(eventType)}_${runId}`
}

export async function appendLocalDeliveryLedgerEntry(
  input: LocalDeliveryLedgerAppendInput
): Promise<LocalDeliveryLedgerAppendResult> {
  const entry = validateLocalDeliveryLedgerEntry(input.entry)
  const ledgerPath = resolveLocalDeliveryLedgerPath(input)

  // P8/SAFETY-GATES-7: append integrity happens on the WRITE PATH. Read prior entries,
  // refuse duplicate ids (idempotent no-op) and dangling lineage references.
  const existing = await readLocalDeliveryLedgerEntries({
    rootDir: input.rootDir,
    deliverableId: entry.deliverableId,
    fileName: input.fileName,
  })
  const knownIds = new Set(existing.map((item) => item.deliveryLogId))
  if (knownIds.has(entry.deliveryLogId)) {
    // Idempotency is CONTENT-AWARE: replaying the identical entry is a no-op, but the
    // same id carrying different content is silent data loss waiting to happen (same
    // startedAt retry over updated facts) — that must fail loudly, never drop a write.
    const existingEntry = existing.find((item) => item.deliveryLogId === entry.deliveryLogId)!
    if (serializeLocalDeliveryLedgerEntry(existingEntry) !== serializeLocalDeliveryLedgerEntry(entry)) {
      throw new Error(
        `${entry.deliveryLogId} is already recorded with different content; ` +
          "a re-run over changed inputs must use a new runId, not overwrite ledger history"
      )
    }
    return {
      path: ledgerPath,
      bytesWritten: 0,
      deliveryLogId: entry.deliveryLogId,
      deliveryMechanism: LOCAL_DELIVERY_LEDGER_MECHANISM,
    }
  }
  if (entry.correctionOf && !knownIds.has(entry.correctionOf)) {
    throw new Error(`${entry.deliveryLogId}.correctionOf references unknown ledger entry: ${entry.correctionOf}`)
  }
  if (entry.supersededBy && !knownIds.has(entry.supersededBy)) {
    throw new Error(`${entry.deliveryLogId}.supersededBy references unknown ledger entry: ${entry.supersededBy}`)
  }

  const line = `${serializeLocalDeliveryLedgerEntry(entry)}\n`
  const ledgerDir = ledgerPath.slice(0, ledgerPath.lastIndexOf("/"))

  await mkdir(ledgerDir, { recursive: true })
  await appendFile(ledgerPath, line, "utf8")

  return {
    path: ledgerPath,
    bytesWritten: Buffer.byteLength(line, "utf8"),
    deliveryLogId: entry.deliveryLogId,
    deliveryMechanism: LOCAL_DELIVERY_LEDGER_MECHANISM,
  }
}

export interface LocalDeliveryLedgerReadInput {
  rootDir: string
  deliverableId: string
  fileName?: string
}

/**
 * Reads all entries from a deliverable's local ledger file. Missing file = empty history;
 * an unparseable line throws (fail loud on corruption, never silently skip audit rows).
 */
export async function readLocalDeliveryLedgerEntries(
  input: LocalDeliveryLedgerReadInput
): Promise<LocalDeliveryLedgerEntry[]> {
  const ledgerPath = resolveLocalDeliveryLedgerPath({
    rootDir: input.rootDir,
    entry: { deliverableId: input.deliverableId },
    fileName: input.fileName,
  })
  let raw: string
  try {
    raw = await readFile(ledgerPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as LocalDeliveryLedgerEntry
      } catch {
        throw new Error(`Corrupt delivery ledger line ${index + 1} in ${ledgerPath}`)
      }
    })
}

export function resolveLocalDeliveryLedgerPath(input: {
  rootDir: string
  entry: Pick<LocalDeliveryLedgerEntry, "deliverableId">
  fileName?: string
}): string {
  assertLocalRoot(input.rootDir)
  const seed = getDeliverableAutomationSeed(input.entry.deliverableId)
  const fileName = input.fileName ?? `${slug(seed.deliverableId)}.jsonl`
  if (basename(fileName) !== fileName || fileName.includes("..") || !fileName.endsWith(".jsonl")) {
    throw new Error(`Unsafe delivery ledger file name: ${fileName}`)
  }
  return join(input.rootDir, "deliveries", slug(seed.deliverableId), fileName)
}

export function validateLocalDeliveryLedgerEntry(entry: LocalDeliveryLedgerEntry): LocalDeliveryLedgerEntry {
  validateDeliveryLogEntry(entry)
  assertNonEmptyString(entry.eventType, `${entry.deliveryLogId}.eventType`)
  assertKnownEventType(entry.eventType)
  if (!DELIVERY_LEDGER_MECHANISMS.includes(entry.deliveryMechanism)) {
    throw new Error(
      `${entry.deliveryLogId}.deliveryMechanism must be one of ${DELIVERY_LEDGER_MECHANISMS.join(", ")}`
    )
  }
  assertEventStatusLifecycle(entry)
  const seed = getDeliverableAutomationSeed(entry.deliverableId)
  if (entry.capabilityId !== seed.capabilityId) {
    throw new Error(`${entry.deliveryLogId}.capabilityId must match the seed matrix`)
  }
  if (entry.lane !== seed.lane) throw new Error(`${entry.deliveryLogId}.lane must match the seed matrix`)
  assertFingerprint(entry.recipientFingerprint, `${entry.deliveryLogId}.recipientFingerprint`)
  assertFingerprint(entry.payloadFingerprint, `${entry.deliveryLogId}.payloadFingerprint`)
  for (const artifactId of entry.artifactIds) validateId(artifactId, `${entry.deliveryLogId}.artifactIds`)
  for (const result of entry.gateResults) validateGateEvidence(result, entry.deliveryLogId)
  assertPublicSafe(entry.publicSummary, `${entry.deliveryLogId}.publicSummary`)
  return entry
}

export function serializeLocalDeliveryLedgerEntry(entry: LocalDeliveryLedgerEntry): string {
  validateLocalDeliveryLedgerEntry(entry)
  return JSON.stringify({
    deliveryLogId: entry.deliveryLogId,
    eventType: entry.eventType,
    capabilityId: entry.capabilityId,
    deliverableId: entry.deliverableId,
    runId: entry.runId,
    lane: entry.lane,
    autonomyState: entry.autonomyState,
    readinessState: entry.readinessState,
    recipientFingerprint: entry.recipientFingerprint,
    payloadFingerprint: entry.payloadFingerprint,
    gateResults: entry.gateResults,
    status: entry.status,
    deliveryMechanism: entry.deliveryMechanism,
    artifactIds: entry.artifactIds,
    publicSummary: entry.publicSummary,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    correctionOf: entry.correctionOf,
    supersededBy: entry.supersededBy,
  })
}

export function validateLocalDeliveryLedgerEntries(
  entries: readonly LocalDeliveryLedgerEntry[]
): { ok: true; count: number } {
  for (const entry of entries) validateLocalDeliveryLedgerEntry(entry)
  return { ok: true, count: entries.length }
}

/**
 * Validates `correctionOf` / `supersededBy` lineage referential integrity over a batch of
 * entries held in memory. The append path does not enforce this because it never reads prior
 * entries; cross-file/streaming enforcement is deferred until a durable ledger store is approved.
 */
export function validateDeliveryLedgerLineage(
  entries: readonly LocalDeliveryLedgerEntry[]
): { ok: true; count: number } {
  for (const entry of entries) validateLocalDeliveryLedgerEntry(entry)
  const knownIds = new Set(entries.map((entry) => entry.deliveryLogId))
  for (const entry of entries) {
    if (entry.correctionOf && !knownIds.has(entry.correctionOf)) {
      throw new Error(`${entry.deliveryLogId}.correctionOf references unknown ledger entry: ${entry.correctionOf}`)
    }
    if (entry.supersededBy && !knownIds.has(entry.supersededBy)) {
      throw new Error(`${entry.deliveryLogId}.supersededBy references unknown ledger entry: ${entry.supersededBy}`)
    }
  }
  return { ok: true, count: entries.length }
}

export interface ShadowLedgerHistoryInput {
  rootDir: string
  deliverableId: string
  /** Evaluation timestamp anchoring the cadence window. */
  evaluatedAt: string
  /** Cadence window size; entries older than this do not count toward idempotency. */
  windowMinutes: number
  /** Caller-supplied fingerprints extend (never replace) the ledger-derived window. */
  extraPriorPayloadFingerprints?: readonly string[]
}

export interface ShadowLedgerHistory {
  priorPayloadFingerprintsInWindow: readonly string[]
  /** Prior successful (status "shadowed") shadow runs across the full ledger history. */
  priorCleanShadowRuns: number
}

const AUTHORIZED_PAYLOAD_STATUSES: ReadonlyArray<LocalDeliveryLedgerEntry["status"]> = [
  "shadowed",
  "authorized_for_review",
  "authorized_for_auto_delivery",
  "delivered",
]

/**
 * P3/SHADOW-MODULES-6: derives trust/idempotency evidence from the deliverable's OWN
 * ledger instead of caller-supplied constants. Fingerprints of payloads already
 * authorized inside the cadence window feed the idempotency gate; prior clean shadow
 * runs feed the trust window.
 */
export async function collectShadowLedgerHistory(input: ShadowLedgerHistoryInput): Promise<ShadowLedgerHistory> {
  const entries = await readLocalDeliveryLedgerEntries({
    rootDir: input.rootDir,
    deliverableId: input.deliverableId,
  })
  return deriveShadowLedgerHistory(entries, input)
}

/**
 * The pure core of shadow-history derivation, shared by the local JSONL reader
 * and the durable store (migration 019) — one derivation, two entry sources.
 */
export function deriveShadowLedgerHistory(
  entries: readonly LocalDeliveryLedgerEntry[],
  input: Pick<ShadowLedgerHistoryInput, "evaluatedAt" | "windowMinutes" | "extraPriorPayloadFingerprints">
): ShadowLedgerHistory {
  const evaluatedAtMs = Date.parse(input.evaluatedAt)
  if (Number.isNaN(evaluatedAtMs)) throw new Error("collectShadowLedgerHistory requires a valid evaluatedAt timestamp")
  if (!Number.isFinite(input.windowMinutes) || input.windowMinutes < 0) {
    throw new Error("collectShadowLedgerHistory requires a finite non-negative windowMinutes")
  }
  const windowStartMs = evaluatedAtMs - input.windowMinutes * 60_000

  const windowFingerprints = entries
    .filter((entry) => {
      if (!AUTHORIZED_PAYLOAD_STATUSES.includes(entry.status)) return false
      const createdAtMs = Date.parse(entry.createdAt)
      if (Number.isNaN(createdAtMs)) {
        // Fail loud on corruption, never silently shrink the idempotency window.
        throw new Error(`Corrupt delivery ledger createdAt on ${entry.deliveryLogId}`)
      }
      return createdAtMs >= windowStartMs && createdAtMs <= evaluatedAtMs
    })
    .map((entry) => entry.payloadFingerprint)

  return {
    priorPayloadFingerprintsInWindow: [
      ...new Set([...(input.extraPriorPayloadFingerprints ?? []), ...windowFingerprints]),
    ],
    priorCleanShadowRuns: entries.filter(
      (entry) => entry.eventType === "shadow_run" && entry.status === "shadowed"
    ).length,
  }
}

function assertLocalRoot(rootDir: string): void {
  assertNonEmptyString(rootDir, "rootDir")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rootDir)) {
    throw new Error("Delivery ledger rootDir must be a local filesystem path")
  }
}

function assertFingerprint(value: string, label: string): void {
  assertNonEmptyString(value, label)
  if (!isSupportedFingerprint(value)) throw new Error(`${label} must be a supported fingerprint`)
}

function assertKnownEventType(value: string): asserts value is LocalDeliveryLedgerEventType {
  if (
    ![
      "shadow_run",
      "delivery_authorization",
      "delivery_attempt",
      "gate_failure",
      "auto_pause",
      "correction",
      "manual_execution_attestation",
      "kill_switch",
    ].includes(value)
  ) {
    throw new Error(`Unknown delivery ledger event type: ${value}`)
  }
}

function assertEventStatusLifecycle(entry: LocalDeliveryLedgerEntry): void {
  const allowedStatuses: Record<LocalDeliveryLedgerEventType, readonly LocalDeliveryLedgerEntry["status"][]> = {
    shadow_run: ["shadowed"],
    delivery_authorization: ["authorized_for_review", "authorized_for_auto_delivery"],
    delivery_attempt: ["delivery_attempted", "delivered", "withheld", "failed"],
    gate_failure: ["blocked"],
    auto_pause: ["paused"],
    correction: ["correction_recorded", "superseded"],
    manual_execution_attestation: ["delivered"],
    kill_switch: ["paused"],
  }
  if (!allowedStatuses[entry.eventType].includes(entry.status)) {
    throw new Error(`${entry.deliveryLogId}.${entry.eventType} cannot use delivery status ${entry.status}`)
  }
}

function validateGateEvidence(result: DeliveryGateResult, deliveryLogId: string): ValidationSummary {
  if (result.status !== "not_applicable" && result.evidenceRefs.length === 0) {
    throw new Error(`${deliveryLogId}.${result.gateId}.evidenceRefs must not be empty`)
  }
  return { ok: true, id: `${deliveryLogId}.${result.gateId}`, checked: ["evidenceRefs"] }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}
