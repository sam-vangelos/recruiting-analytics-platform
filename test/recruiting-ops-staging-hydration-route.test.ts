import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { GoogleAuth, OAuth2Client } from "google-auth-library"

vi.mock("@/lib/recruiting-ops/delivery/staging-hydration-orchestrator", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/recruiting-ops/delivery/staging-hydration-orchestrator")
  >()
  return { ...actual, runStagingHydrationOrchestration: vi.fn() }
})
vi.mock("@/lib/recruiting-ops/delivery/google-workspace-staging-client", () => ({
  createGoogleWorkspaceStagingClients: vi.fn(),
  waitForStagingDriveVersionAdvance: vi.fn(),
}))
vi.mock("@/lib/recruiting-ops/delivery/weekly-recruitment-rollover-runner", () => ({
  runWeeklyRecruitmentStagingRollover: vi.fn(),
}))

import { createGoogleWorkspaceStagingClients } from "@/lib/recruiting-ops/delivery/google-workspace-staging-client"
import {
  ALL_HYDRATION_ARTIFACTS,
  runStagingHydrationOrchestration,
} from "@/lib/recruiting-ops/delivery/staging-hydration-orchestrator"
import { runWeeklyRecruitmentStagingRollover } from "@/lib/recruiting-ops/delivery/weekly-recruitment-rollover-runner"
import {
  RECRUITING_OPS_HYDRATION_SCHEDULER_SERVICE_ACCOUNT,
  STAGING_HYDRATOR_OIDC_AUDIENCE_ENV,
  STAGING_HYDRATOR_SCHEDULER_SERVICE_ACCOUNT_ENV,
  requirePrivateHydratorAuthorization,
  requireSchedulerHydratorAuthorization,
} from "../app/api/cron/recruiting-ops-staging-hydration/authorization"
import { GET, POST } from "../app/api/cron/recruiting-ops-staging-hydration/route"

const run = vi.mocked(runStagingHydrationOrchestration)
const createGoogleClients = vi.mocked(createGoogleWorkspaceStagingClients)
const runRollover = vi.mocked(runWeeklyRecruitmentStagingRollover)
const acceptanceRunId = "acc_0123456789abcdef0123456789abcdef"
const STAGING_HYDRATION_JOB_RESOURCE_ENV = "RECOPS_STAGING_HYDRATION_JOB_RESOURCE"
const STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME_ENV =
  "RECOPS_STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME"
const RECRUITING_OPS_STAGING_HYDRATION_JOB_RESOURCE =
  "projects/example-project/locations/us-central1/jobs/ta-ops-staging-hydration"
const RECRUITING_OPS_STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME =
  "projects/example-project/locations/us-central1/jobs/recops-staging-orchestration-weekday"

function request(query = "", secret?: string): Request {
  return new Request(`http://localhost/api/cron/recruiting-ops-staging-hydration${query}`, {
    headers: secret ? { "x-recops-cron-secret": secret } : {},
  })
}

const oidcAudience = "https://ta-ops-staging-hydrator.example.run.app"
const oidcEnv = {
  [STAGING_HYDRATOR_OIDC_AUDIENCE_ENV]: oidcAudience,
  [STAGING_HYDRATOR_SCHEDULER_SERVICE_ACCOUNT_ENV]:
    RECRUITING_OPS_HYDRATION_SCHEDULER_SERVICE_ACCOUNT,
}

function oidcRequest(token = "signed-scheduler-id-token"): Request {
  return new Request("http://localhost/api/cron/recruiting-ops-staging-hydration", {
    headers: { authorization: `Bearer ${token}` },
  })
}

function schedulerRequest(input: {
  query?: string
  scheduledAt?: string
  body?: string
  headers?: Readonly<Record<string, string | null>>
} = {}): Request {
  const headers = new Headers({
    authorization: "Bearer signed-scheduler-id-token",
    "x-cloudscheduler": "true",
    // The SHORT job id, which is what Cloud Scheduler actually sends. This
    // default used to be the full projects/…/jobs/… resource path, so the whole
    // suite rehearsed a request production never makes — and the route's only
    // real scheduled fire (2026-07-21T06:30Z) was refused with HTTP 400 while
    // every test stayed green.
    "x-cloudscheduler-jobname":
      RECRUITING_OPS_STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME.split("/").pop()!,
    "x-cloudscheduler-scheduletime": input.scheduledAt ?? "2026-07-16T13:30:00.000Z",
  })
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (value === null) headers.delete(name)
    else headers.set(name, value)
  }
  return new Request(
    `http://localhost/api/cron/recruiting-ops-staging-hydration${input.query ?? ""}`,
    {
      method: "POST",
      headers,
      ...(input.body === undefined ? {} : { body: input.body }),
    }
  )
}

