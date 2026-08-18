import { describe, expect, test } from "vitest"

import { evaluateStagingKillSwitchStates, STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID } from "../lib/recruiting-ops/delivery/staging-kill-switch"
import type { KillSwitchState } from "../lib/recruiting-ops/autonomy"

const NOW = Date.parse("2026-07-11T12:10:00.000Z")
const clear: KillSwitchState = {
  scope: "global",
  scopeId: STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID,
  enabled: false,
  reason: "staging validation authorized",
  updatedAt: "2026-07-11T12:00:00Z",
  updatedBy: "operator",
}

describe("staging hydration durable kill switch", () => {
  test("requires an explicit durable disengaged event", () => {
    expect(evaluateStagingKillSwitchStates("all_hires", [], NOW)).toMatchObject({ clear: false })
    expect(evaluateStagingKillSwitchStates("all_hires", [clear], NOW)).toMatchObject({ clear: true })
    expect(evaluateStagingKillSwitchStates("all_hires", [{
      ...clear,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }], NOW)).toMatchObject({ clear: true })
  })

  test.each([
    ["future-dated", "2026-07-11T12:10:00.001Z"],
    ["invalid", "not-a-timestamp"],
  ])("rejects a %s explicit clear event", (_name, updatedAt) => {
    expect(evaluateStagingKillSwitchStates("all_hires", [{
      ...clear,
      updatedAt,
    }], NOW)).toMatchObject({ clear: false })
  })

  test.each([
    ["global", "all"],
    ["global", STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID],
    ["deliverable", "staging:all_hires"],
  ] as const)("an engaged %s:%s switch wins", (scope, scopeId) => {
    const blocker: KillSwitchState = { ...clear, scope, scopeId, enabled: true, updatedAt: "2026-07-11T12:01:00Z" }
    expect(evaluateStagingKillSwitchStates("all_hires", [clear, blocker], NOW)).toMatchObject({ clear: false })
  })
})
