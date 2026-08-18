/**
 * Recruiter-ownership resolver — the proxy evidence ladder as a deterministic,
 * unit-testable function (frozen-spec:284-302, build-program S3 :485).
 *
 * PURE DECISION LOGIC. This module decides confidence + status + winner from
 * evidence; it performs NO network I/O of its own and NO DB writes (the caller —
 * identity-enrichment — persists). Greenhouse access is supplied as injected
 * fetchers (OwnershipFetchers), mirroring the YtdConflictFetchers DI pattern at
 * lib/ytd-conflicts.ts:24-27 so the async entrypoint unit-tests with plain mocks.
 *
 * Two entrypoints:
 *   resolveOwnership(ev)            — synchronous, over already-fetched evidence
 *                                     (the PASS-1 write-time hot path; rungs R1-R3
 *                                     from owners + app fields, R4-R5 only when the
 *                                     optional proxy evidence is already in hand).
 *   resolveOwnershipWithFetchers()  — async, pulls the lower rungs on demand via the
 *                                     injected fetchers (the PASS-2 reconcile path).
 *   upgradeOwnership(prior, ev)     — monotonic merge of fresh evidence onto a prior
 *                                     resolution; NEVER downgrades confidence.
 *
 * Canon (build-program:41, frozen-spec:280, :302): unresolved ownership is a
 * data-quality DEFECT carried as { status + evidence + (caller's) next_retry } — it
 * is status==='unresolved'/'ambiguous'/'permission_blocked' with NULL identity, NEVER
 * the literal "Unknown"/"UNASSIGNED". confidence + status are pure functions of which
 * rung fired (NO model in the loop).
 *
 * The ladder, confidence-ordered, FIRST match wins, MONOTONIC:
 *   R1 responsible:true recruiter owner (exactly one)            -> confirmed  (responsible_owner)
 *   R2 application.recruiter_id matches a recruiter owner        -> confirmed  (owner_match) [+ application_recruiter]
 *      (covers single-owner-match AND multi-owner-with-one-match)
 *   R3 exactly one active recruiter owner, no responsible flag   -> high       (single_owner)
 *   R4 scorecard submitter_id that is a recruiter owner          -> inferred   (scorecard)
 *   R5 first note/activity author that is a recruiter owner      -> inferred   (note_activity)
 *   R6 actor who exited Application Review, a recruiter owner    -> inferred   (stage_exit_actor)
 *   else -> unresolved (zero recruiter owners but API returned owners)
 *        -> ambiguous  (multiple recruiter owners, no disambiguator; ambiguous_candidate_ids set)
 *        -> permission_blocked (the job_owners fetch itself was permission-walled)
 *
 * R1 CAVEAT (verified, frozen-spec:287): list_applications does NOT return recruiter_id
 * and YtdGHApplication.recruiter_id is optional. A null/absent applicationRecruiterId
 * simply skips R2 — the resolver never crashes on its absence and falls through to R3+.
 */

import type {
  GHJobOwnerWithResponsible,
  GHScorecardEvidence,
  StageChangeActorResult,
} from "./greenhouse-evidence"
import type {
  OwnershipEvidenceType,
  OwnershipResolution,
  ResolutionConfidence,
  ResolutionStatus,
} from "./resolution-types"
import type { YtdGHUser } from "./ytd-types"

// ---------------------------------------------------------------------------
// Reconcile gate. Exported per task contract: the PASS-2 reconcile cron treats a
// resolution AT OR ABOVE this confidence as "done" (locked, not re-queued) and a
// resolution BELOW it as still-mutable below-bar work. 'high' means single_owner
// (R3) clears the bar; inferred/unresolved stay in the reconcile queue
// (frozen-spec:282, locked default: reconcileConfidenceFloor='high').
// ---------------------------------------------------------------------------

export const reconcileConfidenceFloor: ResolutionConfidence = "high"

// Confidence rank for monotonic upgrades. confirmed > high > inferred > unresolved
// (frozen-spec:441 CONFIDENCE_RANK; mirrors the SQL CHECK domain order in
// resolution-types.RESOLUTION_CONFIDENCE_VALUES).
const CONFIDENCE_RANK: Record<ResolutionConfidence, number> = {
  unresolved: 0,
  inferred: 1,
  high: 2,
  confirmed: 3,
}

