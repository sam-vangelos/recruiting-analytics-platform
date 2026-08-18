import { OAuth2Client } from "google-auth-library"

import { noStoreJson } from "../ytd/route-utils"

export const EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE_ENV =
  "EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE"
export const EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT_ENV =
  "EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT"
export const EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT_ENV =
  "EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT"

export const EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE =
  "https://ta-ops-analytics-abcdefghij-uc.a.run.app"
export const EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT =
  "ta-ops-ref-report-scheduler@example-project.iam.gserviceaccount.com"
export const EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT =
  "ta-ops-ref-watchdog-scheduler@example-project.iam.gserviceaccount.com"

const EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SUBJECT = "100000000000000000002"
const EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SUBJECT = "100000000000000000001"
const MAX_ID_TOKEN_LENGTH = 8192
const MAX_ID_TOKEN_LIFETIME_SECONDS = 3600
const GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS = 300
// google-auth-library compares maxExpiry to the verifier's wall clock before
// applying its five-minute clock-skew allowance. Keep that horizon compatible
// with the library, then independently enforce Google's one-hour token lifetime.
const MAX_ID_TOKEN_EXPIRY_HORIZON_SECONDS =
  MAX_ID_TOKEN_LIFETIME_SECONDS + GOOGLE_ID_TOKEN_CLOCK_SKEW_SECONDS + 1

export interface EmployeeReferralSchedulerOidcVerifier {
  verify(input: {
    idToken: string
    audience: string
    maxExpiry: number
  }): Promise<{
    subject?: string
    email?: string
    emailVerified?: boolean
  }>
}

interface AuthorizationOptions {
  env?: Readonly<Record<string, string | undefined>>
  oidcVerifier?: EmployeeReferralSchedulerOidcVerifier
}

interface SchedulerBinding {
  serviceAccountEnv: string
  serviceAccountEmail: string
  serviceAccountSubject: string
}

const googleOidcClient = new OAuth2Client()
const googleOidcVerifier: EmployeeReferralSchedulerOidcVerifier = {
  async verify({ idToken, audience, maxExpiry }) {
    const ticket = await googleOidcClient.verifyIdToken({
      idToken,
      audience,
      maxExpiry,
    })
    const payload = ticket.getPayload()
    const issuedAt = payload?.iat
    const expiresAt = payload?.exp
    if (
      typeof issuedAt !== "number" ||
      typeof expiresAt !== "number" ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > MAX_ID_TOKEN_LIFETIME_SECONDS
    ) {
      throw new Error("Invalid Google service-account ID token lifetime")
    }
    return {
      subject: payload?.sub,
      email: payload?.email,
      emailVerified: payload?.email_verified,
    }
  },
}

const reportBinding: SchedulerBinding = {
  serviceAccountEnv: EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT_ENV,
  serviceAccountEmail: EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT,
  serviceAccountSubject: EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SUBJECT,
}

const watchdogBinding: SchedulerBinding = {
  serviceAccountEnv: EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT_ENV,
  serviceAccountEmail: EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT,
  serviceAccountSubject: EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SUBJECT,
}

export function requireEmployeeReferralReportSchedulerAuthorization(
  request: Request,
  options: AuthorizationOptions = {}
): Promise<Response | null> {
  return requireEmployeeReferralSchedulerAuthorization(request, reportBinding, options)
}

export function requireEmployeeReferralWatchdogSchedulerAuthorization(
  request: Request,
  options: AuthorizationOptions = {}
): Promise<Response | null> {
  return requireEmployeeReferralSchedulerAuthorization(request, watchdogBinding, options)
}

async function requireEmployeeReferralSchedulerAuthorization(
  request: Request,
  binding: SchedulerBinding,
  options: AuthorizationOptions
): Promise<Response | null> {
  const env = options.env ?? process.env
  const audience = env[EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE_ENV]?.trim()
  const expectedEmail = env[binding.serviceAccountEnv]?.trim().toLowerCase()
  if (
    audience !== EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE ||
    expectedEmail !== binding.serviceAccountEmail
  ) {
    return unauthorizedResponse()
  }

  if (request.headers.get("x-cloudscheduler") !== "true") {
    return unauthorizedResponse()
  }

  const authorization = request.headers.get("authorization")?.trim() ?? ""
  const match =
    /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
      authorization
    )
  const idToken = match?.[1]
  if (!idToken || idToken.length > MAX_ID_TOKEN_LENGTH) {
    return unauthorizedResponse()
  }

  try {
    const identity = await (options.oidcVerifier ?? googleOidcVerifier).verify({
      idToken,
      audience,
      maxExpiry: MAX_ID_TOKEN_EXPIRY_HORIZON_SECONDS,
    })
    if (
      identity.subject !== binding.serviceAccountSubject ||
      identity.emailVerified !== true ||
      identity.email?.trim().toLowerCase() !== binding.serviceAccountEmail
    ) {
      return unauthorizedResponse()
    }
    return null
  } catch {
    return unauthorizedResponse()
  }
}

function unauthorizedResponse(): Response {
  return noStoreJson({ error: "Unauthorized" }, { status: 401 })
}
