// W2 anti-regression — C3 dual-agency IDEMPOTENCY over a persisted superset.
//
// THE HEADLINE C3 TEST (w2-change-spec:13, :33; ytd-conflicts.ts:262-397). The bug class
// this guards: a YTD incremental re-touches only ONE side of a dual-agency pair (the other
// application was not in the fresh batch and is loaded from the persisted facts). The blind
// fact upsert that follows must NOT erase the known dual_agency verdict on the re-touched
// side. The fix is the PURE superset-reconcile function computeDualAgencyConflicts, which
// takes the in-batch facts UNION the already-persisted facts for the same job_ids and emits
// one deterministic verdict per participating application — so a one-sided re-touch still
// receives the full verdict because the persisted partner is supplied via existingFacts.
//
// This file unit-tests that PURE function directly (no Supabase, no Greenhouse): it is the
// seam the extract orchestrator calls (ytd-conflicts.ts:399-437 applyDualAgencyConflicts ->
// computeDualAgencyConflicts), so asserting the verdict here proves the incremental cannot
// drop a verdict regardless of how the caller wires persistence. Mirrors the fixture style
// of test/ytd-conflicts.test.ts (fact()/candidate() builders, the same field defaults).
//
// Two assertions the spec names:
//   1. A superset where only ONE side of a dual-agency pair is in the fresh batch (the other
//      from existingFacts) PRESERVES the dual_agency verdict on the in-batch side.
//   2. The connected-components group key groups a 3-agency conflict under ONE key.

import { describe, expect, test } from "vitest"
import {
  applyDualAgencyConflicts,
  computeDualAgencyConflicts,
} from "../lib/ytd-conflicts"
import type {
  YtdApplicationFact,
  YtdCandidateSummary,
} from "../lib/ytd-types"

// Same fact() builder shape as test/ytd-conflicts.test.ts:9-66 — every field defaulted so a
// case overrides only what it asserts on. Kept independent (no shared import) so this file is
// self-contained the way the existing test files are.
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

