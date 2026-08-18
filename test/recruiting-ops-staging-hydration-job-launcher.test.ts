import type { ChildProcess } from "node:child_process"
import { createServer } from "node:http"
import { describe, expect, test, vi } from "vitest"

import {
  DEFAULT_JOB_ROUTE_PATH,
  readJobLauncherConfig,
  runJobLauncherCli,
  runStagingHydrationJob,
} from "../scripts/recruiting-ops/staging-hydration-job-launcher.mjs"

const baseEnv = {
  NODE_ENV: "test" as const,
  RECOPS_JOB_PORT: "8181",
  RECOPS_JOB_STARTUP_TIMEOUT_MS: "1000",
  RECOPS_JOB_TIMEOUT_MS: "1000",
}

function response(status: string, httpStatus = 200): Response {
  return new Response(JSON.stringify({ status }), {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  })
}

describe("staging hydration Cloud Run Job launcher", () => {
  test.each(["succeeded", "no_change"])("returns terminal %s and always stops the server", async (status) => {
    const child = {} as ChildProcess
    const startServer = vi.fn(() => child)
    const waitForServer = vi.fn(async () => undefined)
    const stopServer = vi.fn(async () => undefined)
    const fetchImpl = vi.fn(async () => response(status))

    await expect(
      runStagingHydrationJob({
        env: baseEnv,
        createToken: () => "ephemeral-token",
        startServer,
        waitForServer,
        stopServer,
        fetchImpl,
      }),
    ).resolves.toEqual({ status })

    expect(startServer).toHaveBeenCalledWith({
      config: expect.objectContaining({
        host: "127.0.0.1",
        port: 8181,
        routeUrl: `http://127.0.0.1:8181${DEFAULT_JOB_ROUTE_PATH}`,
      }),
      env: baseEnv,
      token: "ephemeral-token",
    })
    expect(waitForServer).toHaveBeenCalledWith(child, expect.any(Object))
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://127.0.0.1:8181${DEFAULT_JOB_ROUTE_PATH}`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer ephemeral-token" }),
      }),
    )
    expect(stopServer).toHaveBeenCalledWith(child)
  })

  test.each(["partial", "failed", "timed_out"])("rejects terminal failure status %s", async (status) => {
    const stopServer = vi.fn(async () => undefined)

    await expect(
      runStagingHydrationJob({
        env: baseEnv,
        createToken: () => "token",
        startServer: () => ({} as ChildProcess),
        waitForServer: async () => undefined,
        stopServer,
        fetchImpl: async () => response(status),
      }),
    ).rejects.toThrow(`status ${status}`)
    expect(stopServer).toHaveBeenCalledOnce()
  })

  // A Cloud Run retry that collides logs overlap_in_progress last, so the
  // original cause has to be named in the line the first attempt already wrote.
  test("names the run and the artifacts that did not land in the failure it throws", async () => {
    await expect(
      runStagingHydrationJob({
        env: baseEnv,
        createToken: () => "token",
        startServer: () => ({} as ChildProcess),
        waitForServer: async () => undefined,
        stopServer: async () => undefined,
        fetchImpl: async () => new Response(JSON.stringify({
          status: "partial",
          reason: "execution_failed",
          runId: "11111111-1111-4111-8111-111111111111",
          failedArtifacts: ["final_offer", "rps_tracking"],
        }), { status: 200, headers: { "content-type": "application/json" } }),
      }),
    ).rejects.toThrow(
      "The orchestration ended with status partial. reason=execution_failed run=11111111-1111-4111-8111-111111111111 failed_artifacts=final_offer,rps_tracking"
    )
  })

  test("rejects non-2xx, non-JSON, and non-terminal responses", async () => {
    const runWith = (fetchImpl: typeof fetch) =>
      runStagingHydrationJob({
        env: baseEnv,
        createToken: () => "token",
        startServer: () => ({} as ChildProcess),
        waitForServer: async () => undefined,
        stopServer: async () => undefined,
        fetchImpl,
      })

    await expect(runWith(async () => response("succeeded", 503))).rejects.toThrow("HTTP 503")
    await expect(runWith(async () => new Response("not-json"))).rejects.toThrow("did not return JSON")
    await expect(runWith(async () => response("written"))).rejects.toThrow("terminal success status")
  })

  test("aborts a timed-out request and stops the server", async () => {
    const stopServer = vi.fn(async () => undefined)
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        }),
    )

    await expect(
      runStagingHydrationJob({
        env: { ...baseEnv, RECOPS_JOB_TIMEOUT_MS: "5" },
        createToken: () => "token",
        startServer: () => ({} as ChildProcess),
        waitForServer: async () => undefined,
        stopServer,
        fetchImpl,
      }),
    ).rejects.toThrow("timed out")
    expect(stopServer).toHaveBeenCalledOnce()
  })

  test("uses the Node HTTP client so delayed response headers are governed only by the job timeout", async () => {
    const server = createServer((_request, reply) => {
      setTimeout(() => {
        reply.writeHead(200, { "content-type": "application/json" })
        reply.end(JSON.stringify({ status: "no_change" }))
      }, 25)
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port.")

    const closeServer = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    )
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("global fetch used"))

    try {
      await expect(
        runStagingHydrationJob({
          env: { ...baseEnv, RECOPS_JOB_PORT: String(address.port) },
          createToken: () => "token",
          startServer: () => ({} as ChildProcess),
          waitForServer: async () => undefined,
          stopServer: closeServer,
        }),
      ).resolves.toEqual({ status: "no_change" })
      expect(globalFetch).not.toHaveBeenCalled()
      expect(closeServer).toHaveBeenCalledOnce()
    } finally {
      globalFetch.mockRestore()
      if (server.listening) await closeServer()
    }
  })

  test("keeps the job timeout active while the response body is pending", async () => {
    const server = createServer((_request, reply) => {
      reply.writeHead(200, { "content-type": "application/json" })
      reply.flushHeaders()
      setTimeout(() => reply.end(JSON.stringify({ status: "no_change" })), 250)
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port.")

    const closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })

    try {
      await expect(
        runStagingHydrationJob({
          env: { ...baseEnv, RECOPS_JOB_PORT: String(address.port), RECOPS_JOB_TIMEOUT_MS: "25" },
          createToken: () => "token",
          startServer: () => ({} as ChildProcess),
          waitForServer: async () => undefined,
          stopServer: closeServer,
        }),
      ).rejects.toThrow("timed out")
    } finally {
      if (server.listening) await closeServer()
    }
  })

  test("keeps the route on loopback and gives the CLI a nonzero failure exit", async () => {
    expect(readJobLauncherConfig({ ...baseEnv, RECOPS_JOB_ROUTE_PATH: "/custom/run" }).routeUrl).toBe(
      "http://127.0.0.1:8181/custom/run",
    )
    expect(() =>
      readJobLauncherConfig({ ...baseEnv, RECOPS_JOB_ROUTE_PATH: "//external.example/run" }),
    ).toThrow("loopback")
    expect(() =>
      readJobLauncherConfig({ ...baseEnv, RECOPS_JOB_TIMEOUT_MS: "10500001" }),
    ).toThrow("10500000")

    const stderr = vi.fn()
    await expect(
      runJobLauncherCli({
        run: async () => {
          throw new Error("The orchestration ended with status partial.")
        },
        stdout: vi.fn(),
        stderr,
      }),
    ).resolves.toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("status partial"))
  })
})
