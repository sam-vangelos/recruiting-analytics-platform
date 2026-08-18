import { describe, expect, test } from "vitest"

import {
  getStagingArtifact,
  STAGING_HYDRATION_ENABLED_AT_ENV,
  STAGING_HYDRATION_EXPIRES_AT_ENV,
  STAGING_HYDRATION_GLOBAL_FLAG,
} from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import { allHiresNormalizationSpec } from "../lib/recruiting-ops/delivery/staging-structural-normalization"
import {
  assertStagingStructuralWritePermit,
  stagingStructuralNormalizationFingerprint,
  type StagingStructuralWritePermit,
} from "../lib/recruiting-ops/delivery/staging-structural-write-permit"

const nowMs = Date.parse("2026-07-11T20:00:00.000Z")
const spec = allHiresNormalizationSpec()
const artifact = getStagingArtifact(spec.artifactKey)
const permit: StagingStructuralWritePermit = {
  artifactKey: spec.artifactKey,
  artifactId: spec.spreadsheetId,
  kind: "google_sheet",
  normalizationId: spec.id,
  normalizationFingerprint: stagingStructuralNormalizationFingerprint(spec),
  expectedStatus: "planned",
  observedStructureFingerprint: `sha256:${"b".repeat(64)}`,
  expectedDriveVersion: "10",
  runId: "structural_20260711200000000",
  sourceGeneratedAt: "2026-07-11T19:30:00.000Z",
  issuedAt: "2026-07-11T19:59:00.000Z",
  expiresAt: "2026-07-11T20:09:00.000Z",
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

describe("staging structural write permit", () => {
  test("accepts a fresh authorization bound to one immutable copy normalization", () => {
    expect(
      assertStagingStructuralWritePermit({ permit, spec, env, nowMs })
    ).toEqual(artifact)
  })

  test.each([
    ["global flag", permit, { [artifact.hydrationFlag]: "true" }, "flags"],
    ["artifact flag", permit, { [STAGING_HYDRATION_GLOBAL_FLAG]: "true" }, "flags"],
    ["expiry", { ...permit, expiresAt: "2026-07-11T20:00:00.000Z" }, env, "expired"],
    ["kill switch", { ...permit, killSwitchClear: false }, env, "kill-switch"],
    ["stale source", { ...permit, sourceGeneratedAt: "2026-07-11T17:59:59.999Z" }, env, "freshness"],
    ["Drive version", { ...permit, expectedDriveVersion: "" }, env, "Drive version"],
    ["contract fingerprint", { ...permit, normalizationFingerprint: `sha256:${"c".repeat(64)}` }, env, "immutable"],
    ["copy id", { ...permit, artifactId: "1ExampleDriveId00000000000000000000000000020" }, env, "exact registered"],
  ])("fails closed on %s", (_name, candidate, candidateEnv, reason) => {
    expect(() =>
      assertStagingStructuralWritePermit({
        permit: candidate as StagingStructuralWritePermit,
        spec,
        env: candidateEnv as Record<string, string>,
        nowMs,
      })
    ).toThrow(String(reason))
  })
})
