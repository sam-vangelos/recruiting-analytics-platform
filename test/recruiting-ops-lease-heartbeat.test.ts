import { describe, expect, test, vi } from "vitest"

import { createLeaseHeartbeat } from "../lib/recruiting-ops/delivery/lease-heartbeat"

describe("lease heartbeat", () => {
  test("renews every registered lease on a tick", async () => {
    const heartbeat = createLeaseHeartbeat(1_000)
    const run = vi.fn(async () => true)
    const source = vi.fn(async () => true)
    heartbeat.register("hydration_run", run)
    heartbeat.register("source_execution", source)

    await heartbeat.tick()
    await heartbeat.tick()

    expect(run).toHaveBeenCalledTimes(2)
    expect(source).toHaveBeenCalledTimes(2)
    expect(heartbeat.lostLeases().size).toBe(0)
    heartbeat.stop()
  })

  test("a renewal that returns false is recorded as lost and stops being renewed", async () => {
    const heartbeat = createLeaseHeartbeat(1_000)
    const renew = vi.fn(async () => false)
    heartbeat.register("hydration_run", renew)

    await heartbeat.tick()
    await heartbeat.tick()

    expect(renew).toHaveBeenCalledOnce()
    expect(heartbeat.lostLeases().has("hydration_run")).toBe(true)
    heartbeat.stop()
  })

  test("a renewal that throws is transient and is retried on the next tick", async () => {
    const heartbeat = createLeaseHeartbeat(1_000)
    const renew = vi.fn(async () => { throw new Error("network") })
    heartbeat.register("hydration_run", renew)

    await heartbeat.tick()
    await heartbeat.tick()

    expect(renew).toHaveBeenCalledTimes(2)
    expect(heartbeat.lostLeases().size).toBe(0)
    heartbeat.stop()
  })

  // The source lease is released deliberately the moment the cut is persisted.
  // A tick landing between that persist and the release sees a row that is no
  // longer 'running' and renews false — which must not be reported as a lost
  // lease, or the orchestrator abandons a run whose source is already safe.
  test("releasing a lease clears any loss recorded against it", async () => {
    const heartbeat = createLeaseHeartbeat(1_000)
    const release = heartbeat.register("source_execution", async () => false)

    await heartbeat.tick()
    expect(heartbeat.lostLeases().has("source_execution")).toBe(true)

    release()

    expect(heartbeat.lostLeases().has("source_execution")).toBe(false)
    heartbeat.stop()
  })

  // The orchestrator stops renewal before sealing the run and again in its
  // finally, so a second stop must be a no-op rather than a throw.
  test("stopping twice is a no-op, and a stopped heartbeat renews nothing", async () => {
    const heartbeat = createLeaseHeartbeat(1_000)
    const renew = vi.fn(async () => true)
    heartbeat.register("hydration_run", renew)

    heartbeat.stop()
    expect(() => heartbeat.stop()).not.toThrow()
    await heartbeat.tick()

    expect(renew).not.toHaveBeenCalled()
  })

  test("rejects an interval short enough to hammer the database", () => {
    expect(() => createLeaseHeartbeat(999)).toThrow(/at least 1000ms/)
  })
})
