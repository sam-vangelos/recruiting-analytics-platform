import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

describe("Greenhouse client privacy and pagination completeness", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv("GREENHOUSE_CLIENT_ID", "client-id")
    vi.stubEnv("GREENHOUSE_CLIENT_SECRET", "client-secret")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  test("does not log or throw a raw non-OK provider body", async () => {
    const canary = "candidate@example.com EMPLOYEE_REPORT_CONTENT"
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              token_type: "Bearer",
              access_token: "token",
              expires_at: "2099-01-01T00:00:00Z",
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response(canary, { status: 500, statusText: "Error" }))
    )
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const { greenhouseGet } = await import("../lib/greenhouse-client")

    const error = await greenhouseGet("/offers").catch((caught) => caught)
    expect(String(error)).not.toContain(canary)
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain(canary)
    expect(consoleError.mock.calls.flat().join(" ")).toContain("500")
  })

  test("rejects a repeated continuation cursor instead of looping or returning partial rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              token_type: "Bearer",
              access_token: "token",
              expires_at: "2099-01-01T00:00:00Z",
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: 1 }]), {
            status: 200,
            headers: {
              link: '<https://harvest.greenhouse.io/v3/offers?cursor=repeat>; rel="next"',
            },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: 2 }]), {
            status: 200,
            headers: {
              link: '<https://harvest.greenhouse.io/v3/offers?cursor=repeat>; rel="next"',
            },
          })
        )
    )
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const { greenhouseGetAll } = await import("../lib/greenhouse-client")
    await expect(greenhouseGetAll("/offers")).rejects.toThrow("repeated cursor")
  })

  test("does not begin a fetch or rate-limit backoff beyond the caller's phase deadline", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token_type: "Bearer",
            access_token: "token",
            expires_at: "2099-01-01T00:00:00Z",
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "Retry-After": "120" } })
      )
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const sleep = vi.fn(async () => undefined)
    const { greenhouseGet } = await import("../lib/greenhouse-client")

    await expect(
      greenhouseGet("/offers", undefined, {
        deadlineAtMs: 50_000,
        now: () => 0,
        sleep,
      })
    ).rejects.toThrow("deadline")
    expect(sleep).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockClear()
    await expect(
      greenhouseGet("/offers", undefined, { deadlineAtMs: 0, now: () => 0 })
    ).rejects.toThrow("deadline")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
