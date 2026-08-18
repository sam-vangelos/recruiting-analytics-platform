import { describe, expect, test } from "vitest"

import {
  canonicalParityRegistry,
  getCanonicalParityArtifact,
} from "../lib/recruiting-ops/delivery/canonical-parity-registry"
import {
  requireStagingMutationTarget,
  stagingArtifactRegistry,
} from "../lib/recruiting-ops/delivery/staging-artifact-registry"

const expectedCanonicalIds = {
  elt_doc: "1ExampleDriveId00000000000000000000000000021",
  weekly_recruitment: "1ExampleDriveId00000000000000000000000000016",
  weekly_progress: "1ExampleDriveId00000000000000000000000000002",
  all_hires: "1ExampleDriveId00000000000000000000000000018",
  pipeline_890: "1ExampleDriveId00000000000000000000000000020",
  pipeline_907: "1ExampleDriveId00000000000000000000000000009",
  pipeline_1026_1027: "1ExampleDriveId00000000000000000000000000022",
  pipeline_1118_1119: "1ExampleDriveId00000000000000000000000000005",
  final_offer: "1ExampleDriveId00000000000000000000000000003",
  rps_tracking: "1ExampleDriveId00000000000000000000000000008",
  delivery_roles_rps: "1ExampleDriveId00000000000000000000000000013",
} as const

describe("canonical parity registry", () => {
  test("registers all eleven manual baselines as comparison-only", () => {
    expect(canonicalParityRegistry).toHaveLength(11)
    expect(Object.fromEntries(canonicalParityRegistry.map((artifact) => [artifact.key, artifact.artifactId]))).toEqual(
      expectedCanonicalIds
    )
    expect(new Set(canonicalParityRegistry.map((artifact) => artifact.key)).size).toBe(11)
    expect(new Set(canonicalParityRegistry.map((artifact) => artifact.artifactId)).size).toBe(11)
    expect(Object.isFrozen(canonicalParityRegistry)).toBe(true)
    expect(canonicalParityRegistry.every(Object.isFrozen)).toBe(true)
    expect(
      canonicalParityRegistry.every(
        (artifact) =>
          artifact.readOnly === true &&
          artifact.writeEligible === false &&
          artifact.purpose === "manual_comparison_baseline"
      )
    ).toBe(true)
  })

  // Per the operator's 2026-08-06 canonical-cutover directive, the mutation registry
  // (lib/recruiting-ops/delivery/staging-artifact-registry.ts) now binds
  // these exact canonical ids directly, so every one of them now resolves as
  // the exact registered mutation target instead of being denied.
  const RETIRED_COPY_IDS = {
    elt_doc: "1ExampleDriveId00000000000000000000000000007",
    weekly_recruitment: "1ExampleDriveId00000000000000000000000000019",
    weekly_progress: "1ExampleDriveId00000000000000000000000000011",
    all_hires: "1ExampleDriveId00000000000000000000000000004",
    pipeline_890: "1ExampleDriveId00000000000000000000000000015",
    pipeline_907: "1ExampleDriveId00000000000000000000000000023",
    pipeline_1026_1027: "1ExampleDriveId00000000000000000000000000006",
    pipeline_1118_1119: "1ExampleDriveId00000000000000000000000000017",
    final_offer: "1ExampleDriveId00000000000000000000000000001",
    rps_tracking: "1ExampleDriveId00000000000000000000000000014",
    delivery_roles_rps: "1ExampleDriveId00000000000000000000000000010",
  } as const

  test("every canonical id is now the exact bound mutation target (post-cutover)", () => {
    const stagingIds = new Set(stagingArtifactRegistry.map((artifact) => artifact.artifactId))
    for (const canonical of canonicalParityRegistry) {
      expect(stagingIds.has(canonical.artifactId)).toBe(true)
      expect(
        requireStagingMutationTarget({
          key: canonical.key,
          artifactId: canonical.artifactId,
          kind: canonical.kind,
        })
      ).toMatchObject({ key: canonical.key, artifactId: canonical.artifactId })
    }
  })

  test("every retired copy id is now structurally denied by the mutation resolver", () => {
    const stagingIds = new Set(stagingArtifactRegistry.map((artifact) => artifact.artifactId))
    for (const [key, retiredId] of Object.entries(RETIRED_COPY_IDS)) {
      expect(stagingIds.has(retiredId)).toBe(false)
      expect(() =>
        requireStagingMutationTarget({
          key: key as keyof typeof RETIRED_COPY_IDS,
          artifactId: retiredId,
          kind: getCanonicalParityArtifact(key as keyof typeof RETIRED_COPY_IDS).kind,
        })
      ).toThrow("exact registered staging artifact")
    }
  })

  test("looks up baselines by the same stable artifact key used by copied targets", () => {
    expect(getCanonicalParityArtifact("all_hires")).toMatchObject({
      artifactId: expectedCanonicalIds.all_hires,
      kind: "google_sheet",
      readOnly: true,
      writeEligible: false,
    })
  })
})
