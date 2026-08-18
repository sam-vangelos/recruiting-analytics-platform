/**
 * Greenhouse evidence retrieval — the proxy-ladder evidence sources the identity
 * resolvers consume (frozen-spec:284-302, build-program S2 :53).
 *
 * This module is PURE TRANSPORT + SHAPING. It WRAPS lib/greenhouse-client.ts
 * (greenhouseGetAll: token mgmt, cursor pagination, 429 retry, sanitized errors)
 * and exposes typed fetchers for the lower rungs of the recruiter-ownership ladder:
 *
 *   - listScorecardsForApplications  (R4: scorecard submitter_id)
 *   - listNotesForCandidates         (R5: activity/note author who actioned)
 *   - getStageChangeActors           (folds into R5: who exited Application Review)
 *   - listJobOwners                  (R1-R3: responsible / single / matched owner)
 *   - listUsers                      (resolve an owner/author/submitter id -> a name)
 *
 * It contains NO resolution logic. It does not decide confidence, pick a winner,
 * or write the literal "Unknown"/"Unknown Agency"/"UNASSIGNED" — that is the job of
 * identity-resolver / agency-resolver / identity-enrichment. Unresolved actors come
 * back here as `null` user ids carried alongside evidence (frozen-spec:280, :302).
 *
 * Live field shapes were confirmed against the Harvest v3 API (not the MCP) before
 * typing; see the per-fetcher notes. The operational projections this code depends on:
 *   /scorecards         -> { id, application_id, interviewer_id, submitter_id, status, submitted_at, overall_rating }
 *   /notes              -> { id, type, visibility, user_id, created_at, application_id, candidate_id, has_body }
 *   /application_stages -> { id, application_id, job_interview_stage_id, entered_at, exited_at, days_in_stage, current, ... }
 *   /job_owners         -> { id, user_id, type, responsible, created_at, updated_at, job_id }
 *   /users              -> { id, first_name, last_name, name, primary_email, deactivated, ... }
 *
 * CRITICAL (frozen-spec:291, identity-handoff:252): /application_stages carries NO
 * actor field. There is no "who moved this candidate" on the stage record. The
 * stage-exit-actor rung therefore CANNOT be read off a stage; it is derived by
 * correlating the Application Review exit timestamp with the candidate's activity-feed
 * authors (/notes type=ACTIVITY). getStageChangeActors returns that correlation as a
 * best-effort INFERENCE the resolver may use — it never asserts an actor the API gave us.
 */

import { greenhouseGetAll } from "./greenhouse-client"
import type { GHCandidate, GHJob } from "./sweep-types"
import type { YtdGHApplicationStage, YtdGHReferrer, YtdGHUser } from "./ytd-types"

// ---------------------------------------------------------------------------
// Batching — mirror lib/ytd-extract.ts:53-77 exactly.
//   * id-filter batch size 50: the cap on how many ids pack into one
//     `application_ids=...`/`candidate_ids=...` query (URL length + GH filter limit).
//   * per_page 500: page size; greenhouseGetAll follows the Link-header cursor to
//     exhaustion per batch. These two are independent (frozen-spec / client.ts:331-346).
// ---------------------------------------------------------------------------

const ID_BATCH_SIZE = 50
const PER_PAGE = 500

/** Unique, ascending, null/undefined-stripped — matches ytd-normalize.uniqSortedNumbers
 *  semantics so an id list dedupes identically on either path (kept local: no import dep). */
function uniqSortedIds(values: Array<number | null | undefined>): number[] {
  const seen = new Set<number>()
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) seen.add(v)
  }
  return [...seen].sort((a, b) => a - b)
}

