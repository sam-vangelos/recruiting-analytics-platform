import { describe, expect, test, vi } from "vitest"

import {
  buildReportingSourceCut,
  replayReportingSourceCut,
  REPORTING_SOURCE_CUT_SCHEMA_VERSION,
} from "../lib/recruiting-ops/delivery-source/reporting-source-cut"
import type { StagingHydrationSourceCollections } from "../lib/recruiting-ops/delivery-source/staging-hydration-source-loader"
import { createFixtureGreenhouseExecReadBoundary, emptyExecStateSources } from "../lib/recruiting-ops/extractors/greenhouse-exec-read-boundary"
import type { GreenhouseHarvestReadClient } from "../lib/recruiting-ops/extractors/greenhouse-harvest-read-adapter"

const GENERATED_AT = "2026-07-14T16:00:00.000Z"

describe("reporting source cut", () => {
  test("loads one base through one client and gives both derivations the same immutable identity", async () => {
    const client: GreenhouseHarvestReadClient = { list: vi.fn(async () => []) }
    const createGreenhouseClient = vi.fn(() => client)
    const collections = fixtureCollections()
    const loadCollections = vi.fn(async (input) => {
      expect(input.client).toBe(client)
      expect(input.requirements).toEqual({
        includeLegacyRpsHistory: true,
        includeDeliveryRpsCurrentWeek: true,
      })
      return collections
    })
    const candidateIds: string[][] = []
    const engagedApplicationIds: string[][] = []
    const createExecBoundary = vi.fn((receivedClient: GreenhouseHarvestReadClient) => {
      expect(receivedClient).toBe(client)
      const fixture = createFixtureGreenhouseExecReadBoundary({
        candidates: [{ id: 20, first_name: "Fixture", last_name: "Finalist" }],
        stageHistories: [{ application_id: 10, entered_at: "2026-07-12T00:00:00.000Z", current: true }],
      })
      return {
        ...fixture,
        async fetchExecCandidateNames(ids: readonly string[]) {
          candidateIds.push([...ids])
          return fixture.fetchExecCandidateNames(ids)
        },
        async fetchEngagedStageHistories(ids: readonly string[]) {
          engagedApplicationIds.push([...ids])
          return fixture.fetchEngagedStageHistories(ids)
        },
      }
    })
    const ports = {
      createGreenhouseClient,
      loadRoster: vi.fn(async () => [{
        recruiterName: "Fixture Recruiter",
        teamId: "fixture",
        teamName: "Fixture",
        hodName: "Fixture HOD",
      }]),
      loadStageTaxonomy: vi.fn(async () => []),
      fingerprintKey: "source-cut-test-secret",
    }

    const first = await buildReportingSourceCut(ports, {}, { loadCollections, createExecBoundary })

    expect(createGreenhouseClient).toHaveBeenCalledTimes(1)
    expect(loadCollections).toHaveBeenCalledTimes(1)
    expect(candidateIds).toEqual([["20"]])
    expect(engagedApplicationIds).toEqual([["10"]])
    expect(first.payload).toEqual(expect.objectContaining({
      schemaVersion: REPORTING_SOURCE_CUT_SCHEMA_VERSION,
      facts: expect.any(Object),
      roster: expect.any(Array),
      eltSnapshot: expect.any(Object),
    }))
    expect(Object.keys(first.payload).sort()).toEqual(["eltSnapshot", "facts", "roster", "schemaVersion"])
    expect(first.payload.facts.generatedAt).toBe(GENERATED_AT)
    expect(first.payload.eltSnapshot.generated_at).toBe(GENERATED_AT)
    expect(first.payload.eltSnapshot.org_rollup.as_of).toBe(GENERATED_AT)
    expect(first.payload.eltSnapshot.req_rows[0]?.finalists[0]?.name).toBe("Fixture Finalist")
    expect(first.payloadFingerprint).toMatch(/^hmac-sha256:[a-f0-9]{64}$/)
    expect(Object.isFrozen(first.payload)).toBe(true)
    expect(Object.isFrozen(first.payload.eltSnapshot.req_rows)).toBe(true)
    expect(Object.isFrozen(first.payload.eltSnapshot.req_rows[0]?.finalists[0])).toBe(true)
    expect(Reflect.set(first.payload.eltSnapshot.org_rollup, "open_roles", 99)).toBe(false)

    const second = await buildReportingSourceCut(ports, {}, { loadCollections, createExecBoundary })
    expect(second.payloadFingerprint).toBe(first.payloadFingerprint)
  })

  test("rejects truncation before governed or E01 follow-up ports run", async () => {
    const collections = fixtureCollections()
    collections.diagnostics = [{ source: "/applications", records: 200_000, truncationSuspected: true }]
    const loadRoster = vi.fn(async () => [])
    const loadStageTaxonomy = vi.fn(async () => [])
    const createExecBoundary = vi.fn()

    await expect(buildReportingSourceCut({
      createGreenhouseClient: () => ({ list: vi.fn(async () => []) }),
      loadRoster,
      loadStageTaxonomy,
      fingerprintKey: "source-cut-test-secret",
    }, {}, {
      loadCollections: vi.fn(async () => collections),
      createExecBoundary,
    })).rejects.toThrow("suspected truncation in /applications (200000)")

    expect(loadRoster).not.toHaveBeenCalled()
    expect(loadStageTaxonomy).not.toHaveBeenCalled()
    expect(createExecBoundary).not.toHaveBeenCalled()
  })

  test("passes explicit calendar identity and scoped requirements to the source loader", async () => {
    const loadCollections = vi.fn(async () => fixtureCollections())

    await buildReportingSourceCut({
      createGreenhouseClient: () => ({ list: vi.fn(async () => []) }),
      loadRoster: async () => [],
      loadStageTaxonomy: async () => [],
      fingerprintKey: "source-cut-test-secret",
    }, {
      nowMs: Date.parse(GENERATED_AT),
      reportingWeekFriday: "2026-07-10",
      quarterStart: "2026-07-01",
      calendarValidationNowMs: Date.parse("2026-07-16T13:30:00Z"),
      requirements: {
        includeLegacyRpsHistory: false,
        includeDeliveryRpsCurrentWeek: true,
      },
    }, {
      loadCollections,
      createExecBoundary: () => createFixtureGreenhouseExecReadBoundary({}),
    })

    expect(loadCollections).toHaveBeenCalledWith(expect.objectContaining({
      nowMs: Date.parse(GENERATED_AT),
      reportingWeekFriday: "2026-07-10",
      quarterStart: "2026-07-01",
      calendarValidationNowMs: Date.parse("2026-07-16T13:30:00Z"),
      requirements: {
        includeLegacyRpsHistory: false,
        includeDeliveryRpsCurrentWeek: true,
      },
    }))
  })

  test("validates and recursively freezes a persisted replay", async () => {
    const key = "source-cut-test-secret"
    const cut = await buildReportingSourceCut({
      createGreenhouseClient: () => ({ list: vi.fn(async () => []) }),
      loadRoster: async () => [],
      loadStageTaxonomy: async () => [],
      fingerprintKey: key,
    }, {}, {
      loadCollections: vi.fn(async () => fixtureCollections()),
      createExecBoundary: () => createFixtureGreenhouseExecReadBoundary({}),
    })
    const persisted = JSON.parse(JSON.stringify(cut.payload))

    const replay = replayReportingSourceCut({
      payload: persisted,
      payloadFingerprint: cut.payloadFingerprint,
      fingerprintKey: key,
    })
    expect(replay.payload).toEqual(cut.payload)
    expect(Object.isFrozen(replay.payload.facts.candidateEvents)).toBe(true)

    const tampered = JSON.parse(JSON.stringify(cut.payload))
    tampered.facts.quarterStart = "2026-04-01"
    expect(() => replayReportingSourceCut({
      payload: tampered,
      payloadFingerprint: cut.payloadFingerprint,
      fingerprintKey: key,
    })).toThrow("HMAC fingerprint mismatch")
  })
})

