import { OAuth2Client } from "google-auth-library"

import { noStoreJson } from "../../ytd/route-utils"

export const STAGING_HYDRATOR_OIDC_AUDIENCE_ENV =
  "RECOPS_STAGING_HYDRATOR_OIDC_AUDIENCE"
export const STAGING_HYDRATOR_SCHEDULER_SERVICE_ACCOUNT_ENV =
  "RECOPS_STAGING_HYDRATION_SCHEDULER_SERVICE_ACCOUNT"
export const RECRUITING_OPS_HYDRATION_SCHEDULER_SERVICE_ACCOUNT =
  "ta-ops-hydration-scheduler@example-project.iam.gserviceaccount.com"

/**
 * Does this `X-CloudScheduler-JobName` header name the given Scheduler job?
 *
 * Cloud Scheduler sends the job's SHORT id, not the full
 * `projects/…/locations/…/jobs/…` resource path, and every route here had been
 * comparing against the full path. The consequence was total and silent: the
 * orchestration scheduler's only lifetime fire (2026-07-21T06:30Z) was rejected
 * with HTTP 400, so a scheduled hydration run had never once started. No test
 * caught it because every test supplied whatever value its author assumed.
 *
 * Both forms are accepted so the comparison cannot break again on the shape of
 * a header we do not control. This is a discriminator, not the authentication —
 * the caller's identity is already established by the OIDC service-account
 * check, and a job id is unique within a project and location.
 */
export function schedulerJobNameMatches(
  header: string | null,
  expectedResourceName: string
): boolean {
  if (header === null) return false
  const supplied = header.trim()
  if (supplied === "") return false
  return supplied === expectedResourceName
    || supplied === expectedResourceName.split("/").pop()
}

export interface StagingHydrationOidcVerifier {
  verify(input: { idToken: string; audience: string }): Promise<{
    email?: string
    emailVerified?: boolean
  }>
}

const googleOidcClient = new OAuth2Client()
const googleOidcVerifier: StagingHydrationOidcVerifier = {
  async verify({ idToken, audience }) {
    const ticket = await googleOidcClient.verifyIdToken({ idToken, audience })
    const payload = ticket.getPayload()
    return {
      email: payload?.email,
      emailVerified: payload?.email_verified,
    }
  },
}

export async function requirePrivateHydratorAuthorization(
  request: Request,
  options: {
    env?: Readonly<Record<string, string | undefined>>
    oidcVerifier?: StagingHydrationOidcVerifier
  } = {}
): Promise<Response | null> {
  const env = options.env ?? process.env
  const expectedSecret = env.CRON_SECRET?.trim()
  const suppliedSecret = request.headers.get("x-recops-cron-secret")?.trim()
  if (expectedSecret && suppliedSecret === expectedSecret) return null
  return requireSchedulerHydratorAuthorization(request, options)
}

export async function requireSchedulerHydratorAuthorization(
  request: Request,
  options: {
    env?: Readonly<Record<string, string | undefined>>
    oidcVerifier?: StagingHydrationOidcVerifier
  } = {}
): Promise<Response | null> {
  const env = options.env ?? process.env
  const audience = env[STAGING_HYDRATOR_OIDC_AUDIENCE_ENV]?.trim()
  const expectedEmail = env[STAGING_HYDRATOR_SCHEDULER_SERVICE_ACCOUNT_ENV]
    ?.trim()
    .toLowerCase()
  if (
    !audience ||
    expectedEmail !== RECRUITING_OPS_HYDRATION_SCHEDULER_SERVICE_ACCOUNT
  ) {
    return unauthorizedResponse()
  }

  const authorization = request.headers.get("authorization")?.trim() ?? ""
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
  if (!match) return unauthorizedResponse()

  try {
    const identity = await (options.oidcVerifier ?? googleOidcVerifier).verify({
      idToken: match[1],
      audience,
    })
    if (
      identity.emailVerified !== true ||
      identity.email?.trim().toLowerCase() !== expectedEmail
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
