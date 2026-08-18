import { describe, expect, test } from "vitest"

import {
  CORE_STAGE_ORDER,
  recruiterTeamHodConfigV1,
  resolveStage,
  resolveTeam,
  stageTaxonomyConfigV1,
  type RecruiterTeamHodEntry,
} from "../lib/recruiting-ops/dimensions"

const SENTINELS = ["unmapped", "Unknown", "UNASSIGNED", "Unknown Agency"]

describe("recruiter → team → HOD resolution", () => {
  test("resolves a known recruiter to a confirmed team and HOD", () => {
    const result = resolveTeam({ recruiterName: "Avery Collins" })
    expect(result.status).toBe("resolved")
    expect(result.confidence).toBe("confirmed")
    expect(result.team_id).toBe("team_avery")
    expect(result.team_name).toBe("Team Avery")
    expect(result.hod_name).toBe("Avery Collins")
    expect(result.evidence).toContain("v1")
  })

  test("matching is case-insensitive on trimmed names", () => {
    expect(resolveTeam({ recruiterName: "  jordan rivera " }).team_id).toBe("team_jordan")
  })

  test("an unknown recruiter is an unresolved DEFECT with null identity, never a sentinel", () => {
    const result = resolveTeam({ recruiterName: "Nobody McNoteam" })
    expect(result.status).toBe("unresolved")
    expect(result.team_id).toBeNull()
    expect(result.team_name).toBeNull()
    expect(result.hod_name).toBeNull()
    expect(result.evidence).toContain("no team mapping")
    for (const sentinel of SENTINELS) {
      expect(result.team_name).not.toBe(sentinel)
    }
  })

  test("a missing/empty name is unresolved", () => {
    expect(resolveTeam({ recruiterName: "" }).status).toBe("unresolved")
    expect(resolveTeam({ recruiterName: null }).status).toBe("unresolved")
    expect(resolveTeam({}).status).toBe("unresolved")
  })

  test("a name mapped to multiple teams is ambiguous with null identity", () => {
    const conflicting: RecruiterTeamHodEntry[] = [
      { recruiterName: "Casey Two", teamId: "team_a", teamName: "Team A", hodName: "A" },
      { recruiterName: "Casey Two", teamId: "team_b", teamName: "Team B", hodName: "B" },
    ]
    const result = resolveTeam({ recruiterName: "Casey Two" }, conflicting)
    expect(result.status).toBe("ambiguous")
    expect(result.team_id).toBeNull()
    expect(result.team_name).toBeNull()
    expect(result.evidence).toContain("multiple teams")
  })

  test("config integrity: non-empty and every recruiter maps to exactly one team", () => {
    expect(recruiterTeamHodConfigV1.length).toBeGreaterThan(0)
    const byName = new Map<string, Set<string>>()
    for (const entry of recruiterTeamHodConfigV1) {
      const teams = byName.get(entry.recruiterName) ?? new Set<string>()
      teams.add(entry.teamId)
      byName.set(entry.recruiterName, teams)
    }
    const conflicted = [...byName.entries()].filter(([, teams]) => teams.size > 1).map(([name]) => name)
    expect(conflicted, `recruiters mapped to multiple teams: ${conflicted.join(", ")}`).toEqual([])
  })
})

describe("substage → core_stage resolution", () => {
  test("resolves a clean substage to a confirmed core stage with order", () => {
    const result = resolveStage("Preliminary Screening Call")
    expect(result.status).toBe("resolved")
    expect(result.confidence).toBe("confirmed")
    expect(result.core_stage).toBe("Recruiter Phone Screen")
    expect(result.stage_order).toBe(3)
  })

  test("a substage the legacy reqs mapped inconsistently resolves at inferred confidence", () => {
    const result = resolveStage("Reached Out")
    expect(result.status).toBe("resolved")
    expect(result.confidence).toBe("inferred")
    expect(result.core_stage).toBe("Sourced")
    expect(result.evidence).toContain("divergent")
  })

  test("an unknown substage is an unresolved DEFECT with null core stage, never a sentinel", () => {
    const result = resolveStage("Mystery Round")
    expect(result.status).toBe("unresolved")
    expect(result.core_stage).toBeNull()
    expect(result.stage_order).toBeNull()
    for (const sentinel of SENTINELS) {
      expect(result.core_stage).not.toBe(sentinel)
    }
  })

  test("a missing/empty substage is unresolved", () => {
    expect(resolveStage("").status).toBe("unresolved")
    expect(resolveStage(null).status).toBe("unresolved")
    expect(resolveStage(undefined).status).toBe("unresolved")
  })

  test("config integrity: unique substages, every core stage known, divergent->inferred", () => {
    const knownCoreStages = new Set(CORE_STAGE_ORDER.map((row) => row.coreStage))
    const seen = new Set<string>()
    for (const entry of stageTaxonomyConfigV1) {
      expect(seen.has(entry.substage.toLowerCase()), `duplicate substage ${entry.substage}`).toBe(false)
      seen.add(entry.substage.toLowerCase())
      expect(knownCoreStages.has(entry.coreStage), `unknown core stage ${entry.coreStage}`).toBe(true)
      const expectedOrder = CORE_STAGE_ORDER.find((row) => row.coreStage === entry.coreStage)?.order
      expect(entry.stageOrder).toBe(expectedOrder)
    }
  })
})
