import { readFileSync, readdirSync } from "node:fs"

import { describe, expect, test } from "vitest"

import {
  authorizeBroadCandidateSurfaceRequest,
  isProtectedBroadCandidateSurfacePath,
} from "../lib/broad-candidate-surface-auth"

function basic(user: string, password: string) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
}

describe("broad candidate surface auth", () => {
  test("matches every people-bearing page and YTD API surface", () => {
    expect(isProtectedBroadCandidateSurfacePath("/agency")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/agency/ytd")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/referrals")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/referrals/ytd/")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/applications")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/agency/applications")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/referral/applications")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/data-quality")).toBe(true)

    // These served named employees, referrers and per-recruiter SLA metrics
    // anonymously until 2026-07-26 because the guard enumerated candidate
    // application routes instead of covering the prefix.
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/summary")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/referral/referrers")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/referral/recruiters")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/referral/summary")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/referral/filter-options")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/agency/agencies")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/agency/recruiters")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/agency/summary")).toBe(true)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/agency/filter-options")).toBe(true)

    // A route invented tomorrow is covered by the prefix, not by an edit here.
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/anything-new")).toBe(true)

    // Scheduler ingestion carries CRON_SECRET instead; routing it through the
    // dashboard credential would 401 Cloud Scheduler and stop ingestion.
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/backfill")).toBe(false)
    expect(isProtectedBroadCandidateSurfacePath("/api/ytd/incremental")).toBe(false)

    expect(isProtectedBroadCandidateSurfacePath("/agency-archive")).toBe(false)
    expect(isProtectedBroadCandidateSurfacePath("/api/cron/ytd-incremental")).toBe(false)
  })

  test("real Next proxy matcher reaches the whole YTD prefix", () => {
    const source = readFileSync("proxy.ts", "utf8")

    expect(source).toContain('"/api/ytd/:path*"')
    expect(source).toContain('"/agency/:path*"')
    expect(source).toContain('"/referrals/:path*"')
    expect(source).toContain('"/state-of-play/:path*"')
  })

  // Behavioral, not textual. An earlier draft of this test checked that each
  // route file *contained* the string "requireBroadCandidateSurfaceAccess";
  // deleting the call while leaving the import satisfied it, so it proved
  // nothing. This version executes every handler with no credentials and
  // requires a 401 — the guard has to actually run.
  test("every YTD route answers 401 unauthenticated, or is a cron route", async () => {
    // Relative to app/api/ytd, e.g. "referral/referrers".
    const routeDirs = readdirSync("app/api/ytd", { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith("/route.ts"))
      .map((entry) => entry.slice(0, -"/route.ts".length))
      .sort()
    expect(routeDirs.length).toBeGreaterThan(10)

    // The bundler resolves only one variable segment per dynamic import, so the
    // three known shapes each get their own loader. A fourth shape fails here
    // rather than being silently skipped.
    const load = async (dir: string) => {
      const segments = dir.split("/")
      if (segments.length === 1) return import(`../app/api/ytd/${segments[0]}/route.ts`)
      if (segments.length === 2 && segments[0] === "agency") {
        return import(`../app/api/ytd/agency/${segments[1]}/route.ts`)
      }
      if (segments.length === 2 && segments[0] === "referral") {
        return import(`../app/api/ytd/referral/${segments[1]}/route.ts`)
      }
      throw new Error(`Unhandled YTD route shape "${dir}" — add a loader so it stays covered.`)
    }

    const open: string[] = []
    for (const dir of routeDirs) {
      const pathname = `/api/ytd/${dir}`
      const source = readFileSync(`app/api/ytd/${dir}/route.ts`, "utf8")

      if (source.includes("requireCronSecret")) {
        // Cron routes carry their own fail-closed guard; assert the predicate's
        // exemption set still matches the code, so the two cannot drift apart.
        expect(isProtectedBroadCandidateSurfacePath(pathname)).toBe(false)
        continue
      }

      expect(isProtectedBroadCandidateSurfacePath(pathname)).toBe(true)

      const mod = (await load(dir)) as {
        GET?: (request: Request) => Promise<Response> | Response
      }
      if (!mod.GET) continue

      const response = await mod.GET(new Request(`https://example.test${pathname}`))
      if (response.status !== 401) open.push(`${pathname} -> ${response.status}`)
    }

    expect(open).toEqual([])
  })

  test("fails closed when no route credentials are configured", () => {
    expect(
      authorizeBroadCandidateSurfaceRequest({
        pathname: "/referrals",
        authorizationHeader: null,
        env: {},
      })
    ).toEqual({
      protectedSurface: true,
      authorized: false,
      reason: "missing_credentials",
    })
  })

  test("authorizes a configured bearer token and rejects the wrong token", () => {
    const env = { RECRUITING_OPS_DASHBOARD_TOKEN: "token-1" }

    expect(
      authorizeBroadCandidateSurfaceRequest({
        pathname: "/api/ytd/referral/applications",
        authorizationHeader: "Bearer token-1",
        env,
      })
    ).toMatchObject({ authorized: true, reason: "authorized_bearer" })

    expect(
      authorizeBroadCandidateSurfaceRequest({
        pathname: "/api/ytd/referral/applications",
        authorizationHeader: "Bearer token-2",
        env,
      })
    ).toMatchObject({ authorized: false, reason: "invalid_credentials" })
  })

  test("authorizes configured basic credentials for browser-facing pages", () => {
    const env = {
      RECRUITING_OPS_DASHBOARD_BASIC_USER: "sam",
      RECRUITING_OPS_DASHBOARD_BASIC_PASSWORD: "secret:with-colon",
    }

    expect(
      authorizeBroadCandidateSurfaceRequest({
        pathname: "/agency/ytd",
        authorizationHeader: basic("sam", "secret:with-colon"),
        env,
      })
    ).toMatchObject({ authorized: true, reason: "authorized_basic" })

    expect(
      authorizeBroadCandidateSurfaceRequest({
        pathname: "/agency/ytd",
        authorizationHeader: basic("sam", "wrong"),
        env,
      })
    ).toMatchObject({ authorized: false, reason: "invalid_credentials" })
  })

  test("treats partial basic configuration as missing credentials", () => {
    expect(
      authorizeBroadCandidateSurfaceRequest({
        pathname: "/agency",
        authorizationHeader: basic("sam", "secret"),
        env: { RECRUITING_OPS_DASHBOARD_BASIC_USER: "sam" },
      })
    ).toMatchObject({ authorized: false, reason: "missing_credentials" })
  })

  test("does not require dashboard credentials for unrelated or cron paths", () => {
    for (const pathname of ["/agency-archive", "/api/cron/ytd-incremental", "/api/ytd/incremental"]) {
      expect(
        authorizeBroadCandidateSurfaceRequest({
          pathname,
          authorizationHeader: null,
          env: {},
        })
      ).toEqual({
        protectedSurface: false,
        authorized: true,
        reason: "not_protected",
      })
    }
  })

  test("fails closed on the previously open people-bearing APIs", () => {
    for (const pathname of [
      "/api/ytd/summary",
      "/api/ytd/referral/referrers",
      "/api/ytd/referral/recruiters",
      "/api/ytd/agency/agencies",
    ]) {
      expect(
        authorizeBroadCandidateSurfaceRequest({
          pathname,
          authorizationHeader: null,
          env: {},
        })
      ).toEqual({
        protectedSurface: true,
        authorized: false,
        reason: "missing_credentials",
      })
    }
  })
})
