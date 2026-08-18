import type { StagingSheetArtifactKey } from "./staging-artifact-value-planner"
import { getStagingSheetContract, type StagingSheetContractId } from "./staging-sheet-contracts"

/**
 * Independent completeness contract for copy acceptance. This must not be
 * derived from a planner result: omitting a planned write is itself an
 * acceptance failure.
 */
export const stagingSheetAcceptanceSurfaceRegistry = Object.freeze({
  weekly_recruitment: Object.freeze([
    "weekly_recruitment_a_c",
    "weekly_recruitment_e_f",
    "weekly_recruitment_h_i",
    "weekly_recruitment_m_w",
    "weekly_recruitment_y_z",
  ]),
  weekly_progress: Object.freeze([
    "weekly_progress_code_rl",
    "weekly_progress_fde_pe",
    "weekly_progress_brazil_colombia",
  ]),
  all_hires: Object.freeze(["all_hires_data"]),
  pipeline_890: Object.freeze(["pipeline_890_candidate", "pipeline_890_job_week"]),
  pipeline_907: Object.freeze(["pipeline_907_candidate", "pipeline_907_job_week"]),
  pipeline_1026_1027: Object.freeze([
    "pipeline_1026_1027_candidate",
    "pipeline_1026_1027_job_week",
  ]),
  pipeline_1118_1119: Object.freeze([
    "pipeline_1118_1119_candidate",
    "pipeline_1118_1119_job_week",
  ]),
  final_offer: Object.freeze([
    "final_offer_master",
    "final_offer_performance_data",
    "final_offer_july_data",
    "final_offer_august_data",
    "final_offer_september_data",
  ]),
  rps_tracking: Object.freeze(["rps_data_dump"]),
  delivery_roles_rps: Object.freeze([
    "delivery_rps_raw",
    "delivery_rps_clean",
    "delivery_rps_dated",
  ]),
} as const satisfies Readonly<Record<StagingSheetArtifactKey, readonly StagingSheetContractId[]>>)

export function expectedStagingSheetAcceptanceSurfaceIds(
  artifactKey: StagingSheetArtifactKey
): readonly StagingSheetContractId[] {
  const ids = stagingSheetAcceptanceSurfaceRegistry[artifactKey]
  for (const id of ids) {
    if (getStagingSheetContract(id).artifactKey !== artifactKey) {
      throw new Error("Staging acceptance surface is bound to the wrong artifact contract.")
    }
  }
  return ids
}
