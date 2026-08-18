import { describe, expect, test, vi } from "vitest"

import type { KillSwitchOperatorEvent } from "../lib/recruiting-ops/autonomy-operator-controls"
import { STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID } from "../lib/recruiting-ops/delivery/staging-kill-switch"
import {
  parseStagingKillSwitchOperatorArgs,
  runStagingKillSwitchOperator,
  type StagingKillSwitchOperatorDependencies,
} from "../scripts/recruiting-ops/staging-kill-switch-operator"

const NOW = "2026-07-11T22:00:00.000Z"

describe("staging hydration kill-switch operator CLI", () => {
  test("requires an explicit action, operator, and reason and defaults to dry-run", () => {
    expect(
      parseStagingKillSwitchOperatorArgs([
        "--action=DISENGAGED",
        "--operator=sam",
        "--reason=Copied-artifact acceptance test",
      ])
    ).toEqual({
      action: "DISENGAGED",
      operator: "sam",
      reason: "Copied-artifact acceptance test",
      mode: "dry_run",
    })

    expect(() => parseStagingKillSwitchOperatorArgs([])).toThrow(/action.*ENGAGED or DISENGAGED/)
    expect(() =>
      parseStagingKillSwitchOperatorArgs(["--action=disengaged", "--operator=sam", "--reason=required"])
    ).toThrow(/ENGAGED or DISENGAGED/)
    expect(() =>
      parseStagingKillSwitchOperatorArgs(["--action=ENGAGED", "--operator=sam", "--reason=   "])
    ).toThrow(/reason.*required/)
    expect(() =>
      parseStagingKillSwitchOperatorArgs(["--action=ENGAGED", "--reason=required"])
    ).toThrow(/operator.*required/)
  })

  test("requires --execute for mutation and rejects ambiguous or unknown modes", () => {
    expect(
      parseStagingKillSwitchOperatorArgs([
        "--action=ENGAGED",
        "--operator=sam",
        "--reason=Close the copied-artifact test window",
        "--execute",
      ]).mode
    ).toBe("execute")

    expect(() =>
      parseStagingKillSwitchOperatorArgs([
        "--action=ENGAGED",
        "--operator=sam",
        "--reason=required",
        "--execute",
        "--dry-run",
      ])
    ).toThrow(/mutually exclusive/)
    expect(() =>
      parseStagingKillSwitchOperatorArgs([
        "--action=ENGAGED",
        "--action=DISENGAGED",
        "--operator=sam",
        "--reason=required",
      ])
    ).toThrow(/Duplicate option: --action/)
    expect(() =>
      parseStagingKillSwitchOperatorArgs([
        "--action=ENGAGED",
        "--operator=sam",
        "--reason=required",
        "--mode=write-with-secret-value",
      ])
    ).toThrow("Unknown option: --mode")
  })

  test("dry-run never constructs the durable store and returns no operator reason", async () => {
    const createDurableStore = vi.fn(() => {
      throw new Error("must not be called")
    })
    const summary = await runStagingKillSwitchOperator(
      {
        action: "DISENGAGED",
        operator: "sam-private-operator",
        reason: "private copied-artifact validation reason",
        mode: "dry_run",
      },
      { now: () => new Date(NOW), createDurableStore }
    )

    expect(createDurableStore).not.toHaveBeenCalled()
    expect(summary).toMatchObject({
      status: "dry_run",
      mode: "dry_run",
      action: "DISENGAGED",
      scope: "global",
      scopeId: STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID,
      switchBlocksStagingWrites: false,
      durableSafetyStoreMutation: false,
      durableStateVerified: false,
      googleArtifactMutation: false,
      outcome: "not_recorded",
    })
    expect(JSON.stringify(summary)).not.toContain("sam-private-operator")
    expect(JSON.stringify(summary)).not.toContain("private copied-artifact validation reason")
  })

  test.each([
    ["DISENGAGED", false],
    ["ENGAGED", true],
  ] as const)("records and verifies an explicit %s event for only the fixed staging scope", async (action, enabled) => {
    let recorded: KillSwitchOperatorEvent | undefined
    const record = vi.fn(async (event: KillSwitchOperatorEvent) => {
      recorded = event
      return { id: event.eventId, outcome: "appended" as const }
    })
    const readStates = vi.fn(async () => (recorded ? [recorded.state] : []))
    const createDurableStore = vi.fn(() => ({ record, readStates }))

    const summary = await runStagingKillSwitchOperator(
      {
        action,
        operator: "sam",
        reason: "Copied-artifact validation window",
        mode: "execute",
      },
      { now: () => new Date(NOW), createDurableStore }
    )

    expect(createDurableStore).toHaveBeenCalledOnce()
    expect(record).toHaveBeenCalledOnce()
    expect(readStates).toHaveBeenCalledOnce()
    expect(recorded?.state).toEqual({
      scope: "global",
      scopeId: STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID,
      enabled,
      reason: "Copied-artifact validation window",
      updatedAt: NOW,
      updatedBy: "sam",
    })
    expect(summary).toMatchObject({
      status: "recorded",
      mode: "execute",
      action,
      switchBlocksStagingWrites: enabled,
      durableSafetyStoreMutation: true,
      durableStateVerified: true,
      googleArtifactMutation: false,
      outcome: "appended",
    })
  })

  test("fails closed with a public-safe error when the durable state cannot be confirmed", async () => {
    const dependencies: StagingKillSwitchOperatorDependencies = {
      now: () => new Date(NOW),
      createDurableStore: () => ({
        record: async (event) => ({ id: event.eventId, outcome: "appended" }),
        readStates: async () => [],
      }),
    }

    await expect(
      runStagingKillSwitchOperator(
        {
          action: "DISENGAGED",
          operator: "sam",
          reason: "Copied-artifact validation window",
          mode: "execute",
        },
        dependencies
      )
    ).rejects.toThrow("Durable kill-switch update was not confirmed; treat staging hydration as blocked")
  })

  test("does not surface durable-store diagnostics that could contain secrets", async () => {
    const dependencies: StagingKillSwitchOperatorDependencies = {
      now: () => new Date(NOW),
      createDurableStore: () => ({
        record: async () => {
          throw new Error("sensitive service-role credential")
        },
        readStates: async () => [],
      }),
    }

    const error = await runStagingKillSwitchOperator(
      {
        action: "ENGAGED",
        operator: "sam",
        reason: "Close copied-artifact validation window",
        mode: "execute",
      },
      dependencies
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain("sensitive service-role credential")
    expect((error as Error).message).toMatch(/treat staging hydration as blocked/)
  })
})
