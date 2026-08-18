import type { ChildProcess } from "node:child_process"
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  buildFixture: vi.fn(),
  preview: vi.fn(),
  run: vi.fn(),
  sync: vi.fn(),
  synthetic: vi.fn(),
  duePeriods: vi.fn(),
  store: {
    getPeriodState: vi.fn(),
    recordManualDelivery: vi.fn(),
    dismissDataDrift: vi.fn(),
    resolveReconciliationIssue: vi.fn(),
  },
}))

vi.mock("@/lib/recruiting-ops/employee-referral-report-runner", () => ({
  EmployeeReferralRunnerError: class extends Error {
    code: string
    publicDiagnostics: Record<string, string | number | boolean>
    constructor(
      code: string,
      _message?: string,
      publicDiagnostics: Record<string, string | number | boolean> = {}
    ) {
      super(code)
      this.code = code
      this.publicDiagnostics = publicDiagnostics
    }
  },
  buildSyntheticEmployeeReferralFixture: mocks.buildFixture,
  dueScheduledPeriods: mocks.duePeriods,
  previewEmployeeReferralReport: mocks.preview,
  runEmployeeReferralReport: mocks.run,
  sendSyntheticEmployeeReferralTest: mocks.synthetic,
  syncEmployeeReferralMasterSheet: mocks.sync,
}))

vi.mock("@/lib/recruiting-ops/employee-referral-report-store", () => ({
  EmployeeReferralReportStore: class {
    constructor() {
      return mocks.store
    }
  },
}))

import {
  buildEmployeeReferralReport,
  createEmployeeReferralReportPeriod,
  type EmployeeReferralSnapshot,
} from "../lib/recruiting-ops/employee-referral-report"
import { POST } from "../app/api/internal/employee-referral-report-operator/route"
import { EmployeeReferralRunnerError } from "../lib/recruiting-ops/employee-referral-report-runner"
import {
  OPERATOR_ROUTE_PATH,
  parseOperatorArguments,
  readOperatorLauncherConfig,
  runEmployeeReferralOperator,
  runOperatorCli,
} from "../scripts/employee-referral-report-operator-launcher.mjs"

const token = "ephemeral-operator-token"
let artifactRoot = ""

function fixtureReport(correlationId = "synthetic-self-test") {
  const period = createEmployeeReferralReportPeriod("2099-01-01", "2099-02-01")
  const empty: EmployeeReferralSnapshot = {
    period,
    currentOffers: [],
    allVersionOffers: [],
    applications: [],
    candidates: [],
    jobs: [],
    departments: [],
    referrers: [],
    sources: [
      { id: 4000194004, name: "Referral", type: { id: 4000002004, name: "Referral" } },
    ],
    customFields: [
      {
        id: 23150958004,
        name: "Hiring Location",
        name_key: "hiring_location",
        field_type: "offer",
        active: true,
      },
    ],
  }
  const report = buildEmployeeReferralReport(empty, { correlationId })
  return {
    ...report,
    html: `${report.html}<p>Private Candidate candidate@example.com</p>`,
  }
}

function operatorRequest(
  body: unknown,
  options: { bearer?: string | null; host?: string } = {}
) {
  return new Request(
    `http://${options.host ?? "127.0.0.1"}:8080/api/internal/employee-referral-report-operator`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.bearer === null
          ? {}
          : { authorization: `Bearer ${options.bearer ?? token}` }),
      },
      body: JSON.stringify(body),
    }
  )
}

