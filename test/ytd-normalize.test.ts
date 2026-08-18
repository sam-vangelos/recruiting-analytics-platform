import { describe, expect, test } from "vitest"
import {
  buildApplicationFact,
  deriveActionBucket,
  deriveActionState,
  deepestStage,
} from "../lib/ytd-normalize"
import type {
  YtdBuildContext,
  YtdGHApplication,
  YtdJobOwnerSnapshot,
  YtdStageEvent,
} from "../lib/ytd-types"

function app(overrides: Partial<YtdGHApplication> = {}): YtdGHApplication {
  return {
    id: 101,
    candidate_id: 201,
    job_id: 301,
    status: "active",
    current_stage: { id: 1, name: "Application Review" },
    source: { id: 4000194004, name: "Referral" },
    credited_to: { id: 501, first_name: "Riley", last_name: "Referrer" },
    applied_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    last_activity_at: "2026-01-01T01:00:00Z",
    current_stage_at: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function event(overrides: Partial<YtdStageEvent>): YtdStageEvent {
  return {
    id: 1,
    application_id: 101,
    job_interview_stage_id: 1,
    stage_name: "Application Review",
    stage_rank: 1,
    entered_at: "2026-01-01T00:00:00Z",
    exited_at: null,
    days_in_stage: null,
    current: false,
    ...overrides,
  }
}

function context(overrides: Partial<YtdBuildContext> = {}): YtdBuildContext {
  const owner: YtdJobOwnerSnapshot = {
    job_id: 301,
    user_id: 901,
    owner_type: "recruiter",
    user_name: "Recruiter One",
    user_email: "recruiter@example.com",
    active: true,
  }
  return {
    scanYear: 2026,
    syncRunId: "00000000-0000-0000-0000-000000000001",
    nowIso: "2026-05-27T00:00:00Z",
    channel: "referral",
    applications: [],
    candidatesById: new Map([
      [
        201,
        {
          id: 201,
          name: "Candidate One",
          email: "candidate@example.com",
          first_name: "Candidate",
          last_name: "One",
          company: "company",
          title: "title",
          phones: [],
          profile_urls: [],
        },
      ],
    ]),
    jobsById: new Map([[301, { id: 301, title: "Role One", department_id: 401, department_name: "Engineering" }]]),
    stageEventsByApplicationId: new Map(),
    ownersByJobId: new Map([[301, [owner]]]),
    usersById: new Map([[501, { id: 501, name: "Riley Referrer" }]]),
    referrersById: new Map(),
    ...overrides,
  }
}

describe("YTD action derivation", () => {
  test("Application Review exit produces exact actioned_at", () => {
    const result = deriveActionState({
      app: app(),
      stageEvents: [
        event({ exited_at: "2026-01-01T06:00:00Z" }),
        event({
          id: 2,
          job_interview_stage_id: 2,
          stage_name: "Recruiter Phone Screen",
          stage_rank: 2,
          entered_at: "2026-01-01T06:00:00Z",
          current: true,
        }),
      ],
    })

    expect(result.actioned_at).toBe("2026-01-01T06:00:00Z")
    expect(result.action_time_hours).toBe(6)
    expect(result.action_time_quality).toBe("exact")
    expect(result.never_actioned).toBe(false)
  })

  test("later-stage fallback marks action time approximate", () => {
    const result = deriveActionState({
      app: app({ current_stage: { id: 2, name: "Recruiter Phone Screen" } }),
      stageEvents: [
        event({ exited_at: null }),
        event({
          id: 2,
          job_interview_stage_id: 2,
          stage_name: "Recruiter Phone Screen",
          stage_rank: 2,
          entered_at: "2026-01-01T10:00:00Z",
          current: true,
        }),
      ],
    })

    expect(result.actioned_at).toBe("2026-01-01T10:00:00Z")
    expect(result.action_time_hours).toBe(10)
    expect(result.action_time_quality).toBe("approximate")
    expect(result.data_quality_flags).toContain("approximate_action_time")
  })

  test("active Application Review with no exit is never actioned", () => {
    const result = deriveActionState({
      app: app(),
      stageEvents: [event({ current: true })],
    })

    expect(result.actioned_at).toBeNull()
    expect(result.never_actioned).toBe(true)
  })

  test("missing stage history is flagged", () => {
    const result = deriveActionState({ app: app(), stageEvents: [] })

    expect(result.data_quality_flags).toContain("missing_stage_history")
  })

  test("action bucket derivation covers actioned and unactioned windows", () => {
    const submittedAt = "2026-01-01T00:00:00Z"

    expect(
      deriveActionBucket({
        submittedAt,
        firstActionAt: "2026-01-01T12:00:00Z",
        firstActionTimeHours: 12,
        nowIso: "2026-01-10T00:00:00Z",
      })
    ).toBe("lt_24h")
    expect(
      deriveActionBucket({
        submittedAt,
        firstActionAt: "2026-01-02T06:00:00Z",
        firstActionTimeHours: 30,
        nowIso: "2026-01-10T00:00:00Z",
      })
    ).toBe("h24_48")
    expect(
      deriveActionBucket({
        submittedAt,
        firstActionAt: "2026-01-04T00:00:00Z",
        firstActionTimeHours: 72,
        nowIso: "2026-01-10T00:00:00Z",
      })
    ).toBe("d2_7")
    expect(
      deriveActionBucket({
        submittedAt,
        firstActionAt: "2026-01-09T00:00:00Z",
        firstActionTimeHours: 192,
        nowIso: "2026-01-10T00:00:00Z",
      })
    ).toBe("gt_7d")
    expect(
      deriveActionBucket({
        submittedAt,
        firstActionAt: null,
        firstActionTimeHours: null,
        nowIso: "2026-01-03T00:00:00Z",
      })
    ).toBe("unactioned_lt_7d")
    expect(
      deriveActionBucket({
        submittedAt,
        firstActionAt: null,
        firstActionTimeHours: null,
        nowIso: "2026-01-09T00:00:00Z",
      })
    ).toBe("unactioned_gt_7d")
  })
})

describe("YTD fact derivation", () => {
  test("deepest stage chooses highest ranked event", () => {
    const result = deepestStage([
      event({ stage_rank: 1, stage_name: "Application Review" }),
      event({ id: 2, job_interview_stage_id: 2, stage_rank: 4, stage_name: "Offer" }),
      event({ id: 3, job_interview_stage_id: 3, stage_rank: 2, stage_name: "Recruiter Screen" }),
    ])

    expect(result.max_stage_name).toBe("Offer")
    expect(result.max_stage_rank).toBe(4)
  })

  test("buildApplicationFact preserves all recruiters and deterministic primary recruiter", () => {
    const owners: YtdJobOwnerSnapshot[] = [
      {
        job_id: 301,
        user_id: 902,
        owner_type: "recruiter",
        user_name: "Recruiter Two",
        user_email: null,
        active: true,
      },
      {
        job_id: 301,
        user_id: 901,
        owner_type: "recruiter",
        user_name: "Recruiter One",
        user_email: null,
        active: true,
      },
    ]
    const fact = buildApplicationFact(
      app({ recruiter_id: 902 }),
      context({ ownersByJobId: new Map([[301, owners]]) })
    )

    expect(fact.primary_recruiter_id).toBe(902)
    expect(fact.primary_recruiter_name).toBe("Recruiter Two")
    expect(fact.recruiter_ids).toEqual([901, 902])
  })

  test("referral referrer uses credited_to before user lookup", () => {
    const fact = buildApplicationFact(app(), context())

    expect(fact.referrer_name).toBe("Riley Referrer")
  })

  test("referral referrer name resolves from the /referrers registry by referrer_id", () => {
    // The real Harvest shape: no credited_to, a top-level referrer_id that is a /referrers.id.
    const fact = buildApplicationFact(
      app({ credited_to: null, referrer_id: 700 }),
      context({ referrersById: new Map([[700, { id: 700, user_id: 999, name: "Dana Referrer" }]]) })
    )

    expect(fact.referrer_id).toBe(700)
    expect(fact.referrer_name).toBe("Dana Referrer")
    expect(fact.data_quality_flags).not.toContain("missing_referrer")
  })

  test("referral with a referrer_id absent from the registry flags missing_referrer", () => {
    const fact = buildApplicationFact(
      app({ credited_to: null, referrer_id: 700 }),
      context({ referrersById: new Map() })
    )

    expect(fact.referrer_name).toBeNull()
    expect(fact.data_quality_flags).toContain("missing_referrer")
  })

  test("rejected application derives terminal outcome", () => {
    const fact = buildApplicationFact(
      app({ status: "rejected", last_activity_at: "2026-01-03T00:00:00Z" }),
      context()
    )

    expect(fact.terminal_outcome).toBe("rejected")
  })

  test("buildApplicationFact carries department and agency action fields", () => {
    const fact = buildApplicationFact(app(), context({ channel: "agency" }))

    expect(fact.department_name).toBe("Engineering")
    expect(fact.submitted_at).toBe("2026-01-01T00:00:00Z")
    expect(fact.first_action_at).toBeNull()
    expect(fact.action_bucket).toBe("unactioned_gt_7d")
  })
})
