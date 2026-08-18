import { timingSafeEqual } from "node:crypto"

export const DASHBOARD_BEARER_TOKEN_ENV = "RECRUITING_OPS_DASHBOARD_TOKEN"
export const DASHBOARD_BASIC_USER_ENV = "RECRUITING_OPS_DASHBOARD_BASIC_USER"
export const DASHBOARD_BASIC_PASSWORD_ENV = "RECRUITING_OPS_DASHBOARD_BASIC_PASSWORD"
export const BROAD_CANDIDATE_SURFACE_BASIC_CHALLENGE =
  'Basic realm="Recruiting Ops Candidate Surfaces", charset="UTF-8"'

export type BroadCandidateSurfaceAccessDecision = {
  protectedSurface: boolean
  authorized: boolean
  reason:
    | "not_protected"
    | "authorized_bearer"
    | "authorized_basic"
    | "missing_credentials"
    | "invalid_credentials"
}

/**
 * Scheduler-driven ingestion routes under /api/ytd. These carry their own
 * fail-closed `requireCronSecret` check and are invoked with `Bearer
 * $CRON_SECRET`, which is deliberately NOT the dashboard credential — so
 * routing them through the dashboard guard would 401 the scheduler and stop
 * ingestion. This is the only exemption, and it is an exemption to a *different*
 * (stronger) auth, never to no auth.
 */
const CRON_AUTHENTICATED_YTD_PATHS = new Set(["/api/ytd/backfill", "/api/ytd/incremental"])

/**
 * Every read surface that exposes people — candidates, employees, referrers, or
 * recruiters — behind the shared dashboard credential.
 *
 * The `/api/ytd` prefix is deliberate rather than an enumeration. This guard
 * previously listed four exact paths, all of them candidate-application routes,
 * because the model behind it was "candidate PII". Nine sibling routes served
 * named employees, named referrers, and per-recruiter SLA performance with no
 * credential at all — not because anyone judged them safe to publish, but
 * because they were never on the list. An allowlist of what to protect fails
 * open on every route added after it; a prefix with a named exemption set fails
 * closed.
 */
export function isProtectedBroadCandidateSurfacePath(pathname: string): boolean {
  const normalized = normalizePathname(pathname)
  if (CRON_AUTHENTICATED_YTD_PATHS.has(normalized)) return false
  return (
    normalized === "/agency" ||
    normalized.startsWith("/agency/") ||
    normalized === "/referrals" ||
    normalized.startsWith("/referrals/") ||
    normalized === "/state-of-play" ||
    normalized.startsWith("/state-of-play/") ||
    normalized === "/api/ytd" ||
    normalized.startsWith("/api/ytd/")
  )
}

export function authorizeBroadCandidateSurfaceRequest(input: {
  pathname: string
  authorizationHeader: string | null | undefined
  env?: Record<string, string | undefined>
}): BroadCandidateSurfaceAccessDecision {
  if (!isProtectedBroadCandidateSurfacePath(input.pathname)) {
    return { protectedSurface: false, authorized: true, reason: "not_protected" }
  }

  const env = input.env ?? process.env
  const bearerToken = readNonBlank(env, DASHBOARD_BEARER_TOKEN_ENV)
  const basicUser = readNonBlank(env, DASHBOARD_BASIC_USER_ENV)
  const basicPassword = readNonBlank(env, DASHBOARD_BASIC_PASSWORD_ENV)
  const hasBearerCredential = Boolean(bearerToken)
  const hasBasicCredential = Boolean(basicUser && basicPassword)

  if (!hasBearerCredential && !hasBasicCredential) {
    return { protectedSurface: true, authorized: false, reason: "missing_credentials" }
  }

  const authorizationHeader = input.authorizationHeader?.trim() ?? ""
  if (bearerToken && bearerTokenMatches(authorizationHeader, bearerToken)) {
    return { protectedSurface: true, authorized: true, reason: "authorized_bearer" }
  }
  if (basicUser && basicPassword && basicCredentialsMatch(authorizationHeader, basicUser, basicPassword)) {
    return { protectedSurface: true, authorized: true, reason: "authorized_basic" }
  }

  return { protectedSurface: true, authorized: false, reason: "invalid_credentials" }
}

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1)
  return pathname
}

function readNonBlank(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name]?.trim()
  return value ? value : null
}

function bearerTokenMatches(header: string, expectedToken: string): boolean {
  const [scheme, token, extra] = header.split(/\s+/)
  if (extra || scheme?.toLowerCase() !== "bearer" || !token) return false
  return constantTimeEqual(token, expectedToken)
}

function basicCredentialsMatch(header: string, expectedUser: string, expectedPassword: string): boolean {
  const [scheme, credentials, extra] = header.split(/\s+/)
  if (extra || scheme?.toLowerCase() !== "basic" || !credentials) return false

  const decoded = decodeBasicCredentials(credentials)
  if (!decoded) return false
  return (
    constantTimeEqual(decoded.user, expectedUser) &&
    constantTimeEqual(decoded.password, expectedPassword)
  )
}

function decodeBasicCredentials(value: string): { user: string; password: string } | null {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8")
    const separatorIndex = decoded.indexOf(":")
    if (separatorIndex < 0) return null
    return {
      user: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    }
  } catch {
    return null
  }
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}
