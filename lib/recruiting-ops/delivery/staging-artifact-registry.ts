export type StagingArtifactKind = "google_sheet" | "google_doc"
export type StagingMaintenanceLane = "weekday_morning" | "weekday_evening"

export type StagingArtifactKey =
  | "elt_doc"
  | "weekly_recruitment"
  | "weekly_progress"
  | "all_hires"
  | "pipeline_890"
  | "pipeline_907"
  | "pipeline_1026_1027"
  | "pipeline_1118_1119"
  | "final_offer"
  | "rps_tracking"
  | "delivery_roles_rps"

export interface StagingArtifactTarget {
  key: StagingArtifactKey
  kind: StagingArtifactKind
  artifactId: string
  deliverableId: string
  phase: "P1" | "P2" | "P3" | "P4" | "P5"
  cadence: "hourly" | "daily" | "weekly" | "monthly"
  maintenanceLane: StagingMaintenanceLane | null
  hydrationFlag: string
  mutationTarget: "canonical"
}

export const STAGING_HYDRATION_GLOBAL_FLAG = "RECOPS_STAGING_HYDRATION_ENABLED"
/** Legacy supervised-run settings; unattended Jobs intentionally ignore them. */
export const STAGING_HYDRATION_ENABLED_AT_ENV = "RECOPS_STAGING_HYDRATION_ENABLED_AT"
export const STAGING_HYDRATION_EXPIRES_AT_ENV = "RECOPS_STAGING_HYDRATION_EXPIRES_AT"

/**
 * The only Google files a write-capable delivery adapter may target. Per
 * the 2026-08-06 canonical-cutover directive, this registry now binds the
 * 11 CANONICAL artifacts directly; mutation authority is no longer routed
 * through the operator-owned copies. See docs/recruiting-ops/delivery/p1/PREREQUISITES.md
 * (RECOPS-ELT-FACT-TABLE-BOUNDARY-v3) for the directive record.
 *
 * Retired copy ids (no longer targetable; kept here only for history/audit):
 *   elt_doc             1ExampleDriveId00000000000000000000000000007
 *   weekly_recruitment  1ExampleDriveId00000000000000000000000000019
 *   weekly_progress     1ExampleDriveId00000000000000000000000000011
 *   all_hires           1ExampleDriveId00000000000000000000000000004
 *   pipeline_890        1ExampleDriveId00000000000000000000000000015
 *   pipeline_907        1ExampleDriveId00000000000000000000000000023
 *   pipeline_1026_1027  1ExampleDriveId00000000000000000000000000006
 *   pipeline_1118_1119  1ExampleDriveId00000000000000000000000000017
 *   final_offer         1ExampleDriveId00000000000000000000000000001
 *   rps_tracking        1ExampleDriveId00000000000000000000000000014
 *   delivery_roles_rps  1ExampleDriveId00000000000000000000000000010
 */
