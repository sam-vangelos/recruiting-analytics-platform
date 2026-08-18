import { describe, expect, test } from "vitest"

import { getStagingArtifact } from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import {
  CURRENT_CYCLE_FINAL_OFFER_Q3_SHEET_IDS,
  CURRENT_CYCLE_MANUAL_ONLY_STRUCTURAL_ARTIFACT_KEYS,
  CURRENT_CYCLE_PIPELINE_CANDIDATE_SHEET_IDS,
  currentCycleStagingStructuralNormalizationSpecs,
} from "../lib/recruiting-ops/delivery/staging-current-cycle-normalizations"
import { planStagingStructuralNormalization } from "../lib/recruiting-ops/delivery/staging-structural-normalization"

describe("current-cycle copied-sheet structural registry", () => {
  test("binds every migration to an exact registered copy and is idempotently plannable", () => {
    const specs = currentCycleStagingStructuralNormalizationSpecs()
    expect(specs.map((spec) => spec.artifactKey)).toEqual([
      "weekly_progress",
      "pipeline_907",
      "pipeline_1026_1027",
      "pipeline_1118_1119",
      "final_offer",
      "rps_tracking",
      "delivery_roles_rps",
    ])
    expect(CURRENT_CYCLE_MANUAL_ONLY_STRUCTURAL_ARTIFACT_KEYS).toEqual([
      "all_hires",
      "pipeline_890",
    ])
    expect(
      specs.some((spec) =>
        CURRENT_CYCLE_MANUAL_ONLY_STRUCTURAL_ARTIFACT_KEYS.some(
          (manualArtifactKey) => manualArtifactKey === spec.artifactKey
        )
      )
    ).toBe(false)
    expect(new Set(specs.map((spec) => spec.id)).size).toBe(specs.length)

    for (const spec of specs) {
      expect(spec.spreadsheetId).toBe(getStagingArtifact(spec.artifactKey).artifactId)
      expect(planStagingStructuralNormalization(spec, spec.expectedBefore).status).toBe("planned")
      expect(planStagingStructuralNormalization(spec, spec.expectedAfter)).toMatchObject({
        status: "already_normalized",
        requests: [],
        rollback: { requests: [] },
      })
    }
  })

  test("uses unique deterministic sheet ids within each copied workbook", () => {
    const pipelineIds = Object.values(CURRENT_CYCLE_PIPELINE_CANDIDATE_SHEET_IDS)
    expect(new Set(pipelineIds).size).toBe(pipelineIds.length)

    const finalOfferIds = Object.values(CURRENT_CYCLE_FINAL_OFFER_Q3_SHEET_IDS)
      .flatMap((month) => Object.values(month))
    expect(new Set(finalOfferIds).size).toBe(finalOfferIds.length)
    expect(finalOfferIds.every((id) => Number.isInteger(id) && id > 0 && id <= 2_147_483_647)).toBe(true)
  })
})
