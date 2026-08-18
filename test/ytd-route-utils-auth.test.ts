import { afterEach, describe, expect, test, vi } from "vitest"

import { requireBroadCandidateSurfaceAccess } from "../app/api/ytd/route-utils"

function request(path: string, authorization?: string) {
  return new Request(`https://example.test${path}`, {
    headers: authorization ? { authorization } : undefined,
  })
}

function basic(user: string, password: string) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
}

describe("YTD route broad candidate surface access", () => {
  afterEach(() => vi.unstubAllEnvs())

  test("fails closed for candidate application/data APIs when credentials are missing", () => {
    const response = requireBroadCandidateSurfaceAccess(request("/api/ytd/applications"))

    expect(response?.status).toBe(401)
    expect(response?.headers.get("cache-control")).toBe("no-store")
    expect(response?.headers.get("www-authenticate")).toContain("Recruiting Ops Candidate Surfaces")

    expect(requireBroadCandidateSurfaceAccess(request("/api/ytd/data-quality"))?.status).toBe(401)
  })

  test("allows candidate application APIs with configured bearer auth", () => {
    vi.stubEnv("RECRUITING_OPS_DASHBOARD_TOKEN", "route-token")

    expect(
      requireBroadCandidateSurfaceAccess(
        request("/api/ytd/referral/applications", "Bearer route-token")
      )
    ).toBeNull()
  })

  test("allows candidate application APIs with configured basic auth", () => {
    vi.stubEnv("RECRUITING_OPS_DASHBOARD_BASIC_USER", "sam")
    vi.stubEnv("RECRUITING_OPS_DASHBOARD_BASIC_PASSWORD", "secret")

    expect(
      requireBroadCandidateSurfaceAccess(request("/api/ytd/agency/applications", basic("sam", "secret")))
    ).toBeNull()
  })

  test("gates the aggregate and roster YTD APIs, which were previously open", () => {
    for (const path of [
      "/api/ytd/summary",
      "/api/ytd/referral/referrers",
      "/api/ytd/referral/recruiters",
      "/api/ytd/agency/agencies",
      "/api/ytd/agency/summary",
    ]) {
      expect(requireBroadCandidateSurfaceAccess(request(path))?.status).toBe(401)
    }
  })

  test("leaves scheduler ingestion routes to their own cron-secret guard", () => {
    expect(requireBroadCandidateSurfaceAccess(request("/api/ytd/incremental"))).toBeNull()
    expect(requireBroadCandidateSurfaceAccess(request("/api/ytd/backfill"))).toBeNull()
  })
})
