// Correctness — dual-agency COMPONENT-LEVEL confidence on every member's verdict.
//
// computeDualAgencyConflicts (lib/ytd-conflicts.ts) unions a job's cross-agency applications
// into connected components and emits one verdict per participating application. The component
// detail (ytd-conflicts.ts:378-382) and its leading comment (ytd-conflicts.ts:359-361) both
// state every member must report the COMPONENT-level severity — the strongest signal anywhere
// in the component — because a confirmed link between two of three agencies makes the whole
// group fee-material. The per-member verdict.confidence must therefore equal the component max,
// NOT the member's own (possibly weaker) pair confidence.
//
// THE BUG this guards (ytd-conflicts.ts:~388): the per-member confidence was
// `own?.confidence ?? componentConfidence`. Because every emitted member has pairEvidence (the
// emit loop is guarded on pairEvidence.has — ytd-conflicts.ts:347), `own` is always defined, so
// the `?? componentConfidence` fallback never fired and a weak-link member reported its OWN weak
// pair confidence. In a 3-application chain with a strong A-B link and a weak B-C link, member C
// wrongly reported "possible" instead of the component max "confirmed".
//
// Fixture style mirrors test/ytd-conflicts.test.ts:9-81 and test/ytd-idempotency.test.ts:36-108
// (fact()/candidate() builders, every field defaulted). Confidence is derived through the real
// compareCandidates ladder (ytd-conflicts.ts:139-146): email_exact -> "confirmed";
// name_company_title alone -> "possible". So a shared email seeds a confirmed link and a shared
// name/company/title (with DIFFERENT emails) seeds a possible link.

import { describe, expect, test } from "vitest"
import { computeDualAgencyConflicts } from "../lib/ytd-conflicts"
import type { YtdApplicationFact, YtdCandidateSummary } from "../lib/ytd-types"

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

describe("dual-agency component-level confidence", () => {
  // A 3-application connected component on ONE job (20), three distinct agency sources.
  //   A (app 1, candidate 10) and B (app 2, candidate 11) share an EMAIL -> confirmed link.
  //   B (app 2, candidate 11) and C (app 3, candidate 12) share NAME/COMPANY/TITLE but have
  //     DIFFERENT emails -> possible link.
  //   A and C share NEITHER email nor name/company/title -> no direct edge (the chain is
  //     A=B (strong) — B-C (weak), not a triangle).
  // Pairwise union still merges all three into ONE component, whose strongest signal is the
  // confirmed A-B link. Every member's verdict.confidence must therefore be "confirmed".
  function chainFacts() {
    const a = fact({
      application_id: 1,
      candidate_id: 10,
      candidate_email: "ab-shared@example.com",
      agency_source_id: 100,
      agency_source_name: "Agency A",
    })
    const b = fact({
      application_id: 2,
      candidate_id: 11,
      candidate_email: "ab-shared@example.com",
      agency_source_id: 101,
      agency_source_name: "Agency B",
    })
    const c = fact({
      application_id: 3,
      candidate_id: 12,
      candidate_email: "c-distinct@example.com",
      agency_source_id: 102,
      agency_source_name: "Agency C",
    })
    const candidatesById = new Map<number, YtdCandidateSummary>([
      // A and B: identical email -> email_exact -> confirmed. Name/company/title differ from C.
      [10, candidate({ id: 10, email: "ab-shared@example.com", first_name: "Alice", last_name: "Strong", company: "Strong Co", title: "Staff Engineer" })],
      [11, candidate({ id: 11, email: "ab-shared@example.com", first_name: "Bridge", last_name: "Member", company: "Bridge Co", title: "Principal" })],
      // C: DIFFERENT email from A/B (so no email_exact to either), but identical
      // name/company/title to B -> name_company_title -> possible (B-C only).
      [12, candidate({ id: 12, email: "c-distinct@example.com", first_name: "Bridge", last_name: "Member", company: "Bridge Co", title: "Principal" })],
    ])
    return { a, b, c, candidatesById }
  }

  test("the weak-link member reports the COMPONENT (strong) confidence, not its own pair confidence", () => {
    const { a, b, c, candidatesById } = chainFacts()
    const { verdictsByApplicationId } = computeDualAgencyConflicts({
      inBatchFacts: [a, b, c],
      existingFacts: [],
      candidatesById,
    })

    const vA = verdictsByApplicationId.get(1)
    const vB = verdictsByApplicationId.get(2)
    const vC = verdictsByApplicationId.get(3)
    expect(vA).toBeDefined()
    expect(vB).toBeDefined()
    expect(vC).toBeDefined()

    // Sanity that the fixture actually builds a MIXED-severity component, not three equal links:
    // C is the weak-link member — it has a single "possible" B-C edge and no email_exact. Its own
    // pair evidence is "possible"; the component max is "confirmed". This is exactly the divergence
    // the bug exposed.
    expect(vC!.evidence).toContain("name_company_title")
    expect(vC!.evidence).not.toContain("email_exact")

    // THE ASSERTION: the weak-link member C reports the COMPONENT (strong) confidence "confirmed",
    // NOT its own weak pair confidence "possible". Fails against `own?.confidence ?? componentConfidence`
    // (which yielded "possible" for C); passes once the per-member confidence is componentConfidence.
    expect(vC!.confidence).toBe("confirmed")

    // The whole component reports the same severity — the strong-link members and the shared detail
    // agree with the weak-link member.
    expect(vA!.confidence).toBe("confirmed")
    expect(vB!.confidence).toBe("confirmed")
    expect(vC!.detail.confidence).toBe("confirmed")

    // The per-member EVIDENCE stays own-pair provenance (NOT widened to the component): C's verdict
    // evidence carries only its own B-C signal, while detail.evidence carries the full component set.
    expect(vC!.detail.evidence).toContain("email_exact")
    expect(vC!.detail.evidence).toContain("name_company_title")
    expect(vC!.detail.applications.map((app) => app.application_id).sort((x, y) => x - y)).toEqual([1, 2, 3])
  })
})
