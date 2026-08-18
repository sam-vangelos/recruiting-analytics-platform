import { gunzipSync, gzipSync } from "node:zlib"

import { createPayloadFingerprint, stableSerialize } from "./checksums"

export const COMPRESSED_SOURCE_PAYLOAD_SCHEMA_VERSION = 3
const SOURCE_PAYLOAD_ENCODING = "gzip-base64"
const MAX_SOURCE_PAYLOAD_BYTES = 256 * 1024 * 1024

export type SourceExecutionStatus = "running" | "completed" | "failed"

export interface SourceExecutionRecord {
  sourceExecutionId: string
  ownerToken: string
  status: SourceExecutionStatus
  acquiredAt: string
  leasedUntil: string
  completedAt: string | null
  sourceGeneratedAt: string | null
  sourceFingerprint: string | null
  sourceCounts: Record<string, unknown> | null
  publicDiagnostics: Record<string, unknown>
  sourcePayload: unknown | null
  sourcePayloadSchemaVersion: number | null
  sourcePayloadChecksum: string | null
}

export interface SourceExecutionDatabaseClient {
  claim(input: {
    sourceExecutionId: string
    ownerToken: string
    leaseSeconds: number
  }): Promise<SourceExecutionRecord | null>
  complete(input: {
    sourceExecutionId: string
    ownerToken: string
    sourceGeneratedAt: string
    sourceFingerprint: string
    sourceCounts: Record<string, unknown>
    publicDiagnostics: Record<string, unknown>
    sourcePayload: Record<string, unknown>
    sourcePayloadSchemaVersion: number
    sourcePayloadChecksum: string
  }): Promise<SourceExecutionRecord>
  fail(input: {
    sourceExecutionId: string
    ownerToken: string
    publicDiagnostics: Record<string, unknown>
  }): Promise<SourceExecutionRecord>
  heartbeat(input: {
    sourceExecutionId: string
    ownerToken: string
    leaseSeconds: number
  }): Promise<boolean>
  reapStale(): Promise<number>
  selectCompleted(sourceExecutionId: string): Promise<SourceExecutionRecord | null>
}

export type SourceExecutionClaim =
  | { outcome: "acquired"; execution: SourceExecutionRecord }
  | { outcome: "overlap_rejected" }

export async function claimSourceExecution(
  input: { sourceExecutionId: string; ownerToken: string; leaseSeconds?: number },
  client: SourceExecutionDatabaseClient
): Promise<SourceExecutionClaim> {
  const leaseSeconds = input.leaseSeconds ?? 3600
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 7200) {
    throw new Error("Source execution lease must be an integer between 60 and 7200 seconds")
  }
  const execution = await client.claim({ ...input, leaseSeconds })
  return execution ? { outcome: "acquired", execution } : { outcome: "overlap_rejected" }
}

export async function completeSourceExecution(
  input: {
    sourceExecutionId: string
    ownerToken: string
    sourceGeneratedAt: string
    sourceFingerprint: string
    sourceCounts: Record<string, unknown>
    publicDiagnostics: Record<string, unknown>
    sourcePayload: Record<string, unknown>
    sourcePayloadSchemaVersion: number
  },
  client: SourceExecutionDatabaseClient
): Promise<SourceExecutionRecord> {
  if (!/^hmac-sha256:[0-9a-f]{64}$/.test(input.sourceFingerprint)) {
    throw new Error("Source fingerprint must be an HMAC-SHA256 fingerprint")
  }
  if (!Number.isInteger(input.sourcePayloadSchemaVersion) || input.sourcePayloadSchemaVersion <= 0) {
    throw new Error("Source payload schema version must be a positive integer")
  }
  if (Number.isNaN(Date.parse(input.sourceGeneratedAt))) {
    throw new Error("Source generated timestamp must parse")
  }

  const sourcePayload = JSON.parse(stableSerialize(input.sourcePayload)) as Record<string, unknown>
  const persistedSourcePayload = input.sourcePayloadSchemaVersion === COMPRESSED_SOURCE_PAYLOAD_SCHEMA_VERSION
    ? encodeSourcePayload(sourcePayload)
    : sourcePayload
  const execution = await client.complete({
    ...input,
    sourcePayload: persistedSourcePayload,
    sourcePayloadChecksum: createPayloadFingerprint(persistedSourcePayload),
  })
  return validateCompletedSourceExecution(execution)
}

