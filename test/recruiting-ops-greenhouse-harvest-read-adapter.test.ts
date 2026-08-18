import { describe, expect, test } from "vitest"

import {
  createGreenhouseHarvestReadBoundary,
  GREENHOUSE_READ_ADAPTER_PLANS,
  mapHarvestApplicationsToPipelineStageFactsWithDiagnostics,
  mapHarvestJobsToOwnershipFactsWithDiagnostics,
  mapHarvestOffersToFinalOfferFactsWithDiagnostics,
  mapHarvestScheduledInterviewsToRpsFactsWithDiagnostics,
  type GreenhouseHarvestEndpoint,
  type GreenhouseHarvestListParams,
  type GreenhouseHarvestReadClient,
  type HarvestApplicationRecord,
  type HarvestApplicationStageRecord,
  type HarvestInterviewKitRecord,
  type HarvestJobInterviewRecord,
  type HarvestJobInterviewStageRecord,
  type HarvestJobOwnerRecord,
  type HarvestJobRecord,
  type HarvestOfferRecord,
  type HarvestOpeningRecord,
  type HarvestScheduledInterviewRecord,
  type HarvestScorecardRecord,
  type HarvestUserRecord,
} from "../lib/recruiting-ops/extractors/greenhouse-harvest-read-adapter"
import { validateGreenhouseReadBoundary } from "../lib/recruiting-ops/extractors/greenhouse-read-boundary"

class FakeHarvestReadClient implements GreenhouseHarvestReadClient {
  readonly calls: { endpoint: GreenhouseHarvestEndpoint; params?: GreenhouseHarvestListParams }[] = []

  constructor(private readonly rowsByEndpoint: Partial<Record<GreenhouseHarvestEndpoint, readonly unknown[]>>) {}

  async list<T>(endpoint: GreenhouseHarvestEndpoint, params?: GreenhouseHarvestListParams): Promise<readonly T[]> {
    this.calls.push({ endpoint, params })
    return (this.rowsByEndpoint[endpoint] ?? []) as readonly T[]
  }
}

const offerRows: HarvestOfferRecord[] = [
  {
    id: 7001,
    application: {
      id: 101,
      job: {
        id: 900,
      },
      recruiter: {
        first_name: "Recruiter",
        last_name: "One",
      },
      sourcer: {
        name: "Sourcer One",
      },
    },
    status: "approval complete",
    created_at: "2026-06-16T12:00:00.000-07:00",
    department: {
      name: "Engineering",
    },
    custom_fields: [
      {
        name: "hod",
        value: "HOD One",
      },
    ],
  },
]

// v3-real: flat interview rows; slot names, kits, and scorecards come from joins.
const interviewRows: HarvestScheduledInterviewRecord[] = [
  {
    id: "interview_101",
    application_id: 101,
    job_id: 900,
    job_interview_id: 501,
    starts_at: "2026-06-18T17:00:00.000Z",
    status: "complete",
  },
  {
    // No starts_at (the dominant live shape) — timestamp must come from the
    // matched scorecard's interviewed_at.
    id: "interview_102",
    application_id: 102,
    job_id: 900,
    job_interview_id: 501,
    status: "collect_feedback",
  },
]

const jobInterviewRows: HarvestJobInterviewRecord[] = [
  { id: 501, name: "Recruiter Phone Screen", job_interview_stage_id: 41, job_id: 900, active: true },
]

const interviewKitRows: HarvestInterviewKitRecord[] = [{ id: 601, job_id: 900, job_interview_id: 501 }]

const scorecardRows: HarvestScorecardRecord[] = [
  {
    id: 701,
    application_id: 101,
    interview_kit_id: 601,
    interviewer_id: 31,
    status: "complete",
    submitted_at: "2026-06-18T18:00:00.000Z",
    interviewed_at: "2026-06-18T17:00:00.000Z",
  },
  {
    id: 702,
    application_id: 102,
    interview_kit_id: 601,
    interviewer_id: 32,
    status: "draft",
    interviewed_at: "2026-06-19T10:00:00.000Z",
  },
]

