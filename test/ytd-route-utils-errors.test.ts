import { afterEach, describe, expect, test, vi } from "vitest"

import { noStoreServerErrorJson } from "../app/api/ytd/route-utils"

describe("YTD route server error responses", () => {
  afterEach(() => vi.restoreAllMocks())

  test("logs full errors server-side but returns a generic no-store response", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const sensitiveError = new Error("SUPABASE_SERVICE_ROLE_KEY and candidate jane@example.com")

    const response = noStoreServerErrorJson("api/ytd/applications", sensitiveError)

    expect(response.status).toBe(500)
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toEqual({ error: "Internal server error" })
    expect(consoleError).toHaveBeenCalledWith("[api/ytd/applications] Failed:", sensitiveError)
  })
})