test("a declared ELT backfill week anchors the quarter and restamps the ELT block only", async () => {
  const loadCollections = vi.fn(async () => fixtureCollections())

  const cut = await buildReportingSourceCut({
    createGreenhouseClient: () => ({ list: vi.fn(async () => []) }),
    loadRoster: async () => [],
    loadStageTaxonomy: async () => [],
    fingerprintKey: "source-cut-test-secret",
  }, {
    nowMs: Date.parse(GENERATED_AT),
    eltBackfillWeekFriday: "2026-06-26",
  }, {
    loadCollections,
    createExecBoundary: () => createFixtureGreenhouseExecReadBoundary({}),
  })

  // The declared week never routes through reportingWeekFriday (that is the
  // weekly-recruitment calendar) but must anchor the pull windows via the
  // quarter start so the declared week's events are inside them.
  expect(loadCollections).toHaveBeenCalledWith(expect.objectContaining({
    quarterStart: "2026-04-01",
  }))
  const firstLoad = (loadCollections.mock.calls as unknown as ReadonlyArray<
    readonly [{ reportingWeekFriday?: string }]
  >)[0]?.[0]
  expect(firstLoad?.reportingWeekFriday).toBeUndefined()

  // The ELT block carries the declared week; the snapshot timestamp stays the
  // collections' own generatedAt.
  const eltFacts = cut.payload.eltSnapshot.elt_facts as {
    weekShort: string
    weekLabel: string
    generatedAt: string
  }
  expect(eltFacts.weekShort).toBe("Jun 26 - Jul 2")
  expect(eltFacts.weekLabel).toBe("Jun 26, 2026 - Jul 2, 2026")
  expect(cut.payload.eltSnapshot.generated_at).toBe(GENERATED_AT)
  expect(eltFacts.generatedAt).toBe(GENERATED_AT)
})