export async function readCompletedSourceExecution(
  sourceExecutionId: string,
  client: SourceExecutionDatabaseClient
): Promise<SourceExecutionRecord | null> {
  const execution = await client.selectCompleted(sourceExecutionId)
  return execution ? validateCompletedSourceExecution(execution) : null
}

export function validateCompletedSourceExecution(execution: SourceExecutionRecord): SourceExecutionRecord {
  if (execution.status !== "completed") {
    throw new Error(`Source execution ${execution.sourceExecutionId} is not completed`)
  }
  if (
    !execution.sourcePayload
    || typeof execution.sourcePayload !== "object"
    || Array.isArray(execution.sourcePayload)
    || typeof execution.sourcePayloadSchemaVersion !== "number"
    || !Number.isInteger(execution.sourcePayloadSchemaVersion)
    || execution.sourcePayloadSchemaVersion <= 0
    || !execution.sourcePayloadChecksum
    || !execution.sourceFingerprint
    || !execution.sourceGeneratedAt
    || !execution.sourceCounts
  ) {
    throw new Error(`Source execution ${execution.sourceExecutionId} has no replayable payload`)
  }
  if (!/^hmac-sha256:[0-9a-f]{64}$/.test(execution.sourceFingerprint)) {
    throw new Error(`Source execution ${execution.sourceExecutionId} fingerprint is invalid`)
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(execution.sourcePayloadChecksum)) {
    throw new Error(`Source execution ${execution.sourceExecutionId} payload checksum is invalid`)
  }
  if (Number.isNaN(Date.parse(execution.sourceGeneratedAt))) {
    throw new Error(`Source execution ${execution.sourceExecutionId} generated timestamp is invalid`)
  }
  const checksum = createPayloadFingerprint(execution.sourcePayload)
  if (checksum !== execution.sourcePayloadChecksum) {
    throw new Error(`Source execution ${execution.sourceExecutionId} payload checksum mismatch`)
  }
  return {
    ...execution,
    sourcePayload: execution.sourcePayloadSchemaVersion === COMPRESSED_SOURCE_PAYLOAD_SCHEMA_VERSION
      ? decodeSourcePayload(execution.sourcePayload, execution.sourceExecutionId)
      : execution.sourcePayload,
  }
}

function encodeSourcePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const bytes = Buffer.from(stableSerialize(payload))
  if (bytes.length > MAX_SOURCE_PAYLOAD_BYTES) {
    throw new Error("Source payload exceeds the supported uncompressed size")
  }
  return {
    encoding: SOURCE_PAYLOAD_ENCODING,
    uncompressedBytes: bytes.length,
    data: gzipSync(bytes, { level: 9 }).toString("base64"),
  }
}

function decodeSourcePayload(payload: unknown, sourceExecutionId: string): Record<string, unknown> {
  const envelope = payload as Partial<{
    encoding: string
    uncompressedBytes: number
    data: string
  }>
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    envelope.encoding !== SOURCE_PAYLOAD_ENCODING ||
    !Number.isInteger(envelope.uncompressedBytes) ||
    envelope.uncompressedBytes! < 1 ||
    envelope.uncompressedBytes! > MAX_SOURCE_PAYLOAD_BYTES ||
    typeof envelope.data !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data) ||
    envelope.data.length % 4 !== 0
  ) {
    throw new Error(`Source execution ${sourceExecutionId} compressed payload envelope is invalid`)
  }
  try {
    const compressed = Buffer.from(envelope.data, "base64")
    if (compressed.toString("base64") !== envelope.data) throw new Error("invalid base64")
    const decoded = gunzipSync(compressed, { maxOutputLength: MAX_SOURCE_PAYLOAD_BYTES })
    if (decoded.length !== envelope.uncompressedBytes) throw new Error("length mismatch")
    const value = JSON.parse(decoded.toString("utf8")) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object")
    return value as Record<string, unknown>
  } catch {
    throw new Error(`Source execution ${sourceExecutionId} compressed payload could not be decoded`)
  }
}
