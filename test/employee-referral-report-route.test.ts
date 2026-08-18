import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { OAuth2Client } from "google-auth-library"

vi.mock("@/lib/recruiting-ops/employee-referral-report-runner", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/recruiting-ops/employee-referral-report-runner")
  >()
  return {
    ...actual,
    syncEmployeeReferralMasterSheet: vi.fn(),
  }
})

import { syncEmployeeReferralMasterSheet } from "@/lib/recruiting-ops/employee-referral-report-runner"
import {
  EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE,
  EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE_ENV,
  EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT,
  EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT_ENV,
} from "../app/api/cron/employee-referral-scheduler-authorization"
import { GET } from "../app/api/cron/employee-referral-report/route"

const sync = vi.mocked(syncEmployeeReferralMasterSheet)
const REPORT_JOB =
  "projects/example-project/locations/us-central1/jobs/employee-referral-monthly-report"
const REPORT_SUBJECT = "100000000000000000002"
const SIGNED_REPORT_ID_TOKEN = "report.payload.signature"

function request(bearer?: string) {
  const headers = new Headers({
    "x-cloudscheduler": "true",
    "x-cloudscheduler-jobname": REPORT_JOB,
  })
  if (bearer) headers.set("authorization", `Bearer ${bearer}`)
  return new Request("https://service.example/api/cron/employee-referral-report", {
    headers,
  })
}

describe("employee referral report cron route", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "legacy-static-secret"
    process.env[EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE_ENV] =
      EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE
    process.env[EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT_ENV] =
      EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockImplementation(
      async ({ idToken, audience }) => {
        if (
          idToken !== SIGNED_REPORT_ID_TOKEN ||
          audience !== EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE
        ) {
          throw new Error("invalid token")
        }
        return {
          getPayload: () => ({
            sub: REPORT_SUBJECT,
            email: EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT,
            email_verified: true,
            iat: 1_000,
            exp: 4_600,
          }),
        } as never
      }
    )
    sync.mockReset()
    sync.mockResolvedValue({
      status: "sheet_updated",
      correlationId: "corr-public",
      periodStartLocal: "2026-07-01",
      periodEndLocalExclusive: "2026-08-01",
      counts: {
        currentCohortCount: 2,
        deprecatedReviewCount: 1,
        ungovernedSourceReviewCount: 0,
        amountMappedCount: 2,
        mappingReviewCount: 1,
        totalRowCount: 3,
      },
      updatedTabs: ["2026-07"],
      currentCohortRowCount: 2,
    })
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env[EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE_ENV]
    delete process.env[EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT_ENV]
    vi.restoreAllMocks()
  })

  test.each([undefined, "legacy-static-secret"])(
    "returns 401 for a missing token or the retired static bearer without touching the runner (%s)",
    async (bearer) => {
      const response = await GET(request(bearer))
      expect(response.status).toBe(401)
      expect(sync).not.toHaveBeenCalled()
    }
  )

  test("syncs once when authorized and returns aggregate state without PII", async () => {
    const response = await GET(request(SIGNED_REPORT_ID_TOKEN))
    const body = await response.json()
    const serialized = JSON.stringify(body)

    expect(response.status).toBe(200)
    expect(sync).toHaveBeenCalledOnce()
    expect(body).toMatchObject({
      status: "sheet_updated",
      correlation_id: "corr-public",
      period_start_local: "2026-07-01",
      period_end_local_exclusive: "2026-08-01",
      counts: { totalRowCount: 3 },
      updated_tabs: ["2026-07"],
      current_cohort_row_count: 2,
    })
    expect(serialized).not.toMatch(/candidate|referrer|@example\.com/i)
  })

  test("surfaces failure as 500 while suppressing private diagnostics", async () => {
    const canary = "Private Candidate candidate@example.com SECRET_REPORT_BODY"
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    sync.mockRejectedValueOnce(new Error(canary))

    const response = await GET(request(SIGNED_REPORT_ID_TOKEN))
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain(canary)
    expect(JSON.stringify(error.mock.calls)).not.toContain(canary)
  })
})
