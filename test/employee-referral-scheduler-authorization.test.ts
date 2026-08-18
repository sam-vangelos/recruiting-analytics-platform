import { OAuth2Client } from "google-auth-library"
import { afterEach, describe, expect, test, vi } from "vitest"

import {
  EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE,
  EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE_ENV,
  EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT,
  EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT_ENV,
  EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT,
  EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT_ENV,
  requireEmployeeReferralReportSchedulerAuthorization,
  requireEmployeeReferralWatchdogSchedulerAuthorization,
  type EmployeeReferralSchedulerOidcVerifier,
} from "../app/api/cron/employee-referral-scheduler-authorization"

const REPORT_SUBJECT = "100000000000000000002"
const WATCHDOG_SUBJECT = "100000000000000000001"
const REPORT_JOB =
  "projects/example-project/locations/us-central1/jobs/employee-referral-monthly-report"
const WATCHDOG_JOB =
  "projects/example-project/locations/us-central1/jobs/employee-referral-monthly-watchdog"
const SIGNED_REPORT_ID_TOKEN = "report.payload.signature"
const SIGNED_WATCHDOG_ID_TOKEN = "watchdog.payload.signature"

const configuredEnv = {
  [EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE_ENV]:
    EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE,
  [EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT_ENV]:
    EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT,
  [EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT_ENV]:
    EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT,
}

function schedulerRequest(
  jobName: string,
  input: {
    bearer?: string
    scheduler?: string
    schedulerJobName?: string
  } = {}
) {
  const headers = new Headers()
  if (input.bearer !== undefined) {
    headers.set("authorization", `Bearer ${input.bearer}`)
  }
  headers.set("x-cloudscheduler", input.scheduler ?? "true")
  headers.set("x-cloudscheduler-jobname", input.schedulerJobName ?? jobName)
  return new Request("https://service.example/api/cron/employee-referral", {
    headers,
  })
}

function verifier(identity: {
  subject?: string
  email?: string
  emailVerified?: boolean
}): EmployeeReferralSchedulerOidcVerifier {
  return { verify: vi.fn(async () => identity) }
}