test("an explicit quarterStart wins over the declared-week default", async () => {
  const loadCollections = vi.fn(async () => fixtureCollections())
  await buildReportingSourceCut({
    createGreenhouseClient: () => ({ list: vi.fn(async () => []) }),
    loadRoster: async () => [],
    loadStageTaxonomy: async () => [],
    fingerprintKey: "source-cut-test-secret",
  }, {
    nowMs: Date.parse(GENERATED_AT),
    quarterStart: "2026-07-01",
    eltBackfillWeekFriday: "2026-06-26",
  }, {
    loadCollections,
    createExecBoundary: () => createFixtureGreenhouseExecReadBoundary({}),
  })
  expect(loadCollections).toHaveBeenCalledWith(expect.objectContaining({ quarterStart: "2026-07-01" }))
})

function fixtureCollections(): StagingHydrationSourceCollections {
  return {
    generatedAt: GENERATED_AT,
    reportingWeekFriday: "2026-07-10",
    quarterStart: "2026-07-01",
    jobs: [],
    openings: [],
    jobOwners: [],
    users: [],
    departments: [],
    applications: [],
    applicationStages: [],
    jobInterviewStages: [],
    jobInterviews: [],
    interviewKits: [],
    scorecards: [],
    scheduledInterviews: [],
    offers: [],
    candidates: [],
    candidateSources: [],
    referrers: [],
    rejectionReasons: [],
    diagnostics: [],
    execSources: {
      ...emptyExecStateSources(),
      jobs: [{ id: 1, requisition_id: 890, name: "Fixture Engineer", opened_at: "2026-01-01" }],
      openings: [{ id: 2, job_id: 1, open: true }],
      applications: [{ id: 10, job_id: 1, candidate_id: 20, stage_name: "Offer", status: "active" }],
    },
    execSourceGaps: [],
  }
}