// v3-real: flat application rows (no req id, no embedded history).
const applicationRows: HarvestApplicationRecord[] = [
  {
    id: 101,
    job_id: 900,
    status: "in_process",
    stage_name: "Recruiter Phone Screen",
    last_activity_at: "2026-06-18T11:00:00.000Z",
  },
]

const applicationStageRows: HarvestApplicationStageRecord[] = [
  {
    id: 801,
    application_id: 101,
    job_interview_stage_id: 40,
    entered_at: "2026-06-16T10:00:00.000Z",
    exited_at: "2026-06-18T10:00:00.000Z",
    current: false,
  },
  {
    id: 802,
    application_id: 101,
    job_interview_stage_id: 41,
    entered_at: "2026-06-18T10:00:00.000Z",
    exited_at: null,
    current: true,
  },
]

const jobInterviewStageRows: HarvestJobInterviewStageRecord[] = [
  { id: 40, name: "Application Review", job_id: 900 },
  { id: 41, name: "Recruiter Phone Screen", job_id: 900 },
]

// v3-real: flat job rows; owners, openings, and user names come from joins.
const jobRows: HarvestJobRecord[] = [
  {
    id: 900,
    requisition_id: 890,
    status: "open",
    updated_at: "2026-06-30T10:00:00.000Z",
    custom_fields: [
      {
        name: "pod",
        value: "Pod A",
      },
    ],
  },
]

const jobOwnerRows: HarvestJobOwnerRecord[] = [
  { id: 1, user_id: 21, job_id: 900, type: "recruiter", responsible: true },
  { id: 2, user_id: 22, job_id: 900, type: "recruiter", responsible: false },
  { id: 3, user_id: 23, job_id: 900, type: "sourcer", responsible: false },
]

const openingRows: HarvestOpeningRecord[] = [
  { id: "opening_1", job_id: 900, open: true },
  { id: "opening_2", job_id: 900, open: true },
  { id: "opening_3", job_id: 900, open: false },
]

const userRows: HarvestUserRecord[] = [
  { id: 21, name: "Recruiter One" },
  { id: 22, name: "Recruiter Two" },
  { id: 23, first_name: "Sourcer", last_name: "One" },
]

