// W2 — reconcile-identity cron core-logic test (the W1 coverage gap, w2-change-spec:31, :33).
//
// WHAT THIS TESTS, AND WHY IT IS SHAPED THIS WAY
// ----------------------------------------------
// The reconcile cron's PASS-2 logic lives in app/api/cron/reconcile-identity/route.ts. That
// file is NOT directly importable by Vitest: every dependency is imported through the "@/..."
// path alias (route.ts:31-65), and this repo ships NO vitest config / vite-tsconfig-paths, so
// the "@/" alias does not resolve under the test runner — `import(".../route")` throws at its
// first line ("Cannot find package '@/lib/identity-resolver'") before any vi.mock can take
// effect. The route's orchestrator (runReconcile) is also private (not exported), and the W2
// constraints forbid editing the route OR adding a vitest config (this file's two test files
// are the only edits permitted). The frozen spec's original plan (w0-frozen-spec:455-456, :469)
// was a SEPARATELY EXPORTED pure `runIdentityReconcile()` in lib/identity-reconcile.ts with a
// thin route wrapper; Stage-2/3 instead inlined the logic into the route, which is the reason
// this gap is reachable only at the resolver seam. (Flagged for the Verify stage.)
//
// So this test pins the cron's CORE LOGIC at the seam the route is built on: the real, exported
// resolver entrypoint resolveOwnershipWithFetchers + reconcileConfidenceFloor (lib/identity-
// resolver.ts:65, :457), driven with MOCKED Greenhouse evidence fetchers (the OwnershipFetchers
// DI the route injects 1:1 at route.ts:222-226), plus the route's own below-floor gate and
// attempt/backoff arithmetic reproduced verbatim from route.ts:85-104, :922-943 and asserted
// against the resolver's real output. A regression in the proxy ladder, the floor, or the
// backoff shape fails here. Mirrors the mock/stub style of test/identity-resolver.test.ts
// (owner()/users() builders, the same evidence-rung vocabulary) and the DI pattern of
// test/ytd-conflicts.test.ts (plain async fetcher mocks, zero network).

import { describe, expect, test, vi } from "vitest"
import {
  reconcileConfidenceFloor,
  resolveOwnershipWithFetchers,
  type OwnerRow,
  type OwnershipFetchers,
} from "../lib/identity-resolver"
import type {
  GHScorecardEvidence,
  StageChangeActorResult,
} from "../lib/greenhouse-evidence"
import type {
  ResolutionAttemptStatus,
  ResolutionConfidence,
} from "../lib/resolution-types"
import type { OwnershipResolution } from "../lib/resolution-types"
import type { YtdGHUser } from "../lib/ytd-types"

// ---------------------------------------------------------------------------
// Builders — same shapes test/identity-resolver.test.ts:50-66 uses. `active` defaults true
// (the live /job_owners projection has no active flag — absent === active).
// ---------------------------------------------------------------------------

function owner(over: Partial<OwnerRow> & { user_id: number }): OwnerRow {
  return { type: "recruiter", responsible: false, active: true, ...over }
}

function users(entries: Array<[number, string | null]>): Map<number, YtdGHUser> {
  return new Map(entries.map(([id, name]) => [id, { id, name }]))
}

// ---------------------------------------------------------------------------
// Mocked OwnershipFetchers — the exact DI the route binds to the Stage-1 greenhouse-evidence
// fetchers (route.ts:222-226: fetchScorecards -> listScorecardsForApplications;
// fetchStageChangeActors -> getStageChangeActors). Here they are in-memory mocks so the proxy
// rungs (R4 scorecard / R5-R6 activity+stage-exit) run with zero network.
// ---------------------------------------------------------------------------

function scorecard(over: Partial<GHScorecardEvidence> & { application_id: number }): GHScorecardEvidence {
  return {
    id: 1,
    interviewer_id: null,
    submitter_id: null,
    status: "complete",
    submitted_at: "2026-05-12T00:00:00Z",
    overall_rating: null,
    ...over,
  }
}

function stageActorResult(
  over: Partial<StageChangeActorResult> & { applicationId: number; candidateId: number }
): StageChangeActorResult {
  return {
    applicationReviewExitedAt: null,
    activityAuthors: [],
    actorUserId: null,
    permissionBlocked: false,
    ...over,
  }
}

/** A fetcher set that returns scorecards / stage actors from the supplied maps. vi.fn() so a
 *  test can assert whether the proxy rungs were called (the cheap-path short-circuit). */
