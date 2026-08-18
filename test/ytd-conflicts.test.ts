import { describe, expect, test } from "vitest"
import {
  applyDualAgencyConflicts,
  applyFeeRiskStates,
  applyPriorHistoryConflicts,
} from "../lib/ytd-conflicts"
import type { YtdApplicationFact, YtdCandidateSummary, YtdGHApplication } from "../lib/ytd-types"

function fact(overrides: Partial<YtdApplicationFact>): YtdApplicationFact {
  return {
    application_id: 1,
    scan_year: 2026,
    channel: "agency",
    candidate_id: 10,
    candidate_name: "Candidate",
    candidate_email: "candidate@example.com",
    job_id: 20,
    job_title: "Role",
    source_id: 100,
    source_name: "Agency",
    department_id: 30,
    department_name: "Engineering",
    application_status: "active",
    applied_at: "2026-05-10T00:00:00Z",
    submitted_at: "2026-05-10T00:00:00Z",
    last_activity_at: "2026-05-10T00:00:00Z",
    referrer_id: null,
    referrer_name: null,
    agency_source_id: 100,
    agency_source_name: "Agency",
    primary_recruiter_id: null,
    primary_recruiter_name: null,
    recruiter_ids: [],
    recruiter_names: [],
    current_stage_id: 1,
    current_stage_name: "Application Review",
    current_stage_entered_at: "2026-05-10T00:00:00Z",
    application_review_entered_at: "2026-05-10T00:00:00Z",
    application_review_exited_at: null,
    actioned_at: null,
    first_action_at: null,
    action_time_hours: null,
    first_action_time_hours: null,
    never_actioned: true,
    action_time_quality: "unknown",
    action_bucket: "unactioned_lt_7d",
    max_stage_id: 1,
    max_stage_name: "Application Review",
    max_stage_rank: 1,
    terminal_outcome: "active",
    conflict_detected: false,
    conflict_types: [],
    dual_agency_group_key: null,
    prior_internal_application_ids: [],
    duplicate_confidence: "none",
    duplicate_evidence_types: [],
    duplicate_candidate_ids: [],
    fee_risk_state: "not_duplicate",
    fee_risk_reason: null,
    conflict_detail: null,
    data_quality_flags: [],
    last_synced_at: "2026-05-27T00:00:00Z",
    sync_run_id: null,
    ...overrides,
  }
}

function candidate(overrides: Partial<YtdCandidateSummary>): YtdCandidateSummary {
  return {
    id: 10,
    name: "Candidate",
    email: "candidate@example.com",
    first_name: "Candidate",
    last_name: "Example",
    company: "Current Co",
    title: "Lead Engineer",
    phones: [],
    profile_urls: [],
    ...overrides,
  }
}

function app(overrides: Partial<YtdGHApplication>): YtdGHApplication {
  return {
    id: 99,
    candidate_id: 99,
    job_id: 20,
    status: "rejected",
    current_stage: { id: 1, name: "Application Review" },
    source: { id: 300, name: "LinkedIn" },
    credited_to: null,
    applied_at: "2026-04-01T00:00:00Z",
    created_at: "2026-04-01T00:00:00Z",
    last_activity_at: "2026-04-02T00:00:00Z",
    current_stage_at: "2026-04-01T00:00:00Z",
    ...overrides,
  }
}

