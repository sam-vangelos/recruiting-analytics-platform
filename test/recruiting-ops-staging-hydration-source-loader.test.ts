import { describe, expect, test } from "vitest"

import {
  deriveStagingHydrationFacts,
  loadStagingHydrationSourceCollections,
} from "../lib/recruiting-ops/delivery-source/staging-hydration-source-loader"
import type {
  GreenhouseHarvestEndpoint,
  GreenhouseHarvestListParams,
  GreenhouseHarvestReadClient,
} from "../lib/recruiting-ops/extractors/greenhouse-harvest-read-adapter"
import { projectFinalOfferSheet } from "../lib/recruiting-ops/delivery/final-offer-sheet-renderer"

describe("staging hydration source loader", () => {
  test("uses an explicit current Friday for a provisional WTD source cut", async () => {
    const client: GreenhouseHarvestReadClient = {
      async list<T>(): Promise<readonly T[]> {
        return []
      },
    }

    const collections = await loadStagingHydrationSourceCollections({
      client,
      nowMs: Date.parse("2026-07-14T16:00:00Z"),
      reportingWeekFriday: "2026-07-10",
    })
    expect(collections.reportingWeekFriday).toBe("2026-07-10")
    expect(collections.generatedAt).toBe("2026-07-14T16:00:00.000Z")

    await expect(loadStagingHydrationSourceCollections({
      client,
      nowMs: Date.parse("2026-07-14T16:00:00Z"),
      reportingWeekFriday: "2026-07-17",
    })).rejects.toThrow("not currently available")
  })

  test("keeps scheduled calendar identity separate from actual source freshness", async () => {
    const calls: { endpoint: GreenhouseHarvestEndpoint; params?: GreenhouseHarvestListParams }[] = []
    const client: GreenhouseHarvestReadClient = {
      async list<T>(
        endpoint: GreenhouseHarvestEndpoint,
        params?: GreenhouseHarvestListParams
      ): Promise<readonly T[]> {
        calls.push({ endpoint, params })
        return []
      },
    }

    const collections = await loadStagingHydrationSourceCollections({
      client,
      nowMs: Date.parse("2026-10-02T18:00:00Z"),
      calendarValidationNowMs: Date.parse("2026-10-01T12:00:00Z"),
      reportingWeekFriday: "2026-09-25",
      quarterStart: "2026-10-01",
    })

    expect(collections).toMatchObject({
      generatedAt: "2026-10-02T18:00:00.000Z",
      reportingWeekFriday: "2026-09-25",
      quarterStart: "2026-10-01",
    })
    expect(calls).toContainEqual(expect.objectContaining({
      endpoint: "/offers",
      params: expect.objectContaining({
        current_only: false,
        created_at: "gte|2026-10-01T00:00:00.000Z",
      }),
    }))
  })

  test("assembles a read-only, capped quarter/current-week source bundle", async () => {
    const calls: { endpoint: GreenhouseHarvestEndpoint; params?: GreenhouseHarvestListParams }[] = []
    const client: GreenhouseHarvestReadClient = {
      async list<T>(endpoint: GreenhouseHarvestEndpoint, params?: GreenhouseHarvestListParams): Promise<readonly T[]> {
        calls.push({ endpoint, params })
        const rows: unknown[] =
          endpoint === "/jobs"
            ? [{ id: 1, requisition_id: 890, name: "Platform Engineer", status: "open", opened_at: "2026-01-01" }]
            : endpoint === "/openings"
              ? [{ id: 2, job_id: 1, status: "open", open: true, opened_at: "2026-01-01" }]
              : endpoint === "/applications"
                ? [{ id: 3, job_id: 1, candidate_id: 4, status: "active" }]
                : endpoint === "/candidates"
                  ? [{ id: 4, first_name: "Fixture", last_name: "Person" }]
                  : []
        return rows as T[]
      },
    }

    const collections = await loadStagingHydrationSourceCollections({
      client,
      nowMs: Date.parse("2026-07-11T12:00:00Z"),
    })
    expect(collections).toMatchObject({
      reportingWeekFriday: "2026-07-03",
      quarterStart: "2026-07-01",
    })
    expect(collections.jobs).toHaveLength(1)
    expect(collections.candidates).toHaveLength(1)
    expect(calls.some((call) => call.endpoint === "/offers" && call.params?.current_only === false)).toBe(true)
    expect(calls.some((call) =>
      call.endpoint === "/offers" &&
      call.params?.current_only === false &&
      call.params?.created_at === "gte|2026-07-01T00:00:00.000Z"
    )).toBe(true)
    expect(calls.some((call) =>
      call.endpoint === "/offers" &&
      call.params?.current_only === true &&
      call.params?.resolved_at === "gte|2026-04-18T12:00:00.000Z"
    )).toBe(true)
    expect(calls.some((call) =>
      call.endpoint === "/application_stages" &&
      call.params?.updated_at === "gte|2026-06-10T12:00:00.000Z"
    )).toBe(true)
    expect(calls.some((call) => call.endpoint === "/sources")).toBe(true)
    expect(calls.some((call) => call.endpoint === "/referrers")).toBe(true)
    expect(calls.some((call) => call.endpoint === "/rejection_details")).toBe(false)
    expect(calls.some((call) => call.endpoint === "/rejection_reasons")).toBe(true)
    expect(calls.some((call) =>
      call.endpoint === "/scorecards" && call.params?.["submitted_at[gte]"] === "2026-03-02T00:00:00.000Z"
    )).toBe(false)

    const facts = deriveStagingHydrationFacts({
      collections,
      roster: [],
      stageTaxonomy: [],
      outcomes: [],
    })
    expect(facts.reqWeeks).toHaveLength(1)
    expect(facts.candidateEvents).toEqual([])
    expect(facts.offers).toEqual([])
    expect(facts.scorecards).toEqual([])
  })

  test("resolves a rejected Final Offer from bounded rejection details and the v3 type key", async () => {
    const calls: { endpoint: GreenhouseHarvestEndpoint; params?: GreenhouseHarvestListParams }[] = []
    const client: GreenhouseHarvestReadClient = {
      async list<T>(endpoint: GreenhouseHarvestEndpoint, params?: GreenhouseHarvestListParams): Promise<readonly T[]> {
        calls.push({ endpoint, params })
        let rows: unknown[] = []
        if (endpoint === "/offers" && params?.current_only === false) {
          rows = [{
            id: 7001,
            application_id: 101,
            candidate_id: 501,
            job_id: 900,
            status: "rejected",
            created_at: "2026-07-02T10:00:00Z",
            resolved_at: "2026-07-03T10:00:00Z",
          }]
        } else if (endpoint === "/applications" && csv(params?.ids).has("101")) {
          rows = [{ id: 101, candidate_id: 501, job_id: 900, status: "rejected" }]
        } else if (endpoint === "/jobs") {
          rows = [{ id: 900, requisition_id: 1027, name: "Research Engineer", status: "open" }]
        } else if (endpoint === "/candidates" && csv(params?.ids).has("501")) {
          rows = [{ id: 501, first_name: "Fixture", last_name: "Candidate" }]
        } else if (endpoint === "/rejection_details") {
          rows = [{ application_id: 101, rejection_reason_id: 44, rejected_at: "2026-07-03T10:00:00Z" }]
        } else if (endpoint === "/rejection_reasons") {
          rows = [{ id: 44, name: "Role requirements not met", type: { key: "we_rejected_them" } }]
        }
        return rows as T[]
      },
    }

    const collections = await loadStagingHydrationSourceCollections({
      client,
      nowMs: Date.parse("2026-07-11T12:00:00Z"),
    })
    const rejectionCall = calls.find((call) => call.endpoint === "/rejection_details")
    expect(rejectionCall?.params).toMatchObject({ per_page: 500, application_ids: "101" })

    const facts = deriveStagingHydrationFacts({
      collections,
      roster: [],
      stageTaxonomy: [],
      outcomes: [],
    })
    expect(facts.offers[0]).toMatchObject({
      application_id: "101",
      rejection_reason_id: "44",
      rejection_type: "we rejected them",
    })
    expect(projectFinalOfferSheet({
      rows: facts.offers,
      roster: [],
      quarter: { startDate: "2026-07-01", endDateExclusive: "2026-10-01" },
    }).rows[0]?.values[1]).toBe("Offer Reneged")
  })

  test("keeps rejection-detail joins complete across 50-id chunks and flags a capped chunk", async () => {
    const applicationIds = Array.from({ length: 51 }, (_, index) => String(index + 1))
    const calls: { endpoint: GreenhouseHarvestEndpoint; params?: GreenhouseHarvestListParams }[] = []
    const client: GreenhouseHarvestReadClient = {
      async list<T>(endpoint: GreenhouseHarvestEndpoint, params?: GreenhouseHarvestListParams): Promise<readonly T[]> {
        calls.push({ endpoint, params })
        if (endpoint === "/offers" && params?.current_only === false) {
          return applicationIds.map((applicationId) => ({
            id: `offer-${applicationId}`,
            application_id: applicationId,
            created_at: "2026-07-02T10:00:00Z",
          })) as T[]
        }
        if (endpoint === "/rejection_details") {
          return [...csv(params?.application_ids)].map((applicationId) => ({
            application_id: applicationId,
            rejection_reason_id: `reason-${applicationId}`,
          })) as T[]
        }
        return []
      },
    }

    const collections = await loadStagingHydrationSourceCollections({
      client,
      nowMs: Date.parse("2026-07-11T12:00:00Z"),
      recordCap: 50,
    })
    const detailCalls = calls.filter((call) => call.endpoint === "/rejection_details")

    expect(detailCalls.map((call) => csv(call.params?.application_ids).size)).toEqual([50, 1])
    expect(collections.rejectionDetails).toHaveLength(51)
    expect(collections.diagnostics).toContainEqual({
      source: "/rejection_details?application_ids (hydration offer joins)",
      records: 51,
      truncationSuspected: true,
    })
  })

  test("keeps a previously closed job when an older offer is declined this week", () => {
    const collections: Parameters<typeof deriveStagingHydrationFacts>[0]["collections"] = {
      generatedAt: "2026-07-14T16:00:00.000Z",
      reportingWeekFriday: "2026-07-10",
      quarterStart: "2026-07-01",
      jobs: [{
        id: 50,
        requisition_id: 1250,
        name: "Platform Analyst",
        status: "closed",
        opened_at: "2026-06-01T00:00:00.000Z",
        closed_at: "2026-07-01T00:00:00.000Z",
      }],
      openings: [{
        id: 51,
        job_id: 50,
        status: "closed",
        open: false,
        opened_at: "2026-06-01T00:00:00.000Z",
      }],
      jobOwners: [],
      users: [],
      departments: [],
      applications: [{ id: 53, job_id: 50, candidate_id: 54, status: "rejected" }],
      applicationStages: [],
      jobInterviewStages: [],
      jobInterviews: [],
      interviewKits: [],
      scorecards: [],
      scheduledInterviews: [],
      offers: [{
        id: 52,
        application_id: 53,
        candidate_id: 54,
        job_id: 50,
        status: "Declined",
        created_at: "2026-06-20T00:00:00.000Z",
        resolved_at: "2026-07-12T00:00:00.000Z",
      }],
      candidates: [{ id: 54, first_name: "Fixture", last_name: "Candidate" }],
      candidateSources: [],
      referrers: [],
      rejectionReasons: [],
      diagnostics: [],
    }

    const facts = deriveStagingHydrationFacts({
      collections,
      roster: [],
      stageTaxonomy: [],
      outcomes: [],
    })

    expect(facts.reqWeeks).toHaveLength(1)
    expect(facts.reqWeeks[0]).toMatchObject({
      requisitionId: "1250",
      declined: 1,
      signed: 0,
      offerExtended: 0,
      daysOpen: 30,
    })
  })

  test("loads the continuous RPS ledger through all-status job kits and retains closed-job joins", async () => {
    const calls: { endpoint: GreenhouseHarvestEndpoint; params?: GreenhouseHarvestListParams }[] = []
    const client: GreenhouseHarvestReadClient = {
      async list<T>(endpoint: GreenhouseHarvestEndpoint, params?: GreenhouseHarvestListParams): Promise<readonly T[]> {
        calls.push({ endpoint, params })
        let rows: unknown[] = []
        if (endpoint === "/jobs") {
          rows = params?.status === "open"
            ? [{ id: 1, requisition_id: 890, name: "Open Role", status: "open" }]
            : [
                { id: 1, requisition_id: 890, name: "Open Role", status: "open" },
                { id: 2, requisition_id: 993, name: "Closed Delivery Role", status: "closed" },
              ]
        } else if (endpoint === "/job_interviews") {
          const ids = csv(params?.job_ids)
          rows = [
            ...(ids.has("1") ? [{ id: 501, job_id: 1, name: "Recruiter Phone Screen" }] : []),
            ...(ids.has("2") ? [{ id: 502, job_id: 2, name: "Recruiter Phone Screen" }] : []),
          ]
        } else if (endpoint === "/interview_kits") {
          const ids = csv(params?.job_ids)
          rows = [
            ...(ids.has("1") ? [{ id: 601, job_id: 1, job_interview_id: 501 }] : []),
            ...(ids.has("2") ? [{ id: 602, job_id: 2, job_interview_id: 502 }] : []),
          ]
        } else if (
          endpoint === "/scorecards" &&
          params?.["created_at[gte]"] === "2026-03-02T00:00:00.000Z" &&
          csv(params.interview_kit_ids).has("602")
        ) {
          rows = [{
            id: 9002,
            application_id: 30,
            interview_kit_id: 602,
            interviewer_id: 702,
            submitter_id: 702,
            status: "complete",
            created_at: "2026-03-03T11:00:00.000Z",
            interviewed_at: "2026-02-28T12:00:00.000Z",
            submitted_at: "2026-03-01T12:00:00.000Z",
          }]
        } else if (endpoint === "/applications" && csv(params?.ids).has("30")) {
          rows = [{ id: 30, job_id: 2, candidate_id: 40, status: "rejected" }]
        } else if (endpoint === "/candidates" && csv(params?.ids).has("40")) {
          rows = [{ id: 40, first_name: "Closed", last_name: "Candidate" }]
        } else if (endpoint === "/interviews" && csv(params?.application_ids).has("30")) {
          rows = [{
            id: 8002,
            application_id: 30,
            job_interview_id: 502,
            ends_at: "2026-02-28T13:00:00.000Z",
            interviewers: [{ id: 702, name: "Historic Interviewer" }],
          }]
        } else if (endpoint === "/users" && csv(params?.ids).has("702")) {
          rows = [{ id: 702, first_name: "Historic", last_name: "Interviewer" }]
        }
        return rows as T[]
      },
    }

    const collections = await loadStagingHydrationSourceCollections({
      client,
      nowMs: Date.parse("2026-07-11T12:00:00Z"),
      requirements: { includeLegacyRpsHistory: true },
    })
    expect(collections.scorecards.map((row) => String(row.id))).toEqual(["9002"])
    expect(collections.jobs.some((row) => String(row.id) === "2" && row.status === "closed")).toBe(true)
    expect(collections.applications.some((row) => String(row.id) === "30")).toBe(true)
    expect(collections.candidates.some((row) => String(row.id) === "40")).toBe(true)
    expect(collections.interviewKits.some((row) => String(row.id) === "602")).toBe(true)
    expect(collections.jobInterviews.some((row) => String(row.id) === "502")).toBe(true)
    expect(calls.some((call) =>
      call.endpoint === "/scorecards" &&
      call.params?.status === "complete" &&
      call.params?.["submitted_at[gte]"] === "2026-03-02T00:00:00.000Z" &&
      call.params?.["submitted_at[lte]"] === "2026-07-11T12:00:00.000Z" &&
      csv(call.params.interview_kit_ids).has("602")
    )).toBe(true)
    expect(calls.some((call) =>
      call.endpoint === "/scorecards" &&
      call.params?.status === "complete" &&
      call.params?.["created_at[gte]"] === "2026-03-02T00:00:00.000Z" &&
      call.params?.["created_at[lte]"] === "2026-07-11T12:00:00.000Z" &&
      csv(call.params.interview_kit_ids).has("602")
    )).toBe(true)
    expect(calls.some((call) =>
      call.endpoint === "/interviews" &&
      csv(call.params?.application_ids).has("30") &&
      call.params?.starts_at === undefined
    )).toBe(true)

    const facts = deriveStagingHydrationFacts({
      collections,
      roster: [],
      stageTaxonomy: [],
      outcomes: [],
    })
    expect(facts.scorecards).toHaveLength(1)
    expect(facts.scorecards[0]).toMatchObject({
      scorecard_id: "9002",
      application_id: "30",
      candidate_name: "Closed Candidate",
      job_id: "2",
      requisition_id: "993",
      job_status: "closed",
      interview_name: "Recruiter Phone Screen",
      created_at: "2026-03-03T11:00:00.000Z",
      submitted_at: "2026-03-01T12:00:00.000Z",
      legacy_bic_reporting_at: "2026-03-03T11:00:00.000Z",
    })
  })

  test("expands current-week Delivery scorecards only for the governed all-status portfolio", async () => {
    const calls: { endpoint: GreenhouseHarvestEndpoint; params?: GreenhouseHarvestListParams }[] = []
    const client: GreenhouseHarvestReadClient = {
      async list<T>(endpoint: GreenhouseHarvestEndpoint, params?: GreenhouseHarvestListParams): Promise<readonly T[]> {
        calls.push({ endpoint, params })
        if (endpoint === "/jobs" && params?.status !== "open") {
          return [
            { id: 1, requisition_id: 890, name: "Principal Forward Deployed AI Engineer" },
            { id: 2, requisition_id: 907, name: "Forward Deployed Engineer - US | Bench", status: "closed" },
          ] as T[]
        }
        if (endpoint === "/interview_kits" && csv(params?.job_ids).has("2")) {
          return [{ id: 602, job_id: 2, job_interview_id: 502 }] as T[]
        }
        if (
          endpoint === "/scorecards" &&
          params?.["submitted_at[gte]"] === "2026-07-03T00:00:00.000Z" &&
          csv(params.interview_kit_ids).has("602")
        ) {
          return [] as T[]
        }
        if (
          endpoint === "/scorecards" &&
          params?.["created_at[gte]"] === "2026-07-03T00:00:00.000Z" &&
          csv(params.interview_kit_ids).has("602")
        ) {
          return [{
            id: 9003,
            application_id: 31,
            interview_kit_id: 602,
            status: "complete",
            created_at: "2026-07-04T08:00:00.000Z",
            submitted_at: "2026-07-02T23:00:00.000Z",
          }] as T[]
        }
        return [] as T[]
      },
    }

    const collections = await loadStagingHydrationSourceCollections({
      client,
      nowMs: Date.parse("2026-07-11T12:00:00Z"),
      requirements: { includeDeliveryRpsCurrentWeek: true },
    })

    const expandedKitCall = calls.find((call) =>
      call.endpoint === "/interview_kits" && csv(call.params?.job_ids).has("2")
    )
    expect(expandedKitCall).toBeDefined()
    expect(csv(expandedKitCall?.params?.job_ids).has("1")).toBe(false)
    expect(calls.some((call) =>
      call.endpoint === "/scorecards" &&
      call.params?.status === "complete" &&
      call.params?.["submitted_at[gte]"] === "2026-07-03T00:00:00.000Z"
    )).toBe(true)
    expect(calls.some((call) =>
      call.endpoint === "/scorecards" &&
      call.params?.status === "complete" &&
      call.params?.["created_at[gte]"] === "2026-07-03T00:00:00.000Z"
    )).toBe(true)
    expect(collections.scorecards.map((scorecard) => String(scorecard.id))).toContain("9003")
  })

  test("retains accepted offers resolved this quarter even when created before it", async () => {
    const client: GreenhouseHarvestReadClient = {
      async list<T>(endpoint: GreenhouseHarvestEndpoint, params?: GreenhouseHarvestListParams): Promise<readonly T[]> {
        if (endpoint !== "/offers") return []
        if (params?.current_only === false) {
          return [
            {
              id: "quarter-created",
              application_id: 10,
              candidate_id: 20,
              job_id: 30,
              status: "Created",
              created_at: "2026-07-02T00:00:00.000Z",
            },
            {
              id: "same-offer",
              application_id: 11,
              candidate_id: 21,
              job_id: 31,
              status: "Sent",
              created_at: "2026-07-03T00:00:00.000Z",
            },
          ] as T[]
        }
        if (params?.status === "Accepted" && typeof params?.resolved_at === "string") {
          return [
            {
              id: "prior-quarter-accepted",
              application_id: 12,
              candidate_id: 22,
              job_id: 32,
              status: "Accepted",
              created_at: "2026-06-20T00:00:00.000Z",
              resolved_at: "2026-07-04T00:00:00.000Z",
            },
            {
              id: "same-offer",
              application_id: 11,
              candidate_id: 21,
              job_id: 31,
              status: "Accepted",
              created_at: "2026-07-03T00:00:00.000Z",
              resolved_at: "2026-07-05T00:00:00.000Z",
            },
          ] as T[]
        }
        return []
      },
    }

    const collections = await loadStagingHydrationSourceCollections({
      client,
      nowMs: Date.parse("2026-07-11T12:00:00Z"),
    })

    expect(collections.offers.map((offer) => offer.id)).toEqual([
      "prior-quarter-accepted",
      "same-offer",
      "quarter-created",
    ])
    expect(collections.offers.find((offer) => offer.id === "same-offer")?.status).toBe("Accepted")
  })
})

function csv(value: unknown): Set<string> {
  return new Set(String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))
}
