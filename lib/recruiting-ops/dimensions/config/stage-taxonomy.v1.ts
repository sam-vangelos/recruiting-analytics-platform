/**
 * substage → core_stage normalization, FIXTURE/SEED ONLY (v1).
 *
 * Union of the per-req `StageMapping` CTEs in the handover pipeline queries
 * (890, 907, 1026/1027, 1118/1119, graph). Those CTEs DISAGREED — e.g. 907 maps
 * `Sourced → Sourced` while 1026/1027 keep `Reached Out` as its own stage, and 890
 * carries `Shortlisted Candidate`. Where the legacy reqs diverged, the entry is
 * canonicalized here and flagged `divergent: true` so the resolver lowers
 * confidence and the discrepancy is a candidate `stale_mapping` to adjudicate.
 *
 * Versioned config, not live data: any substage not listed resolves to an
 * `unresolved` defect rather than a sentinel.
 */

export const STAGE_TAXONOMY_CONFIG_VERSION = "v1-2026-06"

export interface StageTaxonomyEntry {
  substage: string
  coreStage: string
  stageOrder: number
  /** True when the legacy per-req CTEs mapped this substage inconsistently. */
  divergent?: boolean
}

export const CORE_STAGE_ORDER: ReadonlyArray<{ coreStage: string; order: number }> = [
  { coreStage: "Application Review", order: 1 },
  { coreStage: "Sourced", order: 2 },
  { coreStage: "Recruiter Phone Screen", order: 3 },
  { coreStage: "Hiring Manager Review", order: 4 },
  { coreStage: "Manager / Tech Screen", order: 5 },
  { coreStage: "Skills Assessment", order: 6 },
  { coreStage: "Onsite Interviews", order: 7 },
  { coreStage: "Verbal Offer", order: 8 },
  { coreStage: "Offer", order: 9 },
  { coreStage: "Offer Signed", order: 10 },
]

export const stageTaxonomyConfigV1: readonly StageTaxonomyEntry[] = [
  { substage: "Application Review", coreStage: "Application Review", stageOrder: 1 },
  { substage: "Sourced", coreStage: "Sourced", stageOrder: 2 },
  { substage: "Reached Out", coreStage: "Sourced", stageOrder: 2, divergent: true },
  { substage: "Shortlisted Candidate", coreStage: "Sourced", stageOrder: 2, divergent: true },
  { substage: "Preliminary Screening Call", coreStage: "Recruiter Phone Screen", stageOrder: 3 },
  { substage: "Recruiter Phone Screen", coreStage: "Recruiter Phone Screen", stageOrder: 3 },
  { substage: "Recruiter Video Screen", coreStage: "Recruiter Phone Screen", stageOrder: 3 },
  { substage: "No Show", coreStage: "Recruiter Phone Screen", stageOrder: 3, divergent: true },
  { substage: "Hiring Manager Review", coreStage: "Hiring Manager Review", stageOrder: 4 },
  { substage: "Hiring Manager Application Review", coreStage: "Hiring Manager Review", stageOrder: 4 },
  { substage: "HM Review", coreStage: "Hiring Manager Review", stageOrder: 4 },
  { substage: "Hiring Manager Screen", coreStage: "Manager / Tech Screen", stageOrder: 5, divergent: true },
  { substage: "Screening round", coreStage: "Manager / Tech Screen", stageOrder: 5 },
  { substage: "Manager / Tech Screen", coreStage: "Manager / Tech Screen", stageOrder: 5 },
  { substage: "Manager/ Tech Screen", coreStage: "Manager / Tech Screen", stageOrder: 5 },
  { substage: "Technical Interview", coreStage: "Manager / Tech Screen", stageOrder: 5 },
  { substage: "Live Coding Round", coreStage: "Manager / Tech Screen", stageOrder: 5 },
  { substage: "Assessment", coreStage: "Skills Assessment", stageOrder: 6 },
  { substage: "Skills Assessment", coreStage: "Skills Assessment", stageOrder: 6 },
  { substage: "Cultural Add Interview", coreStage: "Onsite Interviews", stageOrder: 7 },
  { substage: "Peer Panel Interview", coreStage: "Onsite Interviews", stageOrder: 7 },
  { substage: "Case Study", coreStage: "Onsite Interviews", stageOrder: 7 },
  { substage: "Executive Interview", coreStage: "Onsite Interviews", stageOrder: 7 },
  { substage: "Onsite Interviews", coreStage: "Onsite Interviews", stageOrder: 7 },
  { substage: "Leadership Round", coreStage: "Onsite Interviews", stageOrder: 7 },
  { substage: "R1 - Technical Screen", coreStage: "Onsite Interviews", stageOrder: 7, divergent: true },
  { substage: "R2 - Arjun/Idris Interview", coreStage: "Onsite Interviews", stageOrder: 7, divergent: true },
  { substage: "R3 - Elias/Vikram", coreStage: "Onsite Interviews", stageOrder: 7, divergent: true },
  { substage: "Verbal Offer", coreStage: "Verbal Offer", stageOrder: 8 },
  { substage: "Offer Extend", coreStage: "Offer", stageOrder: 9, divergent: true },
  { substage: "Offer extend to select", coreStage: "Offer", stageOrder: 9, divergent: true },
  { substage: "Offer", coreStage: "Offer", stageOrder: 9 },
  { substage: "Offer Signed", coreStage: "Offer Signed", stageOrder: 10 },
]
