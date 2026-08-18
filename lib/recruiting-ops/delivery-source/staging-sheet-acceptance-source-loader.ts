import type { GreenhouseHarvestReadClient } from "../extractors/greenhouse-harvest-read-adapter"
import {
  loadGovernedRoster,
  loadInterviewStageTaxonomy,
} from "../governed-dimensions-client"
import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import type { InterviewStageTaxonomyEntry } from "../dimensions/types"
import type { PinnedStagingSheetAcceptanceCut } from "../delivery/staging-sheet-acceptance-runner"
import type { StagingSheetArtifactKey } from "../delivery/staging-artifact-value-planner"
import { getStagingArtifact } from "../delivery/staging-artifact-registry"
import { stagingHydrationSourceRequirementsForArtifacts } from "../delivery/staging-hydration-runner"
import {
  deriveStagingHydrationFacts,
  loadStagingHydrationSourceCollections,
} from "./staging-hydration-source-loader"

const LIVE_RECORD_CAP = 200_000

export interface LivePinnedCutSourceDependencies {
  createGreenhouseClient(): GreenhouseHarvestReadClient
  loadRoster(): Promise<readonly RecruiterTeamHodEntry[]>
  loadStageTaxonomy(): Promise<readonly InterviewStageTaxonomyEntry[]>
  loadCollections: typeof loadStagingHydrationSourceCollections
  deriveFacts: typeof deriveStagingHydrationFacts
}

const defaultDependencies: LivePinnedCutSourceDependencies = {
  createGreenhouseClient: () => {
    throw new Error("Direct live acceptance source loading is retired; replay the orchestrator's persisted source cut.")
  },
  loadRoster: loadGovernedRoster,
  loadStageTaxonomy: loadInterviewStageTaxonomy,
  loadCollections: loadStagingHydrationSourceCollections,
  deriveFacts: deriveStagingHydrationFacts,
}

/**
 * Creates a per-acceptance, one-cut loader. Its first exact Sheet artifact
 * binds the loader; all later calls return the same promise and cannot trigger
 * a second Greenhouse, roster, or taxonomy read. A call for another artifact
 * fails closed instead of silently mixing source requirements.
 */
export function createLivePinnedStagingSheetAcceptanceCutLoader(
  input: { nowMs?: number } = {},
  dependencies: Partial<LivePinnedCutSourceDependencies> = {}
): (request: { artifactKey: StagingSheetArtifactKey }) => Promise<PinnedStagingSheetAcceptanceCut> {
  const deps = { ...defaultDependencies, ...dependencies }
  let boundArtifactKey: StagingSheetArtifactKey | null = null
  let cutPromise: Promise<PinnedStagingSheetAcceptanceCut> | null = null

  return async ({ artifactKey }) => {
    const target = getStagingArtifact(artifactKey)
    if (target.kind !== "google_sheet") {
      throw new Error("Pinned staging acceptance sources require one registered Sheet copy.")
    }
    if (boundArtifactKey && artifactKey !== boundArtifactKey) {
      throw new Error("Pinned staging acceptance sources cannot be rebound to another artifact.")
    }
    boundArtifactKey = artifactKey
    cutPromise ??= loadOnePinnedCut({
      artifactKey,
      nowMs: input.nowMs,
      dependencies: deps,
    })
    return cutPromise
  }
}

async function loadOnePinnedCut(input: {
  artifactKey: StagingSheetArtifactKey
  nowMs?: number
  dependencies: LivePinnedCutSourceDependencies
}): Promise<PinnedStagingSheetAcceptanceCut> {
  const greenhouse = input.dependencies.createGreenhouseClient()
  const [roster, stageTaxonomy] = await Promise.all([
    input.dependencies.loadRoster(),
    input.dependencies.loadStageTaxonomy(),
  ])
  const collections = await input.dependencies.loadCollections({
    client: greenhouse,
    nowMs: input.nowMs,
    recordCap: LIVE_RECORD_CAP,
    requirements: stagingHydrationSourceRequirementsForArtifacts([input.artifactKey]),
  })
  const facts = input.dependencies.deriveFacts({
    collections,
    roster,
    stageTaxonomy: stageTaxonomy.map((entry) => ({
      stageLabel: entry.stageLabel,
      funnelStage: entry.funnelStage ?? null,
    })),
  })
  return { facts, roster }
}
