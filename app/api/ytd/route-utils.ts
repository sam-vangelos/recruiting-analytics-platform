import { NextResponse } from "next/server"
import {
  BROAD_CANDIDATE_SURFACE_BASIC_CHALLENGE,
  authorizeBroadCandidateSurfaceRequest,
} from "../../../lib/broad-candidate-surface-auth"
import { readEnv } from "../../../lib/env"
import type { YtdChannelInput } from "../../../lib/ytd-types"

export const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error"

export function noStoreJson(body: unknown, init?: ResponseInit) {
  const res = NextResponse.json(body, init)
  res.headers.set("Cache-Control", "no-store")
  return res
}

export function logServerError(routeLabel: string, err: unknown) {
  console.error(`[${routeLabel}] Failed:`, err)
}

export function noStoreServerErrorJson(routeLabel: string, err: unknown, status = 500) {
  logServerError(routeLabel, err)
  return noStoreJson({ error: INTERNAL_SERVER_ERROR_MESSAGE }, { status })
}

export function requireCronSecret(request: Request) {
  const cronSecret = readEnv("CRON_SECRET")?.trim()
  const authHeader = request.headers.get("authorization")
  // Fail CLOSED: an unset/blank CRON_SECRET rejects rather than waving the request
  // through. These routes write via the service-role client, so an unconfigured deploy
  // must NOT expose them — a missing secret is a misconfiguration, not an allow-all.
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return noStoreJson({ error: "Unauthorized" }, { status: 401 })
  }
  return null
}

export function requireBroadCandidateSurfaceAccess(request: Request) {
  const decision = authorizeBroadCandidateSurfaceRequest({
    pathname: new URL(request.url).pathname,
    authorizationHeader: request.headers.get("authorization"),
  })
  if (decision.authorized) return null

  const response = noStoreJson({ error: "Unauthorized" }, { status: 401 })
  response.headers.set("WWW-Authenticate", BROAD_CANDIDATE_SURFACE_BASIC_CHALLENGE)
  return response
}

export function parseYear(value: string | null | undefined): number {
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed >= 2000 && parsed <= 2100) return parsed
  return new Date().getUTCFullYear()
}

export function parseBoolean(value: string | null): boolean | undefined {
  if (value === "true") return true
  if (value === "false") return false
  return undefined
}

export function parseChannel(value: unknown): YtdChannelInput {
  return value === "referral" || value === "agency" || value === "all" ? value : "all"
}

export async function parseSyncBody(request: Request): Promise<{
  year: number
  channel: YtdChannelInput
  dry_run: boolean
}> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  return {
    year: parseYear(typeof body.year === "number" || typeof body.year === "string" ? String(body.year) : null),
    channel: parseChannel(body.channel),
    dry_run: Boolean(body.dry_run),
  }
}
