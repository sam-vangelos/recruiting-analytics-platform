import { getSupabase } from "../supabase"
import type { RecruiterTeamHodEntry } from "./dimensions/config/recruiter-team-hod.v1"
import type { InterviewStageTaxonomyEntry } from "./dimensions/types"

/**
 * Readers for the governed dimension tables (migration 018). Live runs load
 * these and inject them; fixture-driven tests keep the compiled configs.
 *
 * An EMPTY roster throws rather than silently falling back to compiled config —
 * a live run resolving attribution from a bypassed governance table would be a
 * silent policy override. The taxonomy is an override table, so empty is fine.
 */

export async function loadGovernedRoster(): Promise<RecruiterTeamHodEntry[]> {
  const { data, error } = await getSupabase()
    .from("recruiting_ops_recruiter_roster")
    .select("recruiter_name, team_id, team_name, hod_name")
    .eq("active", true)
  if (error) {
    throw new Error(`governed roster load failed: ${error.message}`)
  }
  if (!data || data.length === 0) {
    throw new Error(
      "governed roster table is empty — seed it first (npx tsx scripts/recruiting-ops-seed-roster.ts) so live attribution runs on governed rows, not compiled fixture config."
    )
  }
  return data.map((row) => ({
    recruiterName: row.recruiter_name,
    teamId: row.team_id,
    teamName: row.team_name,
    hodName: row.hod_name,
  }))
}

/**
 * Names mapped to more than one team in the active roster. resolveTeam treats
 * these as AMBIGUOUS defects (null attribution, never a guess) — legitimate as
 * a transition state, but a seed or edit that CREATES one should say so loudly.
 */
export function findAmbiguousRosterNames(entries: readonly RecruiterTeamHodEntry[]): string[] {
  const teamsByName = new Map<string, Set<string>>()
  for (const entry of entries) {
    const key = entry.recruiterName.trim().toLowerCase()
    const teams = teamsByName.get(key) ?? new Set<string>()
    teams.add(entry.teamId)
    teamsByName.set(key, teams)
  }
  return [...teamsByName.entries()].filter(([, teams]) => teams.size > 1).map(([name]) => name)
}

export async function loadInterviewStageTaxonomy(): Promise<InterviewStageTaxonomyEntry[]> {
  const { data, error } = await getSupabase()
    .from("recruiting_ops_interview_stage_taxonomy")
    .select("stage_label, stage_class, funnel_stage")
    .eq("active", true)
  if (error) {
    throw new Error(`interview-stage taxonomy load failed: ${error.message}`)
  }
  return (data ?? []).map((row) => ({
    stageLabel: row.stage_label,
    stageClass: row.stage_class as InterviewStageTaxonomyEntry["stageClass"],
    funnelStage: (row as { funnel_stage?: string | null }).funnel_stage ?? null,
  }))
}
