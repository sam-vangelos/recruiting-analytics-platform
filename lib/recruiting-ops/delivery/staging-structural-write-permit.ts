import { createPayloadFingerprint, isSupportedFingerprint } from "../checksums"
import {
  requireStagingMutationTarget,
  stagingHydrationEnabled,
  type StagingArtifactTarget,
} from "./staging-artifact-registry"
import type {
  StagingStructuralNormalizationPlan,
  StagingStructuralNormalizationSpec,
} from "./staging-structural-normalization"
import { assertStagingSourceFreshness } from "./staging-write-permit"

export type StructuralNormalizationExpectedStatus =
  StagingStructuralNormalizationPlan["status"]

/**
 * A short-lived authorization minted from one audited structural read. Unlike
 * a value-write permit, this carries no source rows or range ids: it binds the
 * exact structural migration, full copy preimage, and Drive revision instead.
 */
export interface StagingStructuralWritePermit {
  artifactKey: StagingStructuralNormalizationSpec["artifactKey"]
  artifactId: string
  kind: "google_sheet"
  normalizationId: string
  normalizationFingerprint: string
  expectedStatus: StructuralNormalizationExpectedStatus
  observedStructureFingerprint: string
  expectedDriveVersion: string
  runId: string
  sourceGeneratedAt?: string
  issuedAt: string
  expiresAt: string
  killSwitchStoreReachable: true
  killSwitchClear: true
  canonicalOnly: true
}

export interface AssertStagingStructuralWritePermitInput {
  permit: StagingStructuralWritePermit
  spec: StagingStructuralNormalizationSpec
  env?: Readonly<Record<string, string | undefined>>
  nowMs: number
  maxPermitLifetimeMinutes?: number
}

/** PII-free fingerprint of the complete, reversible normalization contract. */
export function stagingStructuralNormalizationFingerprint(
  spec: StagingStructuralNormalizationSpec
): string {
  return createPayloadFingerprint({
    schemaVersion: 1,
    id: spec.id,
    artifactKey: spec.artifactKey,
    spreadsheetId: spec.spreadsheetId,
    expectedBefore: spec.expectedBefore,
    expectedAfter: spec.expectedAfter,
    forwardRequests: spec.forwardRequests,
    rollbackRequests: spec.rollbackRequests,
  })
}

/**
 * Re-proves the exact copy binding, flags, durable kill switch, freshness, and
 * immutable normalization contract before the Google client is touched.
 */
export function assertStagingStructuralWritePermit(
  input: AssertStagingStructuralWritePermitInput
): StagingArtifactTarget {
  const { permit, spec } = input
  if (permit.artifactKey !== spec.artifactKey || permit.normalizationId !== spec.id) {
    throw new Error("Staging structural permit is bound to a different normalization.")
  }
  const target = requireStagingMutationTarget({
    key: permit.artifactKey,
    artifactId: permit.artifactId,
    kind: permit.kind,
  })
  if (spec.spreadsheetId !== target.artifactId) {
    throw new Error("Staging structural normalization is not bound to the exact registered copy.")
  }
  const nowMs = input.nowMs
  if (!stagingHydrationEnabled(target.key, nowMs, input.env)) {
    throw new Error("Staging hydration flags are not enabled for this artifact.")
  }
  if (permit.canonicalOnly !== true) {
    throw new Error("Staging structural permit must be canonical-only.")
  }
  if (permit.killSwitchStoreReachable !== true || permit.killSwitchClear !== true) {
    throw new Error("Staging structural permit requires an affirmative clear durable kill-switch read.")
  }
  if (!permit.runId.trim()) throw new Error("Staging structural permit run id is required.")
  if (!permit.expectedDriveVersion.trim()) {
    throw new Error("Staging structural permit requires an exact Drive version.")
  }
  if (!isSupportedFingerprint(permit.normalizationFingerprint)) {
    throw new Error("Staging structural normalization fingerprint is malformed.")
  }
  if (!isSupportedFingerprint(permit.observedStructureFingerprint)) {
    throw new Error("Staging structural preimage fingerprint is malformed.")
  }
  if (permit.normalizationFingerprint !== stagingStructuralNormalizationFingerprint(spec)) {
    throw new Error("Staging structural permit does not match the immutable normalization contract.")
  }
  if (permit.expectedStatus !== "planned" && permit.expectedStatus !== "already_normalized") {
    throw new Error("Staging structural permit has an invalid expected status.")
  }

  const issuedAtMs = Date.parse(permit.issuedAt)
  const expiresAtMs = Date.parse(permit.expiresAt)
  if ([issuedAtMs, expiresAtMs].some(Number.isNaN)) {
    throw new Error("Staging structural permit timestamps must be valid ISO timestamps.")
  }
  if (issuedAtMs > nowMs + 60_000) throw new Error("Staging structural permit is future-dated.")
  if (expiresAtMs <= nowMs) throw new Error("Staging structural permit has expired.")
  const maxLifetimeMs = (input.maxPermitLifetimeMinutes ?? 15) * 60_000
  if (expiresAtMs - issuedAtMs > maxLifetimeMs) {
    throw new Error("Staging structural permit lifetime exceeds policy.")
  }
  if (permit.sourceGeneratedAt !== undefined) {
    assertStagingSourceFreshness(permit.sourceGeneratedAt, nowMs)
  }
  return target
}
