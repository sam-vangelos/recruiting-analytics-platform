// Shared resolution vocabulary for the identity layer (migration 005).
//
// This is the single source of truth for the enums and result shapes that every
// other W1 module imports: the pure resolvers (identity-resolver / agency-resolver),
// the resolve+snapshot+persist orchestrator, the reconcile cron, and — later — the
// notification outbox, whose recipient_resolution_status reuses ResolutionStatus.
//
// Canon (build-program:41, frozen-spec:280): unresolved actor/source identity is a
// data-quality DEFECT carried as { status + evidence + next_retry }, never the literal
// "Unknown" / "Unknown Agency" / "UNASSIGNED". A null recruiter or null agency_name
// paired with a non-'resolved' status IS the contract; the string sentinels are not.
//
// Pure types + const arrays only. No runtime dependencies, no I/O, no model in the loop.
// confidence and status are pure functions of which evidence rung fired (frozen-spec:302).
//
// The const arrays below are the TS half of the enum<->SQL contract test (build-program
// H2): each array mirrors a CHECK (... in (...)) domain in 005_identity_resolution.sql,
// and the unions are derived from the arrays so the two can never drift.

// ---------------------------------------------------------------------------
// Confidence + status enums
// ---------------------------------------------------------------------------

// Mirrors the CHECK domain on every `confidence` column in 005 (greenhouse_job_ownership,
// application_ownership_snapshots.ownership_confidence, agency_source_resolution,
// identity_resolution_attempts, and the nullable ytd_application_facts.ownership_confidence
// writeback). Confidence rank is confirmed > high > inferred > unresolved; upgrades are
// monotonic on that order (frozen-spec:441).
export const RESOLUTION_CONFIDENCE_VALUES = [
  "confirmed",
  "high",
  "inferred",
  "unresolved",
] as const
export type ResolutionConfidence = (typeof RESOLUTION_CONFIDENCE_VALUES)[number]

// Mirrors the CHECK domain on the ownership-side `resolution_status` columns in 005
// (greenhouse_job_ownership, application_ownership_snapshots.ownership_resolution_status,
// and the nullable ytd_application_facts / sweep_items / agency_submissions writebacks).
// 'permission_blocked' is terminal-but-visible: the job_owners fetch threw a permission
// error, so the row is a defect that normal backoff does NOT retry (frozen-spec:294).
export const RESOLUTION_STATUS_VALUES = [
  "resolved",
  "ambiguous",
  "unresolved",
  "permission_blocked",
] as const
export type ResolutionStatus = (typeof RESOLUTION_STATUS_VALUES)[number]

// Agency resolution_status is a NARROWER domain than ResolutionStatus: agency_source_resolution
// has no 'permission_blocked' rung (frozen-spec:396 — agency source identity never depends on a
// permission-gated fetch). Kept as its own type so AgencySourceResolution stays truthful to its
// column instead of widening to the ownership domain.
export const AGENCY_RESOLUTION_STATUS_VALUES = [
  "resolved",
  "unresolved",
  "ambiguous",
] as const
export type AgencyResolutionStatus = (typeof AGENCY_RESOLUTION_STATUS_VALUES)[number]

// ---------------------------------------------------------------------------
// Evidence type unions
// ---------------------------------------------------------------------------

// Which rung produced an ownership resolution. One tag per fired rung; resolvers may
// stack tags (e.g. a prior high upgraded to inferred carries both rungs' evidence).
// Maps to the ladder (frozen-spec:287-294) and to evidence_types text[] on
// greenhouse_job_ownership / application_ownership_snapshots.ownership_evidence_types.
//   owner_match        — application_recruiter_id matches an active recruiter owner (R1, confirmed)
//   responsible_owner  — exactly one responsible:true recruiter owner (R2, confirmed)
//   single_owner       — exactly one active recruiter owner, no responsible flag (R3, high)
//   application_recruiter — application_recruiter_id was present and used as evidence
//   scorecard          — a scorecard submitter_id that is one of the owners (R4, inferred)
//   note_activity      — activity-feed / note author who first actioned, an owner (R5, inferred)
//   stage_exit_actor   — the actor who exited the application's stage, an owner
export const OWNERSHIP_EVIDENCE_TYPES = [
  "application_recruiter",
  "responsible_owner",
  "single_owner",
  "owner_match",
  "scorecard",
  "note_activity",
  "stage_exit_actor",
] as const
export type OwnershipEvidenceType = (typeof OWNERSHIP_EVIDENCE_TYPES)[number]

