/**
 * Standalone Greenhouse Harvest v3 API client for Vercel serverless.
 *
 * Replicates auth + pagination patterns from ta-ops-agent/mcp/greenhouse/src:
 *   - OAuth2 client_credentials with 60s refresh buffer (auth.ts)
 *   - Link header parsing + cursor-only continuation pages (client.ts)
 *   - Rate-limit retry with Retry-After (client.ts lines 148-165)
 *   - Sanitized error messages with correlation IDs (client.ts lines 183-203)
 */

import { requireEnv } from "./env"

const TOKEN_URL = "https://auth.greenhouse.io/token"
const API_ORIGIN = "https://harvest.greenhouse.io"
const BASE_PATH = "/v3"

const MAX_RETRIES = 3
const DEFAULT_RETRY_SECONDS = 30
const MAX_RETRY_SECONDS = 120
const TOKEN_REQUEST_TIMEOUT_MS = 20_000
const API_REQUEST_TIMEOUT_MS = 60_000

export interface GreenhouseRequestOptions {
  deadlineAtMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

class GreenhouseDeadlineError extends Error {
  constructor() {
    super("Greenhouse request phase deadline was exhausted")
    this.name = "GreenhouseDeadlineError"
  }
}

function requestNow(options: GreenhouseRequestOptions): number {
  return (options.now ?? Date.now)()
}

function remainingRequestBudget(options: GreenhouseRequestOptions): number {
  return options.deadlineAtMs === undefined
    ? Number.POSITIVE_INFINITY
    : options.deadlineAtMs - requestNow(options)
}

function requireRequestBudget(options: GreenhouseRequestOptions): number {
  const remaining = remainingRequestBudget(options)
  if (remaining <= 0) throw new GreenhouseDeadlineError()
  return remaining
}

function timedSignal(options: GreenhouseRequestOptions, maximumMs: number) {
  const timeoutMs = Math.max(1, Math.min(maximumMs, requireRequestBudget(options)))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timeout) }
}

async function awaitWithinBudget<T>(
  promise: Promise<T>,
  options: GreenhouseRequestOptions
): Promise<T> {
  if (options.deadlineAtMs === undefined) return promise
  const remaining = requireRequestBudget(options)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new GreenhouseDeadlineError()), remaining)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Token management — module-scoped cache persists across warm Vercel invocations
// ---------------------------------------------------------------------------

interface TokenResponse {
  token_type: string
  access_token: string
  expires_at: string
}

let cachedToken: string | null = null
let tokenExpiresAt = 0
let tokenRefreshPromise: Promise<string> | null = null

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = requireEnv("GREENHOUSE_CLIENT_ID")
  const clientSecret = requireEnv("GREENHOUSE_CLIENT_SECRET")
  return { clientId, clientSecret }
}

async function requestAccessToken(options: GreenhouseRequestOptions): Promise<string> {
  const { clientId, clientSecret } = getCredentials()
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  )

  let res: Response
  let receivedResponse = false
  const request = timedSignal(options, TOKEN_REQUEST_TIMEOUT_MS)
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: request.signal,
    })
    receivedResponse = true
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error(`Failed to obtain access token: ${res.status} ${res.statusText}`)
    }
    const data = (await res.json()) as TokenResponse
    cachedToken = data.access_token
    tokenExpiresAt = new Date(data.expires_at).getTime()
    console.log(`[greenhouse] Token obtained, expires at ${data.expires_at}`)
    return cachedToken
  } catch (error) {
    if (request.signal.aborted) throw new GreenhouseDeadlineError()
    if (receivedResponse) throw error
    throw new Error("Failed to obtain Greenhouse access token")
  } finally {
    request.clear()
  }
}

async function getAccessToken(options: GreenhouseRequestOptions): Promise<string> {
  if (cachedToken && requestNow(options) < tokenExpiresAt - 60_000) {
    return cachedToken
  }

  tokenRefreshPromise ??= requestAccessToken(options).finally(() => {
    tokenRefreshPromise = null
  })
  return awaitWithinBudget(tokenRefreshPromise, options)
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

function buildUrl(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): string {
  const base = /^https?:\/\//.test(path)
    ? path
    : `${API_ORIGIN}${BASE_PATH}${path}`
  const url = new URL(base)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value))
      }
    }
  }
  return url.toString()
}

// ---------------------------------------------------------------------------
// Link header parsing — regex matches Greenhouse v3 pagination format
// ---------------------------------------------------------------------------

function parseLinkHeader(header: string | null): string | null {
  if (!header) return null
  const match = header.match(/<([^>]+)>;\s*rel="next"/)
  return match ? match[1] : null
}

