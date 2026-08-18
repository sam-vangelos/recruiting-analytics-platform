import { describe, expect, test } from "vitest"

import { schedulerJobNameMatches } from "../app/api/cron/recruiting-ops-staging-hydration/authorization"

const ORCHESTRATION =
  "projects/example-project/locations/us-central1/jobs/recops-staging-orchestration-weekday"
const WATCHDOG =
  "projects/example-project/locations/us-central1/jobs/recops-staging-hydration-watchdog"

describe("scheduler job-name matching", () => {
  // The bug this exists to prevent: Cloud Scheduler sends the SHORT job id, the
  // routes compared against the full resource path, and every scheduled fire
  // 400'd. The orchestration scheduler's only lifetime fire — 2026-07-21T06:30Z
  // — was rejected exactly this way, so a scheduled run had never once started.
  test("accepts the short job id Cloud Scheduler actually sends", () => {
    expect(schedulerJobNameMatches("recops-staging-orchestration-weekday", ORCHESTRATION)).toBe(true)
    expect(schedulerJobNameMatches("recops-staging-hydration-watchdog", WATCHDOG)).toBe(true)
  })

  test("still accepts the full resource path", () => {
    expect(schedulerJobNameMatches(ORCHESTRATION, ORCHESTRATION)).toBe(true)
    expect(schedulerJobNameMatches(WATCHDOG, WATCHDOG)).toBe(true)
  })

  test("rejects a different Scheduler job in either form", () => {
    expect(schedulerJobNameMatches("recops-staging-hydration-watchdog", ORCHESTRATION)).toBe(false)
    expect(schedulerJobNameMatches(WATCHDOG, ORCHESTRATION)).toBe(false)
    expect(schedulerJobNameMatches("recops-staging-elt-doc", ORCHESTRATION)).toBe(false)
  })

  test("rejects an absent, blank, or partial name", () => {
    expect(schedulerJobNameMatches(null, ORCHESTRATION)).toBe(false)
    expect(schedulerJobNameMatches("", ORCHESTRATION)).toBe(false)
    expect(schedulerJobNameMatches("   ", ORCHESTRATION)).toBe(false)
    expect(schedulerJobNameMatches("jobs/recops-staging-orchestration-weekday", ORCHESTRATION)).toBe(false)
    expect(schedulerJobNameMatches("weekday", ORCHESTRATION)).toBe(false)
  })

  test("tolerates the surrounding whitespace a proxy may add", () => {
    expect(schedulerJobNameMatches("  recops-staging-hydration-watchdog  ", WATCHDOG)).toBe(true)
  })
})
