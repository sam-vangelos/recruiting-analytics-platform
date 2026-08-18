import { describe, expect, test } from "vitest"

import {
  getStagingArtifact,
  STAGING_HYDRATION_ENABLED_AT_ENV,
  STAGING_HYDRATION_EXPIRES_AT_ENV,
  STAGING_HYDRATION_GLOBAL_FLAG,
} from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import { assertStagingWritePermit, type StagingWritePermit } from "../lib/recruiting-ops/delivery/staging-write-permit"

const now = "2026-07-11T20:00:00.000Z"
const artifact = getStagingArtifact("all_hires")
const permit: StagingWritePermit = {
  artifactKey: artifact.key,
  artifactId: artifact.artifactId,
  kind: artifact.kind,
  runId: "hydration_20260711200000000",
  issuedAt: "2026-07-11T19:59:00.000Z",
  expiresAt: "2026-07-11T20:09:00.000Z",
  sourceGeneratedAt: "2026-07-11T19:30:00.000Z",
  payloadFingerprint: `hmac-sha256:${"a".repeat(64)}`,
  structureHash: `sha256:${"b".repeat(64)}`,
  approvedRangeIds: ["all_hires_data_rows"],
  killSwitchStoreReachable: true,
  killSwitchClear: true,
  canonicalOnly: true,
}
const env = {
  [STAGING_HYDRATION_GLOBAL_FLAG]: "true",
  [artifact.hydrationFlag]: "true",
  [STAGING_HYDRATION_ENABLED_AT_ENV]: "2026-07-11T19:59:00.000Z",
  [STAGING_HYDRATION_EXPIRES_AT_ENV]: "2026-07-11T20:10:00.000Z",
}

describe("staging Google write permit", () => {
  test("accepts a fresh, exact, fully gated staging permit", () => {
    expect(
      assertStagingWritePermit({
        permit,
        expectedArtifactKey: "all_hires",
        requiredRangeIds: ["all_hires_data_rows"],
        env,
        nowMs: Date.parse(now),
      })
    ).toEqual(artifact)
  })

  test.each([
    ["global flag off", permit, { [artifact.hydrationFlag]: "true" }, "flags"],
    ["artifact flag off", permit, { [STAGING_HYDRATION_GLOBAL_FLAG]: "true" }, "flags"],
    ["expired", { ...permit, expiresAt: "2026-07-11T20:00:00.000Z" }, env, "expired"],
    ["stale source", { ...permit, sourceGeneratedAt: "2026-07-11T17:59:59.999Z" }, env, "freshness"],
    ["wrong target", { ...permit, artifactId: getStagingArtifact("weekly_progress").artifactId }, env, "exact registered"],
    ["wrong range", permit, env, "authorize every requested range"],
    ["unkeyed payload hash", { ...permit, payloadFingerprint: `sha256:${"c".repeat(64)}` }, env, "HMAC"],
  ])("fails closed when %s", (_name, candidate, candidateEnv, reason) => {
    expect(() =>
      assertStagingWritePermit({
        permit: candidate as StagingWritePermit,
        expectedArtifactKey: "all_hires",
        requiredRangeIds: reason === "authorize every requested range" ? ["unapproved_range"] : ["all_hires_data_rows"],
        env: candidateEnv as Record<string, string>,
        nowMs: Date.parse(now),
      })
    ).toThrow(String(reason))
  })
})
