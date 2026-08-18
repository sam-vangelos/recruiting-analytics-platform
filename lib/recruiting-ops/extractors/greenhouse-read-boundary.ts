import type { GreenhousePipelineStageFact } from "../modules/t02-pipeline"
import type { GreenhouseRpsFact } from "../modules/t05-rps"
import type { GreenhouseFinalOfferFact } from "../modules/t07-final-offer"
import type { GreenhouseOwnershipFact } from "../modules/t09-ownership"
import type { SourceGap } from "../runs"

export interface GreenhouseReadContext {
  asOf: string
  fixtureLabel?: string
}

/**
 * Every fetch returns facts AND the adapter-level source gaps produced while
 * mapping source records into facts. A record the source returned that could
 * not become a fact MUST appear as a gap — the boundary contract makes silent
 * drops unrepresentable (the T02 first-light failure: 5000 live applications
 * became 0 facts with 0 gaps because the boundary discarded diagnostics).
 */
export interface GreenhouseFactFetchResult<TFact> {
  facts: readonly TFact[]
  sourceGaps: readonly SourceGap[]
}

export interface GreenhouseReadBoundary {
  readonly sourceAdapter: "greenhouse_v3_read"
  fetchFinalOfferFacts(context: GreenhouseReadContext): Promise<GreenhouseFactFetchResult<GreenhouseFinalOfferFact>>
  fetchRpsFacts(context: GreenhouseReadContext): Promise<GreenhouseFactFetchResult<GreenhouseRpsFact>>
  fetchPipelineStageFacts(
    context: GreenhouseReadContext
  ): Promise<GreenhouseFactFetchResult<GreenhousePipelineStageFact>>
  fetchOwnershipFacts(context: GreenhouseReadContext): Promise<GreenhouseFactFetchResult<GreenhouseOwnershipFact>>
}

export interface GreenhouseFixtureFacts {
  finalOffers: readonly GreenhouseFinalOfferFact[]
  rps: readonly GreenhouseRpsFact[]
  pipeline: readonly GreenhousePipelineStageFact[]
  ownership: readonly GreenhouseOwnershipFact[]
}

export function createFixtureGreenhouseReadBoundary(facts: GreenhouseFixtureFacts): GreenhouseReadBoundary {
  return {
    sourceAdapter: "greenhouse_v3_read",
    async fetchFinalOfferFacts() {
      return { facts: cloneRows(facts.finalOffers), sourceGaps: [] }
    },
    async fetchRpsFacts() {
      return { facts: cloneRows(facts.rps), sourceGaps: [] }
    },
    async fetchPipelineStageFacts() {
      return { facts: cloneRows(facts.pipeline), sourceGaps: [] }
    },
    async fetchOwnershipFacts() {
      return { facts: cloneRows(facts.ownership), sourceGaps: [] }
    },
  }
}

export async function validateGreenhouseReadBoundary(
  boundary: GreenhouseReadBoundary,
  context: GreenhouseReadContext
): Promise<{
  ok: true
  counts: Record<keyof GreenhouseFixtureFacts, number>
  sourceGapCounts: Record<keyof GreenhouseFixtureFacts, number>
}> {
  const [finalOffers, rps, pipeline, ownership] = await Promise.all([
    boundary.fetchFinalOfferFacts(context),
    boundary.fetchRpsFacts(context),
    boundary.fetchPipelineStageFacts(context),
    boundary.fetchOwnershipFacts(context),
  ])

  return {
    ok: true,
    counts: {
      finalOffers: finalOffers.facts.length,
      rps: rps.facts.length,
      pipeline: pipeline.facts.length,
      ownership: ownership.facts.length,
    },
    sourceGapCounts: {
      finalOffers: finalOffers.sourceGaps.length,
      rps: rps.sourceGaps.length,
      pipeline: pipeline.sourceGaps.length,
      ownership: ownership.sourceGaps.length,
    },
  }
}

function cloneRows<T>(rows: readonly T[]): T[] {
  return rows.map((row) => ({ ...(row as Record<string, unknown>) }) as T)
}
