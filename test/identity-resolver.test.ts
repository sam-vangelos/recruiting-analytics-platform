import { describe, expect, test } from "vitest"
import { resolveOwnership } from "../lib/identity-resolver"
import type { OwnerRow, OwnershipEvidence } from "../lib/identity-resolver"
import type {
  OwnershipEvidenceType,
  OwnershipResolution,
} from "../lib/resolution-types"
import type { YtdGHUser } from "../lib/ytd-types"

// ---------------------------------------------------------------------------
// Resolver-under-test: lib/identity-resolver.ts (frozen-spec:284-302, S3 :485).
// Signature consumed AS WRITTEN by the Stage-1 module:
//
//   resolveOwnership(ev: OwnershipEvidence): OwnershipResolution
//   OwnershipEvidence { jobOwners: OwnerRow[]; usersById: Map<number, YtdGHUser>;
//                       applicationRecruiterId?; scorecardSubmitterIds?;
//                       activityActorIds?; stageExitActorId?;
//                       jobOwnersPermissionBlocked?; proxyPermissionBlocked? }
//   OwnerRow = Pick<GHJobOwnerWithResponsible,'user_id'|'type'|'responsible'|'active'>
//
// resolveOwnership is PURE: confidence + status are functions of which evidence
// rung fired, no I/O, no model (frozen-spec:302). The ladder as implemented
// (identity-resolver.ts:27-37), mapped onto the FROZEN evidence-type vocabulary in
// resolution-types.ts:76-85 (the Stage-1 contract this wave consumes EXACTLY):
//
//   R1  exactly one responsible:true recruiter owner               -> confirmed  (responsible_owner)
//   R2  application.recruiter_id matches a recruiter owner          -> confirmed  (owner_match [+ application_recruiter])
//   R3  exactly one active recruiter owner, no responsible flag     -> high       (single_owner)
//   R4  scorecard submitter_id that is a recruiter owner            -> inferred   (scorecard)
//   R5  first note/activity author that is a recruiter owner        -> inferred   (note_activity)
//   R6  actor who exited Application Review, a recruiter owner      -> inferred   (stage_exit_actor)
//   --  multiple recruiter owners, no disambiguator -> status 'ambiguous', value
//       NULL, ambiguous_candidate_ids = the contended owner set (NOT first-wins)
//   --  zero recruiter owners but owners returned   -> status 'unresolved'
//   --  the job_owners fetch itself was permission-walled -> 'permission_blocked'
//
// Canon (frozen-spec:280, handoff:90-100): an unresolved owner is a DEFECT carried
// as { status + evidence + next_retry }. The resolver NEVER emits the literal
// "Unknown"/"Unknown Agency"/"UNASSIGNED"; identity fields are null and status is
// non-'resolved'. These tests assert that contract directly.
// ---------------------------------------------------------------------------

// Sentinel strings the resolver must NEVER produce as an identity value
// (frozen-spec:280, handoff:25, :88-100). Asserted on every result.
const FORBIDDEN_IDENTITY_STRINGS = ["Unknown", "Unknown Agency", "UNASSIGNED"]

// A recruiter-type owner. `active` defaults true (the live /job_owners projection
// carries no `active` flag, so the resolver treats absent-as-active —
// greenhouse-evidence.ts:385, identity-resolver.ts:150). Make the bit explicit.
function owner(over: Partial<OwnerRow> & { user_id: number }): OwnerRow {
  return { type: "recruiter", responsible: false, active: true, ...over }
}

// Build a usersById map (id -> YtdGHUser) for the owners under test. The resolver
// reads `name` first (identity-resolver.ts:172); a null name exercises the
// "resolvable id, unresolvable name" path where the value must stay null, never a
// sentinel string.
function users(entries: Array<[number, string | null]>): Map<number, YtdGHUser> {
  return new Map(entries.map(([id, name]) => [id, { id, name }]))
}

// Minimal valid OwnershipEvidence; override per case. Optional proxy fields are
// left undefined so a plain ladder run never reads R4-R6 (identity-resolver.ts:118).
function evidence(over: Partial<OwnershipEvidence> = {}): OwnershipEvidence {
  return { jobOwners: [], usersById: new Map(), ...over }
}

