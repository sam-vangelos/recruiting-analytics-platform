import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("@/lib/recruiting-ops/delivery/staging-hydration-watchdog", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/recruiting-ops/delivery/staging-hydration-watchdog")
  >()
  return { ...actual, runStagingHydrationWatchdog: vi.fn() }
})
vi.mock("@/lib/notification-delivery", () => ({ postSlackDm: vi.fn(async () => "ts") }))
vi.mock("@/lib/supabase", () => ({ getSupabase: vi.fn(() => { throw new Error("unused") }) }))

import {
  RECRUITING_OPS_HYDRATION_WATCHDOG_SCHEDULER_JOB_NAME,
  runStagingHydrationWatchdog,
} from "@/lib/recruiting-ops/delivery/staging-hydration-watchdog"
import { postSlackDm } from "@/lib/notification-delivery"
import { SWEEP_CONFIG } from "@/lib/sweep-config"
import { GET } from "../app/api/cron/recruiting-ops-staging-hydration-watchdog/route"
import {
  RECRUITING_OPS_HYDRATION_SCHEDULER_SERVICE_ACCOUNT,
  STAGING_HYDRATOR_OIDC_AUDIENCE_ENV,
  STAGING_HYDRATOR_SCHEDULER_SERVICE_ACCOUNT_ENV,
} from "../app/api/cron/recruiting-ops-staging-hydration/authorization"

const watchdog = vi.mocked(runStagingHydrationWatchdog)
const slack = vi.mocked(postSlackDm)

function request(jobName = RECRUITING_OPS_HYDRATION_WATCHDOG_SCHEDULER_JOB_NAME): Request {
  return new Request(
    "https://ta-ops-staging-hydrator.run.app/api/cron/recruiting-ops-staging-hydration-watchdog",
    { headers: { "x-recops-cron-secret": "watchdog-secret", "x-cloudscheduler-jobname": jobName } }
  )
}

describe("staging hydration watchdog route", () => {
  beforeEach(() => {
    // The watchdog runs on the hydrator service and reuses its scheduler
    // identity; the shared secret path is what makes it testable without OIDC.
    process.env.CRON_SECRET = "watchdog-secret"
    process.env[STAGING_HYDRATOR_OIDC_AUDIENCE_ENV] = "https://ta-ops-staging-hydrator.run.app"
    process.env[STAGING_HYDRATOR_SCHEDULER_SERVICE_ACCOUNT_ENV] =
      RECRUITING_OPS_HYDRATION_SCHEDULER_SERVICE_ACCOUNT
    watchdog.mockReset()
    slack.mockReset()
    slack.mockResolvedValue("ts")
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.CRON_SECRET
    delete process.env[STAGING_HYDRATOR_OIDC_AUDIENCE_ENV]
    delete process.env[STAGING_HYDRATOR_SCHEDULER_SERVICE_ACCOUNT_ENV]
  })

  test("stays silent and reports healthy when every due slot produced a run", async () => {
    watchdog.mockResolvedValue({ status: "healthy", checkedSlots: [], missingSlots: [] })

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(slack).not.toHaveBeenCalled()
  })

  test("alerts and answers 503 when a scheduled cycle produced no run at all", async () => {
    watchdog.mockResolvedValue({
      status: "missing_run",
      checkedSlots: [],
      missingSlots: [
        { scheduledAt: "2026-08-13T13:30:00.000Z", lane: "weekday_morning", dueArtifactCount: 10 },
      ],
    })

    const response = await GET(request())

    expect(response.status).toBe(503)
    expect(slack).toHaveBeenCalledOnce()
    expect(slack.mock.calls[0][0]).toBe(SWEEP_CONFIG.slack.recruitingOpsAlertUserId)
    expect(slack.mock.calls[0][1]).toContain("never started")
    expect(slack.mock.calls[0][1]).toContain("2026-08-13T13:30:00.000Z")
  })

  test("a failed send still leaves the missing run visible in the response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    slack.mockRejectedValueOnce(new Error("slack is down"))
    watchdog.mockResolvedValue({
      status: "missing_run",
      checkedSlots: [],
      missingSlots: [
        { scheduledAt: "2026-08-13T13:30:00.000Z", lane: "weekday_morning", dueArtifactCount: 10 },
      ],
    })

    const response = await GET(request())

    expect(response.status).toBe(503)
    expect((await response.json()).missingSlots).toHaveLength(1)
  })

  test("refuses a request that is not from its own scheduler job", async () => {
    watchdog.mockResolvedValue({ status: "healthy", checkedSlots: [], missingSlots: [] })

    const response = await GET(request(
      "projects/example-project/locations/us-central1/jobs/recops-staging-orchestration-weekday"
    ))

    expect(response.status).toBe(400)
    expect(watchdog).not.toHaveBeenCalled()
  })

  test("refuses an unauthenticated request", async () => {
    watchdog.mockResolvedValue({ status: "healthy", checkedSlots: [], missingSlots: [] })

    const response = await GET(new Request(
      "https://ta-ops-staging-hydrator.run.app/api/cron/recruiting-ops-staging-hydration-watchdog",
      { headers: { "x-cloudscheduler-jobname": RECRUITING_OPS_HYDRATION_WATCHDOG_SCHEDULER_JOB_NAME } }
    ))

    expect(response.status).toBe(401)
    expect(watchdog).not.toHaveBeenCalled()
  })
})