// Which rung produced an agency-source resolution. Maps to the agency ladder
// (frozen-spec:297-300) and to agency_source_resolution.evidence_types text[].
//   registry       — source.id already in agency_source_registry (A1, confirmed)
//   source_type    — source present with type.id === AGENCY_SOURCE_TYPE_ID, not yet in registry (A2, high)
//   agency_account  — resolved via a known agency account / agency_account_id
//   activity        — only agency-user activity evidence (A3, inferred)
//   none           — no matching signals; resolution_status='unresolved', agency_name NULL
export const AGENCY_EVIDENCE_TYPES = [
  "registry",
  "source_type",
  "agency_account",
  "activity",
  "none",
] as const
export type AgencyEvidenceType = (typeof AGENCY_EVIDENCE_TYPES)[number]

// ---------------------------------------------------------------------------
// identity_resolution_attempts enums (own domains — see notes)
// ---------------------------------------------------------------------------

// Mirrors identity_resolution_attempts.entity_type CHECK (frozen-spec:365). entity_id is
// keyed per type: job_id (job_ownership) | application_id::channel (application_ownership)
// | source_id (agency_source / agency_submitter).
export const RESOLUTION_ENTITY_TYPES = [
  "job_ownership",
  "application_ownership",
  "agency_source",
  "agency_submitter",
] as const
export type ResolutionEntityType = (typeof RESOLUTION_ENTITY_TYPES)[number]

// Mirrors identity_resolution_attempts.status CHECK (frozen-spec:369). This is a SUPERSET
// of ResolutionStatus: it adds 'failed' for an attempt that errored without producing a
// terminal status. Kept distinct so the attempts row interface stays truthful to its column.
export const RESOLUTION_ATTEMPT_STATUS_VALUES = [
  "resolved",
  "unresolved",
  "ambiguous",
  "permission_blocked",
  "failed",
] as const
export type ResolutionAttemptStatus = (typeof RESOLUTION_ATTEMPT_STATUS_VALUES)[number]

// ---------------------------------------------------------------------------
// Result / row shapes
// ---------------------------------------------------------------------------

// Output of the pure ownership resolver and the inline+registry shape for
// greenhouse_job_ownership. Identity fields are NULL (never sentinel strings) whenever
// status !== 'resolved'; ambiguous_candidate_ids is populated when status === 'ambiguous'
// (multiple recruiter owners, no disambiguating evidence — frozen-spec:293). bigint columns
// surface as number, bigint[] as number[], jsonb as Record<string, unknown>.
export interface OwnershipResolution {
  primary_recruiter_id: number | null
  primary_recruiter_name: string | null
  recruiter_ids: number[]
  recruiter_names: string[]
  responsible_recruiter_id: number | null
  confidence: ResolutionConfidence
  status: ResolutionStatus
  evidence_types: OwnershipEvidenceType[]
  evidence_detail: Record<string, unknown> | null
  // Transient result field (not a greenhouse_job_ownership column): populated only on
  // status === 'ambiguous' so the caller can record the contended owner set.
  ambiguous_candidate_ids: number[]
}

// Output of the pure agency-source resolver and the row shape for agency_source_resolution.
// agency_name is NULL (NEVER 'Unknown Agency') and source_id is NULL (NEVER 0) when
// status !== 'resolved' (frozen-spec:300, :389). Note status uses the narrower
// AgencyResolutionStatus (no 'permission_blocked').
export interface AgencySourceResolution {
  source_id: number | null
  source_name: string | null
  source_type_id: number | null
  source_type_name: string | null
  agency_name: string | null
  agency_account_id: number | null
  agency_user_ids: number[]
  active: boolean
  confidence: ResolutionConfidence
  status: AgencyResolutionStatus
  evidence_types: AgencyEvidenceType[]
  evidence_detail: Record<string, unknown> | null
}

// Row shape for identity_resolution_attempts (frozen-spec:362-378): the audit + retry queue,
// one live row per (entity_type, entity_id). The reconcile cron updates it in place; the UI
// surfaces it as the defect's provenance. next_retry_at is the backoff target and is NULL
// once status === 'resolved'. id / attempted_at are server-defaulted, so they are optional on
// the write path.
export interface ResolutionAttempt {
  id?: string
  entity_type: ResolutionEntityType
  entity_id: string
  channel: ResolutionChannel | null
  status: ResolutionAttemptStatus
  confidence: ResolutionConfidence | null
  attempt_number: number
  evidence_sources_checked: string[]
  failure_reason: string | null
  next_retry_at: string | null
  attempted_at?: string
  metadata: Record<string, unknown> | null
}

// The two trackers identity resolution serves. Mirrors the channel CHECK on
// application_ownership_snapshots / identity_resolution_attempts and aligns with
// YtdChannel in ytd-types.ts (kept independent here so this module has no import deps).
export type ResolutionChannel = "referral" | "agency"
