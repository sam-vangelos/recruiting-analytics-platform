import {
  STAGE_TAXONOMY_CONFIG_VERSION,
  stageTaxonomyConfigV1,
  type StageTaxonomyEntry,
} from "./config/stage-taxonomy.v1"
import { UNRESOLVED_STAGE, type StageResolution } from "./types"

/**
 * Pure substage → core_stage resolver. No I/O; the taxonomy config is injected
 * (defaults to the fixture v1 config). A substage the legacy reqs mapped
 * inconsistently (`divergent`) still resolves to the canonical core stage but at
 * `inferred` confidence, signalling a candidate `stale_mapping`. An unknown substage
 * yields a NULL core stage and a defect status — never a sentinel.
 */

export function resolveStage(
  substage: string | null | undefined,
  config: readonly StageTaxonomyEntry[] = stageTaxonomyConfigV1
): StageResolution {
  const value = substage?.trim()
  if (!value) {
    return { ...UNRESOLVED_STAGE, evidence: "no substage supplied" }
  }

  const entry = config.find((item) => item.substage.toLowerCase() === value.toLowerCase())
  if (!entry) {
    return { ...UNRESOLVED_STAGE, evidence: `no stage mapping for ${value} (${STAGE_TAXONOMY_CONFIG_VERSION})` }
  }

  return {
    core_stage: entry.coreStage,
    stage_order: entry.stageOrder,
    confidence: entry.divergent ? "inferred" : "confirmed",
    status: "resolved",
    evidence: `${STAGE_TAXONOMY_CONFIG_VERSION}:${entry.substage}${entry.divergent ? " (divergent across legacy reqs)" : ""}`,
  }
}
