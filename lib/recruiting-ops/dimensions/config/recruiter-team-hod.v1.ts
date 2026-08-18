/**
 * Recruiter → team → HOD mapping, FIXTURE/SEED ONLY (v1).
 *
 * Transcribed from the hand-edited `CASE WHEN ... THEN 'Team X'` statements that
 * recur across the handover queries (Role assignment by pod, Final Offer Report,
 * RPS tracking). It is versioned config, not live data: any recruiter not listed
 * resolves to an `unresolved` defect rather than a sentinel. A later pass can
 * replace this with a resolved Greenhouse-backed dimension; the resolver contract
 * does not change.
 */

export const RECRUITER_TEAM_HOD_CONFIG_VERSION = "v1-2026-06"

export interface RecruiterTeamHodEntry {
  recruiterName: string
  teamId: string
  teamName: string
  hodName: string
}

const TEAMS: ReadonlyArray<{ teamId: string; teamName: string; hodName: string; members: readonly string[] }> = [
  {
    teamId: "team_priya",
    teamName: "Team Priya",
    hodName: "Priya Nair",
    members: [
      "Simran Kaur",
      "Kavya Menon",
      "Priya Nair",
      "Sanjay Iyer",
      "Aditi Kulkarni",
      "Tanvi Desai",
      "Dhruv Malhotra",
      "Nikhil Rao",
    ],
  },
  {
    teamId: "team_avery",
    teamName: "Team Avery",
    hodName: "Avery Collins",
    members: [
      "Natan Berg",
      "Mitali Shah",
      "Margot Ellis",
      "Stefan Aguirre",
      "Avery Collins",
      "Swara Sen",
      "Lindsay Boone",
      "Isabela Duarte",
      "Medha Prasad",
    ],
  },
  { teamId: "team_marcus", teamName: "Team Marcus", hodName: "Marcus Webb", members: ["Marcus Webb"] },
  { teamId: "team_jordan", teamName: "Team Jordan", hodName: "Jordan Rivera", members: ["Jordan Rivera"] },
  {
    teamId: "team_bob",
    teamName: "Team Bob",
    hodName: "Bob",
    members: ["Sunita Raghav", "Venkat Balan", "Declan Ames", "Mateo Vargas"],
  },
  {
    teamId: "team_sana",
    teamName: "Team Sana",
    hodName: "Sana Iqbal",
    members: [
      "Sana Iqbal",
      "Victor Reyes",
      "Ravi Pillai",
      "Nirmal Mohan",
      "Aliya Khan",
      "Nikita Sood",
      "Aanya Saxena",
      "Karthik Devan",
      "Nelson Ruiz",
      "Bruno Duval",
      "Ronak Jain",
      "Aniket Rana",
    ],
  },
]

export const recruiterTeamHodConfigV1: readonly RecruiterTeamHodEntry[] = TEAMS.flatMap((team) =>
  team.members.map((recruiterName) => ({
    recruiterName,
    teamId: team.teamId,
    teamName: team.teamName,
    hodName: team.hodName,
  }))
)