// Every result, regardless of rung, must obey the structural defect contract: no
// sentinel identity strings anywhere, and identity fields null exactly when status
// is not 'resolved' (frozen-spec:280, resolution-types.ts:139-152).
function assertContractInvariants(r: OwnershipResolution): void {
  const names = [r.primary_recruiter_name, ...r.recruiter_names].filter(
    (n): n is string => n != null
  )
  for (const n of names) {
    expect(FORBIDDEN_IDENTITY_STRINGS).not.toContain(n)
  }
  if (r.status !== "resolved") {
    expect(r.primary_recruiter_id).toBeNull()
    expect(r.primary_recruiter_name).toBeNull()
  }
  // ambiguous_candidate_ids is populated ONLY on ambiguous (resolution-types.ts:149-151).
  if (r.status !== "ambiguous") {
    expect(r.ambiguous_candidate_ids).toEqual([])
  }
  // status/confidence stay inside their frozen domains.
  expect(["resolved", "ambiguous", "unresolved", "permission_blocked"]).toContain(
    r.status
  )
  expect(["confirmed", "high", "inferred", "unresolved"]).toContain(r.confidence)
}

describe("resolveOwnership — recruiter ownership ladder", () => {
  // R1 (the responsible_owner rung, grafted from C1): exactly one responsible:true
  // recruiter owner -> confirmed, with NO application recruiter and NO proxy call.
  // This is the live job 4962131004 shape (3 recruiter owners, one responsible:true
  // =5103434004) and is the rung that replaces the wrong recruiters[0] pick
  // (ytd-normalize.ts:366, identity-resolver.ts:311-324).
  test("single responsible:true owner among many resolves confirmed (responsible_owner), no app recruiter", () => {
    const result = resolveOwnership(
      evidence({
        applicationRecruiterId: null,
        jobOwners: [
          owner({ user_id: 4381126004 }),
          owner({ user_id: 5103434004, responsible: true }),
          owner({ user_id: 5200000004 }),
        ],
        usersById: users([
          [4381126004, "Avery First"],
          [5103434004, "Riley Responsible"],
          [5200000004, "Casey Third"],
        ]),
      })
    )

    expect(result.status).toBe("resolved")
    expect(result.confidence).toBe("confirmed")
    expect(result.primary_recruiter_id).toBe(5103434004)
    expect(result.primary_recruiter_name).toBe("Riley Responsible")
    expect(result.responsible_recruiter_id).toBe(5103434004)
    expect(result.evidence_types).toContain<OwnershipEvidenceType>(
      "responsible_owner"
    )
    // No app recruiter was supplied, so that tag must NOT be claimed.
    expect(result.evidence_types).not.toContain<OwnershipEvidenceType>(
      "application_recruiter"
    )
    // The owner that won was NOT simply jobOwners[0] (4381126004) — responsible
    // disambiguation beat positional first-wins.
    expect(result.primary_recruiter_id).not.toBe(4381126004)
    expect(result.ambiguous_candidate_ids).toEqual([])
    assertContractInvariants(result)
  })

  // R2 (owner_match): application.recruiter_id that is one of the recruiter owners
  // -> confirmed, when no responsible flag short-circuits at R1. This is the handoff's
  // "application recruiter id resolving to a job owner => confirmed" case. The
  // application_recruiter evidence tag is carried alongside owner_match
  // (resolution-types.ts:72, identity-resolver.ts:330-340).
  test("application recruiter id that is a job owner resolves confirmed (owner_match)", () => {
    const result = resolveOwnership(
      evidence({
        applicationRecruiterId: 5103434004,
        jobOwners: [
          owner({ user_id: 4381126004 }),
          owner({ user_id: 5103434004 }),
          owner({ user_id: 5200000004 }),
        ],
        usersById: users([
          [4381126004, "Avery First"],
          [5103434004, "Riley Owner"],
          [5200000004, "Casey Third"],
        ]),
      })
    )

    expect(result.status).toBe("resolved")
    expect(result.confidence).toBe("confirmed")
    expect(result.primary_recruiter_id).toBe(5103434004)
    expect(result.primary_recruiter_name).toBe("Riley Owner")
    expect(result.evidence_types).toContain<OwnershipEvidenceType>("owner_match")
    expect(result.evidence_types).toContain<OwnershipEvidenceType>(
      "application_recruiter"
    )
    // Despite three owners, R2 is a clean match: NOT ambiguous, no contended set, and
    // NOT positional first-owner-wins (4381126004 would be the first-wins answer).
    expect(result.primary_recruiter_id).not.toBe(4381126004)
    expect(result.ambiguous_candidate_ids).toEqual([])
    assertContractInvariants(result)
  })

  // R2 must NOT fire when the app recruiter is not actually one of the owners; the
  // resolver falls through rather than asserting a non-owner as primary
  // (identity-resolver.ts:330 — ownerIdSet.has guard).
  test("application recruiter id that is NOT an owner does not short-circuit to confirmed", () => {
    const result = resolveOwnership(
      evidence({
        applicationRecruiterId: 999, // not in the owner set
        jobOwners: [owner({ user_id: 4381126004 })],
        usersById: users([
          [4381126004, "Avery First"],
          [999, "Stray Recruiter"],
        ]),
      })
    )

    // Single active recruiter owner -> R3 high; the non-owner app recruiter is never
    // promoted to primary on the strength of recruiter_id alone.
    expect(result.status).toBe("resolved")
    expect(result.confidence).toBe("high")
    expect(result.primary_recruiter_id).toBe(4381126004)
    expect(result.primary_recruiter_id).not.toBe(999)
    expect(result.evidence_types).toContain<OwnershipEvidenceType>("single_owner")
    expect(result.evidence_types).not.toContain<OwnershipEvidenceType>(
      "owner_match"
    )
    assertContractInvariants(result)
  })

  // R3: exactly one active recruiter owner, no responsible flag -> high.
  test("single active recruiter owner with no responsible flag resolves high (single_owner)", () => {
    const result = resolveOwnership(
      evidence({
        jobOwners: [
          owner({ user_id: 4381126004 }),
          // non-recruiter owners must not count toward recruiter cardinality.
          owner({ user_id: 7000000004, type: "coordinator" }),
          owner({ user_id: 7000000005, type: "sourcer" }),
        ],
        usersById: users([
          [4381126004, "Solo Recruiter"],
          [7000000004, "Coordinator Person"],
          [7000000005, "Sourcer Person"],
        ]),
      })
    )

    expect(result.status).toBe("resolved")
    expect(result.confidence).toBe("high")
    expect(result.primary_recruiter_id).toBe(4381126004)
    expect(result.primary_recruiter_name).toBe("Solo Recruiter")
    expect(result.evidence_types).toContain<OwnershipEvidenceType>("single_owner")
    // recruiter_ids reflects ONLY recruiter-type owners (coordinator/sourcer excluded).
    expect(result.recruiter_ids).toEqual([4381126004])
    expect(result.ambiguous_candidate_ids).toEqual([])
    assertContractInvariants(result)
  })

  // An inactive (active:false) recruiter owner does not count: two recruiter owners
  // where one is inactive collapses to a single ACTIVE owner -> R3 high, not ambiguous
  // (identity-resolver.ts:150-152, :255-257).
  test("inactive recruiter owner is excluded; the lone active owner resolves high", () => {
    const result = resolveOwnership(
      evidence({
        jobOwners: [
          owner({ user_id: 4381126004, active: false }),
          owner({ user_id: 5103434004, active: true }),
        ],
        usersById: users([
          [4381126004, "Inactive Recruiter"],
          [5103434004, "Active Recruiter"],
        ]),
      })
    )

    expect(result.status).toBe("resolved")
    expect(result.confidence).toBe("high")
    expect(result.primary_recruiter_id).toBe(5103434004)
    expect(result.recruiter_ids).toEqual([5103434004])
    assertContractInvariants(result)
  })
})