describe("employee referral operator route", () => {
  beforeEach(async () => {
    artifactRoot = await mkdtemp(join(tmpdir(), "employee-referral-operator-test-"))
    await chmod(artifactRoot, 0o700)
    process.env.EMPLOYEE_REFERRAL_REPORT_OPERATOR_MODE = "true"
    process.env.RECOPS_JOB_BEARER_TOKEN = token
    process.env.EMPLOYEE_REFERRAL_REPORT_ARTIFACT_ROOT = artifactRoot
    for (const value of Object.values(mocks.store)) value.mockReset()
    mocks.buildFixture.mockReset()
    mocks.preview.mockReset()
    mocks.run.mockReset()
    mocks.sync.mockReset()
    mocks.synthetic.mockReset()
    mocks.duePeriods.mockReset()
    const report = fixtureReport()
    mocks.buildFixture.mockReturnValue(report)
    mocks.preview.mockResolvedValue({
      report,
      sourceSetFingerprint: `sha256:${"a".repeat(64)}`,
      payloadFingerprint: `hmac-sha256:${"b".repeat(64)}`,
    })
    mocks.synthetic.mockResolvedValue({
      status: "delivered",
      providerMessageId: "email-synthetic",
      event: "delivered",
    })
    mocks.duePeriods.mockReturnValue([
      createEmployeeReferralReportPeriod("2026-07-01", "2026-08-01"),
    ])
    mocks.run.mockResolvedValue({ status: "provider_accepted" })
    mocks.sync.mockResolvedValue({
      status: "sheet_updated",
      periodStartLocal: "2026-05-01",
      periodEndLocalExclusive: "2026-07-01",
      updatedTabs: ["2026-05", "2026-06"],
      currentCohortRowCount: 4,
    })
    mocks.store.getPeriodState.mockResolvedValue({
      runs: [],
      deliveries: [],
      proposals: [],
      issues: [],
    })
  })

  afterEach(async () => {
    delete process.env.EMPLOYEE_REFERRAL_REPORT_OPERATOR_MODE
    delete process.env.RECOPS_JOB_BEARER_TOKEN
    delete process.env.EMPLOYEE_REFERRAL_REPORT_ARTIFACT_ROOT
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  test("is undiscoverable outside operator mode", async () => {
    process.env.EMPLOYEE_REFERRAL_REPORT_OPERATOR_MODE = "false"
    const response = await POST(operatorRequest({ action: "self_test" }))

    expect(response.status).toBe(404)
    expect(mocks.buildFixture).not.toHaveBeenCalled()
  })

  test("returns 401 for a wrong/missing bearer or a non-loopback host", async () => {
    expect(
      (await POST(operatorRequest({ action: "self_test" }, { bearer: "wrong" }))).status
    ).toBe(401)
    expect(
      (await POST(operatorRequest({ action: "self_test" }, { bearer: null }))).status
    ).toBe(401)
    expect(
      (await POST(operatorRequest({ action: "self_test" }, { host: "service.run.app" }))).status
    ).toBe(401)
    expect(mocks.buildFixture).not.toHaveBeenCalled()
  })

  test("rejects malformed and unsupported actions before doing work", async () => {
    expect((await POST(operatorRequest({}))).status).toBe(400)
    expect((await POST(operatorRequest({ action: "delete_everything" }))).status).toBe(400)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  test("writes private self-test artifacts and returns no report rows or PII", async () => {
    const response = await POST(operatorRequest({ action: "self_test" }))
    const body = (await response.json()) as {
      status: string
      artifacts: {
        directory: string
        manifest_path: string
        html_path: string
        csv_path: string
      }
    }
    const serialized = JSON.stringify(body)

    expect(response.status).toBe(200)
    expect(body.status).toBe("self_test_passed")
    expect(serialized).not.toContain("Private Candidate")
    expect(serialized).not.toContain("candidate@example.com")
    expect((await stat(body.artifacts.directory)).mode & 0o777).toBe(0o700)
    expect((await stat(body.artifacts.manifest_path)).mode & 0o777).toBe(0o600)
    expect((await stat(body.artifacts.html_path)).mode & 0o777).toBe(0o600)
    expect((await stat(body.artifacts.csv_path)).mode & 0o777).toBe(0o600)
    expect(await readFile(body.artifacts.html_path, "utf8")).toContain("Private Candidate")
    expect(await readFile(body.artifacts.manifest_path, "utf8")).not.toMatch(
      /Private Candidate|candidate@example\.com/
    )
  })

  test("rejects an artifact root inside the repository and suppresses artifact contents", async () => {
    process.env.EMPLOYEE_REFERRAL_REPORT_ARTIFACT_ROOT = process.cwd()
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const response = await POST(operatorRequest({ action: "self_test" }))

    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain("Private Candidate")
    expect(JSON.stringify(error.mock.calls)).not.toContain("Private Candidate")
  })

  test("preview returns aggregate diagnostics and private artifact paths, never rows", async () => {
    const response = await POST(
      operatorRequest({
        action: "preview",
        period_start_local: "2026-04-01",
        period_end_local_exclusive: "2026-07-01",
      })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.preview).toHaveBeenCalledOnce()
    expect(body).toMatchObject({
      status: "preview_ready",
      period_start_local: "2026-04-01",
      period_end_local_exclusive: "2026-07-01",
      counts: { totalRowCount: 0 },
    })
    expect(JSON.stringify(body)).not.toContain("Private Candidate")
    expect(body).not.toHaveProperty("rows")
    expect(body).not.toHaveProperty("html")
    expect(body).not.toHaveProperty("csv")
  })

  test("syncs an explicit period without invoking delivery", async () => {
    const response = await POST(
      operatorRequest({
        action: "sync_sheet",
        period_start_local: "2026-05-01",
        period_end_local_exclusive: "2026-07-01",
      })
    )

    expect(response.status).toBe(200)
    expect(mocks.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        periodStartLocal: "2026-05-01",
        periodEndLocalExclusive: "2026-07-01",
      })
    )
    expect(mocks.run).not.toHaveBeenCalled()
  })

  test("requires the exact approved preview fingerprint before a backfill send", async () => {
    const fingerprint = `hmac-sha256:${"b".repeat(64)}`
    const missing = await POST(operatorRequest({ action: "send_backfill" }))
    expect(missing.status).toBe(500)
    expect(mocks.run).not.toHaveBeenCalled()

    const response = await POST(
      operatorRequest({ action: "send_backfill", expected_payload_fingerprint: fingerprint })
    )
    expect(response.status).toBe(200)
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPayloadFingerprint: fingerprint,
        period: expect.objectContaining({
          periodStartLocal: "2026-04-01",
          periodEndLocalExclusive: "2026-07-01",
        }),
      })
    )
  })

  test("can recover an explicitly approved missing ordinary month only when it is due", async () => {
    const fingerprint = `hmac-sha256:${"c".repeat(64)}`
    const response = await POST(
      operatorRequest({
        action: "send_month",
        period_start_local: "2026-07-01",
        period_end_local_exclusive: "2026-08-01",
        expected_payload_fingerprint: fingerprint,
      })
    )

    expect(response.status).toBe(200)
    expect(mocks.store.getPeriodState).toHaveBeenCalledWith("2026-07-01", "2026-08-01")
    expect(mocks.run).toHaveBeenCalledWith({
      period: expect.objectContaining({
        periodStartLocal: "2026-07-01",
        periodEndLocalExclusive: "2026-08-01",
      }),
      expectedPayloadFingerprint: fingerprint,
    })

    mocks.run.mockReset()
    mocks.duePeriods.mockReturnValue([])
    const future = await POST(
      operatorRequest({
        action: "send_month",
        period_start_local: "2026-08-01",
        period_end_local_exclusive: "2026-09-01",
        expected_payload_fingerprint: fingerprint,
      })
    )
    expect(future.status).toBe(409)
    expect(await future.json()).toMatchObject({ code: "scheduled_period_not_due" })
    expect(mocks.run).not.toHaveBeenCalled()
  })

  test("rejects missing-month recovery when a run or delivery already exists", async () => {
    const requestBody = {
      action: "send_month",
      period_start_local: "2026-07-01",
      period_end_local_exclusive: "2026-08-01",
      expected_payload_fingerprint: `hmac-sha256:${"d".repeat(64)}`,
    }
    mocks.store.getPeriodState.mockResolvedValueOnce({
      runs: [{ revision: 1, status: "attention_required" }],
      deliveries: [],
      proposals: [],
      issues: [],
    })

    const existingRun = await POST(operatorRequest(requestBody))
    expect(existingRun.status).toBe(409)
    expect(await existingRun.json()).toMatchObject({ code: "scheduled_period_already_exists" })
    expect(mocks.run).not.toHaveBeenCalled()

    mocks.store.getPeriodState.mockResolvedValueOnce({
      runs: [],
      deliveries: [{ revision: 1, status: "transport_failed" }],
      proposals: [],
      issues: [],
    })
    const existingDelivery = await POST(operatorRequest(requestBody))
    expect(existingDelivery.status).toBe(409)
    expect(await existingDelivery.json()).toMatchObject({
      code: "scheduled_period_already_exists",
    })
    expect(mocks.run).not.toHaveBeenCalled()
  })

  test("returns only a safe runner code for an expected operator conflict", async () => {
    mocks.run.mockRejectedValueOnce(
      new EmployeeReferralRunnerError(
        "manual_delivery_already_exists",
        "private diagnostics"
      )
    )
    const response = await POST(
      operatorRequest({
        action: "send_backfill",
        expected_payload_fingerprint: `hmac-sha256:${"b".repeat(64)}`,
      })
    )
    const serialized = JSON.stringify(await response.json())

    expect(response.status).toBe(409)
    expect(serialized).toContain("manual_delivery_already_exists")
    expect(serialized).not.toContain("private diagnostics")
  })

  test("returns preserved manual artifacts and a safe fingerprint for an unconfirmed commit", async () => {
    const fingerprint = `hmac-sha256:${"c".repeat(64)}`
    const preparationToken = "00000000-0000-4000-8000-000000000055"
    mocks.run.mockImplementationOnce(async (input) => {
      await input.manualArtifactWriter(fixtureReport(preparationToken))
      throw new EmployeeReferralRunnerError(
        "manual_delivery_commit_unconfirmed",
        "private diagnostics",
        {
          payload_fingerprint: fingerprint,
          manual_preparation_token: preparationToken,
        }
      )
    })

    const response = await POST(operatorRequest({ action: "prepare_manual_delivery" }))
    const body = (await response.json()) as {
      status: string
      code: string
      payload_fingerprint: string
      manual_preparation_token: string
      artifacts: {
        directory: string
        manifest_path: string
        html_path: string
        csv_path: string
      }
    }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: "manual_preparation_unconfirmed",
      code: "manual_delivery_commit_unconfirmed",
      payload_fingerprint: fingerprint,
      manual_preparation_token: preparationToken,
    })
    expect(body.artifacts.directory).toContain(preparationToken)
    expect((await stat(body.artifacts.directory)).mode & 0o777).toBe(0o700)
    expect((await stat(body.artifacts.manifest_path)).mode & 0o777).toBe(0o600)
    expect((await stat(body.artifacts.html_path)).mode & 0o777).toBe(0o600)
    expect((await stat(body.artifacts.csv_path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(body.artifacts.manifest_path, "utf8"))).toEqual({
      schema_version: 1,
      artifact_token: preparationToken,
      period_start_local: "2099-01-01",
      period_end_local_exclusive: "2099-02-01",
    })
    expect(JSON.stringify(body)).not.toMatch(/Private Candidate|candidate@example\.com/)
  })

  test("recovers a manual artifact by preparation token when the command response is lost", async () => {
    const preparationToken = "00000000-0000-4000-8000-000000000077"
    mocks.run.mockImplementationOnce(async (input) => {
      await input.manualArtifactWriter(fixtureReport(preparationToken))
      return { status: "manual_prepared", correlation_id: preparationToken }
    })

    const response = await POST(operatorRequest({ action: "prepare_manual_delivery" }))
    expect(response.status).toBe(200)

    const directories = await readdir(artifactRoot)
    const ownedDirectory = directories.find((entry) => entry.includes(preparationToken))
    expect(ownedDirectory).toBeDefined()
    const manifestPath = join(artifactRoot, ownedDirectory!, "manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))

    expect(manifest).toEqual({
      schema_version: 1,
      artifact_token: preparationToken,
      period_start_local: "2099-01-01",
      period_end_local_exclusive: "2099-02-01",
    })
    expect(JSON.stringify(manifest)).not.toMatch(/Private Candidate|candidate@example\.com/)
  })

  test("review strips unknown database fields that could contain PII", async () => {
    const payloadFingerprint = `hmac-sha256:${"d".repeat(64)}`
    const preparationToken = "00000000-0000-4000-8000-000000000066"
    mocks.store.getPeriodState.mockResolvedValueOnce({
      runs: [
        {
          revision: 1,
          status: "delivered",
          total_row_count: 1,
          payload_fingerprint: payloadFingerprint,
          source_set_fingerprint: `sha256:${"e".repeat(64)}`,
          recipient_scope_version: "scope-v1",
          manual_preparation_token: preparationToken,
          policy_export_sha256: "f".repeat(64),
          candidate_name: "Private Candidate",
          report_body: "SECRET_REPORT_BODY",
        },
      ],
      deliveries: [
        {
          revision: 1,
          recipient_slot: "ta_lead",
          delivery_channel: "resend",
          status: "delivered",
          recipient_address: "candidate@example.com",
        },
      ],
      proposals: [],
      issues: [],
    })
    const response = await POST(
      operatorRequest({
        action: "review",
        period_start_local: "2026-07-01",
        period_end_local_exclusive: "2026-08-01",
      })
    )
    const serialized = JSON.stringify(await response.json())

    expect(response.status).toBe(200)
    expect(serialized).toContain(payloadFingerprint)
    expect(serialized).toContain(preparationToken)
    expect(serialized).not.toMatch(/Private Candidate|candidate@example\.com|SECRET_REPORT_BODY/)
  })
})

