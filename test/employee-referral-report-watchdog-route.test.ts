import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { OAuth2Client } from "google-auth-library"

vi.mock("@/lib/recruiting-ops/employee-referral-report-runner", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/recruiting-ops/employee-referral-report-runner")
  >()
  return { ...actual, runEmployeeReferralWatchdog: vi.fn() }
})

import { runEmployeeReferralWatchdog } from "@/lib/recruiting-ops/employee-referral-report-runner"
import {
  EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE,
  EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE_ENV,
  EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT,
  EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT_ENV,
} from "../app/api/cron/employee-referral-scheduler-authorization"
import { GET } from "../app/api/cron/employee-referral-report-watchdog/route"

const run = vi.mocked(runEmployeeReferralWatchdog)
const WATCHDOG_JOB =
  "projects/example-project/locations/us-central1/jobs/employee-referral-monthly-watchdog"
const WATCHDOG_SUBJECT = "100000000000000000001"
const SIGNED_WATCHDOG_ID_TOKEN = "watchdog.payload.signature"

function request(bearer?: string) {
  const headers = new Headers({
    "x-cloudscheduler": "true",
    "x-cloudscheduler-jobname": WATCHDOG_JOB,
  })
  if (bearer) headers.set("authorization", `Bearer ${bearer}`)
  return new Request("https://service.example/api/cron/employee-referral-report-watchdog", {
    headers,
  })
}

describe("employee referral report watchdog route", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "legacy-static-secret"
    process.env[EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE_ENV] =
      EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE
    process.env[EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT_ENV] =
      EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT
    process.env.EMPLOYEE_REFERRAL_REPORT_SEND_ENABLED = "false"
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockImplementation(
      async ({ idToken, audience }) => {
        if (
          idToken !== SIGNED_WATCHDOG_ID_TOKEN ||
          audience !== EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE
        ) {
          throw new Error("invalid token")
        }
        return {
          getPayload: () => ({
            sub: WATCHDOG_SUBJECT,
            email: EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT,
            email_verified: true,
            iat: 1_000,
            exp: 4_600,
          }),
        } as never
      }
    )
    run.mockReset()
    run.mockResolvedValue({
      status: "healthy",
      checkedSlotCount: 2,
      unhealthyCount: 0,
      complaintCount: 0,
      lookupFailureCount: 0,
      missingDuePeriod: false,
    })
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env[EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE_ENV]
    delete process.env[EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT_ENV]
    delete process.env.EMPLOYEE_REFERRAL_REPORT_SEND_ENABLED
    vi.restoreAllMocks()
  })

  test.each([undefined, "legacy-static-secret"])(
    "requires the Scheduler OIDC token and rejects the retired static bearer (%s)",
    async (bearer) => {
      const response = await GET(request(bearer))
      expect(response.status).toBe(401)
      expect(run).not.toHaveBeenCalled()
    }
  )

  test("remains operational while the report send gate is false", async () => {
    const response = await GET(request(SIGNED_WATCHDOG_ID_TOKEN))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: "healthy", checkedSlotCount: 2 })
    expect(response.headers.get("cache-control")).toContain("no-store")
    expect(run).toHaveBeenCalledOnce()
  })

  test("returns 503 for aggregate unhealthy state so monitoring observes it", async () => {
    run.mockResolvedValueOnce({
      status: "unhealthy",
      checkedSlotCount: 2,
      unhealthyCount: 1,
      complaintCount: 0,
      lookupFailureCount: 1,
      missingDuePeriod: true,
    })
    const response = await GET(request(SIGNED_WATCHDOG_ID_TOKEN))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      status: "unhealthy",
      checkedSlotCount: 2,
      unhealthyCount: 1,
      complaintCount: 0,
      lookupFailureCount: 1,
      missingDuePeriod: true,
    })
  })

  test("returns a safe 500 when status recovery fails", async () => {
    const canary = "candidate@example.com SECRET_REPORT_BODY"
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    run.mockRejectedValueOnce(new Error(canary))

    const response = await GET(request(SIGNED_WATCHDOG_ID_TOKEN))
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain(canary)
    expect(JSON.stringify(error.mock.calls)).not.toContain(canary)
  })
})
