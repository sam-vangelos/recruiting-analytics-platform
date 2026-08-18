import { describe, expect, test } from "vitest"

import {
  createGreenhouseHarvestExecReadBoundary,
  type GreenhouseHarvestEndpoint,
  type GreenhouseHarvestListParams,
  type GreenhouseHarvestReadClient,
} from "../lib/recruiting-ops/extractors/greenhouse-harvest-read-adapter"
import { createFixtureGreenhouseExecReadBoundary } from "../lib/recruiting-ops/extractors/greenhouse-exec-read-boundary"

interface RecordedCall {
  endpoint: GreenhouseHarvestEndpoint
  params: GreenhouseHarvestListParams
}

function stubClient(
  respond: (endpoint: GreenhouseHarvestEndpoint, params: GreenhouseHarvestListParams) => readonly unknown[]
): { client: GreenhouseHarvestReadClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    client: {
      async list<T>(endpoint: GreenhouseHarvestEndpoint, params: GreenhouseHarvestListParams = {}) {
        calls.push({ endpoint, params })
        return respond(endpoint, params) as readonly T[]
      },
    },
  }
}

const WINDOWS = { movementSinceIso: "2026-06-21T00:00:00.000Z", offersSinceIso: "2026-04-10T00:00:00.000Z" }
const CONTEXT = { asOf: "2026-07-06T00:00:00.000Z" }

