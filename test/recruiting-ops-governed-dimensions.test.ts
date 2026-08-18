import { describe, expect, test } from "vitest"

import type { RecruiterTeamHodEntry } from "../lib/recruiting-ops/dimensions/config/recruiter-team-hod.v1"
import { resolveTeam } from "../lib/recruiting-ops/dimensions/recruiter-team-hod"
import { findAmbiguousRosterNames } from "../lib/recruiting-ops/governed-dimensions-client"
import { normalizeFinalOfferRows } from "../lib/recruiting-ops/modules/t07-final-offer"
import { normalizeOwnershipRows } from "../lib/recruiting-ops/modules/t09-ownership"
import { normalizeRpsStage, normalizeRpsRows } from "../lib/recruiting-ops/modules/t05-rps"

const governedRoster: RecruiterTeamHodEntry[] = [
  {
    recruiterName: "Newly Hired",
    teamId: "team_governed",
    teamName: "Team Governed",
    hodName: "Governed HOD",
  },
]

describe("governed dimensions (migration 018)", () => {
  test("an injected roster is exclusive — governed rows resolve, compiled-only names do not", () => {
    // A name only the governed table knows resolves...
    expect(resolveTeam({ recruiterName: "Newly Hired" }, governedRoster).status).toBe("resolved")
    // ...and a name only the compiled config knows does NOT: the injected
    // roster replaces policy, it never merges with the fixture.
    const compiledOnly = resolveTeam({ recruiterName: "Avery Collins" }, governedRoster)
    expect(compiledOnly.status).toBe("unresolved")
    // Without injection the compiled config still resolves it (test fixture path).
    expect(resolveTeam({ recruiterName: "Avery Collins" }).status).toBe("resolved")
  })

  test("modules thread the governed roster into team attribution", () => {
    const offerRows = normalizeFinalOfferRows(
      [
        {
          applicationId: "app_1",
          jobId: "job_1",
          offerId: "offer_1",
          status: "accepted",
          createdAt: "2026-06-16T10:00:00.000Z",
          recruiterName: "Newly Hired",
        },
      ],
      governedRoster
    )
    expect(offerRows[0].team_name).toBe("Team Governed")
    expect(offerRows[0].hod_name).toBe("Governed HOD")

    const ownershipRows = normalizeOwnershipRows(
      [{ jobId: "job_1", recruiterName: "Newly Hired", openingsCount: 2 }],
      governedRoster
    )
    expect(ownershipRows[0].pod_name).toBe("Team Governed")

    const rpsRows = normalizeRpsRows(
      [
        {
          applicationId: "app_1",
          jobId: "job_1",
          interviewId: "iv_1",
          stageName: "Recruiter Phone Screen",
          scheduledAt: "2026-06-18T10:00:00.000Z",
          scorecardStatus: "submitted",
          submitterName: "Newly Hired",
        },
      ],
      { roster: governedRoster }
    )
    expect(rpsRows[0].team_name).toBe("Team Governed")
  })

  test("a team change in config surfaces as an ambiguous-name warning, not a silent duplicate", () => {
    // The seed upsert keys on (recruiter_name, team_id): moving a person to a
    // new team ADDS a row instead of replacing the old one.
    const afterTeamMove: RecruiterTeamHodEntry[] = [
      { recruiterName: "Moved Person", teamId: "team_old", teamName: "Team Old", hodName: "HOD Old" },
      { recruiterName: "Moved Person", teamId: "team_new", teamName: "Team New", hodName: "HOD New" },
      { recruiterName: "Stable Person", teamId: "team_old", teamName: "Team Old", hodName: "HOD Old" },
    ]
    expect(findAmbiguousRosterNames(afterTeamMove)).toEqual(["moved person"])
    // And resolveTeam refuses to guess for the duplicated name.
    expect(resolveTeam({ recruiterName: "Moved Person" }, afterTeamMove).status).toBe("ambiguous")
  })

  test("a governed taxonomy row classifies org-specific slot labels; heuristics stay the fallback", () => {
    // Heuristics alone cannot place this org-specific label.
    expect(normalizeRpsStage("CodePair Interview")).toBe("unknown")
    // A governed row classifies it by policy (exact label, case-insensitive).
    const taxonomy = [{ stageLabel: "codepair interview", stageClass: "technical" as const }]
    expect(normalizeRpsStage("CodePair Interview", taxonomy)).toBe("technical")
    // Labels the table does not list still classify heuristically.
    expect(normalizeRpsStage("Recruiter Phone Screen", taxonomy)).toBe("rps")
  })
})