describe("recruiting ops Greenhouse Harvest read adapter", () => {
  test("declares the endpoint + join plans without production execution", () => {
    expect(GREENHOUSE_READ_ADAPTER_PLANS).toEqual([
      {
        workflowId: "T07",
        endpoint: "/offers",
        joinEndpoints: [],
        factTarget: "final_offer",
        requiredFields: ["id", "application_id", "job_id", "status", "created_at"],
        notes: "Offer lifecycle facts for monthly final-offer reporting.",
      },
      {
        workflowId: "T05",
        endpoint: "/interviews",
        joinEndpoints: ["/job_interviews", "/interview_kits", "/scorecards"],
        factTarget: "rps_scorecard",
        requiredFields: ["id", "application_id", "job_id", "stage_name", "scheduled_at", "scorecard_status"],
        notes: "Interview and scorecard accountability facts for RPS tracking.",
      },
      {
        workflowId: "T02",
        endpoint: "/applications",
        joinEndpoints: ["/application_stages", "/job_interview_stages", "/jobs"],
        factTarget: "pipeline_stage",
        requiredFields: ["id", "job_id", "req_id", "stage_name", "stage_changed_at"],
        notes: "Application stage facts for role-specific pipeline and T03 progress.",
      },
      {
        workflowId: "T09",
        endpoint: "/jobs",
        joinEndpoints: ["/job_owners", "/openings", "/users"],
        factTarget: "ownership",
        requiredFields: ["id", "openings", "hiring_team"],
        notes: "Job ownership and workload facts for role assignment by pod.",
      },
    ])
  })

  test("maps v3 composite sources into module fact contracts", () => {
    expect(mapHarvestOffersToFinalOfferFactsWithDiagnostics(offerRows).facts).toEqual([
      {
        applicationId: "101",
        jobId: "900",
        offerId: "7001",
        status: "approval complete",
        createdAt: "2026-06-16T19:00:00.000Z",
        recruiterName: "Recruiter One",
        sourcerName: "Sourcer One",
        teamName: "Engineering",
        hodName: "HOD One",
      },
    ])

    const rps = mapHarvestScheduledInterviewsToRpsFactsWithDiagnostics({
      interviews: interviewRows,
      jobInterviews: jobInterviewRows,
      interviewKits: interviewKitRows,
      scorecards: scorecardRows,
    })
    expect(rps.facts).toEqual([
      {
        applicationId: "101",
        jobId: "900",
        interviewId: "interview_101",
        stageName: "Recruiter Phone Screen",
        scheduledAt: "2026-06-18T17:00:00.000Z",
        scorecardStatus: "submitted",
        interviewerName: undefined,
      },
      {
        applicationId: "102",
        jobId: "900",
        interviewId: "interview_102",
        stageName: "Recruiter Phone Screen",
        // Timestamp recovered from the matched draft scorecard's interviewed_at.
        scheduledAt: "2026-06-19T10:00:00.000Z",
        scorecardStatus: "pending",
        interviewerName: undefined,
      },
    ])
    expect(rps.sourceGaps).toEqual([])

    const pipeline = mapHarvestApplicationsToPipelineStageFactsWithDiagnostics({
      applications: applicationRows,
      applicationStages: applicationStageRows,
      jobInterviewStages: jobInterviewStageRows,
      jobs: jobRows,
    })
    expect(pipeline.facts).toEqual([
      {
        applicationId: "101",
        jobId: "900",
        reqId: "890",
        stageName: "Application Review",
        stageChangedAt: "2026-06-16T10:00:00.000Z",
      },
      {
        applicationId: "101",
        jobId: "900",
        reqId: "890",
        stageName: "Recruiter Phone Screen",
        stageChangedAt: "2026-06-18T10:00:00.000Z",
      },
    ])
    expect(pipeline.sourceGaps).toEqual([])

    const ownership = mapHarvestJobsToOwnershipFactsWithDiagnostics({
      jobs: jobRows,
      jobOwners: jobOwnerRows,
      openings: openingRows,
      users: userRows,
    })
    expect(ownership.facts).toEqual([
      {
        jobId: "900",
        recruiterName: "Recruiter One",
        sourcerName: "Sourcer One",
        podName: "Pod A",
        openingsCount: 2,
        observedAt: "2026-06-30T10:00:00.000Z",
      },
    ])
    expect(ownership.sourceGaps).toEqual([])
  })

  test("skips never-entered plan-scaffolding stage rows without facts or gaps", () => {
    // v3 pre-creates a stage row per plan stage; only occupied rows count.
    const pipeline = mapHarvestApplicationsToPipelineStageFactsWithDiagnostics({
      applications: applicationRows,
      applicationStages: [
        { id: 801, application_id: 101, job_interview_stage_id: 40, entered_at: "2026-06-16T10:00:00.000Z", exited_at: null, current: true },
        // Never entered: no entered_at, no exited_at, not current — scaffolding.
        { id: 802, application_id: 101, job_interview_stage_id: 41, entered_at: null, exited_at: null, current: false },
        { id: 803, application_id: 101, job_interview_stage_id: 42, entered_at: null, exited_at: null, current: false },
      ],
      jobInterviewStages: jobInterviewStageRows,
      jobs: jobRows,
    })
    expect(pipeline.facts).toHaveLength(1)
    expect(pipeline.facts[0].stageName).toBe("Application Review")
    expect(pipeline.sourceGaps).toEqual([])
  })

  test("names exactly what Greenhouse does not provide when joins cannot fill a field", () => {
    // An OCCUPIED row (current) without entered_at is a genuine gap.
    const pipeline = mapHarvestApplicationsToPipelineStageFactsWithDiagnostics({
      applications: applicationRows,
      applicationStages: [
        { id: 803, application_id: 101, job_interview_stage_id: 41, entered_at: null, current: true },
      ],
      jobInterviewStages: jobInterviewStageRows,
      jobs: jobRows,
    })
    expect(pipeline.facts).toEqual([])
    expect(pipeline.sourceGaps).toHaveLength(1)
    expect(pipeline.sourceGaps[0].field).toBe("stage_changed_at")
    expect(pipeline.sourceGaps[0].reason).toContain("entered_at is null")

    // Application whose job is missing from the /jobs join — no requisition id.
    const noReq = mapHarvestApplicationsToPipelineStageFactsWithDiagnostics({
      applications: applicationRows,
      applicationStages: applicationStageRows,
      jobInterviewStages: jobInterviewStageRows,
      jobs: [],
    })
    expect(noReq.facts).toEqual([])
    expect(noReq.sourceGaps.some((gap) => gap.field === "req_id" && gap.reason.includes("/jobs join"))).toBe(true)

    // Interview with no timestamp anywhere and no matched scorecard.
    const rps = mapHarvestScheduledInterviewsToRpsFactsWithDiagnostics({
      interviews: [{ id: "interview_103", application_id: 103, job_id: 900, job_interview_id: 501, status: "to_be_scheduled" }],
      jobInterviews: jobInterviewRows,
      interviewKits: interviewKitRows,
      scorecards: [],
    })
    expect(rps.facts).toEqual([])
    expect(rps.sourceGaps.some((gap) => gap.field === "scheduled_at" && gap.reason.includes("interviewed_at"))).toBe(true)

    // Job with typed recruiter owners whose user ids resolve to no names.
    const ownership = mapHarvestJobsToOwnershipFactsWithDiagnostics({
      jobs: jobRows,
      jobOwners: jobOwnerRows,
      openings: openingRows,
      users: [],
    })
    expect(ownership.facts).toHaveLength(1)
    expect(ownership.sourceGaps.some((gap) => gap.field === "hiring_team" && gap.reason.includes("/users join"))).toBe(true)

    // Job whose only owners are coordinators — no recruiter/sourcer assigned.
    const coordinatorOnly = mapHarvestJobsToOwnershipFactsWithDiagnostics({
      jobs: jobRows,
      jobOwners: [{ id: 4, user_id: 24, job_id: 900, type: "coordinator", responsible: true }],
      openings: openingRows,
      users: [{ id: 24, name: "Coordinator One" }],
    })
    expect(
      coordinatorOnly.sourceGaps.some((gap) => gap.field === "hiring_team" && gap.reason.includes("coordinator-only"))
    ).toBe(true)

    // Job with no owners at all.
    const unowned = mapHarvestJobsToOwnershipFactsWithDiagnostics({
      jobs: jobRows,
      jobOwners: [],
      openings: openingRows,
      users: userRows,
    })
    expect(unowned.sourceGaps.some((gap) => gap.field === "hiring_team" && gap.reason.includes("unassigned"))).toBe(true)
  })

  test("creates a composite GreenhouseReadBoundary over a fake client without network access", async () => {
    const client = new FakeHarvestReadClient({
      "/offers": offerRows,
      "/interviews": interviewRows,
      "/applications": applicationRows,
      "/jobs": jobRows,
      "/application_stages": applicationStageRows,
      "/job_interview_stages": jobInterviewStageRows,
      "/job_interviews": jobInterviewRows,
      "/interview_kits": interviewKitRows,
      "/scorecards": scorecardRows,
      "/job_owners": jobOwnerRows,
      "/openings": openingRows,
      "/users": userRows,
    })
    const boundary = createGreenhouseHarvestReadBoundary(client, {
      params: {
        T07: {
          per_page: 100,
          created_at: "gte|2026-06-01T00:00:00.000Z",
        },
      },
    })

    const validation = await validateGreenhouseReadBoundary(boundary, {
      asOf: "2026-06-24T23:30:00.000Z",
    })

    expect(validation).toEqual({
      ok: true,
      counts: {
        finalOffers: 1,
        rps: 2,
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

    // Primary pulls honor per-workflow params.
    expect(client.calls).toContainEqual({
      endpoint: "/offers",
      params: { per_page: 100, created_at: "gte|2026-06-01T00:00:00.000Z" },
    })
    expect(client.calls).toContainEqual({ endpoint: "/interviews", params: { per_page: 500 } })
    expect(client.calls).toContainEqual({ endpoint: "/applications", params: { per_page: 500 } })
    // Join pulls are scoped by ids derived from the primary pull — never unfiltered.
    expect(client.calls).toContainEqual({
      endpoint: "/application_stages",
      params: { per_page: 500, application_ids: "101" },
    })
    expect(client.calls).toContainEqual({ endpoint: "/jobs", params: { per_page: 500, ids: "900" } })
    expect(client.calls).toContainEqual({ endpoint: "/scorecards", params: { per_page: 500, application_ids: "101,102" } })
    expect(client.calls).toContainEqual({ endpoint: "/job_interviews", params: { per_page: 500, job_ids: "900" } })
    expect(client.calls).toContainEqual({ endpoint: "/interview_kits", params: { per_page: 500, job_ids: "900" } })
    expect(client.calls).toContainEqual({ endpoint: "/users", params: { per_page: 500, ids: "21,22,23" } })
    // T09's org-wide sub-pulls.
    expect(client.calls).toContainEqual({ endpoint: "/job_owners", params: { per_page: 500 } })
    expect(client.calls).toContainEqual({ endpoint: "/openings", params: { per_page: 500, open: true } })
  })

  test("chunks id-array filters at 50 ids and never issues an empty-id join pull", async () => {
    const manyJobIds = Array.from({ length: 120 }, (_, index) => String(9000 + index))
    const client = new FakeHarvestReadClient({ "/applications": [] })
    const boundary = createGreenhouseHarvestReadBoundary(client, {
      params: { T02: { per_page: 500, job_ids: manyJobIds.join(",") } },
    })

    const fetchResult = await boundary.fetchPipelineStageFacts({ asOf: "2026-06-24T23:30:00.000Z" })

    expect(fetchResult.facts).toEqual([])
    const applicationCalls = client.calls.filter((call) => call.endpoint === "/applications")
    expect(applicationCalls).toHaveLength(3)
    expect(applicationCalls.map((call) => String(call.params?.job_ids).split(",").length)).toEqual([50, 50, 20])
    // Zero applications -> the id-scoped joins must not fire at all (an empty id
    // filter would silently widen to an org-wide pull).
    expect(client.calls.filter((call) => call.endpoint !== "/applications")).toEqual([])
  })

  // Regression lock for the first-light fail-open seam: the boundary once mapped
  // through facts-only variants, so 5000 live /applications records became
  // 0 facts + 0 gaps. A record the client returned that does not become a fact
  // MUST surface as a blocking source gap on the fetch result — never silence.
  test("boundary fetches surface a blocking gap for every source record that cannot become a fact", async () => {
    const unmappableByEndpoint = {
      "/offers": [
        { id: 7001, status: "approved" },
        { id: 7002, status: "sent" },
      ],
      "/interviews": [{ id: "interview_1", starts_at: "not-a-date" }],
      "/applications": [{ id: 101, stage_changed_at: "2026-06-16T10:00:00.000Z" }],
      "/jobs": [{ name: "job with no id", openings_count: 1 }],
    } satisfies Partial<Record<GreenhouseHarvestEndpoint, readonly unknown[]>>
    const boundary = createGreenhouseHarvestReadBoundary(new FakeHarvestReadClient(unmappableByEndpoint))
    const context = { asOf: "2026-06-24T23:30:00.000Z" }

    const fetches = [
      { fetchResult: await boundary.fetchFinalOfferFacts(context), recordCount: 2 },
      { fetchResult: await boundary.fetchRpsFacts(context), recordCount: 1 },
      { fetchResult: await boundary.fetchPipelineStageFacts(context), recordCount: 1 },
      { fetchResult: await boundary.fetchOwnershipFacts(context), recordCount: 1 },
    ]
    for (const { fetchResult, recordCount } of fetches) {
      expect(fetchResult.facts).toEqual([])
      // Every dropped source record is represented by at least one blocking gap.
      const gappedRecords = new Set(
        fetchResult.sourceGaps.map((gap) => gap.id.match(/record_(\d+)/)?.[1]).filter(Boolean)
      )
      expect(gappedRecords.size).toBe(recordCount)
      expect(fetchResult.sourceGaps.length).toBeGreaterThanOrEqual(recordCount)
      expect(fetchResult.sourceGaps.every((gap) => gap.blocksCutover)).toBe(true)
    }
  })
})