// ---------------------------------------------------------------------------
// Rate-limit retry — up to 3 retries on 429, respects Retry-After header
// ---------------------------------------------------------------------------

class RateLimitError extends Error {
  retryAfterSeconds: number
  constructor(retryAfter: number) {
    super(`Rate limited. Retry after ${retryAfter} seconds.`)
    this.name = "RateLimitError"
    this.retryAfterSeconds = retryAfter
  }
}

class AuthTokenRevokedError extends Error {
  constructor(endpoint: string) {
    super(`Greenhouse token was refreshed or revoked while calling ${endpoint}.`)
    this.name = "AuthTokenRevokedError"
  }
}

/** A non-OK Greenhouse response, carried with its status and the ALREADY-SANITIZED message
 *  handleNonOkResponse builds (status + pathname + correlation id, never the body). Typed so the
 *  request catch blocks can pass it through instead of flattening it into the generic
 *  "Greenhouse API fetch failed" — that flattening silently broke every downstream matcher on
 *  `Greenhouse API error: 401|403` (sweep-agency.ts:320, greenhouse-evidence.ts:98,
 *  reconcile-identity route), so permission walls degraded to an opaque failure instead of the
 *  designed permission_blocked path, and a sweep_runs.error_message never named its status. */
export class GreenhouseApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "GreenhouseApiError"
    this.status = status
  }
}

// Gateway-transient statuses: a cursor page of the referral census fetch intermittently 503s
// (first observed killing the whole 2026-08-12 19:00Z sweep tick). Retried like 429, with a short
// fixed wait — unlike 429 there is no Retry-After to respect. A plain 500 is NOT here: it marks a
// request the server rejects, and retrying it triples load for the same failure.
const TRANSIENT_STATUSES = new Set([502, 503, 504])
const TRANSIENT_RETRY_SECONDS = 5

function clearCachedToken() {
  cachedToken = null
  tokenExpiresAt = 0
  tokenRefreshPromise = null
}

function parseRetryAfter(res: Response): number {
  const raw = parseInt(res.headers.get("Retry-After") || "", 10)
  return isNaN(raw) ? DEFAULT_RETRY_SECONDS : raw
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: GreenhouseRequestOptions
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    requireRequestBudget(options)
    try {
      return await fn()
    } catch (err) {
      if (err instanceof RateLimitError && attempt < MAX_RETRIES) {
        const waitSeconds = Math.min(
          err.retryAfterSeconds,
          MAX_RETRY_SECONDS
        )
        console.log(
          `[greenhouse] 429 rate limited — waiting ${waitSeconds}s (attempt ${attempt + 1}/${MAX_RETRIES})`
        )
        const waitMilliseconds = waitSeconds * 1000
        if (waitMilliseconds >= remainingRequestBudget(options)) {
          throw new GreenhouseDeadlineError()
        }
        await (options.sleep ?? ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds))))(
          waitMilliseconds
        )
        continue
      }
      if (err instanceof AuthTokenRevokedError && attempt < MAX_RETRIES) {
        clearCachedToken()
        console.log(
          `[greenhouse] token revoked during request — refreshing (attempt ${attempt + 1}/${MAX_RETRIES})`
        )
        continue
      }
      if (
        err instanceof GreenhouseApiError &&
        TRANSIENT_STATUSES.has(err.status) &&
        attempt < MAX_RETRIES
      ) {
        console.log(
          `[greenhouse] ${err.status} transient — waiting ${TRANSIENT_RETRY_SECONDS}s (attempt ${attempt + 1}/${MAX_RETRIES})`
        )
        const waitMilliseconds = TRANSIENT_RETRY_SECONDS * 1000
        if (waitMilliseconds >= remainingRequestBudget(options)) {
          throw new GreenhouseDeadlineError()
        }
        await (options.sleep ?? ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds))))(
          waitMilliseconds
        )
        continue
      }
      throw err
    }
  }
  throw new Error("Unreachable")
}

// ---------------------------------------------------------------------------
// Sanitized error handling — correlation IDs for cross-referencing logs
// ---------------------------------------------------------------------------

function newCorrelationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function handleNonOkResponse(
  res: Response,
  endpoint: string
): Promise<never> {
  const correlationId = newCorrelationId()
  let bodyText: string
  try {
    bodyText = await res.text()
  } catch {
    bodyText = "<unreadable>"
  }
  if (
    res.status === 401 &&
    /refreshed or revoked/i.test(bodyText)
  ) {
    throw new AuthTokenRevokedError(endpoint)
  }
  console.error(
    `[greenhouse] ERROR ${correlationId} ${res.status} ${endpoint}`
  )
  throw new GreenhouseApiError(
    res.status,
    `Greenhouse API error: ${res.status} ${res.statusText ?? ""} (${endpoint}) [correlation_id=${correlationId}]`
  )
}