/** True iff confidence `a` is strictly higher than `b` on CONFIDENCE_RANK. */
function isHigher(a: ResolutionConfidence, b: ResolutionConfidence): boolean {
  return CONFIDENCE_RANK[a] > CONFIDENCE_RANK[b]
}

// ---------------------------------------------------------------------------
// Injected fetchers (DI). Mirrors YtdConflictFetchers (ytd-conflicts.ts:24-27):
// a narrow interface of the exact GH reads the lower rungs need, so the async
// resolver unit-tests against in-memory mocks with zero network. Signatures match
// the greenhouse-evidence fetchers 1:1 (listScorecardsForApplications,
// getStageChangeActors return shapes; listNotesForCandidates' permission flag is
// folded into the stage-actor result), so production wiring is a direct pass-through.
// ---------------------------------------------------------------------------

export interface OwnershipFetchers {
  /** R4 evidence. Scorecards for the application(s); submitter_id is the scored actor. */
  fetchScorecards(applicationIds: number[]): Promise<GHScorecardEvidence[]>
  /** R5+R6 evidence. Stage-exit-actor correlation (frozen-spec:291): activityAuthors
   *  feeds R5 (first author), actorUserId feeds R6 (who exited Application Review).
   *  permissionBlocked on the result folds the tail rungs to permission_blocked. */
  fetchStageChangeActors(
    apps: Array<{ applicationId: number; candidateId: number }>
  ): Promise<StageChangeActorResult[]>
}

// ---------------------------------------------------------------------------
// Evidence inputs
// ---------------------------------------------------------------------------

/** A recruiter owner already filtered to type==='recruiter' (or the raw owner row,
 *  which the resolver filters itself). `active` absent === active (the live
 *  /job_owners projection has no active flag — greenhouse-evidence.ts:385). */
export type OwnerRow = Pick<
  GHJobOwnerWithResponsible,
  "user_id" | "type" | "responsible" | "active"
>

/** Everything the synchronous resolver needs. Owners + users come from data the
 *  sweep/extract already fetched (PASS 1). The optional proxy fields are present
 *  only on the reconcile path (PASS 2) — when absent, the corresponding rung is
 *  skipped, never failed. */