describe("C3 dual-agency idempotency over a persisted superset", () => {
  // A dual-agency pair: two applications on the SAME job_id (20), DIFFERENT agency sources
  // (100 vs 101), with the SAME confirmed identity (one shared email). This is the canonical
  // fee-material case (ytd-conflicts.ts:139-141 email_exact -> confirmed).
  function pairFacts() {
    const left = fact({
      application_id: 1,
      candidate_id: 10,
      candidate_email: "shared@example.com",
      agency_source_id: 100,
      agency_source_name: "Agency A",
    })
    const right = fact({
      application_id: 2,
      candidate_id: 11,
      candidate_email: "shared@example.com",
      agency_source_id: 101,
      agency_source_name: "Agency B",
    })
    const candidatesById = new Map<number, YtdCandidateSummary>([
      [10, candidate({ id: 10, email: "shared@example.com" })],
      [11, candidate({ id: 11, email: "shared@example.com" })],
    ])
    return { left, right, candidatesById }
  }

  // Establish the baseline: a FULL batch with both sides present resolves both to a
  // dual_agency verdict. This is what a backfill (or the first incremental that saw both
  // sides) persisted; the partner that one-sided re-touch later loads from facts.
  test("full batch flags both sides of a dual-agency pair (the persisted baseline)", () => {
    const { left, right, candidatesById } = pairFacts()
    const { verdictsByApplicationId } = computeDualAgencyConflicts({
      inBatchFacts: [left, right],
      existingFacts: [],
      candidatesById,
    })

    const v1 = verdictsByApplicationId.get(1)
    const v2 = verdictsByApplicationId.get(2)
    expect(v1).toBeDefined()
    expect(v2).toBeDefined()
    expect(v1!.confidence).toBe("confirmed")
    expect(v2!.confidence).toBe("confirmed")
    // Both sides share ONE component key (same job, same connected component).
    expect(v1!.group_key).toBe(v2!.group_key)
    // Each side names the OTHER candidate as its dual partner.
    expect(v1!.duplicate_candidate_ids).toEqual([11])
    expect(v2!.duplicate_candidate_ids).toEqual([10])
  })

  // THE REGRESSION: the incremental batch contains ONLY application 2 (the right side was
  // re-touched — e.g. its updated_at moved); application 1 is NOT in the fresh batch and is
  // supplied from the persisted facts via existingFacts. The verdict for the in-batch side
  // (2) must STILL be the full dual_agency verdict — the one-sided re-touch does not erase it.
  test("one-sided re-touch over the superset PRESERVES the dual_agency verdict", () => {
    const { left, right, candidatesById } = pairFacts()

    const { verdictsByApplicationId } = computeDualAgencyConflicts({
      inBatchFacts: [right], // only application 2 in the fresh batch
      existingFacts: [left], // application 1 loaded from persisted facts
      candidatesById,
    })

    const verdict = verdictsByApplicationId.get(2)
    expect(verdict, "in-batch side must receive a verdict from the superset").toBeDefined()
    expect(verdict!.confidence).toBe("confirmed")
    expect(verdict!.duplicate_candidate_ids).toEqual([10])
    // The partner application (1) is named in the component detail even though it was not
    // re-touched this run (ytd-conflicts.ts:371-377 — detail covers the whole component).
    expect(verdict!.detail.applications.map((a) => a.application_id).sort()).toEqual([1, 2])
  })

  // The same one-sided re-touch, asserted at the MUTATING entrypoint the extract uses
  // (ytd-conflicts.ts:406-437 applyDualAgencyConflicts). The in-batch fact must come back
  // carrying conflict_types=['dual_agency'], a non-null group key, and the confirmed
  // duplicate — i.e. the value the blind upsert would have erased had the superset not been
  // supplied. This is the contract w2-change-spec:13 pins on the extract upsert.
  test("applyDualAgencyConflicts writes the dual_agency verdict onto a one-sided re-touch", () => {
    const { left, right, candidatesById } = pairFacts()

    applyDualAgencyConflicts({
      facts: [right], // the only fact being persisted this incremental
      candidatesById,
      existingFacts: [left], // its persisted partner, loaded for the superset
    })

    expect(right.conflict_detected).toBe(true)
    expect(right.conflict_types).toContain("dual_agency")
    expect(right.dual_agency_group_key).not.toBeNull()
    expect(right.duplicate_confidence).toBe("confirmed")
    expect(right.duplicate_evidence_types).toContain("email_exact")
    expect(right.duplicate_candidate_ids).toEqual([10])
  })

  // Idempotence proper: the verdict for application 2 is IDENTICAL whether both sides are in
  // the batch or only application 2 is (partner from existingFacts). The verdict depends only
  // on the SET of applications supplied, not on which subset was re-touched (ytd-conflicts.ts:
  // 266-267). Re-running the incremental therefore converges — it cannot churn the verdict.
  test("the verdict is invariant to which side was re-touched (true idempotence)", () => {
    const full = pairFacts()
    const fullRun = computeDualAgencyConflicts({
      inBatchFacts: [full.left, full.right],
      existingFacts: [],
      candidatesById: full.candidatesById,
    }).verdictsByApplicationId.get(2)!

    const partial = pairFacts()
    const partialRun = computeDualAgencyConflicts({
      inBatchFacts: [partial.right],
      existingFacts: [partial.left],
      candidatesById: partial.candidatesById,
    }).verdictsByApplicationId.get(2)!

    // group_key, confidence, evidence, and partner set all match across the two runs.
    expect(partialRun.group_key).toBe(fullRun.group_key)
    expect(partialRun.confidence).toBe(fullRun.confidence)
    expect([...partialRun.evidence].sort()).toEqual([...fullRun.evidence].sort())
    expect(partialRun.duplicate_candidate_ids).toEqual(fullRun.duplicate_candidate_ids)
  })

  // The OTHER side of the regression: when neither the batch NOR existingFacts carry a real
  // dual-agency partner, no verdict is fabricated (a single agency application on its own job
  // is not a conflict). Guards against the fix over-firing — the superset must not invent
  // conflicts, only preserve real ones.
  test("a lone agency application over the superset gets NO dual_agency verdict", () => {
    const lone = fact({
      application_id: 7,
      candidate_id: 70,
      candidate_email: "solo@example.com",
      agency_source_id: 100,
      job_id: 99,
    })
    const { verdictsByApplicationId } = computeDualAgencyConflicts({
      inBatchFacts: [lone],
      existingFacts: [],
      candidatesById: new Map([[70, candidate({ id: 70, email: "solo@example.com" })]]),
    })
    expect(verdictsByApplicationId.get(7)).toBeUndefined()
  })
})