// ---------------------------------------------------------------------------
// Core GET — returns data + nextCursor for pagination
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  data: T
  nextCursor: string | null
}

export async function greenhouseGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  options: GreenhouseRequestOptions = {}
): Promise<ApiResponse<T>> {
  return withRetry(async () => {
    const token = await getAccessToken(options)
    const url = buildUrl(path, params)
    const pathname = new URL(url).pathname

    console.log(`[greenhouse] GET ${pathname}`)

    let res: Response
    const request = timedSignal(options, API_REQUEST_TIMEOUT_MS)
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: request.signal,
      })
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined)
        throw new RateLimitError(parseRetryAfter(res))
      }
      if (!res.ok) await handleNonOkResponse(res, pathname)
      const data = (await res.json()) as T
      const nextUrl = parseLinkHeader(res.headers.get("link"))
      const nextCursor = nextUrl
        ? new URL(nextUrl).searchParams.get("cursor")
        : null
      return { data, nextCursor }
    } catch (error) {
      if (
        error instanceof RateLimitError ||
        error instanceof AuthTokenRevokedError ||
        error instanceof GreenhouseDeadlineError ||
        error instanceof GreenhouseApiError
      ) {
        throw error
      }
      throw request.signal.aborted
        ? new GreenhouseDeadlineError()
        : new Error("Greenhouse API fetch failed")
    } finally {
      request.clear()
    }
  }, options)
}

/**
 * Cursor-only pagination page. Per Greenhouse v3 docs, cursor must be the
 * sole query parameter on continuation pages — no other filters allowed.
 */
export async function greenhouseGetWithCursor<T>(
  path: string,
  cursor: string,
  options: GreenhouseRequestOptions = {}
): Promise<ApiResponse<T>> {
  return withRetry(async () => {
    const token = await getAccessToken(options)
    const url = new URL(`${API_ORIGIN}${BASE_PATH}${path}`)
    url.searchParams.set("cursor", cursor)
    const pathname = url.pathname

    console.log(`[greenhouse] GET (cursor) ${pathname}`)

    let res: Response
    const request = timedSignal(options, API_REQUEST_TIMEOUT_MS)
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: request.signal,
      })
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined)
        throw new RateLimitError(parseRetryAfter(res))
      }
      if (!res.ok) await handleNonOkResponse(res, pathname)
      const data = (await res.json()) as T
      const nextUrl = parseLinkHeader(res.headers.get("link"))
      const nextCursor = nextUrl
        ? new URL(nextUrl).searchParams.get("cursor")
        : null
      return { data, nextCursor }
    } catch (error) {
      if (
        error instanceof RateLimitError ||
        error instanceof AuthTokenRevokedError ||
        error instanceof GreenhouseDeadlineError ||
        error instanceof GreenhouseApiError
      ) {
        throw error
      }
      throw request.signal.aborted
        ? new GreenhouseDeadlineError()
        : new Error("Greenhouse API fetch failed")
    } finally {
      request.clear()
    }
  }, options)
}

/**
 * Follow cursors to exhaustion, returning all pages concatenated.
 * Expects the endpoint to return T[] (array) per page.
 */
export async function greenhouseGetAll<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  options: GreenhouseRequestOptions = {}
): Promise<T[]> {
  const firstPage = await greenhouseGet<T[]>(path, params, options)
  const allData: T[] = [...firstPage.data]

  let cursor = firstPage.nextCursor
  const seenCursors = new Set<string>()
  while (cursor) {
    if (seenCursors.has(cursor)) {
      throw new Error("Greenhouse pagination returned a repeated cursor; refusing partial output")
    }
    if (seenCursors.size >= 10_000) {
      throw new Error("Greenhouse pagination exceeded the safe page limit; refusing partial output")
    }
    seenCursors.add(cursor)
    const nextPage = await greenhouseGetWithCursor<T[]>(path, cursor, options)
    allData.push(...nextPage.data)
    cursor = nextPage.nextCursor
  }

  return allData
}

/**
 * Single record fetch (no pagination expected).
 */
export async function greenhouseGetOne<T>(
  path: string,
  options: GreenhouseRequestOptions = {}
): Promise<T> {
  const { data } = await greenhouseGet<T>(path, undefined, options)
  return data
}