describe("resolveOwnership — ambiguity is recorded, never arbitrated", () => {
  // THE HEADLINE AMBIGUITY CASE (frozen-spec:293, handoff:408, ytd-normalize.ts:366
  // bug): multiple recruiter owners, NO responsible flag, NO application recruiter, NO
  // proxy disambiguation -> 'ambiguous'. The assertion that matters: this is NOT
  // arbitrary first-owner-wins. value is NULL and the contended set is recorded.
  test("multiple recruiter owners with no app recruiter is ambiguous, NOT first-owner-wins", () => {
    const result = resolveOwnership(
      evidence({
        applicationRecruiterId: null,
        jobOwners: [
          owner({ user_id: 4381126004 }),
          owner({ user_id: 5103434004 }),
          owner({ user_id: 5200000004 }),
        ],
        usersById: users([
          [4381126004, "Avery First"],
          [5103434004, "Riley Second"],
          [5200000004, "Casey Third"],
        ]),
      })
    )

    expect(result.status).toBe("ambiguous")
    // The contract: NO winner is fabricated. This also fails a naive recruiters[0]
    // implementation, which would set primary to 4381126004.
    expect(result.primary_recruiter_id).toBeNull()
    expect(result.primary_recruiter_name).toBeNull()
    expect(result.primary_recruiter_id).not.toBe(4381126004)
    // The contended owners are recorded so the defect surface can show them
    // (resolution-types.ts:149-151, identity-resolver.ts:436).
    expect(result.ambiguous_candidate_ids).toEqual(
      expect.arrayContaining([4381126004, 5103434004, 5200000004])
    )
    expect(result.ambiguous_candidate_ids).toHaveLength(3)
    // ambiguous is a defect, not a confident resolution.
    expect(result.confidence).not.toBe("confirmed")
    expect(result.confidence).not.toBe("high")
    assertContractInvariants(result)
  })

  // R4 (scorecard) disambiguation: an otherwise-ambiguous owner set is resolved when a
  // scorecard submitter is exactly one of the owners -> inferred (frozen-spec:290,
  // identity-resolver.ts:355-377). Proves the resolver consumes the optional proxy
  // field when present and picks the evidenced owner, not the first.
  test("scorecard evidence resolves an otherwise-ambiguous owner to inferred (scorecard)", () => {
    const base = {
      applicationRecruiterId: null,
      jobOwners: [
        owner({ user_id: 4381126004 }),
        owner({ user_id: 5103434004 }),
      ],
      usersById: users([
        [4381126004, "Avery First"],
        [5103434004, "Riley Scorer"],
      ]),
    }

    // Control: without proxy evidence this set is ambiguous.
    const ambiguous = resolveOwnership(evidence(base))
    expect(ambiguous.status).toBe("ambiguous")

    // With a scorecard submitter that is one of the owners, that owner is picked.
    const resolved = resolveOwnership(
      evidence({ ...base, scorecardSubmitterIds: [5103434004] })
    )

    expect(resolved.status).toBe("resolved")
    expect(resolved.confidence).toBe("inferred")
    expect(resolved.primary_recruiter_id).toBe(5103434004)
    expect(resolved.primary_recruiter_name).toBe("Riley Scorer")
    expect(resolved.evidence_types).toContain<OwnershipEvidenceType>("scorecard")
    // It did NOT default to the first owner; proxy evidence chose the second.
    expect(resolved.primary_recruiter_id).not.toBe(4381126004)
    expect(resolved.ambiguous_candidate_ids).toEqual([])
    assertContractInvariants(resolved)
  })

  // R5 (note_activity): the first activity/note author who is a recruiter owner
  // resolves an otherwise-ambiguous owner -> inferred (frozen-spec:291,
  // identity-resolver.ts:379-399). No scorecard present, so this is the deciding rung.
  test("activity-actor evidence resolves an otherwise-ambiguous owner to inferred (note_activity)", () => {
    const resolved = resolveOwnership(
      evidence({
        applicationRecruiterId: null,
        jobOwners: [
          owner({ user_id: 4381126004 }),
          owner({ user_id: 5103434004 }),
        ],
        usersById: users([
          [4381126004, "Avery First"],
          [5103434004, "Riley Actor"],
        ]),
        // No scorecard evidence; the activity author is the only proxy signal.
        activityActorIds: [5103434004],
      })
    )

    expect(resolved.status).toBe("resolved")
    expect(resolved.confidence).toBe("inferred")
    expect(resolved.primary_recruiter_id).toBe(5103434004)
    expect(resolved.evidence_types).toContain<OwnershipEvidenceType>(
      "note_activity"
    )
    expect(resolved.primary_recruiter_id).not.toBe(4381126004)
    assertContractInvariants(resolved)
  })

  // Proxy evidence that points at a NON-owner must not resolve the ambiguity — the
  // actor is not on the job, so it cannot be the owner. Stays ambiguous
  // (identity-resolver.ts:358-360 ownerIdSet filter, :382-384).
  test("proxy evidence pointing at a non-owner does not resolve the ambiguity", () => {
    const result = resolveOwnership(
      evidence({
        applicationRecruiterId: null,
        jobOwners: [
          owner({ user_id: 4381126004 }),
          owner({ user_id: 5103434004 }),
        ],
        usersById: users([
          [4381126004, "Avery First"],
          [5103434004, "Riley Second"],
        ]),
        scorecardSubmitterIds: [888], // a submitter who is not a job owner
        activityActorIds: [888],
      })
    )

    expect(result.status).toBe("ambiguous")
    expect(result.primary_recruiter_id).toBeNull()
    expect(result.ambiguous_candidate_ids).toEqual(
      expect.arrayContaining([4381126004, 5103434004])
    )
    assertContractInvariants(result)
  })
})

