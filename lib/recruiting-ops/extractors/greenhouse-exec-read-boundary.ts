import type { SourceGap } from "../runs"
import type {
  HarvestApplicationRecord,
  HarvestApplicationStageRecord,
  HarvestCandidateRecord,
  HarvestDepartmentRecord,
  HarvestInterviewKitRecord,
  HarvestJobInterviewRecord,
  HarvestJobInterviewStageRecord,
  HarvestJobOwnerRecord,
  HarvestJobRecord,
  HarvestOfferRecord,
  HarvestOpeningRecord,
  HarvestScheduledInterviewRecord,
  HarvestScorecardRecord,
  HarvestUserRecord,
} from "./greenhouse-harvest-read-adapter"
import type { GreenhouseReadContext } from "./greenhouse-read-boundary"

/**
 * Read boundary for the exec state-of-play module. Deliberately SEPARATE from
 * `GreenhouseReadBoundary`: the six-module boundary is focus-req-scoped and
 * returns mapped facts; the exec module is org-wide and does its derivation in
 * the module (pure, fixture-testable), so this boundary returns typed RAW
 * source collections. The facts+gaps contract still holds — the boundary
 * performs no mapping, so it can drop nothing; every filter it applies is a
 * documented query param, and per-pull diagnostics make cap truncation visible
 * instead of silent.
 */

export interface ExecPullDiagnostic {
  /** Human-readable pull label, e.g. "/applications?status=active&prospect=false". */
  source: string
  records: number
  /**
   * True when a single list call returned at least the client's record cap —
   * the live client truncates silently at the cap, so count >= cap means
   * "more pages likely existed". The module turns this into a blocking gap.
   */
  truncationSuspected: boolean
}

export interface HarvestExecStateSources {
  /** Open jobs, org-wide. */
  jobs: readonly HarvestJobRecord[]
  /** Open openings, org-wide (seat counts join by job_id). */
  openings: readonly HarvestOpeningRecord[]
  jobOwners: readonly HarvestJobOwnerRecord[]
  /** Users referenced by job_owners rows. */
  users: readonly HarvestUserRecord[]
  departments: readonly HarvestDepartmentRecord[]
  /** Active (in-process), prospect-excluded applications on open jobs. */
  applications: readonly HarvestApplicationRecord[]
  /**
   * Applications referenced by recent stage rows but absent from the active
   * pull (advanced then rejected/hired inside the window) — id→job_id
   * resolution so their movement still counts.
   */
  movementApplications: readonly HarvestApplicationRecord[]
  /** Stage-history rows touched inside the movement window, org-wide. */
  applicationStages: readonly HarvestApplicationStageRecord[]
  /** Stage definitions for open jobs. */
  jobInterviewStages: readonly HarvestJobInterviewStageRecord[]
  /** Interview-plan slots for open jobs (slot → stage). */
  jobInterviews: readonly HarvestJobInterviewRecord[]
  /** Kits for open jobs (scorecard → kit → slot). */
  interviewKits: readonly HarvestInterviewKitRecord[]
  /** Scorecards whose interview (or submission) falls inside the movement window, org-wide. */
  scorecards: readonly HarvestScorecardRecord[]
  /** Interviews on open jobs currently awaiting feedback — conducted, write-up outstanding. */
  awaitingFeedbackInterviews: readonly HarvestScheduledInterviewRecord[]
  /** Accepted offers org-wide (NOT scoped to open jobs) inside the trailing window. */
  offers: readonly HarvestOfferRecord[]
  /** Jobs referenced by offers but no longer open — hire enrichment (name/department/priority) for closed reqs. */
  offerJobs: readonly HarvestJobRecord[]
}

export interface ExecReadWindows {
  /** ISO timestamp bounding stage-row / scorecard recency (the 14d activity window + margin). */
  movementSinceIso: string
  /** ISO timestamp bounding accepted-offer resolved_at (the trailing-12-week window + margin). */
  offersSinceIso: string
}

export interface GreenhouseExecSourcesResult {
  sources: HarvestExecStateSources
  sourceGaps: readonly SourceGap[]
  pullDiagnostics: readonly ExecPullDiagnostic[]
}

export interface GreenhouseExecReadBoundary {
  readonly sourceAdapter: "greenhouse_v3_read"
  fetchExecStateSources(context: GreenhouseReadContext, windows: ExecReadWindows): Promise<GreenhouseExecSourcesResult>
  /** Name resolution for exactly the candidate ids the module decided it needs (finalists + hires). */
  fetchExecCandidateNames(candidateIds: readonly string[]): Promise<readonly HarvestCandidateRecord[]>
  /**
   * Full stage histories (all rows, unbounded by the movement window) for
   * exactly the engaged application ids the module collected — the source for
   * true last-advance dates and time-in-current-stage. Verified live: the v3
   * endpoint accepts `application_ids`, and /applications records themselves
   * carry no stage-recency field, so this scoped pull is the only path.
   */
  fetchEngagedStageHistories(applicationIds: readonly string[]): Promise<readonly HarvestApplicationStageRecord[]>
}

export function emptyExecStateSources(): HarvestExecStateSources {
  return {
    jobs: [],
    openings: [],
    jobOwners: [],
    users: [],
    departments: [],
    applications: [],
    movementApplications: [],
    applicationStages: [],
    jobInterviewStages: [],
    jobInterviews: [],
    interviewKits: [],
    scorecards: [],
    awaitingFeedbackInterviews: [],
    offers: [],
    offerJobs: [],
  }
}

export function createFixtureGreenhouseExecReadBoundary(fixture: {
  sources?: Partial<HarvestExecStateSources>
  candidates?: readonly HarvestCandidateRecord[]
  stageHistories?: readonly HarvestApplicationStageRecord[]
  pullDiagnostics?: readonly ExecPullDiagnostic[]
}): GreenhouseExecReadBoundary {
  return {
    sourceAdapter: "greenhouse_v3_read",
    async fetchExecStateSources() {
      return {
        sources: { ...emptyExecStateSources(), ...fixture.sources },
        sourceGaps: [],
        pullDiagnostics: fixture.pullDiagnostics ?? [],
      }
    },
    async fetchExecCandidateNames(candidateIds) {
      const wanted = new Set(candidateIds.map(String))
      return (fixture.candidates ?? []).filter((candidate) => wanted.has(String(candidate.id)))
    },
    async fetchEngagedStageHistories(applicationIds) {
      const wanted = new Set(applicationIds.map(String))
      return (fixture.stageHistories ?? []).filter((row) => wanted.has(String(row.application_id)))
    },
  }
}