function manyJobs(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Job ${index + 1}`, status: "open" }))
}

describe("createGreenhouseHarvestExecReadBoundary — pull contract", () => {
  test("applications are pulled active, prospect-excluded, chunked over open job ids", async () => {
    const { client, calls } = stubClient((endpoint) => (endpoint === "/jobs" ? manyJobs(60) : []))
    const boundary = createGreenhouseHarvestExecReadBoundary(client)
    await boundary.fetchExecStateSources(CONTEXT, WINDOWS)

    const applicationCalls = calls.filter((call) => call.endpoint === "/applications" && call.params.status === "active")
    expect(applicationCalls).toHaveLength(2) // 60 job ids at the 50-id filter limit
    for (const call of applicationCalls) {
      expect(call.params.prospect).toBe(false)
      expect(typeof call.params.job_ids).toBe("string")
    }
    const idsSeen = applicationCalls.flatMap((call) => String(call.params.job_ids).split(","))
    expect(idsSeen).toHaveLength(60)
  })

  test("offers are pulled org-wide — never scoped to open jobs", async () => {
    const { client, calls } = stubClient((endpoint) => (endpoint === "/jobs" ? manyJobs(3) : []))
    const boundary = createGreenhouseHarvestExecReadBoundary(client)
    await boundary.fetchExecStateSources(CONTEXT, WINDOWS)

    const offerCalls = calls.filter((call) => call.endpoint === "/offers")
    expect(offerCalls).toHaveLength(1)
    expect(offerCalls[0].params.job_ids).toBeUndefined()
    expect(offerCalls[0].params.status).toBe("Accepted")
    expect(offerCalls[0].params.current_only).toBe(true)
    expect(offerCalls[0].params.resolved_at).toBe(`gte|${WINDOWS.offersSinceIso}`)
  })

  test("scorecards are kit-scoped + windowed (org-wide window pulls time out in Greenhouse), merged by id", async () => {
    const { client, calls } = stubClient((endpoint, params) => {
      if (endpoint === "/jobs") return manyJobs(1)
      if (endpoint === "/interview_kits") return [{ id: 601, job_id: 1, job_interview_id: 401 }]
      if (endpoint === "/scorecards" && typeof params["interviewed_at[gte]"] === "string") {
        return [{ id: 1 }, { id: 2 }]
      }
      if (endpoint === "/scorecards" && typeof params["submitted_at[gte]"] === "string") {
        return [{ id: 2 }, { id: 3 }]
      }
      return []
    })
    const boundary = createGreenhouseHarvestExecReadBoundary(client)
    const result = await boundary.fetchExecStateSources(CONTEXT, WINDOWS)

    const scorecardCalls = calls.filter((call) => call.endpoint === "/scorecards")
    expect(scorecardCalls).toHaveLength(2)
    for (const call of scorecardCalls) {
      expect(call.params.interview_kit_ids).toBe("601")
      // The exec accountability consumer still needs drafts; only the staging
      // parity expansion adds status=complete.
      expect(call.params.status).toBeUndefined()
    }
    expect(scorecardCalls).toContainEqual(expect.objectContaining({
      params: expect.objectContaining({ "interviewed_at[gte]": WINDOWS.movementSinceIso }),
    }))
    expect(scorecardCalls).toContainEqual(expect.objectContaining({
      params: expect.objectContaining({ "submitted_at[gte]": WINDOWS.movementSinceIso }),
    }))
    expect(result.sources.scorecards.map((record) => record.id).sort()).toEqual([1, 2, 3])
  })

  test("no kits means no scorecard calls at all", async () => {
    const { client, calls } = stubClient((endpoint) => (endpoint === "/jobs" ? manyJobs(1) : []))
    const boundary = createGreenhouseHarvestExecReadBoundary(client)
    await boundary.fetchExecStateSources(CONTEXT, WINDOWS)
    expect(calls.filter((call) => call.endpoint === "/scorecards")).toHaveLength(0)
  })

  test("interviews are pulled with status=awaiting_feedback", async () => {
    const { client, calls } = stubClient((endpoint) => (endpoint === "/jobs" ? manyJobs(2) : []))
    const boundary = createGreenhouseHarvestExecReadBoundary(client)
    await boundary.fetchExecStateSources(CONTEXT, WINDOWS)

    const interviewCalls = calls.filter((call) => call.endpoint === "/interviews")
    expect(interviewCalls.length).toBeGreaterThan(0)
    for (const call of interviewCalls) expect(call.params.status).toBe("awaiting_feedback")
  })

  test("movement delta pulls exactly the stage-row application ids missing from the active set", async () => {
    const { client, calls } = stubClient((endpoint, params) => {
      if (endpoint === "/jobs") return manyJobs(1)
      if (endpoint === "/applications" && params.status === "active") return [{ id: 100, job_id: 1 }]
      if (endpoint === "/application_stages") {
        return [
          { id: 1, application_id: 100 }, // already in the active set
          { id: 2, application_id: 200 }, // needs the delta pull
          { id: 3, application_id: 200 }, // duplicate — one id, once
          { id: 4, application_id: 300 },
        ]
      }
      return []
    })
    const boundary = createGreenhouseHarvestExecReadBoundary(client)
    await boundary.fetchExecStateSources(CONTEXT, WINDOWS)

    const deltaCalls = calls.filter((call) => call.endpoint === "/applications" && typeof call.params.ids === "string")
    expect(deltaCalls).toHaveLength(1)
    expect(String(deltaCalls[0].params.ids).split(",").sort()).toEqual(["200", "300"])
  })

  test("offers on closed jobs trigger a jobs-by-ids enrichment pull for exactly the missing jobs", async () => {
    const { client, calls } = stubClient((endpoint, params) => {
      if (endpoint === "/jobs" && params.status === "open") return manyJobs(1) // job id 1 is open
      if (endpoint === "/offers") {
        return [
          { id: 9, job_id: 1 }, // open job — already enriched
          { id: 10, job_id: 999 }, // closed job — needs the delta pull
        ]
      }
      return []
    })
    const boundary = createGreenhouseHarvestExecReadBoundary(client)
    const result = await boundary.fetchExecStateSources(CONTEXT, WINDOWS)

    const jobDeltaCalls = calls.filter((call) => call.endpoint === "/jobs" && typeof call.params.ids === "string")
    expect(jobDeltaCalls).toHaveLength(1)
    expect(jobDeltaCalls[0].params.ids).toBe("999")
    expect(result.sources.offers).toHaveLength(2)
  })

  test("a pull returning >= the record cap is flagged as suspected truncation", async () => {
    const capSized = Array.from({ length: 5 }, (_, index) => ({ id: index, application_id: index }))
    const { client } = stubClient((endpoint) => {
      if (endpoint === "/jobs") return manyJobs(1)
      if (endpoint === "/application_stages") return capSized
      return []
    })
    const boundary = createGreenhouseHarvestExecReadBoundary(client, { recordCap: 5 })
    const result = await boundary.fetchExecStateSources(CONTEXT, WINDOWS)

    const stagePull = result.pullDiagnostics.find((diag) => diag.source === "/application_stages?updated_at")
    expect(stagePull?.truncationSuspected).toBe(true)
    const jobsPull = result.pullDiagnostics.find((diag) => diag.source === "/jobs?status=open")
    expect(jobsPull?.truncationSuspected).toBe(false)
  })

  test("zero open jobs means no chunked endpoint calls at all", async () => {
    const { client, calls } = stubClient(() => [])
    const boundary = createGreenhouseHarvestExecReadBoundary(client)
    const result = await boundary.fetchExecStateSources(CONTEXT, WINDOWS)

    expect(calls.filter((call) => typeof call.params.job_ids === "string")).toHaveLength(0)
    expect(result.sources.applications).toHaveLength(0)
    // Org-wide pulls still ran (offers, scorecards, stages, departments...).
    expect(calls.some((call) => call.endpoint === "/offers")).toBe(true)
  })

  test("candidate name resolution dedupes ids and chunks at the 50-id limit", async () => {
    const { client, calls } = stubClient(() => [])
    const boundary = createGreenhouseHarvestExecReadBoundary(client)
    const ids = [...Array.from({ length: 60 }, (_, index) => String(index)), "0", "1"] // 60 distinct + 2 dupes
    await boundary.fetchExecCandidateNames(ids)

    const candidateCalls = calls.filter((call) => call.endpoint === "/candidates")
    expect(candidateCalls).toHaveLength(2)
    const sent = candidateCalls.flatMap((call) => String(call.params.ids).split(","))
    expect(sent).toHaveLength(60)
    expect(new Set(sent).size).toBe(60)
  })
})

describe("fixture exec boundary", () => {
  test("returns provided sources over empty defaults and filters candidates by id", async () => {
    const boundary = createFixtureGreenhouseExecReadBoundary({
      sources: { jobs: [{ id: 1, name: "Role", status: "open" }] },
      candidates: [
        { id: 7, first_name: "Ada", last_name: "L" },
        { id: 8, first_name: "Grace", last_name: "H" },
      ],
    })
    const result = await boundary.fetchExecStateSources({ asOf: "2026-07-06" }, WINDOWS)
    expect(result.sources.jobs).toHaveLength(1)
    expect(result.sources.offers).toHaveLength(0)
    const names = await boundary.fetchExecCandidateNames(["7"])
    expect(names).toHaveLength(1)
    expect(names[0].first_name).toBe("Ada")
  })
})
