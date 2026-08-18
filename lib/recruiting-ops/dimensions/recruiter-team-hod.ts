import {
  RECRUITER_TEAM_HOD_CONFIG_VERSION,
  recruiterTeamHodConfigV1,
  type RecruiterTeamHodEntry,
} from "./config/recruiter-team-hod.v1"
import { UNRESOLVED_TEAM, type TeamResolution } from "./types"

/**
 * Pure recruiter/sourcer/owner → team → HOD resolver. No I/O; the mapping config is
 * injected (defaults to the fixture v1 config), mirroring the W1 resolveOwnership DI
 * pattern. An unresolved or ambiguous name yields NULL identity fields and a defect
 * status — never a sentinel string like "Unknown"/"unmapped".
 */

export interface TeamResolutionEvidence {
  recruiterName?: string | null
}

/**
 * Team display labels here are person-derived ("Team Avery"), so public surfaces must
 * carry the teamId slug instead. NULL for an unknown label — never a sentinel.
 */
export function teamIdForTeamName(
  teamName: string,
  config: readonly RecruiterTeamHodEntry[] = recruiterTeamHodConfigV1
): string | null {
  const label = teamName.trim().toLowerCase()
  if (!label) return null
  const match = config.find((entry) => entry.teamName.toLowerCase() === label)
  return match ? match.teamId : null
}

export function resolveTeam(
  evidence: TeamResolutionEvidence,
  config: readonly RecruiterTeamHodEntry[] = recruiterTeamHodConfigV1
): TeamResolution {
  const name = evidence.recruiterName?.trim()
  if (!name) {
    return { ...UNRESOLVED_TEAM, evidence: "no recruiter name supplied" }
  }

  const matches = config.filter((entry) => entry.recruiterName.toLowerCase() === name.toLowerCase())
  if (matches.length === 0) {
    return { ...UNRESOLVED_TEAM, evidence: `no team mapping for ${name} (${RECRUITER_TEAM_HOD_CONFIG_VERSION})` }
  }

  const teamIds = new Set(matches.map((entry) => entry.teamId))
  if (teamIds.size > 1) {
    // Same name mapped to multiple teams in config — an ambiguous defect, not a guess.
    return {
      team_id: null,
      team_name: null,
      hod_name: null,
      confidence: "unresolved",
      status: "ambiguous",
      evidence: `${name} maps to multiple teams: ${[...teamIds].join(", ")}`,
    }
  }

  const entry = matches[0]
  return {
    team_id: entry.teamId,
    team_name: entry.teamName,
    hod_name: entry.hodName,
    confidence: "confirmed",
    status: "resolved",
    evidence: `${RECRUITER_TEAM_HOD_CONFIG_VERSION}:${entry.recruiterName}`,
  }
}