describe("YTD agency conflicts", () => {
  test("dual-agency conflict groups same email and job across agencies", () => {
    const facts = [
      fact({ application_id: 1, agency_source_id: 100, agency_source_name: "Agency A" }),
      fact({ application_id: 2, candidate_id: 11, agency_source_id: 101, agency_source_name: "Agency B" }),
      fact({ application_id: 3, candidate_id: 12, agency_source_id: 100, job_id: 21 }),
    ]
    const candidatesById = new Map([
      [10, candidate({ id: 10, email: "same@example.com" })],
      [11, candidate({ id: 11, email: "same@example.com" })],
      [12, candidate({ id: 12, email: "same@example.com" })],
    ])

    applyDualAgencyConflicts({ facts, candidatesById })

    expect(facts[0].conflict_types).toContain("dual_agency")
    expect(facts[1].conflict_types).toContain("dual_agency")
    expect(facts[2].conflict_types).not.toContain("dual_agency")
    expect(facts[0].duplicate_confidence).toBe("confirmed")
    expect(facts[0].duplicate_evidence_types).toContain("email_exact")
  })

  test("missing identity suppresses conflict detection and adds quality flag", () => {
    const facts = [fact({ candidate_email: null })]

    applyDualAgencyConflicts({
      facts,
      candidatesById: new Map([[10, candidate({ email: null, company: null, title: null })]]),
    })

    expect(facts[0].conflict_detected).toBe(false)
    expect(facts[0].data_quality_flags).toContain("cannot_check_conflict_missing_email")
  })

  test("phone, profile, and name/company/title evidence derive high and possible confidence", () => {
    const phoneFacts = [
      fact({ application_id: 1, agency_source_id: 100 }),
      fact({ application_id: 2, candidate_id: 11, agency_source_id: 101 }),
    ]
    applyDualAgencyConflicts({
      facts: phoneFacts,
      candidatesById: new Map([
        [10, candidate({ id: 10, email: null, phones: ["5551112222"] })],
        [11, candidate({ id: 11, email: null, phones: ["5551112222"] })],
      ]),
    })
    expect(phoneFacts[0].duplicate_confidence).toBe("high")
    expect(phoneFacts[0].duplicate_evidence_types).toContain("phone_exact")

    const profileFacts = [
      fact({ application_id: 3, agency_source_id: 100 }),
      fact({ application_id: 4, candidate_id: 12, agency_source_id: 101 }),
    ]
    applyDualAgencyConflicts({
      facts: profileFacts,
      candidatesById: new Map([
        [10, candidate({ id: 10, email: null, profile_urls: ["linkedin.com/in/example"] })],
        [12, candidate({ id: 12, email: null, profile_urls: ["https://www.linkedin.com/in/example/"] })],
      ]),
    })
    expect(profileFacts[0].duplicate_confidence).toBe("high")
    expect(profileFacts[0].duplicate_evidence_types).toContain("profile_url_exact")

    const possibleFacts = [
      fact({ application_id: 5, agency_source_id: 100 }),
      fact({ application_id: 6, candidate_id: 13, agency_source_id: 101 }),
    ]
    applyDualAgencyConflicts({
      facts: possibleFacts,
      candidatesById: new Map([
        [10, candidate({ id: 10, email: null })],
        [13, candidate({ id: 13, email: null })],
      ]),
    })
    expect(possibleFacts[0].duplicate_confidence).toBe("possible")
    expect(possibleFacts[0].duplicate_evidence_types).toContain("name_company_title")
  })

  test("prior-history conflict detects earlier non-agency application", async () => {
    const facts = [fact({ application_id: 10, candidate_email: "same@example.com" })]

    await applyPriorHistoryConflicts({
      facts,
      agencySourceIds: new Set([100, 101]),
      jobsById: new Map([[20, { id: 20, title: "Role", department_id: 30, department_name: "Engineering" }]]),
      fetchers: {
        findCandidatesByEmail: async () => [{ id: 99 }],
        findApplicationsByCandidateId: async () => [app({ id: 99, source: { id: 300, name: "Referral" } })],
      },
    })

    expect(facts[0].conflict_types).toContain("prior_history")
    expect(facts[0].prior_internal_application_ids).toEqual([99])
    expect(facts[0].duplicate_confidence).toBe("confirmed")
  })

  test("fee-risk state distinguishes exposed duplicates from slow non-duplicates", () => {
    const exposed = fact({
      duplicate_confidence: "confirmed",
      first_action_time_hours: 200,
      action_bucket: "gt_7d",
    })
    const cleared = fact({
      application_id: 2,
      duplicate_confidence: "high",
      first_action_time_hours: 20,
      action_bucket: "lt_24h",
    })
    const slowNonDuplicate = fact({
      application_id: 3,
      duplicate_confidence: "none",
      first_action_time_hours: 240,
      action_bucket: "gt_7d",
    })

    applyFeeRiskStates({
      facts: [exposed, cleared, slowNonDuplicate],
      nowIso: "2026-05-20T00:00:00Z",
    })

    expect(exposed.fee_risk_state).toBe("exposed")
    expect(cleared.fee_risk_state).toBe("cleared_in_window")
    expect(slowNonDuplicate.fee_risk_state).toBe("not_duplicate")
  })

  test("unactioned duplicate after seven days is exposed", () => {
    const duplicate = fact({
      duplicate_confidence: "confirmed",
      submitted_at: "2026-05-01T00:00:00Z",
      first_action_at: null,
      first_action_time_hours: null,
    })

    applyFeeRiskStates({ facts: [duplicate], nowIso: "2026-05-10T00:00:00Z" })

    expect(duplicate.fee_risk_state).toBe("exposed")
  })
})
