import { describe, expect, test, vi } from "vitest"

import type { GreenhouseHarvestReadClient } from "../lib/recruiting-ops/extractors/greenhouse-harvest-read-adapter"
import {
  createLivePinnedStagingSheetAcceptanceCutLoader,
} from "../lib/recruiting-ops/delivery-source/staging-sheet-acceptance-source-loader"
import type {
  StagingHydrationFacts,
  StagingHydrationSourceCollections,
} from "../lib/recruiting-ops/delivery-source/staging-hydration-source-loader"

const NOW = Date.parse("2026-07-11T12:00:00.000Z")

describe("live pinned staging Sheet acceptance cut loader", () => {
  test("has no production Greenhouse client outside the persisted orchestrator cut", async () => {
    const loadPinnedCut = createLivePinnedStagingSheetAcceptanceCutLoader()

    await expect(loadPinnedCut({ artifactKey: "all_hires" })).rejects.toThrow(
      "replay the orchestrator's persisted source cut"
    )
  })

  test("loads Greenhouse, roster, and taxonomy once and reuses the exact same pinned cut", async () => {
    const greenhouse = { list: vi.fn() } as unknown as GreenhouseHarvestReadClient
    const roster = [{
      recruiterName: "Fixture Recruiter",
      teamId: "team-1",
      teamName: "Fixture Team",
      hodName: "Fixture HOD",
    }]
    const taxonomy = [{
      stageLabel: "Fixture interview",
      stageClass: "technical" as const,
      funnelStage: "TECHNICAL",
    }]
    const collections = {} as StagingHydrationSourceCollections
    const facts = fixtureFacts()
    const createGreenhouseClient = vi.fn(() => greenhouse)
    const loadRoster = vi.fn(async () => roster)
    const loadStageTaxonomy = vi.fn(async () => taxonomy)
    const loadCollections = vi.fn(async () => collections)
    const deriveFacts = vi.fn(() => facts)
    const loadPinnedCut = createLivePinnedStagingSheetAcceptanceCutLoader(
      { nowMs: NOW },
      {
        createGreenhouseClient,
        loadRoster,
        loadStageTaxonomy,
        loadCollections,
        deriveFacts,
      }
    )

    const [first, second] = await Promise.all([
      loadPinnedCut({ artifactKey: "rps_tracking" }),
      loadPinnedCut({ artifactKey: "rps_tracking" }),
    ])

    expect(first).toBe(second)
    expect(first).toEqual({ facts, roster })
    expect(createGreenhouseClient).toHaveBeenCalledOnce()
    expect(loadRoster).toHaveBeenCalledOnce()
    expect(loadStageTaxonomy).toHaveBeenCalledOnce()
    expect(loadCollections).toHaveBeenCalledOnce()
    expect(loadCollections).toHaveBeenCalledWith({
      client: greenhouse,
      nowMs: NOW,
      recordCap: 200_000,
      requirements: {
        includeLegacyRpsHistory: true,
        includeDeliveryRpsCurrentWeek: false,
      },
    })
    expect(deriveFacts).toHaveBeenCalledWith({
      collections,
      roster,
      stageTaxonomy: [{ stageLabel: "Fixture interview", funnelStage: "TECHNICAL" }],
    })
  })

  test("cannot be rebound to a second artifact after its source requirements are pinned", async () => {
    const loadPinnedCut = createLivePinnedStagingSheetAcceptanceCutLoader(
      {},
      {
        createGreenhouseClient: () => ({ list: vi.fn() } as unknown as GreenhouseHarvestReadClient),
        loadRoster: async () => [],
        loadStageTaxonomy: async () => [],
        loadCollections: async () => ({} as StagingHydrationSourceCollections),
        deriveFacts: () => fixtureFacts(),
      }
    )

    await loadPinnedCut({ artifactKey: "all_hires" })
    await expect(loadPinnedCut({ artifactKey: "weekly_progress" })).rejects.toThrow("cannot be rebound")
  })
})

function fixtureFacts(): StagingHydrationFacts {
  return {
    generatedAt: "2026-07-11T12:00:00.000Z",
    reportingWeekFriday: "2026-07-03",
    quarterStart: "2026-07-01",
    candidateEvents: [],
    offers: [],
    scorecards: [],
    reqWeeks: [],
    diagnostics: [],
  }
}