describe("copy-only staging hydration route", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "route-test-secret"
    process.env[STAGING_HYDRATOR_OIDC_AUDIENCE_ENV] = oidcAudience
    process.env[STAGING_HYDRATOR_SCHEDULER_SERVICE_ACCOUNT_ENV] =
      RECRUITING_OPS_HYDRATION_SCHEDULER_SERVICE_ACCOUNT
    process.env[STAGING_HYDRATION_JOB_RESOURCE_ENV] =
      RECRUITING_OPS_STAGING_HYDRATION_JOB_RESOURCE
    process.env[STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME_ENV] =
      RECRUITING_OPS_STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-16T13:30:01.000Z"))
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => ({
        email: RECRUITING_OPS_HYDRATION_SCHEDULER_SERVICE_ACCOUNT,
        email_verified: true,
      }),
    } as never)
    vi.spyOn(GoogleAuth.prototype, "request").mockResolvedValue({ data: {} } as never)
    run.mockReset()
    createGoogleClients.mockReset()
    runRollover.mockReset()
    createGoogleClients.mockResolvedValue({} as never)
    run.mockResolvedValue({
      status: "no_change",
      runId: "11111111-1111-4111-8111-111111111111",
      businessDate: "2026-07-15",
      sourceExecutionId: "11111111-1111-4111-8111-111111111111",
      sourceFingerprint: `hmac-sha256:${"a".repeat(64)}`,
      completedArtifacts: [],
      failedArtifacts: [],
      artifactOutcomes: [],
      replayed: false,
    })
    runRollover.mockResolvedValue({
      runId: "weekly_recruitment_rollover_test",
      mode: "dry_run",
      reportingWeekFriday: "2026-07-10",
      copyOnly: false,
      canonicalWriteAuthorized: true,
      outcomes: [{ artifactKey: "weekly_recruitment", status: "dry_run" }],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.CRON_SECRET
    delete process.env[STAGING_HYDRATOR_OIDC_AUDIENCE_ENV]
    delete process.env[STAGING_HYDRATOR_SCHEDULER_SERVICE_ACCOUNT_ENV]
    delete process.env[STAGING_HYDRATION_JOB_RESOURCE_ENV]
    delete process.env[STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME_ENV]
  })

  test("fails closed without private Scheduler authorization", async () => {
    expect((await GET(request())).status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  test("preserves secret-or-verified-OIDC authorization for the existing GET route", async () => {
    expect(await requirePrivateHydratorAuthorization(request("", "route-test-secret"), {
      env: { CRON_SECRET: "route-test-secret" },
    })).toBeNull()
    expect(await requirePrivateHydratorAuthorization(oidcRequest(), {
      env: { ...oidcEnv, CRON_SECRET: "route-test-secret" },
      oidcVerifier: {
        verify: vi.fn(async () => ({
          email: RECRUITING_OPS_HYDRATION_SCHEDULER_SERVICE_ACCOUNT,
          emailVerified: true,
        })),
      },
    })).toBeNull()
  })

  test("accepts only a verified Scheduler OIDC identity for the configured audience", async () => {
    const verify = vi.fn(async () => ({
      email: RECRUITING_OPS_HYDRATION_SCHEDULER_SERVICE_ACCOUNT,
      emailVerified: true,
    }))
    expect(await requireSchedulerHydratorAuthorization(oidcRequest(), {
      env: oidcEnv,
      oidcVerifier: { verify },
    })).toBeNull()
    expect(verify).toHaveBeenCalledWith({
      idToken: "signed-scheduler-id-token",
      audience: oidcAudience,
    })
  })

  test("fails closed when an OIDC binding or approved identity is absent", async () => {
    const verify = vi.fn()
    for (const env of [
      {},
      { [STAGING_HYDRATOR_OIDC_AUDIENCE_ENV]: oidcAudience },
      {
        ...oidcEnv,
        [STAGING_HYDRATOR_SCHEDULER_SERVICE_ACCOUNT_ENV]: "another@example.com",
      },
    ]) {
      expect((await requireSchedulerHydratorAuthorization(oidcRequest(), {
        env,
        oidcVerifier: { verify },
      }))?.status).toBe(401)
    }
    expect(verify).not.toHaveBeenCalled()
  })

  test.each([
    { email: "another@example.com", emailVerified: true },
    { email: RECRUITING_OPS_HYDRATION_SCHEDULER_SERVICE_ACCOUNT, emailVerified: false },
    { emailVerified: true },
  ])("rejects an unapproved decoded Scheduler identity", async (identity) => {
    expect((await requireSchedulerHydratorAuthorization(oidcRequest(), {
      env: oidcEnv,
      oidcVerifier: { verify: vi.fn(async () => identity) },
    }))?.status).toBe(401)
  })

  test("rejects malformed and cryptographically invalid OIDC tokens", async () => {
    const verifier = { verify: vi.fn(async () => { throw new Error("invalid signature") }) }
    expect((await requireSchedulerHydratorAuthorization(oidcRequest("contains whitespace"), {
      env: oidcEnv,
      oidcVerifier: verifier,
    }))?.status).toBe(401)
    expect(verifier.verify).not.toHaveBeenCalled()
    expect((await requireSchedulerHydratorAuthorization(oidcRequest(), {
      env: oidcEnv,
      oidcVerifier: verifier,
    }))?.status).toBe(401)
  })

  test("routes the default all-copy dry run through one durable orchestration", async () => {
    expect((await GET(request("", "route-test-secret"))).status).toBe(200)
    expect(run).toHaveBeenCalledWith({
      artifactKeys: ALL_HYDRATION_ARTIFACTS,
      mode: "dry_run",
    })
  })

  test("routes ELT and one copied Sheet through the same durable boundary", async () => {
    await GET(request("?artifact=elt_doc", "route-test-secret"))
    expect(run).toHaveBeenLastCalledWith({ artifactKeys: ["elt_doc"], mode: "dry_run" })
    await GET(request("?artifact=all_hires&mode=write", "route-test-secret"))
    expect(run).toHaveBeenLastCalledWith({ artifactKeys: ["all_hires"], mode: "write" })
  })

  test("rejects a broad legacy write before orchestration", async () => {
    expect((await GET(request("?artifact=all&mode=write", "route-test-secret"))).status).toBe(400)
    expect((await GET(request("?mode=write", "route-test-secret"))).status).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  test("rejects pinned hydration weeks now that the persisted cut owns the period", async () => {
    expect((await GET(request(
      "?artifact=weekly_recruitment&reporting_week_friday=2026-07-10",
      "route-test-secret"
    ))).status).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  test("keeps explicit copy rollover separate and source-free", async () => {
    const response = await GET(request(
      "?artifact=weekly_recruitment&mode=rollover_dry_run&reporting_week_friday=2026-07-10",
      "route-test-secret"
    ))
    expect(response.status).toBe(200)
    expect(createGoogleClients).toHaveBeenCalledOnce()
    expect(runRollover).toHaveBeenCalledWith(expect.objectContaining({
      reportingWeekFriday: "2026-07-10",
      mode: "dry_run",
    }))
    expect(run).not.toHaveBeenCalled()
  })

  test("retires direct copy rollover writes before Google access", async () => {
    const response = await GET(request(
      "?artifact=weekly_recruitment&mode=rollover_write&reporting_week_friday=2026-07-10",
      "route-test-secret"
    ))
    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({
      routeMode: "rollover_write",
      error: expect.stringContaining("durable orchestration"),
    })
    expect(createGoogleClients).not.toHaveBeenCalled()
    expect(runRollover).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  test("retires direct live acceptance instead of minting an independent token", async () => {
    const response = await GET(request(
      `?artifact=all_hires&mode=acceptance&acceptance_run_id=${acceptanceRunId}`,
      "route-test-secret"
    ))
    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({
      acceptance_run_id: acceptanceRunId,
      error: expect.stringContaining("durable orchestration"),
    })
    expect(run).not.toHaveBeenCalled()
  })

  test("rejects malformed acceptance identity before any source or Google access", async () => {
    expect((await GET(request(
      "?artifact=all_hires&mode=acceptance&acceptance_run_id=free-form",
      "route-test-secret"
    ))).status).toBe(400)
    expect(run).not.toHaveBeenCalled()
    expect(createGoogleClients).not.toHaveBeenCalled()
  })

  test("suppresses private orchestration diagnostics", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    run.mockRejectedValueOnce(new Error("Bearer secret candidate-private-value"))
    const response = await GET(request("?artifact=all_hires", "route-test-secret"))
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain("candidate-private-value")
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("candidate-private-value")
  })

  test("keeps the static cron secret off POST while preserving OIDC GET", async () => {
    expect((await GET(oidcRequest())).status).toBe(200)
    const secretOnly = schedulerRequest({
      headers: {
        authorization: null,
        "x-recops-cron-secret": "route-test-secret",
      },
    })
    expect((await POST(secretOnly)).status).toBe(401)
    expect(GoogleAuth.prototype.request).not.toHaveBeenCalled()
  })

  test("launches only the fixed Cloud Run Job with the normalized scheduled timestamp", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-07-21T06:30:00.536Z"))
    const response = await POST(schedulerRequest({
      scheduledAt: "2026-07-21T06:30:00.536623Z",
    }))

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: "accepted" })
    expect(GoogleAuth.prototype.request).toHaveBeenCalledOnce()
    expect(GoogleAuth.prototype.request).toHaveBeenCalledWith({
      url: `https://run.googleapis.com/v2/${RECRUITING_OPS_STAGING_HYDRATION_JOB_RESOURCE}:run`,
      method: "POST",
      data: {
        overrides: {
          containerOverrides: [{
            env: [{ name: "RECOPS_SCHEDULED_AT", value: "2026-07-21T06:30:00.000Z" }],
          }],
        },
      },
    })
    expect(run).not.toHaveBeenCalled()
  })

  test("accepts the exact Friday 06:30 Pacific ELT refresh slot", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-07-17T13:30:01.000Z"))
    const response = await POST(schedulerRequest({
      scheduledAt: "2026-07-17T13:30:00.246810Z",
    }))

    expect(response.status).toBe(202)
    expect(GoogleAuth.prototype.request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          overrides: {
            containerOverrides: [{
              env: [{ name: "RECOPS_SCHEDULED_AT", value: "2026-07-17T13:30:00.000Z" }],
            }],
          },
        },
      })
    )
  })

  test.each([
    ["before the governed minute", "2026-07-21T06:29:59.999Z"],
    ["at the two-minute deadline", "2026-07-21T06:32:00.000Z"],
  ])("rejects a Scheduler launch %s", async (_label, now) => {
    vi.mocked(Date.now).mockReturnValue(Date.parse(now))
    const response = await POST(schedulerRequest({
      scheduledAt: "2026-07-21T06:30:00.536623Z",
    }))

    expect(response.status).toBe(400)
    expect(GoogleAuth.prototype.request).not.toHaveBeenCalled()
  })

  test.each([
    ["query selection", { query: "?artifact=all_hires" }],
    ["request body", { body: "{}" }],
    ["missing Scheduler marker", { headers: { "x-cloudscheduler": null } }],
    ["wrong Scheduler job", { headers: { "x-cloudscheduler-jobname": "other-job" } }],
    ["missing schedule time", { headers: { "x-cloudscheduler-scheduletime": null } }],
    ["off-second schedule time", { scheduledAt: "2026-07-21T06:30:01.536623Z" }],
    ["off-slot schedule time", { scheduledAt: "2026-07-16T13:31:00Z" }],
    ["weekend schedule time", { scheduledAt: "2026-07-18T13:30:00Z" }],
  ] as const)("rejects %s before launching the Job", async (_label, input) => {
    expect((await POST(schedulerRequest(input))).status).toBe(400)
    expect(GoogleAuth.prototype.request).not.toHaveBeenCalled()
  })

  test("fails closed when the fixed Job or Scheduler configuration drifts", async () => {
    process.env[STAGING_HYDRATION_JOB_RESOURCE_ENV] =
      "projects/example-project/locations/us-central1/jobs/other-job"
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    const response = await POST(schedulerRequest())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "Internal server error" })
    expect(GoogleAuth.prototype.request).not.toHaveBeenCalled()
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("other-job")
  })

  test("suppresses private Cloud Run launch diagnostics", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.mocked(GoogleAuth.prototype.request).mockRejectedValueOnce(
      new Error("Bearer secret candidate-private-value")
    )
    const response = await POST(schedulerRequest())

    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain("candidate-private-value")
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("candidate-private-value")
  })
})
