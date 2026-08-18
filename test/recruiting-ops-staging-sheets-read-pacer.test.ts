import { describe, expect, test } from "vitest"

import {
  createStagingSheetsReadPacer,
  STAGING_SHEETS_READ_MINIMUM_INTERVAL_MS,
} from "../lib/recruiting-ops/delivery/staging-sheets-read-pacer"

describe("staging Sheets read pacer", () => {
  test("serializes concurrent read slots at the configured interval", async () => {
    let nowMs = 1_000
    const sleeps: number[] = []
    const pacer = createStagingSheetsReadPacer({
      minimumIntervalMs: 1_500,
      nowMs: () => nowMs,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        nowMs += milliseconds
      },
    })

    await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()])

    expect(sleeps).toEqual([1_500, 1_500])
    expect(nowMs).toBe(4_000)
  })

  test("does not sleep after enough wall-clock time has elapsed", async () => {
    let nowMs = 1_000
    const sleeps: number[] = []
    const pacer = createStagingSheetsReadPacer({
      minimumIntervalMs: STAGING_SHEETS_READ_MINIMUM_INTERVAL_MS,
      nowMs: () => nowMs,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        nowMs += milliseconds
      },
    })

    await pacer.wait()
    nowMs += STAGING_SHEETS_READ_MINIMUM_INTERVAL_MS
    await pacer.wait()

    expect(sleeps).toEqual([])
  })

  test("places the forty-first slot at the next minute boundary", async () => {
    let nowMs = 0
    const pacer = createStagingSheetsReadPacer({
      minimumIntervalMs: STAGING_SHEETS_READ_MINIMUM_INTERVAL_MS,
      nowMs: () => nowMs,
      sleep: async (milliseconds) => {
        nowMs += milliseconds
      },
    })

    await Promise.all(Array.from({ length: 41 }, () => pacer.wait()))

    expect(nowMs).toBe(60_000)
  })

  test("rejects an invalid pacing interval", () => {
    expect(() => createStagingSheetsReadPacer({ minimumIntervalMs: -1 })).toThrow(
      "non-negative finite number"
    )
  })
})