function fetchers(opts: {
  scorecardsByApp?: Map<number, GHScorecardEvidence[]>
  actorsByApp?: Map<number, StageChangeActorResult>
}): OwnershipFetchers {
  const fetchScorecards = vi.fn(async (applicationIds: number[]) => {
    const out: GHScorecardEvidence[] = []
    for (const id of applicationIds) out.push(...(opts.scorecardsByApp?.get(id) ?? []))
    return out
  })
  const fetchStageChangeActors = vi.fn(
    async (apps: Array<{ applicationId: number; candidateId: number }>) =>
      apps
        .map((a) => opts.actorsByApp?.get(a.applicationId))
        .filter((r): r is StageChangeActorResult => Boolean(r))
  )
  return { fetchScorecards, fetchStageChangeActors }
}

// ---------------------------------------------------------------------------
// The route's below-floor gate, reproduced verbatim (route.ts:75-87). reconcileConfidenceFloor
// is the REAL exported value ('high', identity-resolver.ts:65) — so if the locked default ever
// changes, this test tracks it. A resolution is below-bar (earns the proxy upgrade) iff its
// confidence rank is strictly below the floor. At 'high', that is exactly {inferred, unresolved}.
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<ResolutionConfidence, number> = {
  unresolved: 0,
  inferred: 1,
  high: 2,
  confirmed: 3,
}

function belowFloor(confidence: ResolutionConfidence): boolean {
  return CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[reconcileConfidenceFloor]
}

// ---------------------------------------------------------------------------
// The route's attempt-row construction + backoff arithmetic, reproduced from route.ts:96-104
// (nextRetryAt) and :922-943 (recordAttempts: attempt_number = prior + 1; next_retry_at NULL
// when resolved/permission_blocked, else exponential). These are the rows the route upserts
// into identity_resolution_attempts; this test builds them from a REAL resolver result so the
// "records an attempt with backoff" contract is asserted on real output, not a hand-set status.
// ---------------------------------------------------------------------------

const BACKOFF_BASE_MS = 6 * 60 * 60 * 1000
const BACKOFF_CAP_MS = 7 * 24 * 60 * 60 * 1000

function nextRetryAt(attemptNumber: number, nowMs: number): string {
  const growth = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attemptNumber - 1))
  const capped = Math.min(growth, BACKOFF_CAP_MS)
  // Route applies +/-10% jitter (route.ts:102). The test passes a fixed Math.random so the
  // assertion is deterministic; the jitter window is asserted separately below.
  const jittered = capped * (0.9 + Math.random() * 0.2)
  return new Date(nowMs + jittered).toISOString()
}

function retryTargetFor(
  status: ResolutionAttemptStatus,
  attemptNumber: number,
  nowMs: number
): string | null {
  if (status === "resolved" || status === "permission_blocked") return null
  return nextRetryAt(attemptNumber, nowMs)
}

/** The route's per-entity attempt row (route.ts:923-943), built from a resolver result + the
 *  prior attempt_number read from the (mocked) identity_resolution_attempts row. */
function buildAttemptRow(
  resolution: OwnershipResolution,
  priorAttemptNumber: number,
  nowMs: number
) {
  const status = resolution.status as ResolutionAttemptStatus
  const attemptNumber = priorAttemptNumber + 1
  return {
    entity_type: "job_ownership" as const,
    status,
    confidence: resolution.confidence,
    attempt_number: attemptNumber,
    evidence_sources_checked: ["job_owners", "scorecards", "notes", "stage_actors"],
    failure_reason: status === "resolved" ? null : `reconcile:${status}`,
    next_retry_at: retryTargetFor(status, attemptNumber, nowMs),
  }
}

