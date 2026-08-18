import type {
  StagingArtifactKey,
  StagingArtifactKind,
} from "./staging-artifact-registry"

export interface CanonicalParityArtifact {
  readonly key: StagingArtifactKey
  readonly kind: StagingArtifactKind
  readonly artifactId: string
  readonly purpose: "manual_comparison_baseline"
  readonly readOnly: true
  readonly writeEligible: false
}

/**
 * Manual artifacts used only as read-only comparison baselines while their
 * copied counterparts are exercised. These ids are intentionally isolated
 * from the staging mutation registry and must never be accepted by a Google
 * mutation boundary.
 */
export const canonicalParityRegistry = Object.freeze([
  baseline("elt_doc", "google_doc", "1ExampleDriveId00000000000000000000000000021"),
  baseline("weekly_recruitment", "google_sheet", "1ExampleDriveId00000000000000000000000000016"),
  baseline("weekly_progress", "google_sheet", "1ExampleDriveId00000000000000000000000000002"),
  baseline("all_hires", "google_sheet", "1ExampleDriveId00000000000000000000000000018"),
  baseline("pipeline_890", "google_sheet", "1ExampleDriveId00000000000000000000000000020"),
  baseline("pipeline_907", "google_sheet", "1ExampleDriveId00000000000000000000000000009"),
  baseline("pipeline_1026_1027", "google_sheet", "1ExampleDriveId00000000000000000000000000022"),
  baseline("pipeline_1118_1119", "google_sheet", "1ExampleDriveId00000000000000000000000000005"),
  baseline("final_offer", "google_sheet", "1ExampleDriveId00000000000000000000000000003"),
  baseline("rps_tracking", "google_sheet", "1ExampleDriveId00000000000000000000000000008"),
  baseline("delivery_roles_rps", "google_sheet", "1ExampleDriveId00000000000000000000000000013"),
] as const) satisfies readonly CanonicalParityArtifact[]

const byKey = new Map(canonicalParityRegistry.map((artifact) => [artifact.key, artifact]))

/** Read-only lookup for comparison readers. There is deliberately no mutation resolver. */
export function getCanonicalParityArtifact(key: StagingArtifactKey): CanonicalParityArtifact {
  const artifact = byKey.get(key)
  if (!artifact) throw new Error(`Unknown canonical parity artifact key: ${key}`)
  return artifact
}

function baseline(
  key: StagingArtifactKey,
  kind: StagingArtifactKind,
  artifactId: string
): CanonicalParityArtifact {
  return Object.freeze({
    key,
    kind,
    artifactId,
    purpose: "manual_comparison_baseline",
    readOnly: true,
    writeEligible: false,
  })
}
