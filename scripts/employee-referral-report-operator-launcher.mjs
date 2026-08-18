import { randomBytes } from "node:crypto"
import { once } from "node:events"
import { request } from "node:http"
import { createConnection } from "node:net"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"

export const OPERATOR_ROUTE_PATH = "/api/internal/employee-referral-report-operator"

const LOOPBACK_HOST = "127.0.0.1"
const MAX_OPERATION_TIMEOUT_MS = 870_000
const SHUTDOWN_MARGIN_MS = 5_000
const MAX_RESPONSE_BYTES = 1024 * 1024

function positiveInteger(value, fallback, name, maximum) {
  const parsed = value === undefined || value === "" ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`)
  }
  return parsed
}

export function readOperatorLauncherConfig(env = process.env) {
  const port = positiveInteger(
    env.EMPLOYEE_REFERRAL_REPORT_OPERATOR_PORT ?? env.PORT,
    8080,
    "EMPLOYEE_REFERRAL_REPORT_OPERATOR_PORT",
    65_535
  )
  const operationTimeoutMs = positiveInteger(
    env.EMPLOYEE_REFERRAL_REPORT_OPERATOR_TIMEOUT_MS,
    MAX_OPERATION_TIMEOUT_MS,
    "EMPLOYEE_REFERRAL_REPORT_OPERATOR_TIMEOUT_MS",
    MAX_OPERATION_TIMEOUT_MS
  )
  if (operationTimeoutMs <= SHUTDOWN_MARGIN_MS) {
    throw new Error(
      `EMPLOYEE_REFERRAL_REPORT_OPERATOR_TIMEOUT_MS must exceed ${SHUTDOWN_MARGIN_MS}.`
    )
  }
  return {
    host: LOOPBACK_HOST,
    port,
    routeUrl: `http://${LOOPBACK_HOST}:${port}${OPERATOR_ROUTE_PATH}`,
    startupTimeoutMs: positiveInteger(
      env.EMPLOYEE_REFERRAL_REPORT_OPERATOR_STARTUP_TIMEOUT_MS,
      60_000,
      "EMPLOYEE_REFERRAL_REPORT_OPERATOR_STARTUP_TIMEOUT_MS",
      120_000
    ),
    operationTimeoutMs,
  }
}

export function parseOperatorArguments(argv) {
  const { flags, values } = parseFlags(argv)
  const selected = [
    ["self-test", "self_test"],
    ["preview", "preview"],
    ["sync-sheet", "sync_sheet"],
    ["send-backfill", "send_backfill"],
    ["send-month", "send_month"],
    ["prepare-manual-delivery", "prepare_manual_delivery"],
    ["send-synthetic-test", "send_synthetic_test"],
    ["review", "review"],
    ["record-manual-delivery", "record_manual_delivery"],
    ["dismiss-data-drift", "dismiss_data_drift"],
    ["resolve-reconciliation-issue", "resolve_reconciliation_issue"],
    ["send-correction", "send_correction"],
    ["resume-correction", "resume_correction"],
  ].filter(([flag]) => flags.has(flag))
  if (selected.length !== 1) throw new Error("Select exactly one employee-referral operator action.")

  const action = selected[0][1]
  const body = { action }
  copyValue(values, body, "period-start", "period_start_local")
  copyValue(values, body, "period-end", "period_end_local_exclusive")
  copyInteger(values, body, "revision", "revision")
  copyInteger(values, body, "predecessor-revision", "predecessor_revision")
  copyValue(values, body, "recipient-slot", "recipient_slot")
  copyValue(values, body, "delivered-at", "delivered_at")
  copyValue(values, body, "manual-evidence-ref", "manual_evidence_ref")
  copyValue(values, body, "proposal-id", "proposal_id")
  copyValue(values, body, "issue-code", "issue_code")
  copyValue(values, body, "reason", "reason")
  copyValue(values, body, "late-delivery-reason", "late_delivery_reason")
  copyValue(values, body, "expected-payload-fingerprint", "expected_payload_fingerprint")
  if (flags.has("acknowledge-possible-late-delivery")) {
    body.acknowledge_possible_late_delivery = true
  }
  return body
}

function parseFlags(argv) {
  const booleanNames = new Set([
    "self-test",
    "preview",
    "sync-sheet",
    "send-backfill",
    "send-month",
    "prepare-manual-delivery",
    "send-synthetic-test",
    "review",
    "record-manual-delivery",
    "dismiss-data-drift",
    "resolve-reconciliation-issue",
    "send-correction",
    "resume-correction",
    "acknowledge-possible-late-delivery",
  ])
  const valueNames = new Set([
    "period-start",
    "period-end",
    "revision",
    "predecessor-revision",
    "recipient-slot",
    "delivered-at",
    "manual-evidence-ref",
    "proposal-id",
    "issue-code",
    "reason",
    "late-delivery-reason",
    "expected-payload-fingerprint",
  ])
  const flags = new Set()
  const values = new Map()
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`)
    const name = argument.slice(2)
    if (booleanNames.has(name)) {
      if (flags.has(name)) throw new Error(`Duplicate flag: --${name}`)
      flags.add(name)
      continue
    }
    if (!valueNames.has(name)) throw new Error(`Unknown flag: --${name}`)
    if (values.has(name)) throw new Error(`Duplicate flag: --${name}`)
    const value = argv[++index]
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value.`)
    values.set(name, value)
  }
  return { flags, values }
}

