import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

import {
  createFixtureGreenhouseReadBoundary,
  validateGreenhouseReadBoundary,
  type GreenhouseFixtureFacts,
} from "../lib/recruiting-ops/extractors/greenhouse-read-boundary"

const fixtureRoot = join(process.cwd(), "test", "fixtures", "recruiting-ops")

function readFixture<T>(fileName: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, fileName), "utf8")) as T
}

function readGreenhouseFixtures(): GreenhouseFixtureFacts {
  return {
    finalOffers: readFixture("greenhouse-final-offers.json"),
    rps: readFixture("greenhouse-rps.json"),
    pipeline: readFixture("greenhouse-pipeline.json"),
    ownership: readFixture("greenhouse-ownership.json"),
  }
}

describe("recruiting ops Greenhouse read boundary", () => {
  test("exposes read-only Greenhouse-shaped fixture facts for P0/P1 modules", async () => {
    const boundary = createFixtureGreenhouseReadBoundary(readGreenhouseFixtures())
    const validation = await validateGreenhouseReadBoundary(boundary, {
      asOf: "2026-06-24T23:30:00.000Z",
      fixtureLabel: "contract-test",
    })

    expect(boundary.sourceAdapter).toBe("greenhouse_v3_read")
    expect(validation).toEqual({
      ok: true,
      counts: {
        finalOffers: 1,
        rps: 1,
        pipeline: 2,
        ownership: 1,
      },
      sourceGapCounts: {
        finalOffers: 0,
        rps: 0,
        pipeline: 0,
        ownership: 0,
      },
    })
  })

  test("every fetch result carries an explicit sourceGaps channel (no silent-drop shape)", async () => {
    const boundary = createFixtureGreenhouseReadBoundary(readGreenhouseFixtures())
    const context = { asOf: "2026-06-24T23:30:00.000Z" }
    for (const fetchResult of await Promise.all([
      boundary.fetchFinalOfferFacts(context),
      boundary.fetchRpsFacts(context),
      boundary.fetchPipelineStageFacts(context),
      boundary.fetchOwnershipFacts(context),
    ])) {
      expect(Array.isArray(fetchResult.facts)).toBe(true)
      expect(Array.isArray(fetchResult.sourceGaps)).toBe(true)
    }
  })

  test("returns cloned rows so fixture callers cannot mutate shared evidence", async () => {
    const boundary = createFixtureGreenhouseReadBoundary(readGreenhouseFixtures())
    const firstRead = await boundary.fetchFinalOfferFacts({ asOf: "2026-06-24T23:30:00.000Z" })
    ;(firstRead.facts[0] as { status: string }).status = "declined"

    const secondRead = await boundary.fetchFinalOfferFacts({ asOf: "2026-06-24T23:31:00.000Z" })
    expect(secondRead.facts[0].status).toBe("accepted")
  })
})
