import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("@/lib/recruiting-ops/delivery/staging-hydration-orchestrator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/recruiting-ops/delivery/staging-hydration-orchestrator")>()
  return { ...actual, runStagingHydrationOrchestration: vi.fn() }
})
vi.mock("@/lib/notification-delivery", () => ({ postSlackDm: vi.fn(async () => "ts") }))

import { runStagingHydrationOrchestration } from "@/lib/recruiting-ops/delivery/staging-hydration-orchestrator"
import { postSlackDm } from "@/lib/notification-delivery"
import { SWEEP_CONFIG } from "@/lib/sweep-config"
import { POST } from "../app/api/cron/recruiting-ops-staging-orchestration/route"

const run = vi.mocked(runStagingHydrationOrchestration)
const slack = vi.mocked(postSlackDm)
const token = "job-route-test-token"

function request(host = "127.0.0.1", bearer = token): Request {
  return new Request(`http://${host}:8080/api/cron/recruiting-ops-staging-orchestration`, {
    method: "POST",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })
}

describe("loopback staging hydration orchestration route", () => {
  beforeEach(() => {
    process.env.RECOPS_JOB_BEARER_TOKEN = token
    delete process.env.RECOPS_JOB_MODE
    delete process.env.RECOPS_JOB_ARTIFACTS
    delete process.env.RECOPS_SCHEDULED_AT
    run.mockReset()
    slack.mockReset()
    slack.mockResolvedValue("ts")
    run.mockResolvedValue({
      status: "no_change",
      runId: "run-1",
      businessDate: "2026-07-15",
      sourceExecutionId: "source-1",
      sourceFingerprint: `hmac-sha256:${"a".repeat(64)}`,
      completedArtifacts: [],
      failedArtifacts: [],
      artifactOutcomes: [],
      replayed: false,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.RECOPS_JOB_BEARER_TOKEN
    delete process.env.RECOPS_JOB_MODE
    delete process.env.RECOPS_JOB_ARTIFACTS
    delete process.env.RECOPS_SCHEDULED_AT
  })

  test("requires both loopback and the ephemeral bearer token", async () => {
    expect((await POST(request("service.run.app"))).status).toBe(404)
    expect((await POST(request("127.0.0.1", "wrong"))).status).toBe(404)
    expect(run).not.toHaveBeenCalled()

    expect((await POST(request())).status).toBe(200)
    expect(run).toHaveBeenCalledOnce()
  })

  test("defaults to all-artifact dry run and returns only the durable public result", async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ mode: "dry_run" }))
    expect((run.mock.calls[0]?.[0]?.artifactKeys ?? [])).toHaveLength(11)
    expect(await response.json()).toMatchObject({ status: "no_change", runId: "run-1" })
  })

  test("accepts an ordered artifact tier and rejects invalid job configuration", async () => {
    process.env.RECOPS_JOB_MODE = "write"
    process.env.RECOPS_JOB_ARTIFACTS = "all_hires,elt_doc"
    expect((await POST(request())).status).toBe(200)
    expect(run).toHaveBeenCalledWith({ mode: "write", artifactKeys: ["elt_doc", "all_hires"] })

    process.env.RECOPS_JOB_ARTIFACTS = "all_hires,unknown"
    expect((await POST(request())).status).toBe(500)
  })

  test("requires an explicit registered copied-artifact eligibility list in scheduled mode", async () => {
    process.env.RECOPS_SCHEDULED_AT = "2026-07-16T13:30:00Z"

    expect((await POST(request())).status).toBe(500)
    expect(run).not.toHaveBeenCalled()

    process.env.RECOPS_JOB_ARTIFACTS = "all_hires,elt_doc"
    expect((await POST(request())).status).toBe(200)
    expect(run).toHaveBeenCalledWith({
      mode: "dry_run",
      artifactKeys: ["all_hires", "elt_doc"],
      scheduledCycle: expect.objectContaining({
        lane: "weekday_morning",
        dueArtifacts: ["all_hires", "elt_doc"],
      }),
    })

    run.mockClear()
    process.env.RECOPS_JOB_ARTIFACTS = "all_hires,,weekly_recruitment"
    expect((await POST(request())).status).toBe(500)
    expect(run).not.toHaveBeenCalled()
  })

  test("returns not_due before orchestration when no eligible copy is due", async () => {
    process.env.RECOPS_SCHEDULED_AT = "2026-07-13T13:30:00Z"
    process.env.RECOPS_JOB_ARTIFACTS = "weekly_recruitment,final_offer"

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "no_change",
      disposition: "not_due",
      runId: null,
      scheduledAt: "2026-07-13T13:30:00.000Z",
      lane: "weekday_morning",
      businessDate: "2026-07-13",
      dueArtifacts: [],
      sourceExecutionId: null,
    })
    expect(run).not.toHaveBeenCalled()
  })

  test("passes one deterministic Thursday cycle to the durable orchestrator", async () => {
    process.env.RECOPS_SCHEDULED_AT = "2026-07-16T13:30:00Z"
    process.env.RECOPS_JOB_MODE = "write"
    process.env.RECOPS_JOB_ARTIFACTS = [
      "rps_tracking",
      "weekly_progress",
      "all_hires",
      "pipeline_890",
      "final_offer",
    ].join(",")

    expect((await POST(request())).status).toBe(200)
    expect(run).toHaveBeenCalledWith({
      mode: "write",
      artifactKeys: [
        "all_hires",
        "weekly_progress",
        "pipeline_890",
        "final_offer",
        "rps_tracking",
      ],
      scheduledCycle: {
        scheduledAt: "2026-07-16T13:30:00.000Z",
        lane: "weekday_morning",
        businessDate: "2026-07-16",
        reportingWeekFriday: "2026-07-10",
        quarterStart: "2026-07-01",
        dueArtifacts: [
          "all_hires",
          "weekly_progress",
          "pipeline_890",
          "final_offer",
          "rps_tracking",
        ],
      },
    })
  })

  test("routes the Friday ELT refresh with All Hires through the same durable cycle", async () => {
    process.env.RECOPS_SCHEDULED_AT = "2026-07-17T13:30:00Z"
    process.env.RECOPS_JOB_ARTIFACTS = "elt_doc,all_hires,weekly_progress"

    expect((await POST(request())).status).toBe(200)
    expect(run).toHaveBeenCalledWith({
      mode: "dry_run",
      artifactKeys: ["all_hires", "elt_doc"],
      scheduledCycle: {
        scheduledAt: "2026-07-17T13:30:00.000Z",
        lane: "weekday_morning",
        businessDate: "2026-07-17",
        reportingWeekFriday: "2026-07-17",
        quarterStart: "2026-07-01",
        dueArtifacts: ["all_hires", "elt_doc"],
      },
    })
  })

  test("keeps the evening report on the original Pacific business date", async () => {
    process.env.RECOPS_SCHEDULED_AT = "2026-07-14T06:30:00Z"
    process.env.RECOPS_JOB_ARTIFACTS = "delivery_roles_rps"

    expect((await POST(request())).status).toBe(200)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      artifactKeys: ["delivery_roles_rps"],
      scheduledCycle: expect.objectContaining({
        lane: "weekday_evening",
        businessDate: "2026-07-13",
      }),
    }))
  })

  test("suppresses private failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    run.mockRejectedValueOnce(new Error("candidate-private-value"))
    const response = await POST(request())
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain("candidate-private-value")
    expect(JSON.stringify(error.mock.calls)).not.toContain("candidate-private-value")
    expect(JSON.stringify(slack.mock.calls)).not.toContain("candidate-private-value")
  })

  test("reports every run, naming the artifacts that did not land", async () => {
    run.mockResolvedValueOnce({
      status: "partial",
      runId: "run-1",
      businessDate: "2026-08-13",
      sourceExecutionId: "source-1",
      sourceFingerprint: `hmac-sha256:${"a".repeat(64)}`,
      completedArtifacts: ["all_hires"],
      failedArtifacts: ["final_offer"],
      artifactOutcomes: [
        { artifactKey: "all_hires", outcome: "written", certified: true, failureCode: null, failureStage: null },
        { artifactKey: "final_offer", outcome: "failed", certified: false, failureCode: "blocked", failureStage: "planning" },
      ],
      replayed: false,
      reason: "execution_failed",
    })

    expect((await POST(request())).status).toBe(200)
    expect(slack).toHaveBeenCalledOnce()
    const [recipient, text] = slack.mock.calls[0]
    expect(recipient).toBe(SWEEP_CONFIG.slack.recruitingOpsAlertUserId)
    expect(text).toContain("1 of 2 landed")
    expect(text).toContain("Final Offer")
    expect(text).toContain("`blocked`")
  })

  test("reports a clean run too, so silence always means the job did not run", async () => {
    expect((await POST(request())).status).toBe(200)
    expect(slack).toHaveBeenCalledOnce()
  })

  // The job's exit code is the orchestration's outcome. A Slack outage must
  // not turn a clean run into a failure and send Cloud Run into a retry.
  test("a failed send never changes the run's own outcome", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    slack.mockRejectedValueOnce(new Error("slack is down"))

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect((await response.json()).status).toBe("no_change")
  })

  test("a route-level throw still reports, because nothing else recorded the cycle", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    run.mockRejectedValueOnce(new Error("boom"))

    expect((await POST(request())).status).toBe(500)

    expect(slack).toHaveBeenCalledOnce()
    expect(slack.mock.calls[0][1]).toContain("did not update")
  })
})
