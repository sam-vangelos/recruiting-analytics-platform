// Transient-5xx retry. The referral census fetch paginates ~5 pages of
// /applications per hourly tick, and Greenhouse intermittently answers a cursor page with 503 —
// the first live census tick (2026-08-12 19:00Z) died exactly this way. The client retried only
// 429 and revoked-token 401; a single transient gateway error therefore killed the whole sweep
// run. 502/503/504 now retry like the 429 path (bounded by MAX_RETRIES and the request budget).
// A plain 500 stays fail-fast: it signals a request the server rejects, and retrying it would
// just triple the load for the same failure.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const tokenResponse = () =>
  new Response(
    JSON.stringify({
      token_type: "Bearer",
      access_token: "token",
      expires_at: "2099-01-01T00:00:00Z",
    }),
    { status: 200 }
  )

const okBody = () => new Response(JSON.stringify([{ id: 1 }]), { status: 200 })

describe("Greenhouse client transient-5xx retry", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv("GREENHOUSE_CLIENT_ID", "client-id")
    vi.stubEnv("GREENHOUSE_CLIENT_SECRET", "client-secret")
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  test("a 503 followed by a 200 succeeds instead of killing the request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(okBody())
    vi.stubGlobal("fetch", fetchMock)
    const sleep = vi.fn(async () => undefined)
    const { greenhouseGet } = await import("../lib/greenhouse-client")

    const page = await greenhouseGet("/applications", undefined, { sleep })
    expect(page).toEqual({ data: [{ id: 1 }], nextCursor: null })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  test("a persistent 503 still fails, with the sanitized error", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("auth.greenhouse.io")
        ? tokenResponse()
        : new Response("upstream unavailable", { status: 503 })
    )
    vi.stubGlobal("fetch", fetchMock)
    const sleep = vi.fn(async () => undefined)
    const { greenhouseGet } = await import("../lib/greenhouse-client")

    const error = await greenhouseGet("/applications", undefined, { sleep }).catch((e) => e)
    expect(String(error)).toContain("503")
    expect(String(error)).not.toContain("upstream unavailable")
  })

  test("a 500 fails fast without retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)
    const sleep = vi.fn(async () => undefined)
    const { greenhouseGet } = await import("../lib/greenhouse-client")

    await expect(greenhouseGet("/applications", undefined, { sleep })).rejects.toThrow("500")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleep).not.toHaveBeenCalled()
  })

  test("a transient-retry wait beyond the caller's deadline aborts instead of sleeping", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("", { status: 503 }))
    vi.stubGlobal("fetch", fetchMock)
    const sleep = vi.fn(async () => undefined)
    const { greenhouseGet } = await import("../lib/greenhouse-client")

    await expect(
      greenhouseGet("/applications", undefined, {
        deadlineAtMs: 1_000,
        now: () => 0,
        sleep,
      })
    ).rejects.toThrow("deadline")
    expect(sleep).not.toHaveBeenCalled()
  })
})
