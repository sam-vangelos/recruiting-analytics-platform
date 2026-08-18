import {
  deliveryRpsRawFilterNormalizationSpec,
  finalOfferNormalizationSpec,
  pipelineNormalizationSpec,
  rpsTrackingNormalizationSpec,
  weeklyProgressNormalizationSpec,
  type FinalOfferQ3SheetIds,
  type StagingStructuralNormalizationSpec,
} from "./staging-structural-normalization"

/**
 * Reserved only inside their registered copied workbooks. These deterministic
 * ids make a retried one-time normalization recognize the same exact target
 * instead of creating a second tab.
 */
export const CURRENT_CYCLE_PIPELINE_CANDIDATE_SHEET_IDS = {
  pipeline_890: 1_800_000_890,
  pipeline_1026_1027: 1_800_102_627,
  pipeline_1118_1119: 1_800_111_819,
} as const

export const CURRENT_CYCLE_FINAL_OFFER_Q3_SHEET_IDS = {
  July: {
    offerData: 1_801_000_701,
    recruiterPerformance: 1_801_000_702,
    sourcerPerformance: 1_801_000_703,
  },
  August: {
    offerData: 1_801_000_801,
    recruiterPerformance: 1_801_000_802,
    sourcerPerformance: 1_801_000_803,
  },
  September: {
    offerData: 1_801_000_901,
    recruiterPerformance: 1_801_000_902,
    sourcerPerformance: 1_801_000_903,
  },
} as const satisfies FinalOfferQ3SheetIds

export const CURRENT_CYCLE_WEEK_HEADER = "03 Jul - 09 Jul"
export const CURRENT_CYCLE_PIPELINE_CANDIDATE_TITLE = "Candidate Level Data - 10 July"

/**
 * These copied-workbook form changes are intentionally outside the automated
 * current-cycle runner. Their standalone specs remain available as audited
 * historical/reference data, but they require a manual spreadsheet action.
 */
export const CURRENT_CYCLE_MANUAL_ONLY_STRUCTURAL_ARTIFACT_KEYS = [
  "all_hires",
  "pipeline_890",
] as const

/**
 * Exact one-time form changes needed before the 2026-07-03 through 2026-07-09
 * copied-sheet hydration. Canonical artifacts are neither parameters nor
 * members of this registry.
 */
export function currentCycleStagingStructuralNormalizationSpecs(): readonly StagingStructuralNormalizationSpec[] {
  return [
    weeklyProgressNormalizationSpec({ currentWeekHeader: CURRENT_CYCLE_WEEK_HEADER }),
    pipelineNormalizationSpec({
      artifactKey: "pipeline_907",
      currentCandidateTitle: CURRENT_CYCLE_PIPELINE_CANDIDATE_TITLE,
    }),
    pipelineNormalizationSpec({
      artifactKey: "pipeline_1026_1027",
      currentCandidateTitle: CURRENT_CYCLE_PIPELINE_CANDIDATE_TITLE,
      reservedCandidateSheetId: CURRENT_CYCLE_PIPELINE_CANDIDATE_SHEET_IDS.pipeline_1026_1027,
    }),
    pipelineNormalizationSpec({
      artifactKey: "pipeline_1118_1119",
      currentCandidateTitle: CURRENT_CYCLE_PIPELINE_CANDIDATE_TITLE,
      reservedCandidateSheetId: CURRENT_CYCLE_PIPELINE_CANDIDATE_SHEET_IDS.pipeline_1118_1119,
    }),
    finalOfferNormalizationSpec({ q3SheetIds: CURRENT_CYCLE_FINAL_OFFER_Q3_SHEET_IDS }),
    rpsTrackingNormalizationSpec(),
    deliveryRpsRawFilterNormalizationSpec(),
  ]
}