describe("resolveOwnership — unresolved defect contract", () => {
  // Zero recruiter owners (API returned owners, none of recruiter type) ->
  // 'unresolved' (frozen-spec:294, identity-resolver.ts:300-309). The DEFECT contract:
  // NULL identity, a non-'resolved' status, and an evidence trail of WHAT was checked —
  // never the literal "Unknown"/"UNASSIGNED" (frozen-spec:280, handoff:267).
  test("zero recruiter owners yields status 'unresolved' with NULL identity and no sentinel string", () => {
    const result = resolveOwnership(
      evidence({
        applicationRecruiterId: null,
        jobOwners: [
          owner({ user_id: 7000000004, type: "coordinator" }),
          owner({ user_id: 7000000005, type: "sourcer" }),
        ],
        usersById: users([
          [7000000004, "Coordinator Person"],
          [7000000005, "Sourcer Person"],
        ]),
      })
    )

    expect(result.status).toBe("unresolved")
    expect(result.confidence).toBe("unresolved")
    expect(result.primary_recruiter_id).toBeNull()
    expect(result.primary_recruiter_name).toBeNull()
    expect(result.recruiter_ids).toEqual([])
    expect(result.recruiter_names).toEqual([])
    // ambiguous_candidate_ids is reserved for 'ambiguous'; unresolved leaves it empty.
    expect(result.ambiguous_candidate_ids).toEqual([])
    // The literal sentinels are NEVER the value — the whole point of the layer.
    expect(result.primary_recruiter_name).not.toBe("Unknown")
    expect(result.primary_recruiter_name).not.toBe("UNASSIGNED")
    assertContractInvariants(result)
  })

  // No owners at all (empty list) is still 'unresolved' with a recorded evidence trail.
  // evidence_types is a TYPED OwnershipEvidenceType[] (resolution-types.ts:147) feeding
  // identity_resolution_attempts.evidence_sources_checked — it records what was checked
  // and can NEVER contain the string "Unknown"/"UNASSIGNED".
  test("no owners at all yields 'unresolved' and records the evidence checked, never 'Unknown'", () => {
    const result = resolveOwnership(
      evidence({ applicationRecruiterId: null, jobOwners: [], usersById: new Map() })
    )

    expect(result.status).toBe("unresolved")
    expect(result.primary_recruiter_id).toBeNull()
    expect(result.primary_recruiter_name).toBeNull()
    expect(Array.isArray(result.evidence_types)).toBe(true)
    expect(result.evidence_types as string[]).not.toContain("Unknown")
    expect(result.evidence_types as string[]).not.toContain("UNASSIGNED")
    // evidence_detail is the self-describing defect payload (what was checked).
    expect(result.evidence_detail).not.toBeNull()
    assertContractInvariants(result)
  })

  // R1/R2 ABSENT (no recruiter_id): applicationRecruiterId omitted/null must not crash;
  // the resolver skips the owner-match rung and falls through the rest of the ladder
  // (frozen-spec:287, identity-resolver.ts:39-41, :268-272). list_applications omits
  // recruiter_id, so this is the common live shape — it must degrade gracefully.
  test("absent application recruiter id does not crash; falls through the ladder", () => {
    // Omitted app recruiter + a single recruiter owner -> R3 high (owner-match skipped).
    expect(() =>
      resolveOwnership(
        evidence({
          jobOwners: [owner({ user_id: 4381126004 })],
          usersById: users([[4381126004, "Solo Recruiter"]]),
        })
      )
    ).not.toThrow()

    const result = resolveOwnership(
      evidence({
        jobOwners: [owner({ user_id: 4381126004 })],
        usersById: users([[4381126004, "Solo Recruiter"]]),
      })
    )
    expect(result.status).toBe("resolved")
    expect(result.confidence).toBe("high")
    expect(result.evidence_types).toContain<OwnershipEvidenceType>("single_owner")
    // The owner-match tag is NOT claimed when no app recruiter was present.
    expect(result.evidence_types).not.toContain<OwnershipEvidenceType>(
      "owner_match"
    )
    expect(result.evidence_types).not.toContain<OwnershipEvidenceType>(
      "application_recruiter"
    )
    assertContractInvariants(result)

    // Explicit null app recruiter + an empty owner set -> 'unresolved', still no throw.
    const unresolved = resolveOwnership(
      evidence({ applicationRecruiterId: null, jobOwners: [], usersById: new Map() })
    )
    expect(unresolved.status).toBe("unresolved")
    assertContractInvariants(unresolved)

    // Explicit null app recruiter alongside multiple owners -> ambiguous (the absence
    // of recruiter_id is exactly why R2 can't disambiguate); still no throw.
    const ambiguous = resolveOwnership(
      evidence({
        applicationRecruiterId: null,
        jobOwners: [
          owner({ user_id: 4381126004 }),
          owner({ user_id: 5103434004 }),
        ],
        usersById: users([
          [4381126004, "Avery First"],
          [5103434004, "Riley Second"],
        ]),
      })
    )
    expect(ambiguous.status).toBe("ambiguous")
    assertContractInvariants(ambiguous)
  })

  // The job_owners fetch itself was permission-walled and no owner evidence is present
  // -> 'permission_blocked' (terminal-but-visible; NOT retried on normal backoff —
  // frozen-spec:294, identity-resolver.ts:287-296). Distinct status from 'unresolved'.
  test("permission-walled owner fetch yields 'permission_blocked', not a sentinel value", () => {
    const result = resolveOwnership(
      evidence({
        jobOwners: [],
        usersById: new Map(),
        jobOwnersPermissionBlocked: true,
      })
    )

    expect(result.status).toBe("permission_blocked")
    expect(result.confidence).toBe("unresolved")
    expect(result.primary_recruiter_id).toBeNull()
    expect(result.primary_recruiter_name).toBeNull()
    expect(result.primary_recruiter_name).not.toBe("Unknown")
    assertContractInvariants(result)
  })

  // A user whose id resolves to a null/missing name is still a valid owner; the
  // resolver keeps the id and carries a null name — NOT substitute "Unknown"
  // (identity-resolver.ts:169-176 nameOf returns null, never a sentinel).
  test("owner with an unresolvable name keeps the id and a null name, never 'Unknown'", () => {
    const result = resolveOwnership(
      evidence({
        jobOwners: [owner({ user_id: 4381126004, responsible: true })],
        // name resolves to null (user lookup returned no display name).
        usersById: users([[4381126004, null]]),
      })
    )

    expect(result.status).toBe("resolved")
    expect(result.primary_recruiter_id).toBe(4381126004)
    // The name is null, never the sentinel string.
    expect(result.primary_recruiter_name).toBeNull()
    expect(result.primary_recruiter_name).not.toBe("Unknown")
    // recruiter_names drops unresolved names rather than padding with placeholders
    // (identity-resolver.ts:180-187).
    expect(result.recruiter_names).toEqual([])
    assertContractInvariants(result)
  })
})
