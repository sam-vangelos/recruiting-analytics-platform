import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test, vi } from "vitest"

import {
  GreenhouseLiveReadDisabledError,
  createPhase4GreenhouseLiveReadBoundary,
  evaluateGreenhouseLiveReadReadiness,
} from "../lib/recruiting-ops/extractors/greenhouse-live-read-scaffold"
import type { GreenhouseFixtureFacts } from "../lib/recruiting-ops/extractors/greenhouse-read-boundary"
import type { GreenhousePipelineStageFact } from "../lib/recruiting-ops/modules/t02-pipeline"
import type { GreenhouseRpsFact } from "../lib/recruiting-ops/modules/t05-rps"
import type { GreenhouseFinalOfferFact } from "../lib/recruiting-ops/modules/t07-final-offer"
import type { GreenhouseOwnershipFact } from "../lib/recruiting-ops/modules/t09-ownership"

const fixtureRoot = join(process.cwd(), "test", "fixtures", "recruiting-ops")

function readFixture<T>(fileName: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, fileName), "utf8")) as T
}

function facts(): GreenhouseFixtureFacts {
  return {
    finalOffers: readFixture<GreenhouseFinalOfferFact[]>("greenhouse-final-offers.json"),
    rps: readFixture<GreenhouseRpsFact[]>("greenhouse-rps.json"),
    pipeline: readFixture<GreenhousePipelineStageFact[]>("greenhouse-pipeline.json"),
    ownership: readFixture<GreenhouseOwnershipFact[]>("greenhouse-ownership.json"),
  }
}

describe("Phase 4 Greenhouse live-read scaffold", () => {
  test("defaults to a disabled boundary and does not call fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const boundary = createPhase4GreenhouseLiveReadBoundary()

    await expect(boundary.fetchRpsFacts({ asOf: "2026-06-24T00:00:00.000Z" })).rejects.toBeInstanceOf(
      GreenhouseLiveReadDisabledError
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  test("reports disabled readiness with live reads, credentials, and network calls off", () => {
    const report = evaluateGreenhouseLiveReadReadiness({
      generatedAt: "2026-06-24T00:00:00.000Z",
    })

    expect(report).toMatchObject({
      adapterId: "greenhouse_harvest",
      sourceAdapter: "greenhouse_v3_read",
      mode: "disabled",
      status: "disabled",
      liveReadsEnabled: false,
      networkCallsAllowed: false,
      liveAuthAllowed: false,
    })
    expect(report.checks.every((check) => check.status === "pass")).toBe(true)
  })

  test("blocks readiness if any live-read boundary flag is enabled", () => {
    const report = evaluateGreenhouseLiveReadReadiness({
      generatedAt: "2026-06-24T00:00:00.000Z",
      liveReadFlagEnabled: true,
      realCredentialsConfigured: true,
      networkCallsEnabled: true,
    })

    expect(report.status).toBe("blocked")
    expect(report.liveReadsEnabled).toBe(false)
    expect(report.networkCallsAllowed).toBe(false)
    expect(report.liveAuthAllowed).toBe(false)
    expect(report.checks.filter((check) => check.status === "fail").map((check) => check.checkId)).toEqual([
      "live_read_flag",
      "real_credentials",
      "network_calls",
    ])
  })

  test("supports mock readiness and fixture-only reads without network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const mockFacts = facts()
    const boundary = createPhase4GreenhouseLiveReadBoundary({
      mode: "mock",
      mockFacts,
    })
    const report = evaluateGreenhouseLiveReadReadiness({
      generatedAt: "2026-06-24T00:00:00.000Z",
      mode: "mock",
      mockFacts,
    })

    const ownershipFetch = await boundary.fetchOwnershipFacts({ asOf: "2026-06-24T00:00:00.000Z" })
    expect(ownershipFetch.facts).toHaveLength(mockFacts.ownership.length)
    expect(ownershipFetch.sourceGaps).toEqual([])
    expect(report.status).toBe("mock_ready")
    expect(report.counts).toEqual({
      finalOffers: mockFacts.finalOffers.length,
      rps: mockFacts.rps.length,
      pipeline: mockFacts.pipeline.length,
      ownership: mockFacts.ownership.length,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  test("requires fixtures for mock mode", () => {
    expect(() => createPhase4GreenhouseLiveReadBoundary({ mode: "mock" })).toThrow(/requires fixture facts/)
    expect(
      evaluateGreenhouseLiveReadReadiness({
        generatedAt: "2026-06-24T00:00:00.000Z",
        mode: "mock",
      })
    ).toMatchObject({ status: "blocked" })
  })
})
