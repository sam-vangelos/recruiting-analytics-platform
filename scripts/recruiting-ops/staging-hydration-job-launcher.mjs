import { randomBytes } from "node:crypto"
import { once } from "node:events"
import { request } from "node:http"
import { createConnection } from "node:net"
import { resolve } from "node:path"
import { json } from "node:stream/consumers"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"

export const DEFAULT_JOB_ROUTE_PATH = "/api/cron/recruiting-ops-staging-orchestration"

const LOOPBACK_HOST = "127.0.0.1"
// Sized to the Cloud Run task timeout (3h) less the container's own startup and
// shutdown. A Thursday batch writes ten artifacts against Google, and no full
// batch has ever been timed end to end; the previous 55-minute ceiling was a
// guess that, if a batch overran it, ended the cycle `partial` and left the
// reports stale until the next Thursday.
const MAXIMUM_REQUEST_TIMEOUT_MS = 10_500_000
const SUCCESS_STATUSES = new Set(["succeeded", "no_change"])
const FAILURE_STATUSES = new Set(["partial", "failed", "timed_out"])

function fetchLoopback(url, init) {
  return new Promise((resolveResponse, rejectResponse) => {
    const pending = request(url, init, (response) => {
      resolveResponse({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: () => json(response),
      })
    })
    pending.once("error", rejectResponse)
    pending.end()
  })
}

function positiveInteger(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = value === undefined || value === "" ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`)
  }
  return parsed
}

export function readJobLauncherConfig(env = process.env) {
  const port = positiveInteger(env.RECOPS_JOB_PORT ?? env.PORT, 8080, "RECOPS_JOB_PORT", 65_535)
  const origin = `http://${LOOPBACK_HOST}:${port}`
  const routePath = env.RECOPS_JOB_ROUTE_PATH?.trim() || DEFAULT_JOB_ROUTE_PATH
  const routeUrl = new URL(routePath, origin)

  if (!routePath.startsWith("/") || routeUrl.origin !== origin) {
    throw new Error("RECOPS_JOB_ROUTE_PATH must be an absolute loopback path.")
  }

  return {
    host: LOOPBACK_HOST,
    port,
    routeUrl: routeUrl.href,
    startupTimeoutMs: positiveInteger(
      env.RECOPS_JOB_STARTUP_TIMEOUT_MS,
      60_000,
      "RECOPS_JOB_STARTUP_TIMEOUT_MS",
    ),
    requestTimeoutMs: positiveInteger(
      env.RECOPS_JOB_TIMEOUT_MS,
      MAXIMUM_REQUEST_TIMEOUT_MS,
      "RECOPS_JOB_TIMEOUT_MS",
      MAXIMUM_REQUEST_TIMEOUT_MS,
    ),
  }
}

export function startStandaloneServer({ config, env, token }) {
  return spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...env,
      HOSTNAME: config.host,
      PORT: String(config.port),
      RECOPS_JOB_BEARER_TOKEN: token,
    },
    stdio: "inherit",
  })
}

function portIsListening(host, port) {
  return new Promise((resolveListening) => {
    const socket = createConnection({ host, port })
    const finish = (listening) => {
      socket.destroy()
      resolveListening(listening)
    }
    socket.setTimeout(500, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

export async function waitForStandaloneServer(child, config) {
  const deadline = Date.now() + config.startupTimeoutMs
  let launchError = null
  const recordLaunchError = (error) => {
    launchError = error
  }
  child.on("error", recordLaunchError)

  try {
    while (Date.now() < deadline) {
      if (launchError) throw launchError
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("The standalone server exited before it was ready.")
      }
      if (await portIsListening(config.host, config.port)) return
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    throw new Error("Timed out waiting for the standalone server.")
  } finally {
    child.off("error", recordLaunchError)
  }
}

export async function stopStandaloneServer(child, graceMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  const exited = once(child, "exit")
  if (!child.kill("SIGTERM")) return

  let graceTimeout
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolveGrace) => {
      graceTimeout = setTimeout(() => resolveGrace(false), graceMs)
    }),
  ])
  clearTimeout(graceTimeout)
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
    await exited
  }
}

export async function runStagingHydrationJob({
  env = process.env,
  createToken = () => randomBytes(32).toString("base64url"),
  startServer = startStandaloneServer,
  waitForServer = waitForStandaloneServer,
  stopServer = stopStandaloneServer,
  fetchImpl = fetchLoopback,
} = {}) {
  const config = readJobLauncherConfig(env)
  const token = createToken()
  if (!token) throw new Error("The job launcher could not create a bearer token.")

  const child = startServer({ config, env, token })
  try {
    await waitForServer(child, config)

    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.requestTimeoutMs)

    try {
      const response = await fetchImpl(config.routeUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`The orchestration route returned HTTP ${response.status}.`)
      }

      let payload
      try {
        payload = await response.json()
      } catch {
        if (timedOut) throw new Error("The orchestration request timed out.")
        throw new Error("The orchestration route did not return JSON.")
      }

      const status = payload && typeof payload === "object" ? payload.status : null
      if (SUCCESS_STATUSES.has(status)) return payload
      if (FAILURE_STATUSES.has(status)) {
        // Name the run and the failed artifacts so a retry's overlap rejection
        // cannot mask the original cause as the last line in the job log.
        const detail = [
          payload.reason ? `reason=${payload.reason}` : null,
          payload.runId ? `run=${payload.runId}` : null,
          Array.isArray(payload.failedArtifacts) && payload.failedArtifacts.length > 0
            ? `failed_artifacts=${payload.failedArtifacts.join(",")}`
            : null,
        ].filter(Boolean).join(" ")
        throw new Error(`The orchestration ended with status ${status}.${detail ? ` ${detail}` : ""}`)
      }
      throw new Error("The orchestration route did not return a terminal success status.")
    } catch (error) {
      if (timedOut) throw new Error("The orchestration request timed out.")
      throw error
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    await stopServer(child)
  }
}

export async function runJobLauncherCli({ run = runStagingHydrationJob, stdout = console.log, stderr = console.error } = {}) {
  try {
    const result = await run()
    stdout(JSON.stringify({ status: result.status }))
    return 0
  } catch (error) {
    stderr(`[recruiting-ops staging job] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  process.exitCode = await runJobLauncherCli()
}
