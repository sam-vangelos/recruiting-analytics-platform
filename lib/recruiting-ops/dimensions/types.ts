import type { ResolutionConfidence, ResolutionStatus } from "../../resolution-types"

/**
 * Shared recruiting-ops dimensions: recruiter/sourcer/owner → team → HOD, and
 * substage → core_stage. These are the two pieces of logic the handover queries
 * duplicated and let drift (hand-edited CASE statements). They reuse the W1
 * resolution vocabulary (`lib/resolution-types.ts`) so the command center and the
 * YTD pipeline speak one identity language.
 *
 * Canon (resolution-types.ts:8-11): an unresolved value is a data-quality DEFECT
 * carried as `{ status + confidence + evidence }` with NULL identity fields — never
 * the literal "Unknown" / "unmapped" / "UNASSIGNED". Modules surface the defect as a
 * `SourceGap`, not a sentinel string.
 */

export interface TeamResolution {
  /** NULL whenever `status !== "resolved"` — never a sentinel string. */
  team_id: string | null
  team_name: string | null
  hod_name: string | null
  confidence: ResolutionConfidence
  status: ResolutionStatus
  /** Which config version/entry resolved it, or why it could not. */
  evidence: string | null
}

export interface StageResolution {
  /** NULL whenever `status !== "resolved"` — never a sentinel string. */
  core_stage: string | null
  stage_order: number | null
  confidence: ResolutionConfidence
  status: ResolutionStatus
  evidence: string | null
}

/**
 * Governed interview-stage classification for T05 (migration 018). Slot labels
 * are org-specific ("CodePair Interview"), so classification is a governed
 * override table; the module's contains-heuristics remain the fallback for
 * labels the table does not list.
 */
export interface InterviewStageTaxonomyEntry {
  stageLabel: string
  stageClass: "rps" | "technical" | "onsite"
  /** Exec funnel mapping (migration 021); null/absent = not funnel-governed, heuristic fallback applies. */
  funnelStage?: string | null
}

export const UNRESOLVED_TEAM: TeamResolution = {
  team_id: null,
  team_name: null,
  hod_name: null,
  confidence: "unresolved",
  status: "unresolved",
  evidence: null,
}

export const UNRESOLVED_STAGE: StageResolution = {
  core_stage: null,
  stage_order: null,
  confidence: "unresolved",
  status: "unresolved",
  evidence: null,
}