describe("employee referral Scheduler OIDC authorization", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("delegates signature, issuer, time, audience, and lifetime validation to Google", async () => {
    const verifyIdToken = vi
      .spyOn(OAuth2Client.prototype, "verifyIdToken")
      .mockResolvedValue({
        getPayload: () => ({
          sub: REPORT_SUBJECT,
          email: EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT,
          email_verified: true,
          iat: 1_000,
          exp: 4_600,
        }),
      } as never)

    expect(
      await requireEmployeeReferralReportSchedulerAuthorization(
        schedulerRequest(REPORT_JOB, { bearer: SIGNED_REPORT_ID_TOKEN }),
        { env: configuredEnv }
      )
    ).toBeNull()
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: SIGNED_REPORT_ID_TOKEN,
      audience: EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE,
      maxExpiry: 3901,
    })
  })

  test("rejects a Google-signed token whose declared lifetime exceeds one hour", async () => {
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => ({
        sub: REPORT_SUBJECT,
        email: EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT,
        email_verified: true,
        iat: 1_000,
        exp: 4_601,
      }),
    } as never)

    expect(
      (
        await requireEmployeeReferralReportSchedulerAuthorization(
          schedulerRequest(REPORT_JOB, { bearer: SIGNED_REPORT_ID_TOKEN }),
          { env: configuredEnv }
        )
      )?.status
    ).toBe(401)
  })

  test("accepts only the report identity with the fixed audience and route binding", async () => {
    const oidcVerifier = verifier({
      subject: REPORT_SUBJECT,
      email: EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT,
      emailVerified: true,
    })

    expect(
      await requireEmployeeReferralReportSchedulerAuthorization(
        schedulerRequest(REPORT_JOB, { bearer: SIGNED_REPORT_ID_TOKEN }),
        { env: configuredEnv, oidcVerifier }
      )
    ).toBeNull()
    expect(oidcVerifier.verify).toHaveBeenCalledWith({
      idToken: SIGNED_REPORT_ID_TOKEN,
      audience: EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE,
      maxExpiry: 3901,
    })
  })

  test("accepts only the watchdog identity with the fixed audience and route binding", async () => {
    const oidcVerifier = verifier({
      subject: WATCHDOG_SUBJECT,
      email: EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT,
      emailVerified: true,
    })

    expect(
      await requireEmployeeReferralWatchdogSchedulerAuthorization(
        schedulerRequest(WATCHDOG_JOB, { bearer: SIGNED_WATCHDOG_ID_TOKEN }),
        { env: configuredEnv, oidcVerifier }
      )
    ).toBeNull()
  })

  test("fails closed on missing or drifted immutable deployment bindings", async () => {
    const verify = vi.fn()
    const oidcVerifier = { verify }
    const request = schedulerRequest(REPORT_JOB, {
      bearer: SIGNED_REPORT_ID_TOKEN,
    })
    const invalidEnvironments = [
      {},
      {
        ...configuredEnv,
        [EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE_ENV]:
          "https://another-service.example.run.app",
      },
      {
        ...configuredEnv,
        [EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT_ENV]:
          EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT,
      },
    ]

    for (const env of invalidEnvironments) {
      expect(
        (
          await requireEmployeeReferralReportSchedulerAuthorization(request, {
            env,
            oidcVerifier,
          })
        )?.status
      ).toBe(401)
    }
    expect(verify).not.toHaveBeenCalled()
  })

  test("rejects a missing Scheduler marker before token verification", async () => {
    const verify = vi.fn()
    const oidcVerifier = { verify }
    const request = schedulerRequest(REPORT_JOB, {
      bearer: SIGNED_REPORT_ID_TOKEN,
      scheduler: "false",
    })

    expect(
      (
        await requireEmployeeReferralReportSchedulerAuthorization(request, {
          env: configuredEnv,
          oidcVerifier,
        })
      )?.status
    ).toBe(401)
    expect(verify).not.toHaveBeenCalled()
  })

  test("does not treat the unsigned Scheduler job-name header as identity", async () => {
    const oidcVerifier = verifier({
      subject: REPORT_SUBJECT,
      email: EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT,
      emailVerified: true,
    })

    expect(
      await requireEmployeeReferralReportSchedulerAuthorization(
        schedulerRequest(REPORT_JOB, {
          bearer: SIGNED_REPORT_ID_TOKEN,
          schedulerJobName: WATCHDOG_JOB,
        }),
        { env: configuredEnv, oidcVerifier }
      )
    ).toBeNull()
    expect(oidcVerifier.verify).toHaveBeenCalledOnce()
  })

  test("rejects missing, malformed, oversized, or cryptographically invalid tokens", async () => {
    const verify = vi.fn(async () => {
      throw new Error("invalid signature")
    })
    const oidcVerifier = { verify }
    const requests = [
      schedulerRequest(REPORT_JOB),
      schedulerRequest(REPORT_JOB, { bearer: "contains whitespace" }),
      schedulerRequest(REPORT_JOB, { bearer: "a".repeat(8193) }),
      schedulerRequest(REPORT_JOB, { bearer: "legacy-static-secret" }),
      schedulerRequest(REPORT_JOB, { bearer: "forged.payload.signature" }),
    ]

    for (const request of requests) {
      expect(
        (
          await requireEmployeeReferralReportSchedulerAuthorization(request, {
            env: configuredEnv,
            oidcVerifier,
          })
        )?.status
      ).toBe(401)
    }
    expect(verify).toHaveBeenCalledOnce()
  })

  test.each([
    {
      subject: WATCHDOG_SUBJECT,
      email: EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT,
      emailVerified: true,
    },
    {
      subject: REPORT_SUBJECT,
      email: EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT,
      emailVerified: true,
    },
    {
      subject: REPORT_SUBJECT,
      email: EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT,
      emailVerified: false,
    },
    {
      subject: REPORT_SUBJECT,
      emailVerified: true,
    },
  ])("rejects an unapproved decoded report identity", async (identity) => {
    expect(
      (
        await requireEmployeeReferralReportSchedulerAuthorization(
          schedulerRequest(REPORT_JOB, { bearer: SIGNED_REPORT_ID_TOKEN }),
          { env: configuredEnv, oidcVerifier: verifier(identity) }
        )
      )?.status
    ).toBe(401)
  })

  test("prevents the watchdog identity from invoking the report route", async () => {
    expect(
      (
        await requireEmployeeReferralReportSchedulerAuthorization(
          schedulerRequest(REPORT_JOB, { bearer: SIGNED_WATCHDOG_ID_TOKEN }),
          {
            env: configuredEnv,
            oidcVerifier: verifier({
              subject: WATCHDOG_SUBJECT,
              email: EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT,
              emailVerified: true,
            }),
          }
        )
      )?.status
    ).toBe(401)
  })
})
