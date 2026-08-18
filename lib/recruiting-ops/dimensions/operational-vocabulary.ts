/**
 * Operational vocabulary resolver — the allowlist that lets value-driven
 * person-name detection (safe-public-output.ts) tell canonical operational
 * language apart from person names inside public strings.
 *
 * Two layers:
 * - `allowedPublicPhrases`: exact canonical strings assembled from the plane's
 *   own configs (registry titles, stage-taxonomy strings, legacy artifact
 *   titles, output-contract column labels). Required because some canonical
 *   phrases embed person names ("Recruiter Daily Report",
 *   "R2 - Arjun/Idris Interview"): the exact phrase stays usable as an
 *   operational label while the bare name remains redactable in free text.
 * - `operationalWords`: lower-cased single-word allowlist (versioned config at
 *   config/operational-vocabulary.v1.ts) for capitalized runs that are
 *   operational but not registered as exact phrases ("Weekly Progress Sheet
 *   for Frontier Data Lead"). A capitalized run counts as person-like when it
 *   is not an allowed phrase and contains at least one non-operational word.
 */
import { legacyArtifactRegistry } from "../legacy-artifact-registry"
import { concreteOutputContracts } from "../output-contracts"
import {
  queryRegistry,
  scriptAssetRegistry,
  sourceRegistry,
  workflowRegistry,
} from "../registries"
import { OPERATIONAL_WORDS_V1 } from "./config/operational-vocabulary.v1"
import { CORE_STAGE_ORDER, stageTaxonomyConfigV1 } from "./config/stage-taxonomy.v1"

function collectPhrases(): ReadonlySet<string> {
  const phrases = new Set<string>()
  const add = (value: string | undefined) => {
    if (typeof value === "string" && value.trim()) phrases.add(value.trim())
  }

  for (const row of workflowRegistry) add(row.title)
  for (const row of sourceRegistry) add(row.title)
  for (const row of queryRegistry) add(row.title)
  for (const row of scriptAssetRegistry) add(row.title)
  for (const row of legacyArtifactRegistry) add(row.title)
  for (const contract of concreteOutputContracts) {
    for (const column of contract.columns) add(column.label)
  }
  for (const entry of stageTaxonomyConfigV1) {
    add(entry.substage)
    add(entry.coreStage)
  }
  for (const entry of CORE_STAGE_ORDER) add(entry.coreStage)

  return phrases
}

export const allowedPublicPhrases: ReadonlySet<string> = collectPhrases()

export const operationalWords: ReadonlySet<string> = new Set<string>(OPERATIONAL_WORDS_V1)