export interface OwnershipEvidence {
  /** The job's owners (all types). The resolver filters to type==='recruiter'. */
  jobOwners: OwnerRow[]
  /** user_id -> user record, for surfacing names. May omit ids; a missing name -> null. */
  usersById: Map<number, YtdGHUser>
  /** application.recruiter_id, if the source projection carried it. Optional &
   *  null-safe: list_applications omits it (frozen-spec:287), so R2 skips on absence. */
  applicationRecruiterId?: number | null
  /** R4: scorecard submitter user_ids observed for the application(s). */
  scorecardSubmitterIds?: number[]
  /** R5: activity/note author user_ids who first actioned the candidate. Order is
   *  the caller's "first actioned" order; the resolver picks the first that is an owner. */
  activityActorIds?: number[]
  /** R6: the actor who exited Application Review (best-effort correlation hint). */
  stageExitActorId?: number | null
  /** True when the job_owners fetch itself was permission-walled (frozen-spec:294).
   *  Forces status='permission_blocked' when no usable owner evidence is present. */
  jobOwnersPermissionBlocked?: boolean
  /** True when a tail-evidence fetch (R5/R6 activity) hit a 403 scope wall. Recorded
   *  in evidence_detail; does NOT by itself force permission_blocked (owner-level
   *  evidence may still resolve), but is surfaced so the defect carries provenance. */
  proxyPermissionBlocked?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RECRUITER_TYPE = "recruiter"

/** An owner counts as active unless explicitly active===false. The live projection
 *  omits `active` entirely (greenhouse-evidence.ts:385), so absent === active. */
function isActiveOwner(o: OwnerRow): boolean {
  return o.active !== false
}

/** Unique, ascending, finite-only — same semantics as ytd-normalize.uniqSortedNumbers
 *  / greenhouse-evidence.uniqSortedIds, kept local to keep this module dependency-light. */
function uniqSorted(
  values: Array<number | null | undefined> | null | undefined
): number[] {
  const seen = new Set<number>()
  for (const v of values ?? []) {
    if (typeof v === "number" && Number.isFinite(v)) seen.add(v)
  }
  return [...seen].sort((a, b) => a - b)
}

/** Resolve a user_id to a display name from the injected map. Mirrors
 *  ytd-normalize.userName shaping: explicit `name`, else "first last", else null.
 *  A missing user, or a user with no name parts, yields null — never a sentinel. */
function nameOf(userId: number, usersById: Map<number, YtdGHUser>): string | null {
  const user = usersById.get(userId)
  if (!user) return null
  const fromName = user.name?.trim()
  if (fromName) return fromName
  const composed = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim()
  return composed || null
}

/** Names for an ordered id list, dropping nulls (a name we couldn't resolve is
 *  simply absent from recruiter_names, not a placeholder). Aligned to the id order. */
function namesOf(ids: number[], usersById: Map<number, YtdGHUser>): string[] {
  const out: string[] = []
  for (const id of ids) {
    const n = nameOf(id, usersById)
    if (n) out.push(n)
  }
  return out
}

// ---------------------------------------------------------------------------
// Result constructors — every resolution is one of these shapes. All identity
// fields are NULL whenever status !== 'resolved' (the contract: resolution-types
// OwnershipResolution doc, frozen-spec:280). evidence_detail always carries what
// was checked, so an unresolved defect is self-describing.
// ---------------------------------------------------------------------------

function resolvedTo(input: {
  recruiterOwnerIds: number[]
  primaryId: number
  responsibleId: number | null
  confidence: Exclude<ResolutionConfidence, "unresolved">
  evidenceTypes: OwnershipEvidenceType[]
  evidenceDetail: Record<string, unknown>
  usersById: Map<number, YtdGHUser>
}): OwnershipResolution {
  return {
    primary_recruiter_id: input.primaryId,
    primary_recruiter_name: nameOf(input.primaryId, input.usersById),
    recruiter_ids: input.recruiterOwnerIds,
    recruiter_names: namesOf(input.recruiterOwnerIds, input.usersById),
    responsible_recruiter_id: input.responsibleId,
    confidence: input.confidence,
    status: "resolved",
    evidence_types: input.evidenceTypes,
    evidence_detail: input.evidenceDetail,
    ambiguous_candidate_ids: [],
  }
}

function unresolvedTo(input: {
  recruiterOwnerIds: number[]
  responsibleId: number | null
  status: Exclude<ResolutionStatus, "resolved">
  evidenceTypes: OwnershipEvidenceType[]
  evidenceDetail: Record<string, unknown>
  ambiguousCandidateIds?: number[]
  usersById: Map<number, YtdGHUser>
}): OwnershipResolution {
  return {
    primary_recruiter_id: null,
    primary_recruiter_name: null,
    // Carry the contended owner set even when unresolved — names included so the UI
    // can render "owner not resolved; candidates were X, Y" without a re-fetch. This
    // is provenance, not an assertion of ownership.
    recruiter_ids: input.recruiterOwnerIds,
    recruiter_names: namesOf(input.recruiterOwnerIds, input.usersById),
    responsible_recruiter_id: input.responsibleId,
    confidence: "unresolved",
    status: input.status,
    evidence_types: input.evidenceTypes,
    evidence_detail: input.evidenceDetail,
    ambiguous_candidate_ids: input.ambiguousCandidateIds ?? [],
  }
}

// ---------------------------------------------------------------------------
// resolveOwnership — synchronous ladder over already-fetched evidence.
// FIRST match wins. Deterministic: identical evidence -> identical resolution.
// ---------------------------------------------------------------------------

export function resolveOwnership(ev: OwnershipEvidence): OwnershipResolution {
  const usersById = ev.usersById ?? new Map<number, YtdGHUser>()

  // Filter to active recruiter owners; preserve a stable (ascending) id order so the
  // recruiter_ids array and any "first owner" tie-breaks are deterministic.
  const recruiterOwners = (ev.jobOwners ?? []).filter(
    (o) => o.type === RECRUITER_TYPE && isActiveOwner(o)
  )
  const recruiterOwnerIds = uniqSorted(recruiterOwners.map((o) => o.user_id))
  const ownerIdSet = new Set(recruiterOwnerIds)

  // responsible:true recruiter owners (R1 disambiguator). Captured up front so it is
  // recorded on the resolution even when a higher/other rung fires.
  const responsibleIds = uniqSorted(
    recruiterOwners.filter((o) => o.responsible === true).map((o) => o.user_id)
  )
  const responsibleId = responsibleIds.length === 1 ? responsibleIds[0] : null

  const appRecruiterId =
    typeof ev.applicationRecruiterId === "number" &&
    Number.isFinite(ev.applicationRecruiterId)
      ? ev.applicationRecruiterId
      : null

  // Base evidence_detail every branch extends — records WHAT was checked, so an
  // unresolved row is a self-describing defect (frozen-spec:280, :302).
  const checked: Record<string, unknown> = {
    recruiter_owner_ids: recruiterOwnerIds,
    responsible_owner_ids: responsibleIds,
    application_recruiter_id: appRecruiterId,
    owners_returned: (ev.jobOwners ?? []).length,
  }
  if (ev.proxyPermissionBlocked) checked.proxy_permission_blocked = true

  // --- Permission wall on the owner fetch itself: terminal-but-visible, no identity.
  // Checked before the empty-owner case so a 403 is distinguished from "API returned
  // zero owners" (frozen-spec:294 — permission_blocked is NOT retried on normal backoff).
  if (ev.jobOwnersPermissionBlocked && recruiterOwnerIds.length === 0) {
    return unresolvedTo({
      recruiterOwnerIds: [],
      responsibleId: null,
      status: "permission_blocked",
      evidenceTypes: [],
      evidenceDetail: { ...checked, reason: "job_owners_permission_blocked" },
      usersById,
    })
  }

  // --- Zero recruiter owners: unresolved defect (frozen-spec:294). Distinct from the
  // 403 case above; here the API answered and there simply is no recruiter owner.
  if (recruiterOwnerIds.length === 0) {
    return unresolvedTo({
      recruiterOwnerIds: [],
      responsibleId: null,
      status: "unresolved",
      evidenceTypes: [],
      evidenceDetail: { ...checked, reason: "no_recruiter_owners" },
      usersById,
    })
  }

  // === R1: exactly one responsible:true recruiter owner -> confirmed.
  // The most common multi-owner case; resolves with zero extra calls and replaces the
  // legacy recruiters[0] pick (frozen-spec:288, ytd-normalize.ts:366 bug).
  if (responsibleId !== null) {
    return resolvedTo({
      recruiterOwnerIds,
      primaryId: responsibleId,
      responsibleId,
      confidence: "confirmed",
      evidenceTypes: ["responsible_owner"],
      evidenceDetail: { ...checked, matched_rung: "R1_responsible_owner" },
      usersById,
    })
  }

  // === R2: application.recruiter_id matches a recruiter owner -> confirmed.
  // Covers BOTH "single owner == app.recruiter_id" and "multiple owners, one ==
  // app.recruiter_id" (task ladder rungs 2 and 4 collapse here — the disambiguator is
  // identical). Skipped, never failed, when app.recruiter_id is absent (frozen-spec:287).
  if (appRecruiterId !== null && ownerIdSet.has(appRecruiterId)) {
    return resolvedTo({
      recruiterOwnerIds,
      primaryId: appRecruiterId,
      responsibleId,
      confidence: "confirmed",
      evidenceTypes: ["owner_match", "application_recruiter"],
      evidenceDetail: { ...checked, matched_rung: "R2_owner_match" },
      usersById,
    })
  }

  // === R3: exactly one active recruiter owner, no responsible flag -> high.
  if (recruiterOwnerIds.length === 1) {
    return resolvedTo({
      recruiterOwnerIds,
      primaryId: recruiterOwnerIds[0],
      responsibleId,
      confidence: "high",
      evidenceTypes: ["single_owner"],
      evidenceDetail: { ...checked, matched_rung: "R3_single_owner" },
      usersById,
    })
  }

  // === R4: a scorecard submitter that is a recruiter owner -> inferred.
  // Reconcile-only evidence; present only when the caller supplied it. Determinism on
  // multiple matching submitters: pick the lowest user_id (uniqSorted order).
  const scorecardMatches = uniqSorted(ev.scorecardSubmitterIds).filter((id) =>
    ownerIdSet.has(id)
  )
  if (scorecardMatches.length >= 1) {
    const primaryId = scorecardMatches[0]
    return resolvedTo({
      recruiterOwnerIds,
      primaryId,
      responsibleId,
      confidence: "inferred",
      evidenceTypes: ["scorecard"],
      evidenceDetail: {
        ...checked,
        matched_rung: "R4_scorecard",
        scorecard_submitter_id: primaryId,
        scorecard_submitter_matches: scorecardMatches,
      },
      usersById,
    })
  }

  // === R5: the FIRST activity/note author that is a recruiter owner -> inferred.
  // Order-sensitive: activityActorIds is the caller's first-actioned order, so the
  // first owner-matching author wins (NOT lowest id — "first actioned" is the signal).
  const activityActor = (ev.activityActorIds ?? []).find(
    (id) => typeof id === "number" && Number.isFinite(id) && ownerIdSet.has(id)
  )
  if (typeof activityActor === "number") {
    return resolvedTo({
      recruiterOwnerIds,
      primaryId: activityActor,
      responsibleId,
      confidence: "inferred",
      evidenceTypes: ["note_activity"],
      evidenceDetail: {
        ...checked,
        matched_rung: "R5_note_activity",
        activity_actor_id: activityActor,
      },
      usersById,
    })
  }

  // === R6: the actor who exited Application Review, if a recruiter owner -> inferred.
  // Best-effort correlation (frozen-spec:291): /application_stages has no actor, so this
  // is the activity-feed author nearest the stage exit. Only clears the rung when that
  // actor is itself an owner.
  const stageActor =
    typeof ev.stageExitActorId === "number" &&
    Number.isFinite(ev.stageExitActorId) &&
    ownerIdSet.has(ev.stageExitActorId)
      ? ev.stageExitActorId
      : null
  if (stageActor !== null) {
    return resolvedTo({
      recruiterOwnerIds,
      primaryId: stageActor,
      responsibleId,
      confidence: "inferred",
      evidenceTypes: ["stage_exit_actor"],
      evidenceDetail: {
        ...checked,
        matched_rung: "R6_stage_exit_actor",
        stage_exit_actor_id: stageActor,
      },
      usersById,
    })
  }

  // === Fallthrough: multiple recruiter owners, no disambiguator -> ambiguous.
  // value NULL, ambiguous_candidate_ids = the contended owner set (frozen-spec:293).
  // This is the fix for the legacy first-owner-wins bug.
  return unresolvedTo({
    recruiterOwnerIds,
    responsibleId,
    status: "ambiguous",
    evidenceTypes: [],
    evidenceDetail: { ...checked, reason: "multiple_owners_no_disambiguator" },
    ambiguousCandidateIds: recruiterOwnerIds,
    usersById,
  })
}

// ---------------------------------------------------------------------------
// resolveOwnershipWithFetchers — async reconcile entrypoint. Pulls the R4-R6
// proxy evidence on demand via the injected fetchers, then runs the same pure
// ladder. Short-circuits: if the owner-level rungs (R1-R3) already resolve, it
// resolves WITHOUT touching the fetchers (cheap path preserved).
// ---------------------------------------------------------------------------

export interface OwnershipResolutionRequest {
  applicationId: number
  candidateId: number
  jobOwners: OwnerRow[]
  usersById: Map<number, YtdGHUser>
  applicationRecruiterId?: number | null
  jobOwnersPermissionBlocked?: boolean
}

export async function resolveOwnershipWithFetchers(
  req: OwnershipResolutionRequest,
  fetchers: OwnershipFetchers
): Promise<OwnershipResolution> {
  // First pass over owner-level evidence only — no proxy fields. If R1-R3 fire (or a
  // permission/empty-owner terminal), we are done and never call the fetchers.
  const ownerOnly = resolveOwnership({
    jobOwners: req.jobOwners,
    usersById: req.usersById,
    applicationRecruiterId: req.applicationRecruiterId,
    jobOwnersPermissionBlocked: req.jobOwnersPermissionBlocked,
  })
  // confirmed/high are owner-level outcomes; resolved means a top rung already fired.
  // permission_blocked / unresolved-with-zero-owners are terminal (no proxy can help —
  // proxy rungs require an owner set to match against).
  if (
    ownerOnly.status === "resolved" ||
    ownerOnly.status === "permission_blocked" ||
    (ownerOnly.status === "unresolved" && ownerOnly.recruiter_ids.length === 0)
  ) {
    return ownerOnly
  }

  // We have >=2 owners with no disambiguator (ambiguous). Pull proxy evidence to try
  // to break the tie. Failures here degrade to "no proxy evidence", never throw —
  // the resolver still returns the ambiguous defect (mirrors greenhouse-evidence's
  // permission-aware shaping; the caller persists the attempt).
  let scorecardSubmitterIds: number[] = []
  let activityActorIds: number[] = []
  let stageExitActorId: number | null = null
  let proxyPermissionBlocked = false

  try {
    const scorecards = await fetchers.fetchScorecards([req.applicationId])
    scorecardSubmitterIds = uniqSorted(
      scorecards.map((s) => s.submitter_id ?? null)
    )
  } catch {
    proxyPermissionBlocked = true
  }

  try {
    const actors = await fetchers.fetchStageChangeActors([
      { applicationId: req.applicationId, candidateId: req.candidateId },
    ])
    const forApp = actors.find((a) => a.applicationId === req.applicationId)
    if (forApp) {
      if (forApp.permissionBlocked) proxyPermissionBlocked = true
      // R5 order = nearest-by-time first (StageChangeActorResult.activityAuthors is
      // sorted nearest-first), so the closest authored activity is the "first actioned".
      activityActorIds = forApp.activityAuthors.map((a) => a.userId)
      stageExitActorId = forApp.actorUserId
    }
  } catch {
    proxyPermissionBlocked = true
  }

  // Re-run the pure ladder WITH proxy evidence. R1-R3 fall through (already known to
  // not fire from the owner-only pass), so R4-R6 decide; if none match, the ambiguous
  // defect stands, now annotated with the proxy provenance.
  return resolveOwnership({
    jobOwners: req.jobOwners,
    usersById: req.usersById,
    applicationRecruiterId: req.applicationRecruiterId,
    jobOwnersPermissionBlocked: req.jobOwnersPermissionBlocked,
    scorecardSubmitterIds,
    activityActorIds,
    stageExitActorId,
    proxyPermissionBlocked,
  })
}

// ---------------------------------------------------------------------------
// upgradeOwnership — monotonic merge of fresh evidence onto a prior resolution.
// The reconcile cron's UPGRADE step (frozen-spec:282, :441): re-resolve with newly
// available proxy evidence and adopt the result ONLY when it is strictly higher
// confidence than the prior. NEVER downgrades; an equal-confidence re-resolve keeps
// the prior (idempotent, so a re-run does not churn snapshots).
// ---------------------------------------------------------------------------

export function upgradeOwnership(
  prior: OwnershipResolution,
  ev: OwnershipEvidence
): OwnershipResolution {
  const next = resolveOwnership(ev)

  // Strictly higher confidence -> adopt the fresh resolution, but preserve the prior's
  // evidence trail so the upgrade is auditable (both rungs visible, deduped).
  if (isHigher(next.confidence, prior.confidence)) {
    const mergedTypes = Array.from(
      new Set<OwnershipEvidenceType>([
        ...prior.evidence_types,
        ...next.evidence_types,
      ])
    )
    return {
      ...next,
      evidence_types: mergedTypes,
      evidence_detail: {
        ...(prior.evidence_detail ?? {}),
        ...(next.evidence_detail ?? {}),
        upgraded_from_confidence: prior.confidence,
      },
    }
  }

  // No upgrade: keep the prior unchanged (monotonic — never downgrade, never churn on
  // equal confidence). The caller appends a new snapshot only when value/confidence
  // actually changed, so returning the prior verbatim is the no-op signal.
  return prior
}