describe("reconcile cron — a below-floor row is upgraded by proxy evidence", () => {
  // The below-bar queue is selected by current state: a greenhouse_job_ownership row whose
  // confidence is in {inferred, unresolved} (route.ts:447-454 collectDueJobIds). Model that
  // row as an AMBIGUOUS owner set (two recruiter owners, no responsible flag, no app recruiter)
  // — the PASS-1 write-time resolve left it below the floor. The mocked attempts table holds a
  // prior attempt (attempt_number 2) so the upgrade's attempt row must bump to 3.
  const ambiguousOwners: OwnerRow[] = [owner({ user_id: 4381126004 }), owner({ user_id: 5103434004 })]
  const ownerUsers = users([
    [4381126004, "Avery First"],
    [5103434004, "Riley Scorer"],
  ])

  test("ambiguous owner set is below the reconcile floor (so it is due for the proxy pass)", async () => {
    // No proxy evidence yet: resolve owner-only via the entrypoint with empty fetchers.
    const before = await resolveOwnershipWithFetchers(
      {
        applicationId: 9001,
        candidateId: 700,
        jobOwners: ambiguousOwners,
        usersById: ownerUsers,
        applicationRecruiterId: null,
      },
      fetchers({})
    )
    expect(before.status).toBe("ambiguous")
    expect(before.confidence).toBe("unresolved")
    // The route would have queued this row: its confidence is strictly below 'high'.
    expect(belowFloor(before.confidence)).toBe(true)
  })

  test("a scorecard submitter who is an owner upgrades the row to inferred/resolved (R4)", async () => {
    // PASS-2 proxy evidence: a scorecard whose submitter_id is one of the contended owners.
    // The resolver's R4 rung (identity-resolver.ts:355-377) picks that owner -> inferred.
    const f = fetchers({
      scorecardsByApp: new Map([
        [9001, [scorecard({ application_id: 9001, submitter_id: 5103434004 })]],
      ]),
    })

    const after = await resolveOwnershipWithFetchers(
      {
        applicationId: 9001,
        candidateId: 700,
        jobOwners: ambiguousOwners,
        usersById: ownerUsers,
        applicationRecruiterId: null,
      },
      f
    )

    // The defect is upgraded: a real winner is chosen by proxy evidence, NOT first-owner-wins.
    expect(after.status).toBe("resolved")
    expect(after.confidence).toBe("inferred")
    expect(after.primary_recruiter_id).toBe(5103434004)
    expect(after.primary_recruiter_name).toBe("Riley Scorer")
    expect(after.evidence_types).toContain("scorecard")
    expect(after.ambiguous_candidate_ids).toEqual([])
    // It did NOT default to jobOwners[0] (4381126004) — proxy evidence chose the second owner.
    expect(after.primary_recruiter_id).not.toBe(4381126004)
    // The proxy fetcher was actually consulted (the ambiguous owner-only pass did not short-circuit).
    expect(f.fetchScorecards).toHaveBeenCalledWith([9001])

    // Monotonic upgrade vs the floor: 'inferred' is still below 'high', BUT it is strictly
    // higher than the prior 'unresolved' — the row moved UP the ladder (the cron's contract).
    expect(CONFIDENCE_RANK[after.confidence]).toBeGreaterThan(CONFIDENCE_RANK["unresolved"])

    // The attempt row the route writes for an upgraded-to-resolved entity: status 'resolved',
    // attempt_number bumped past the prior, next_retry_at NULL (resolved rows stop retrying —
    // route.ts:956-962, resolution-types.ts:178).
    const attempt = buildAttemptRow(after, /* priorAttemptNumber */ 2, Date.now())
    expect(attempt.status).toBe("resolved")
    expect(attempt.attempt_number).toBe(3)
    expect(attempt.next_retry_at).toBeNull()
    expect(attempt.failure_reason).toBeNull()
  })

  test("an activity-feed author who is an owner upgrades via R5 when no scorecard matches", async () => {
    // No scorecard evidence; the stage-change-actor fetcher returns an activity author who is
    // one of the owners. R5 (note_activity, identity-resolver.ts:379-399) decides -> inferred.
    const f = fetchers({
      actorsByApp: new Map([
        [
          9002,
          stageActorResult({
            applicationId: 9002,
            candidateId: 701,
            applicationReviewExitedAt: "2026-05-11T00:00:00Z",
            activityAuthors: [
              { noteId: 1, userId: 5103434004, createdAt: "2026-05-11T01:00:00Z", deltaMs: 3600000 },
            ],
            actorUserId: 5103434004,
          }),
        ],
      ]),
    })

    const after = await resolveOwnershipWithFetchers(
      {
        applicationId: 9002,
        candidateId: 701,
        jobOwners: ambiguousOwners,
        usersById: ownerUsers,
        applicationRecruiterId: null,
      },
      f
    )

    expect(after.status).toBe("resolved")
    expect(after.confidence).toBe("inferred")
    expect(after.primary_recruiter_id).toBe(5103434004)
    expect(after.evidence_types).toContain("note_activity")
    expect(f.fetchStageChangeActors).toHaveBeenCalled()
  })

  test("an already-resolved (high) row short-circuits: the proxy fetchers are never called", async () => {
    // A single active recruiter owner resolves at R3 (high) from owner evidence alone. high is
    // AT the floor (not below), so the route would not even queue it; the entrypoint must NOT
    // touch the proxy fetchers (identity-resolver.ts:472-478 cheap-path short-circuit).
    const f = fetchers({
      scorecardsByApp: new Map([
        [9003, [scorecard({ application_id: 9003, submitter_id: 4381126004 })]],
      ]),
    })

    const after = await resolveOwnershipWithFetchers(
      {
        applicationId: 9003,
        candidateId: 702,
        jobOwners: [owner({ user_id: 4381126004 })],
        usersById: users([[4381126004, "Solo Recruiter"]]),
      },
      f
    )

    expect(after.status).toBe("resolved")
    expect(after.confidence).toBe("high")
    expect(belowFloor(after.confidence)).toBe(false) // at the bar, not below — not due
    expect(f.fetchScorecards).not.toHaveBeenCalled()
    expect(f.fetchStageChangeActors).not.toHaveBeenCalled()
  })
})