export const stagingArtifactRegistry = [
  target(
    "elt_doc",
    "google_doc",
    "1ExampleDriveId00000000000000000000000000021",
    "elt_recruiting_doc",
    "P1",
    "weekly",
    "weekday_morning",
    "RECOPS_HYDRATE_ELT_DOC"
  ),
  target(
    "weekly_recruitment",
    "google_sheet",
    "1ExampleDriveId00000000000000000000000000016",
    "weekly_recruitment_sheet",
    "P2",
    "weekly",
    "weekday_morning",
    "RECOPS_HYDRATE_WEEKLY_RECRUITMENT"
  ),
  target(
    "weekly_progress",
    "google_sheet",
    "1ExampleDriveId00000000000000000000000000002",
    "weekly_progress_sheet",
    "P1",
    "weekly",
    "weekday_morning",
    "RECOPS_HYDRATE_WEEKLY_PROGRESS"
  ),
  target(
    "all_hires",
    "google_sheet",
    "1ExampleDriveId00000000000000000000000000018",
    "all_hires_sheet",
    "P1",
    "daily",
    "weekday_morning",
    "RECOPS_HYDRATE_ALL_HIRES"
  ),
  target(
    "pipeline_890",
    "google_sheet",
    "1ExampleDriveId00000000000000000000000000020",
    "role_pipeline_sheets",
    "P1",
    "weekly",
    "weekday_morning",
    "RECOPS_HYDRATE_PIPELINE_890"
  ),
  target(
    "pipeline_907",
    "google_sheet",
    "1ExampleDriveId00000000000000000000000000009",
    "role_pipeline_sheets",
    "P1",
    "weekly",
    "weekday_morning",
    "RECOPS_HYDRATE_PIPELINE_907"
  ),
  target(
    "pipeline_1026_1027",
    "google_sheet",
    "1ExampleDriveId00000000000000000000000000022",
    "role_pipeline_sheets",
    "P1",
    "weekly",
    "weekday_morning",
    "RECOPS_HYDRATE_PIPELINE_1026_1027"
  ),
  target(
    "pipeline_1118_1119",
    "google_sheet",
    "1ExampleDriveId00000000000000000000000000005",
    "role_pipeline_sheets",
    "P1",
    "weekly",
    "weekday_morning",
    "RECOPS_HYDRATE_PIPELINE_1118_1119"
  ),
  target(
    "final_offer",
    "google_sheet",
    "1ExampleDriveId00000000000000000000000000003",
    "final_offer_sheet",
    "P3",
    "weekly",
    "weekday_morning",
    "RECOPS_HYDRATE_FINAL_OFFER"
  ),
  target(
    "rps_tracking",
    "google_sheet",
    "1ExampleDriveId00000000000000000000000000008",
    "rps_tracking_sheet",
    "P4",
    "weekly",
    "weekday_morning",
    "RECOPS_HYDRATE_RPS_TRACKING"
  ),
  target(
    "delivery_roles_rps",
    "google_sheet",
    "1ExampleDriveId00000000000000000000000000013",
    "recruiter_daily_sheet",
    "P5",
    "daily",
    "weekday_evening",
    "RECOPS_HYDRATE_DELIVERY_ROLES_RPS"
  ),
] as const satisfies readonly StagingArtifactTarget[]

const byKey = new Map(stagingArtifactRegistry.map((artifact) => [artifact.key, artifact]))
const byId = new Map(stagingArtifactRegistry.map((artifact) => [artifact.artifactId, artifact]))

export function getStagingArtifact(key: StagingArtifactKey): StagingArtifactTarget {
  const artifact = byKey.get(key)
  if (!artifact) throw new Error(`Unknown staging artifact key: ${key}`)
  return artifact
}

export function requireStagingMutationTarget(input: {
  key: StagingArtifactKey
  artifactId: string
  kind: StagingArtifactKind
}): StagingArtifactTarget {
  const artifact = getStagingArtifact(input.key)
  if (artifact.artifactId !== input.artifactId || artifact.kind !== input.kind) {
    throw new Error("Google mutation target is not the exact registered staging artifact.")
  }
  if (byId.get(input.artifactId)?.key !== input.key) {
    throw new Error("Google mutation target has an ambiguous staging binding.")
  }
  return artifact
}

export function stagingHydrationEnabled(
  key: StagingArtifactKey,
  nowMs: number,
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const artifact = getStagingArtifact(key)
  if (
    env[STAGING_HYDRATION_GLOBAL_FLAG]?.trim() !== "true" ||
    env[artifact.hydrationFlag]?.trim() !== "true" ||
    !Number.isFinite(nowMs)
  ) {
    return false
  }
  return true
}

function target(
  key: StagingArtifactKey,
  kind: StagingArtifactKind,
  artifactId: string,
  deliverableId: string,
  phase: StagingArtifactTarget["phase"],
  cadence: StagingArtifactTarget["cadence"],
  maintenanceLane: StagingArtifactTarget["maintenanceLane"],
  hydrationFlag: string
): StagingArtifactTarget {
  return {
    key,
    kind,
    artifactId,
    deliverableId,
    phase,
    cadence,
    maintenanceLane,
    hydrationFlag,
    mutationTarget: "canonical",
  }
}