function copyValue(values, body, flag, property) {
  if (values.has(flag)) body[property] = values.get(flag)
}

function copyInteger(values, body, flag, property) {
  if (!values.has(flag)) return
  const value = Number(values.get(flag))
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${flag} must be positive.`)
  body[property] = value
}

export function startOperatorServer({ config, env, token }) {
  return spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...env,
      HOSTNAME: config.host,
      PORT: String(config.port),
      EMPLOYEE_REFERRAL_REPORT_OPERATOR_MODE: "true",
      RECOPS_JOB_BEARER_TOKEN: token,
    },
    stdio: "inherit",
  })
}

function portIsListening(host, port) {
  return new Promise((done) => {
    const socket = createConnection({ host, port })
    const finish = (value) => {
      socket.destroy()
      done(value)
    }
    socket.setTimeout(500, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

export async function waitForOperatorServer(child, config) {
  const deadline = Date.now() + config.startupTimeoutMs
  let launchError = null
  const recordError = (error) => {
    launchError = error
  }
  child.on("error", recordError)
  try {
    while (Date.now() < deadline) {
      if (launchError) throw launchError
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("The standalone server exited before it was ready.")
      }
      if (await portIsListening(config.host, config.port)) return
      await new Promise((done) => setTimeout(done, 100))
    }
    throw new Error("Timed out waiting for the standalone server.")
  } finally {
    child.off("error", recordError)
  }
}

export async function stopOperatorServer(child, graceMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  if (!child.kill("SIGTERM")) return
  let timeout
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((done) => {
      timeout = setTimeout(() => done(false), graceMs)
    }),
  ])
  clearTimeout(timeout)
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
    await exited
  }
}

function postLoopbackJson(url, token, body, signal) {
  return new Promise((resolveResponse, rejectResponse) => {
    const serialized = JSON.stringify(body)
    const pending = request(
      url,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(serialized),
        },
        signal,
      },
      (response) => {
        const chunks = []
        let bytes = 0
        response.on("data", (chunk) => {
          bytes += chunk.length
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Operator response exceeded the safe size limit."))
            return
          }
          chunks.push(chunk)
        })
        response.once("error", rejectResponse)
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let payload
          try {
            payload = JSON.parse(text)
          } catch {
            rejectResponse(new Error("The operator route did not return JSON."))
            return
          }
          resolveResponse({ status: response.statusCode ?? 0, payload })
        })
      }
    )
    pending.once("error", rejectResponse)
    pending.end(serialized)
  })
}

export async function runEmployeeReferralOperator({
  argv = process.argv.slice(2),
  env = process.env,
  createToken = () => randomBytes(32).toString("base64url"),
  startServer = startOperatorServer,
  waitForServer = waitForOperatorServer,
  stopServer = stopOperatorServer,
  post = postLoopbackJson,
} = {}) {
  const config = readOperatorLauncherConfig(env)
  const body = parseOperatorArguments(argv)
  const token = createToken()
  if (!token) throw new Error("The operator launcher could not create a bearer token.")
  const controller = new AbortController()
  let timedOut = false
  let rejectDeadline
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject
  })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
    rejectDeadline(new Error("The operator process timed out."))
  }, config.operationTimeoutMs - SHUTDOWN_MARGIN_MS)
  let child
  try {
    child = startServer({ config, env, token })
    try {
      await Promise.race([waitForServer(child, config), deadline])
      const response = await Promise.race([
        post(config.routeUrl, token, body, controller.signal),
        deadline,
      ])
      if (response.status < 200 || response.status >= 300) {
        const safeCode =
          response.payload &&
          typeof response.payload.code === "string" &&
          /^[a-z0-9_]{1,64}$/.test(response.payload.code)
            ? ` (${response.payload.code})`
            : ""
        throw new Error(`The operator route returned HTTP ${response.status}${safeCode}.`)
      }
      return response.payload
    } catch (error) {
      if (timedOut) throw new Error("The operator process timed out.")
      throw error
    }
  } finally {
    clearTimeout(timeout)
    await stopServer(child)
  }
}

export async function runOperatorCli({
  run = runEmployeeReferralOperator,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  try {
    const result = await run()
    stdout(JSON.stringify(result))
    if (
      result &&
      typeof result === "object" &&
      result.status === "manual_preparation_unconfirmed"
    ) {
      stderr(
        "[employee-referral operator] ATTENTION: manual ledger commit is unconfirmed; the private artifact was preserved."
      )
      return 2
    }
    return 0
  } catch (error) {
    stderr(
      `[employee-referral operator] FAILED: ${error instanceof Error ? error.message : String(error)}`
    )
    return 1
  }
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) process.exitCode = await runOperatorCli()