const launcherEnv = {
  NODE_ENV: "test" as const,
  EMPLOYEE_REFERRAL_REPORT_OPERATOR_PORT: "8182",
  EMPLOYEE_REFERRAL_REPORT_OPERATOR_STARTUP_TIMEOUT_MS: "1000",
  EMPLOYEE_REFERRAL_REPORT_OPERATOR_TIMEOUT_MS: "10000",
}

describe("employee referral operator launcher", () => {
  test("parses exactly one action and its bounded correction arguments", () => {
    expect(
      parseOperatorArguments([
        "--sync-sheet",
        "--period-start",
        "2026-05-01",
        "--period-end",
        "2026-07-01",
      ])
    ).toEqual({
      action: "sync_sheet",
      period_start_local: "2026-05-01",
      period_end_local_exclusive: "2026-07-01",
    })
    expect(
      parseOperatorArguments([
        "--send-correction",
        "--period-start",
        "2026-07-01",
        "--period-end",
        "2026-08-01",
        "--predecessor-revision",
        "1",
        "--reason",
        "approved correction",
        "--acknowledge-possible-late-delivery",
        "--late-delivery-reason",
        "provider status unresolved",
        "--expected-payload-fingerprint",
        `hmac-sha256:${"f".repeat(64)}`,
      ])
    ).toEqual({
      action: "send_correction",
      period_start_local: "2026-07-01",
      period_end_local_exclusive: "2026-08-01",
      predecessor_revision: 1,
      reason: "approved correction",
      acknowledge_possible_late_delivery: true,
      late_delivery_reason: "provider status unresolved",
      expected_payload_fingerprint: `hmac-sha256:${"f".repeat(64)}`,
    })
    expect(() => parseOperatorArguments([])).toThrow("exactly one")
    expect(() => parseOperatorArguments(["--preview", "--review"])).toThrow("exactly one")
    expect(() => parseOperatorArguments(["--self-test", "--unknown"])).toThrow("Unknown flag")
    expect(() => parseOperatorArguments(["--resume-correction", "--revision", "0"])).toThrow(
      "positive"
    )
    expect(
      parseOperatorArguments([
        "--send-month",
        "--period-start",
        "2026-07-01",
        "--period-end",
        "2026-08-01",
        "--expected-payload-fingerprint",
        `hmac-sha256:${"e".repeat(64)}`,
      ])
    ).toEqual({
      action: "send_month",
      period_start_local: "2026-07-01",
      period_end_local_exclusive: "2026-08-01",
      expected_payload_fingerprint: `hmac-sha256:${"e".repeat(64)}`,
    })
  })

  test("keeps its endpoint on fixed loopback with bounded timeouts", () => {
    expect(readOperatorLauncherConfig(launcherEnv)).toEqual({
      host: "127.0.0.1",
      port: 8182,
      routeUrl: `http://127.0.0.1:8182${OPERATOR_ROUTE_PATH}`,
      startupTimeoutMs: 1000,
      operationTimeoutMs: 10000,
    })
    expect(() =>
      readOperatorLauncherConfig({
        ...launcherEnv,
        EMPLOYEE_REFERRAL_REPORT_OPERATOR_TIMEOUT_MS: "870001",
      })
    ).toThrow("870000")
    expect(() =>
      readOperatorLauncherConfig({
        ...launcherEnv,
        EMPLOYEE_REFERRAL_REPORT_OPERATOR_TIMEOUT_MS: "5000",
      })
    ).toThrow("exceed 5000")
  })

  test("does not reset the whole-process deadline after server startup", async () => {
    vi.useFakeTimers()
    try {
      const child = {} as ChildProcess
      let finishStartup: (() => void) | undefined
      const waitForServer = vi.fn(
        () => new Promise<void>((resolve) => (finishStartup = resolve))
      )
      const stopServer = vi.fn(async () => undefined)
      const post = vi.fn(
        async (_url: string, _token: string, _body: unknown, signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          })
      )
      const run = runEmployeeReferralOperator({
        argv: ["--self-test"],
        env: launcherEnv,
        createToken: () => "token",
        startServer: () => child,
        waitForServer,
        stopServer,
        post,
      })
      const timedOut = expect(run).rejects.toThrow("process timed out")

      await vi.advanceTimersByTimeAsync(4_000)
      finishStartup?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(post).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(999)
      expect(stopServer).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      await timedOut
      expect(stopServer).toHaveBeenCalledWith(child)
    } finally {
      vi.useRealTimers()
    }
  })

  test("uses one ephemeral bearer for server and POST, then always stops the server", async () => {
    const child = {} as ChildProcess
    const startServer = vi.fn(() => child)
    const waitForServer = vi.fn(async () => undefined)
    const stopServer = vi.fn(async () => undefined)
    const post = vi.fn(async () => ({ status: 200, payload: { status: "self_test_passed" } }))

    await expect(
      runEmployeeReferralOperator({
        argv: ["--self-test"],
        env: launcherEnv,
        createToken: () => "one-time-token",
        startServer,
        waitForServer,
        stopServer,
        post,
      })
    ).resolves.toEqual({ status: "self_test_passed" })
    expect(startServer).toHaveBeenCalledWith({
      config: expect.objectContaining({ host: "127.0.0.1", port: 8182 }),
      env: launcherEnv,
      token: "one-time-token",
    })
    expect(post).toHaveBeenCalledWith(
      `http://127.0.0.1:8182${OPERATOR_ROUTE_PATH}`,
      "one-time-token",
      { action: "self_test" },
      expect.any(AbortSignal)
    )
    expect(stopServer).toHaveBeenCalledWith(child)
  })

  test.each(["startup", "request"])("cleans up after a %s failure", async (phase) => {
    const child = {} as ChildProcess
    const stopServer = vi.fn(async () => undefined)
    const failure = new Error("safe failure")
    await expect(
      runEmployeeReferralOperator({
        argv: ["--self-test"],
        env: launcherEnv,
        createToken: () => "token",
        startServer: () => child,
        waitForServer: async () => {
          if (phase === "startup") throw failure
        },
        stopServer,
        post: async () => {
          if (phase === "request") throw failure
          return { status: 200, payload: {} }
        },
      })
    ).rejects.toThrow("safe failure")
    expect(stopServer).toHaveBeenCalledWith(child)
  })

  test("rejects a non-2xx route response and gives the CLI a nonzero safe exit", async () => {
    const stopServer = vi.fn(async () => undefined)
    await expect(
      runEmployeeReferralOperator({
        argv: ["--self-test"],
        env: launcherEnv,
        createToken: () => "token",
        startServer: () => ({} as ChildProcess),
        waitForServer: async () => undefined,
        stopServer,
        post: async () => ({ status: 401, payload: { error: "Unauthorized" } }),
      })
    ).rejects.toThrow("HTTP 401")
    expect(stopServer).toHaveBeenCalledOnce()

    await expect(
      runEmployeeReferralOperator({
        argv: ["--self-test"],
        env: launcherEnv,
        createToken: () => "token",
        startServer: () => ({} as ChildProcess),
        waitForServer: async () => undefined,
        stopServer: async () => undefined,
        post: async () => ({
          status: 409,
          payload: { code: "manual_delivery_already_exists" },
        }),
      })
    ).rejects.toThrow("HTTP 409 (manual_delivery_already_exists)")

    const stderr = vi.fn()
    await expect(
      runOperatorCli({
        run: async () => {
          throw new Error("route failed")
        },
        stdout: vi.fn(),
        stderr,
      })
    ).resolves.toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("route failed"))

    const stdout = vi.fn()
    stderr.mockReset()
    await expect(
      runOperatorCli({
        run: async () => ({
          status: "manual_preparation_unconfirmed",
          artifacts: { directory: "/private/artifacts/report" },
        }),
        stdout,
        stderr,
      })
    ).resolves.toBe(2)
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("manual_preparation_unconfirmed")
    )
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("ATTENTION"))
  })
})