describe("C3 connected-components group key", () => {
  // A 3-AGENCY conflict on ONE job: three applications, three distinct agency sources, all the
  // same candidate identity (shared email). Pairwise detection unions them into ONE connected
  // component; the group_key derives from the component root (the minimum application_id in the
  // component — ytd-conflicts.ts:355-358), so all three share ONE key regardless of which pair
  // was discovered first. This is the assertion w2-change-spec:13 names ("groups a 3-agency
  // conflict together").
  function tripleFacts() {
    const a = fact({
      application_id: 31,
      candidate_id: 310,
      candidate_email: "trio@example.com",
      agency_source_id: 100,
      agency_source_name: "Agency A",
    })
    const b = fact({
      application_id: 32,
      candidate_id: 311,
      candidate_email: "trio@example.com",
      agency_source_id: 101,
      agency_source_name: "Agency B",
    })
    const c = fact({
      application_id: 33,
      candidate_id: 312,
      candidate_email: "trio@example.com",
      agency_source_id: 102,
      agency_source_name: "Agency C",
    })
    const candidatesById = new Map<number, YtdCandidateSummary>([
      [310, candidate({ id: 310, email: "trio@example.com" })],
      [311, candidate({ id: 311, email: "trio@example.com" })],
      [312, candidate({ id: 312, email: "trio@example.com" })],
    ])
    return { a, b, c, candidatesById }
  }

  test("a 3-agency conflict on one job resolves to ONE shared group key", () => {
    const { a, b, c, candidatesById } = tripleFacts()
    const { verdictsByApplicationId } = computeDualAgencyConflicts({
      inBatchFacts: [a, b, c],
      existingFacts: [],
      candidatesById,
    })

    const v31 = verdictsByApplicationId.get(31)
    const v32 = verdictsByApplicationId.get(32)
    const v33 = verdictsByApplicationId.get(33)
    expect(v31).toBeDefined()
    expect(v32).toBeDefined()
    expect(v33).toBeDefined()

    // The single-key invariant: all three members carry the identical group_key.
    const keys = new Set([v31!.group_key, v32!.group_key, v33!.group_key])
    expect(keys.size).toBe(1)

    // The key is component-rooted on the minimum application_id (31), not pairwise.
    expect(v31!.group_key).toBe("dual_agency::20::31")

    // Each member's detail enumerates all THREE applications in the component.
    expect(v31!.detail.applications.map((app) => app.application_id).sort()).toEqual([
      31, 32, 33,
    ])
    // Each member names the other TWO candidates as duplicates.
    expect(v32!.duplicate_candidate_ids.sort((x, y) => x - y)).toEqual([310, 312])
  })

  // Order-independence of the group key: feeding the three applications in REVERSE batch order
  // (and splitting them across inBatchFacts/existingFacts) yields the SAME key. The union-find
  // root is the minimum id, not the first-discovered pair (ytd-conflicts.ts:247-259 deterministic
  // merge). This is what makes the key safe to persist and re-derive on an incremental.
  test("the 3-agency group key is independent of batch/load order", () => {
    const forward = tripleFacts()
    const forwardKey = computeDualAgencyConflicts({
      inBatchFacts: [forward.a, forward.b, forward.c],
      existingFacts: [],
      candidatesById: forward.candidatesById,
    }).verdictsByApplicationId.get(33)!.group_key

    const shuffled = tripleFacts()
    const shuffledKey = computeDualAgencyConflicts({
      // c re-touched this run; a + b loaded from facts, supplied in reverse.
      inBatchFacts: [shuffled.c],
      existingFacts: [shuffled.b, shuffled.a],
      candidatesById: shuffled.candidatesById,
    }).verdictsByApplicationId.get(33)!.group_key

    expect(shuffledKey).toBe(forwardKey)
    expect(shuffledKey).toBe("dual_agency::20::31")
  })
})