function chunk<T>(values: T[], size = ID_BATCH_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

/** Fetch an id-filtered list endpoint in <=50-id batches, paginating each batch to
 *  exhaustion. Empty/blank id set short-circuits to [] without a network call. */
async function fetchByIds<T>(
  path: string,
  idsParam: string,
  ids: Array<number | null | undefined>,
  extra?: Record<string, string | number | boolean | undefined>
): Promise<T[]> {
  const clean = uniqSortedIds(ids)
  if (clean.length === 0) return []
  const out: T[] = []
  for (const batch of chunk(clean)) {
    out.push(
      ...(await greenhouseGetAll<T>(path, {
        ...extra,
        [idsParam]: batch.join(","),
        per_page: PER_PAGE,
      }))
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Permission-aware execution — the tail-evidence rungs (R5 activity) degrade to
// [] + permission_blocked on 403, NEVER throw (frozen-spec:291, :461, :486).
// The client surfaces a forbidden scope as `Error: Greenhouse API error: 403 ...`
// AFTER it has already exhausted its own token-refresh retry on 401, so a 401/403
// reaching here is a genuine scope wall, not a transient token blip.
// ---------------------------------------------------------------------------

const PERMISSION_STATUS_RE = /Greenhouse API error:\s*(401|403)\b/

function isPermissionError(err: unknown): boolean {
  return err instanceof Error && PERMISSION_STATUS_RE.test(err.message)
}

/** Run a fetch, classifying a permission wall as a visible defect rather than a throw.
 *  Returns the data on success, [] + permissionBlocked=true on 401/403. Any other error
 *  (429-exhausted, network, 5xx) still propagates — those are not "no access", they are
 *  ret riable failures the caller's own try/catch should see. */
async function runPermissionAware<T>(
  label: string,
  fn: () => Promise<T[]>
): Promise<{ data: T[]; permissionBlocked: boolean }> {
  try {
    return { data: await fn(), permissionBlocked: false }
  } catch (err) {
    if (isPermissionError(err)) {
      console.warn(
        `[greenhouse-evidence] permission_blocked on ${label}: ${(err as Error).message}`
      )
      return { data: [], permissionBlocked: true }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Scorecards — R4 evidence: a scorecard submitter_id that is one of the owners
// -> inferred (frozen-spec:290). Operational projection only; no answers/notes
// (those need detail_profile=answers + a reason + allowlisted on_behalf_of_user_id,
// which this analytics path never requests).
// ---------------------------------------------------------------------------

export interface GHScorecardEvidence {
  id: number
  application_id: number
  interviewer_id: number | null
  submitter_id: number | null
  status: string | null
  submitted_at: string | null
  overall_rating: string | null
}

/** Scorecards for the given applications, batched <=50 ids/query.
 *  submitter_id is the actor the R4 rung scores; status ∈ complete|draft (live-verified). */
export async function listScorecardsForApplications(
  applicationIds: Array<number | null | undefined>
): Promise<GHScorecardEvidence[]> {
  return fetchByIds<GHScorecardEvidence>(
    "/scorecards",
    "application_ids",
    applicationIds
  )
}

// ---------------------------------------------------------------------------
// Notes / activity feed — R5 evidence: the activity-feed / note author who first
// actioned a candidate, when that author is one of the owners -> inferred
// (frozen-spec:291). Minimal projection: no subject/body (those need
// detail_profile=body + reason + allowlist); has_body flags their existence only.
//
// Live-verified: user_id is NULL on system-generated activities (e.g. the
// stage-progression auto-rows Greenhouse writes at application creation) and
// populated only on human-authored notes/activities. The resolver must treat a
// null author as "no actor evidence", never as an actor.
// ---------------------------------------------------------------------------

export type GHNoteType =
  | "NOTE"
  | "ACTIVITY"
  | "INTERVIEW"
  | "EMAIL"
  | "FOLLOW_UP"
  | "TAKE_HOME_TEST"
  | "LINKEDIN_NOTE"
  | "LINKEDIN_INMAIL"
  | "AVAILABILITY_REQUEST"
  | "TOUCHPOINT"
  | "FORM"
  | "FEEDBACK"
  // Forward-compatible: Greenhouse may add types; do not let an unknown tag break typing.
  | (string & {})

export interface GHNoteEvidence {
  id: number
  type: GHNoteType
  visibility: string | null
  /** Human author of the note/activity. NULL for system-generated rows — NOT an actor. */
  user_id: number | null
  created_at: string | null
  /** NULL on candidate-level (not application-scoped) activities (live-verified). */
  application_id: number | null
  candidate_id: number
  has_body: boolean
}

export interface ListNotesOptions {
  /** Restrict to one note type (e.g. "ACTIVITY" for the actioned-by feed). */
  type?: GHNoteType
  /** Restrict to specific authors (server-side `user_ids` filter, verified working). */
  userIds?: Array<number | null | undefined>
}

/**
 * Notes/activity for the given candidates, batched <=50 ids/query. Degrades to
 * [] + permissionBlocked=true on a 401/403 scope wall and NEVER throws on that case,
 * so the R5 rung can fold to `permission_blocked` without failing the sweep
 * (frozen-spec:291). Other errors propagate.
 *
 * Note: cursor-continuation pages on the v3 API must carry the cursor as the SOLE
 * query param (client.ts:279), so the `type`/`user_ids` filters apply on the first
 * page of each id-batch and the client preserves them across the cursor walk.
 */
export async function listNotesForCandidates(
  candidateIds: Array<number | null | undefined>,
  options: ListNotesOptions = {}
): Promise<{ notes: GHNoteEvidence[]; permissionBlocked: boolean }> {
  const userIdsCsv = options.userIds
    ? uniqSortedIds(options.userIds).join(",") || undefined
    : undefined
  const extra: Record<string, string | undefined> = {
    type: options.type,
    user_ids: userIdsCsv,
  }
  const { data, permissionBlocked } = await runPermissionAware("/notes", () =>
    fetchByIds<GHNoteEvidence>("/notes", "candidate_ids", candidateIds, extra)
  )
  return { notes: data, permissionBlocked }
}

// ---------------------------------------------------------------------------
// Stage-change actors — folds into R5 (frozen-spec:291, identity-handoff:252).
//
// /application_stages has NO actor field (live-verified: the stage record carries
// only timestamps + current flag). "Who moved this candidate out of Application
// Review" therefore cannot be asserted from the stage; it is INFERRED by correlating
// the Application Review exit timestamp with the candidate's activity-feed authors.
//
// This fetcher does the transport + the timestamp correlation only. It returns:
//   - applicationReviewExitedAt : the exit timestamp off the stage record (or null)
//   - candidateId               : so the resolver can scope authored activity
//   - activityAuthors           : candidate activity authors near the exit, with
//                                 deltas, so the resolver picks/scores the actor
//   - actorUserId               : the nearest-by-time authored activity's author, as a
//                                 best-effort hint (NULL when no authored activity sits
//                                 within the window) — an inference, never an assertion.
// The resolver owns whether that hint clears a rung; this module only shapes evidence.
// ---------------------------------------------------------------------------

/** Application Review stage names to match against the stage definition lookup.
 *  Matches the live "Application Review" label and the sweep's urgency anchor
 *  (sweep-types.ts:71). The caller supplies stage-id->name resolution; this set is the
 *  default name vocabulary for the rung. */
export const APPLICATION_REVIEW_STAGE_NAMES = new Set<string>(["Application Review"])

/** Default lookback window (ms) around a stage exit within which an authored activity
 *  is considered plausibly the action that caused the exit. 72h is generous enough to
 *  catch a same-session move logged slightly before/after the stage flip without
 *  swallowing unrelated later activity. */
const ACTOR_CORRELATION_WINDOW_MS = 72 * 60 * 60 * 1000

export interface StageActorActivity {
  noteId: number
  userId: number
  createdAt: string
  /** abs(activity.created_at - stage.exited_at) in ms; smaller = stronger correlation. */
  deltaMs: number
}

export interface StageChangeActorResult {
  applicationId: number
  candidateId: number
  /** Exit timestamp of the Application Review stage for this application, or null if the
   *  app never exited Application Review / the stage record carried no exited_at. */
  applicationReviewExitedAt: string | null
  /** Authored activities within the correlation window, nearest-first. May be empty. */
  activityAuthors: StageActorActivity[]
  /** Best-effort nearest authored-activity author. NULL = no authored activity in window. */
  actorUserId: number | null
  /** True when /notes hit a 401/403 scope wall — the rung folds to permission_blocked. */
  permissionBlocked: boolean
}

export interface StageChangeActorInput {
  applicationId: number
  candidateId: number
}

/**
 * For each (application, candidate), find who plausibly moved the candidate out of
 * Application Review, by correlating the stage's exit timestamp with the candidate's
 * authored ACTIVITY feed. Pure transport + correlation; NO confidence decision.
 *
 * @param apps              application+candidate pairs to resolve
 * @param stageNameById     job_interview_stage_id -> stage name (caller already loads
 *                          /job_interview_stages for stage definitions; pass that map in
 *                          so this module stays a single-responsibility evidence fetcher).
 * @param stageNames        which stage names count as "Application Review"
 *                          (defaults to APPLICATION_REVIEW_STAGE_NAMES).
 */
export async function getStageChangeActors(
  apps: StageChangeActorInput[],
  stageNameById: Map<number, string | null>,
  stageNames: Set<string> = APPLICATION_REVIEW_STAGE_NAMES
): Promise<StageChangeActorResult[]> {
  const applicationIds = apps.map((a) => a.applicationId)
  if (applicationIds.length === 0) return []

  // 1. Pull every stage row for these applications (no actor on it — timestamps only).
  const stages = await fetchByIds<YtdGHApplicationStage>(
    "/application_stages",
    "application_ids",
    applicationIds
  )

  // 2. The Application Review exit timestamp per application.
  const exitByApp = new Map<number, string | null>()
  for (const stage of stages) {
    const name = stageNameById.get(stage.job_interview_stage_id ?? -1) ?? null
    if (name === null || !stageNames.has(name)) continue
    if (!stage.exited_at) continue
    const prior = exitByApp.get(stage.application_id)
    // An application can theoretically re-enter a stage; keep the EARLIEST exit (the
    // first time it left Application Review is the action that mattered for SLA).
    if (prior == null || stage.exited_at < prior) {
      exitByApp.set(stage.application_id, stage.exited_at)
    }
  }

  // 3. Authored ACTIVITY for these candidates (permission-aware; system rows have null
  //    user_id and are dropped — they are not actors).
  const candidateIds = apps.map((a) => a.candidateId)
  const { notes, permissionBlocked } = await listNotesForCandidates(candidateIds, {
    type: "ACTIVITY",
  })
  const authoredByCandidate = new Map<number, GHNoteEvidence[]>()
  for (const note of notes) {
    if (note.user_id == null || !note.created_at) continue
    const list = authoredByCandidate.get(note.candidate_id)
    if (list) list.push(note)
    else authoredByCandidate.set(note.candidate_id, [note])
  }

  // 4. Correlate each app's exit with that candidate's authored activity.
  return apps.map((app) => {
    const exitedAt = exitByApp.get(app.applicationId) ?? null
    const exitMs = exitedAt ? Date.parse(exitedAt) : NaN

    let activityAuthors: StageActorActivity[] = []
    if (Number.isFinite(exitMs)) {
      activityAuthors = (authoredByCandidate.get(app.candidateId) ?? [])
        .map((note) => ({
          noteId: note.id,
          userId: note.user_id as number,
          createdAt: note.created_at as string,
          deltaMs: Math.abs(Date.parse(note.created_at as string) - exitMs),
        }))
        .filter(
          (a) => Number.isFinite(a.deltaMs) && a.deltaMs <= ACTOR_CORRELATION_WINDOW_MS
        )
        .sort((a, b) => a.deltaMs - b.deltaMs)
    }

    return {
      applicationId: app.applicationId,
      candidateId: app.candidateId,
      applicationReviewExitedAt: exitedAt,
      activityAuthors,
      actorUserId: activityAuthors.length > 0 ? activityAuthors[0].userId : null,
      permissionBlocked,
    }
  })
}

// ---------------------------------------------------------------------------
// Job owners — R1-R3 evidence (frozen-spec:287-289). The `responsible` boolean is
// the disambiguator R2 leans on; it is present on the live /job_owners record
// (verified: job 5159235004 has 3 recruiter owners, one responsible:true). The live
// record has NO `active` flag, so `active` is typed optional and the resolver treats
// absent-as-active. Mirrors GHJobOwnerWithResponsible from frozen-spec:459.
// ---------------------------------------------------------------------------

export interface GHJobOwnerWithResponsible {
  id: number
  user_id: number
  type: string
  responsible: boolean
  /** Not returned by the live /job_owners projection; present for forward-compat. */
  active?: boolean
  created_at?: string | null
  updated_at?: string | null
  job_id: number
}

/** Owners (recruiter/sourcer/coordinator) for the given jobs, batched <=50 ids/query.
 *  Returns every owner row; the resolver filters to type==="recruiter" and applies the
 *  responsible/single/match rungs. Optionally narrow to one owner `type` server-side. */
export async function listJobOwners(
  jobIds: Array<number | null | undefined>,
  options: { type?: "recruiter" | "sourcer" | "coordinator" } = {}
): Promise<GHJobOwnerWithResponsible[]> {
  return fetchByIds<GHJobOwnerWithResponsible>("/job_owners", "job_ids", jobIds, {
    type: options.type,
  })
}

// ---------------------------------------------------------------------------
// Users — resolve an owner / scorecard-submitter / activity-author id to a name.
// Reuses YtdGHUser (ytd-types.ts:122) so callers share one user shape across the
// YTD extract path and the resolvers. Batched by `ids` <=50/query.
// ---------------------------------------------------------------------------

/** Greenhouse users for the given ids, batched <=50 ids/query. The name/email shaping
 *  lives in ytd-normalize.userName/userEmail; this fetcher returns the raw projection. */
export async function listUsers(
  userIds: Array<number | null | undefined>
): Promise<YtdGHUser[]> {
  return fetchByIds<YtdGHUser>("/users", "ids", userIds)
}

/** Greenhouse referrers for the given ids, batched <=50 ids/query. An application's
 *  `referrer_id` is a `/referrers.id`, NOT a `/users.id` — resolving one against /users 404s —
 *  so this is the only join that names a referrer. Harvest v3 dropped `credited_to` (the v2
 *  field the sweep used to read), which is why referrer_name was null on every row until this
 *  join existed. Shape is { id, user_id, name } with a single `name` field, no first/last split.
 *  Mirrors ytd-extract's /referrers fetch (ytd-extract.ts:516) so both paths name referrers the
 *  same way. */
export async function listReferrers(
  referrerIds: Array<number | null | undefined>
): Promise<YtdGHReferrer[]> {
  return fetchByIds<YtdGHReferrer>("/referrers", "ids", referrerIds)
}

/** Jobs by id, batched <=50 ids/query. The referral sweep's census union can reference more
 *  jobs than one `ids` call legally carries; a raw join of 50+ ids 400s the whole sweep tick. */
export async function listJobsByIds(
  jobIds: Array<number | null | undefined>
): Promise<GHJob[]> {
  return fetchByIds<GHJob>("/jobs", "ids", jobIds)
}

/** Candidates by id, batched <=50 ids/query. Same cap rationale as listJobsByIds. */
export async function listCandidatesByIds(
  candidateIds: Array<number | null | undefined>
): Promise<GHCandidate[]> {
  return fetchByIds<GHCandidate>("/candidates", "ids", candidateIds)
}
