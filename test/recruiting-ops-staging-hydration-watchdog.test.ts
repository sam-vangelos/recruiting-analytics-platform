import { describe, expect, test, vi } from "vitest"

import { runStagingHydrationWatchdog } from "../lib/recruiting-ops/delivery/staging-hydration-watchdog"

/** 2026-08-13 is a Thursday; 08:30 Pacific daylight time is 15:30Z. */
const THURSDAY_0830_PACIFIC = Date.parse("2026-08-13T15:30:00.000Z")
const THURSDAY_MORNING_SLOT = "2026-08-13T13:30:00.000Z"
const WEDNESDAY_EVENING_SLOT = "2026-08-13T06:30:00.000Z"

function watchdog(claimed: readonly string[], nowMs = THURSDAY_0830_PACIFIC) {
  const claimedDedupeKeys = vi.fn(async () => new Set(claimed))
  return { claimedDedupeKeys, nowMs: () => nowMs }
}

describe("staging hydration watchdog", () => {
  test("stays quiet when both due slots produced a run", async () => {
    const dependencies = watchdog([
      `staging-hydration:v2:${THURSDAY_MORNING_SLOT}:write`,
      `staging-hydration:v2:${WEDNESDAY_EVENING_SLOT}:write`,
    ])

    const result = await runStagingHydrationWatchdog(dependencies)

    expect(result.status).toBe("healthy")
    expect(result.missingSlots).toEqual([])
    expect(result.checkedSlots.map((slot) => slot.scheduledAt)).toEqual([
      WEDNESDAY_EVENING_SLOT,
      THURSDAY_MORNING_SLOT,
    ])
  })

  // The silent stall: the scheduler, the launch call, or the job never fired,
  // so no run row exists and nothing else in the system can notice.
  test("reports the Thursday morning slot when no run was ever claimed for it", async () => {
    const dependencies = watchdog([`staging-hydration:v2:${WEDNESDAY_EVENING_SLOT}:write`])

    const result = await runStagingHydrationWatchdog(dependencies)

    expect(result.status).toBe("missing_run")
    expect(result.missingSlots).toEqual([{
      scheduledAt: THURSDAY_MORNING_SLOT,
      lane: "weekday_morning",
      dueArtifactCount: 10,
    }])
  })

  test("asks about the exact dedupe keys the claim would mint", async () => {
    const dependencies = watchdog([])

    await runStagingHydrationWatchdog(dependencies)

    expect(dependencies.claimedDedupeKeys).toHaveBeenCalledWith([
      `staging-hydration:v2:${WEDNESDAY_EVENING_SLOT}:write`,
      `staging-hydration:v2:${THURSDAY_MORNING_SLOT}:write`,
    ])
  })

  // A run row appears about a minute after the scheduler fires. Accusing a
  // cycle that is merely starting would make the alert worthless.
  test("says nothing about a slot that is only minutes old", async () => {
    const justAfterTheSlot = Date.parse(THURSDAY_MORNING_SLOT) + 10 * 60 * 1000
    const dependencies = watchdog([], justAfterTheSlot)

    const result = await runStagingHydrationWatchdog(dependencies)

    expect(result.missingSlots.map((slot) => slot.scheduledAt)).not.toContain(
      THURSDAY_MORNING_SLOT
    )
  })

  test("a weekend morning has no scheduled slot to miss", async () => {
    // 2026-08-16 is a Sunday; 08:30 Pacific is 15:30Z.
    const dependencies = watchdog([], Date.parse("2026-08-16T15:30:00.000Z"))

    const result = await runStagingHydrationWatchdog(dependencies)

    expect(result.status).toBe("healthy")
    expect(result.checkedSlots).toEqual([])
    expect(dependencies.claimedDedupeKeys).not.toHaveBeenCalled()
  })

  test("resolves the Pacific slot correctly on both sides of a DST change", async () => {
    // 2026-11-05 is the Thursday after the 2026-11-01 fall-back, so Pacific is
    // UTC-8 and the 06:30 slot is 14:30Z rather than 13:30Z.
    const dependencies = watchdog([], Date.parse("2026-11-05T16:30:00.000Z"))

    const result = await runStagingHydrationWatchdog(dependencies)

    expect(result.checkedSlots.map((slot) => slot.scheduledAt)).toContain(
      "2026-11-05T14:30:00.000Z"
    )
  })

  test("counts only the artifacts that slot was actually due to write", async () => {
    // Wednesday 08:30 Pacific: the morning slot carries All Hires alone.
    const dependencies = watchdog([], Date.parse("2026-08-12T15:30:00.000Z"))

    const result = await runStagingHydrationWatchdog(dependencies)

    const morning = result.missingSlots.find((slot) => slot.lane === "weekday_morning")
    expect(morning?.dueArtifactCount).toBe(1)
    const evening = result.missingSlots.find((slot) => slot.lane === "weekday_evening")
    expect(evening?.dueArtifactCount).toBe(1)
  })
})
