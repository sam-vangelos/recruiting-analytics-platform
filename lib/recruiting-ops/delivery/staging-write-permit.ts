import { isSupportedFingerprint } from "../checksums"
import {
  getStagingArtifact,
  requireStagingMutationTarget,
  stagingHydrationEnabled,
  type StagingArtifactKey,
  type StagingArtifactKind,
  type StagingArtifactTarget,
} from "./staging-artifact-registry"

const STAGING_SOURCE_MAXIMUM_AGE_MINUTES = 120

export interface StagingWritePermit {
  artifactKey: StagingArtifactKey
  artifactId: string
  kind: StagingArtifactKind
  runId: string
  issuedAt: string
  expiresAt: string
  sourceGeneratedAt: string
  payloadFingerprint: string
  structureHash: string
  approvedRangeIds: readonly string[]
  killSwitchStoreReachable: true
  killSwitchClear: true
  canonicalOnly: true
}

export interface AssertStagingWritePermitInput {
  permit: StagingWritePermit
  expectedArtifactKey: StagingArtifactKey
  requiredRangeIds: readonly string[]
  env?: Readonly<Record<string, string | undefined>>
  nowMs: number
  maxSourceAgeMinutes?: number
  maxPermitLifetimeMinutes?: number
}

export function assertStagingSourceFreshness(
  sourceGeneratedAt: string,
  nowMs: number,
  maxSourceAgeMinutes = STAGING_SOURCE_MAXIMUM_AGE_MINUTES
): void {
  const sourceGeneratedAtMs = Date.parse(sourceGeneratedAt)
  if (Number.isNaN(sourceGeneratedAtMs)) {
    throw new Error("Staging write source timestamp must be valid ISO timestamp.")
  }
  const sourceAgeMs = nowMs - sourceGeneratedAtMs
  if (sourceAgeMs < 0) throw new Error("Staging write source is future-dated.")
  if (sourceAgeMs > maxSourceAgeMinutes * 60_000) {
    throw new Error("Staging write source exceeds the hard freshness limit.")
  }
}

/**
 * Defense-in-depth validation at the network chokepoint. Artifact planners can
 * fail earlier, but no Google mutation is allowed unless this exact permit is
 * still fresh and all staging/safety evidence is affirmative.
 */
export function assertStagingWritePermit(input: AssertStagingWritePermitInput): StagingArtifactTarget {
  const { permit } = input
  if (permit.artifactKey !== input.expectedArtifactKey) {
    throw new Error("Staging write permit is bound to a different artifact.")
  }
  const target = requireStagingMutationTarget({
    key: permit.artifactKey,
    artifactId: permit.artifactId,
    kind: permit.kind,
  })
  if (!permit.runId.trim()) throw new Error("Staging write permit run id is required.")
  if (permit.canonicalOnly !== true) throw new Error("Staging write permit must be canonical-only.")
  if (permit.killSwitchStoreReachable !== true || permit.killSwitchClear !== true) {
    throw new Error("Staging write permit requires an affirmative clear durable kill-switch read.")
  }
  if (!isSupportedFingerprint(permit.payloadFingerprint) || !isSupportedFingerprint(permit.structureHash)) {
    throw new Error("Staging write permit fingerprints are missing or malformed.")
  }
  if (!permit.payloadFingerprint.startsWith("hmac-sha256:")) {
    throw new Error("Staging payload fingerprint must use the live PII-safe HMAC form.")
  }
  const nowMs = input.nowMs
  if (!stagingHydrationEnabled(target.key, nowMs, input.env)) {
    throw new Error("Staging hydration flags are not enabled for this artifact.")
  }

  const issuedAtMs = Date.parse(permit.issuedAt)
  const expiresAtMs = Date.parse(permit.expiresAt)
  if ([issuedAtMs, expiresAtMs].some(Number.isNaN)) {
    throw new Error("Staging write permit timestamps must be valid ISO timestamps.")
  }
  if (issuedAtMs > nowMs + 60_000) throw new Error("Staging write permit is future-dated.")
  if (expiresAtMs <= nowMs) throw new Error("Staging write permit has expired.")
  const maxLifetimeMs = (input.maxPermitLifetimeMinutes ?? 15) * 60_000
  if (expiresAtMs - issuedAtMs > maxLifetimeMs) throw new Error("Staging write permit lifetime exceeds policy.")
  assertStagingSourceFreshness(
    permit.sourceGeneratedAt,
    nowMs,
    input.maxSourceAgeMinutes
  )

  const permitRangeIds = new Set(permit.approvedRangeIds)
  if (input.requiredRangeIds.length === 0 || input.requiredRangeIds.some((rangeId) => !permitRangeIds.has(rangeId))) {
    throw new Error("Staging write permit does not authorize every requested range contract.")
  }
  if (permit.approvedRangeIds.some((rangeId) => !rangeId.trim())) {
    throw new Error("Staging write permit contains an empty range contract id.")
  }
  return getStagingArtifact(target.key)
}