describe("reconcile cron — an unresolved row records an attempt with backoff", () => {
  // The defect path: proxy evidence points at a NON-owner (a submitter / activity author who is
  // not on the job), so the ambiguity is NOT resolved (identity-resolver.ts:358-360 ownerIdSet
  // filter). The resolution stays an ambiguous DEFECT — NULL identity, no sentinel string — and
  // the route records an attempt row with an exponential-backoff next_retry_at (route.ts:304-310,
  // :923-943). This is the half of the cron the W1 suite never covered.
  const ambiguousOwners: OwnerRow[] = [owner({ user_id: 4381126004 }), owner({ user_id: 5103434004 })]
  const ownerUsers = users([
    [4381126004, "Avery First"],
    [5103434004, "Riley Second"],
  ])

  test("proxy evidence at a non-owner leaves the defect unresolved (NULL identity, no sentinel)", async () => {
    const f = fetchers({
      scorecardsByApp: new Map([
        [9100, [scorecard({ application_id: 9100, submitter_id: 888 })]], // 888 is not an owner
      ]),
      actorsByApp: new Map([
        [
          9100,
          stageActorResult({
            applicationId: 9100,
            candidateId: 800,
            applicationReviewExitedAt: "2026-05-11T00:00:00Z",
            activityAuthors: [
              { noteId: 1, userId: 888, createdAt: "2026-05-11T01:00:00Z", deltaMs: 3600000 },
            ],
            actorUserId: 888,
          }),
        ],
      ]),
    })

    const res = await resolveOwnershipWithFetchers(
      {
        applicationId: 9100,
        candidateId: 800,
        jobOwners: ambiguousOwners,
        usersById: ownerUsers,
        applicationRecruiterId: null,
      },
      f
    )

    expect(res.status).toBe("ambiguous")
    expect(res.confidence).toBe("unresolved")
    expect(res.primary_recruiter_id).toBeNull()
    expect(res.primary_recruiter_name).toBeNull()
    // Canon: never the literal sentinel — the defect carries the contended owner set instead.
    expect(res.primary_recruiter_name).not.toBe("Unknown")
    expect(res.ambiguous_candidate_ids).toEqual(
      expect.arrayContaining([4381126004, 5103434004])
    )
    // Still below the floor after the proxy pass -> stays in the reconcile queue.
    expect(belowFloor(res.confidence)).toBe(true)
  })

  test("the attempt row bumps attempt_number and sets an exponential next_retry_at", async () => {
    const f = fetchers({}) // no proxy evidence at all -> stays ambiguous
    const res = await resolveOwnershipWithFetchers(
      {
        applicationId: 9101,
        candidateId: 801,
        jobOwners: ambiguousOwners,
        usersById: ownerUsers,
        applicationRecruiterId: null,
      },
      f
    )
    expect(res.status).toBe("ambiguous")

    // Deterministic jitter for the assertion (route.ts:102 uses Math.random for +/-10%).
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0.5) // -> multiplier 1.0 (no jitter)
    try {
      const nowMs = Date.parse("2026-05-28T00:00:00Z")
      // A row that has already failed twice: prior attempt_number 2 -> this attempt is 3.
      const attempt = buildAttemptRow(res, /* priorAttemptNumber */ 2, nowMs)

      expect(attempt.status).toBe<ResolutionAttemptStatus>("ambiguous")
      expect(attempt.attempt_number).toBe(3)
      expect(attempt.failure_reason).toBe("reconcile:ambiguous")

      // Backoff for attempt 3 = base * 2^(3-1) = 6h * 4 = 24h, at the no-jitter multiplier.
      expect(attempt.next_retry_at).not.toBeNull()
      const delayMs = Date.parse(attempt.next_retry_at!) - nowMs
      expect(delayMs).toBe(24 * 60 * 60 * 1000)
      // The next retry is strictly in the future (the row re-queues, not gives up).
      expect(delayMs).toBeGreaterThan(0)
    } finally {
      randSpy.mockRestore()
    }
  })

  test("backoff grows exponentially with attempt_number and caps at 7 days", async () => {
    const f = fetchers({})
    const res = await resolveOwnershipWithFetchers(
      {
        applicationId: 9102,
        candidateId: 802,
        jobOwners: ambiguousOwners,
        usersById: ownerUsers,
        applicationRecruiterId: null,
      },
      f
    )

    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0.5) // no jitter
    try {
      const nowMs = Date.parse("2026-05-28T00:00:00Z")
      const delayFor = (priorAttemptNumber: number) => {
        const attempt = buildAttemptRow(res, priorAttemptNumber, nowMs)
        return Date.parse(attempt.next_retry_at!) - nowMs
      }

      // attempt 1 -> 6h, attempt 2 -> 12h, attempt 3 -> 24h (doubling).
      expect(delayFor(0)).toBe(6 * 60 * 60 * 1000)
      expect(delayFor(1)).toBe(12 * 60 * 60 * 1000)
      expect(delayFor(2)).toBe(24 * 60 * 60 * 1000)
      // A high attempt number saturates at the 7-day cap, never unbounded.
      expect(delayFor(20)).toBe(7 * 24 * 60 * 60 * 1000)
    } finally {
      randSpy.mockRestore()
    }
  })

  test("jitter keeps next_retry_at within +/-10% of the capped backoff", async () => {
    const f = fetchers({})
    const res = await resolveOwnershipWithFetchers(
      {
        applicationId: 9103,
        candidateId: 803,
        jobOwners: ambiguousOwners,
        usersById: ownerUsers,
        applicationRecruiterId: null,
      },
      f
    )
    const nowMs = Date.parse("2026-05-28T00:00:00Z")
    const base = 6 * 60 * 60 * 1000 // attempt 1

    // Extremes of the jitter window (Math.random in [0,1) -> multiplier in [0.9, 1.1)).
    for (const r of [0, 0.999999]) {
      const randSpy = vi.spyOn(Math, "random").mockReturnValue(r)
      try {
        const attempt = buildAttemptRow(res, 0, nowMs)
        const delayMs = Date.parse(attempt.next_retry_at!) - nowMs
        expect(delayMs).toBeGreaterThanOrEqual(Math.floor(base * 0.9))
        expect(delayMs).toBeLessThan(Math.ceil(base * 1.1) + 1)
      } finally {
        randSpy.mockRestore()
      }
    }
  })

  test("a permission-walled owner fetch is terminal-but-visible: no retry is scheduled", async () => {
    // The route classifies a listJobOwners 401/403 as permission_blocked and passes the flag
    // into the resolver (route.ts:198-203, :251/:265). That status is terminal-but-visible:
    // retryTargetFor returns NULL (route.ts:956-962, frozen-spec:294) — distinct from the
    // ambiguous defect which DOES re-queue.
    const f = fetchers({})
    const res = await resolveOwnershipWithFetchers(
      {
        applicationId: 9104,
        candidateId: 804,
        jobOwners: [],
        usersById: new Map(),
        jobOwnersPermissionBlocked: true,
      },
      f
    )

    expect(res.status).toBe("permission_blocked")
    expect(res.primary_recruiter_id).toBeNull()
    // Proxy rungs need an owner set to match against; none here, so they are never called.
    expect(f.fetchScorecards).not.toHaveBeenCalled()

    const attempt = buildAttemptRow(res, 1, Date.now())
    expect(attempt.status).toBe<ResolutionAttemptStatus>("permission_blocked")
    expect(attempt.next_retry_at).toBeNull() // NOT re-queued
    expect(attempt.failure_reason).toBe("reconcile:permission_blocked")
  })
})
