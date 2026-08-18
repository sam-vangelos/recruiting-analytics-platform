import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("@/lib/recruiting-ops/live-workflow", () => ({
  runLiveCommandCenterWorkflow: vi.fn(),
}))

import { runLiveCommandCenterWorkflow } from "@/lib/recruiting-ops/live-workflow"
import { GET } from "../app/api/cron/recruiting-ops-shadow/route"

const mockRun = vi.mocked(runLiveCommandCenterWorkflow)

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/cron/recruiting-ops-shadow", { headers })
}

describe("recruiting-ops-shadow cron route (C3 trigger)", () => {
  beforeEach(() => {
    mockRun.mockReset()
    process.env.CRON_SECRET = "test-cron-secret"
    delete process.env.RECOPS_SHADOW_ENABLED
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.RECOPS_SHADOW_ENABLED
  })

  test("rejects requests without the cron secret and never touches the workflow", async () => {
    const response = await GET(request())
    expect(response.status).toBe(401)
    expect(mockRun).not.toHaveBeenCalled()
  })

  test("stays DORMANT by default: authorized but unflagged returns disabled without any workflow call", async () => {
    const response = await GET(request({ authorization: "Bearer test-cron-secret" }))
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.status).toBe("disabled")
    // The dormant lane must not read Greenhouse or write Supabase.
    expect(mockRun).not.toHaveBeenCalled()
  })

  test("a non-'true' flag value stays dormant (no truthy coercion)", async () => {
    process.env.RECOPS_SHADOW_ENABLED = "1"
    const response = await GET(request({ authorization: "Bearer test-cron-secret" }))
    const body = (await response.json()) as Record<string, unknown>
    expect(body.status).toBe("disabled")
    expect(mockRun).not.toHaveBeenCalled()
  })

  test("when flipped (G2), runs the shared workflow in SHADOW mode and returns public-safe counts", async () => {
    process.env.RECOPS_SHADOW_ENABLED = "true"
    mockRun.mockResolvedValueOnce({
      mode: "shadow",
      startedAt: "2026-07-03T00:00:00.000Z",
      publicSummary: { moduleCount: 6 },
      moduleStatuses: {
        T07: { status: "succeeded", rows: 36, sourceGaps: 144, blockingSourceGaps: 0, discrepancies: 144 },
      },
      artifactCount: 12,
      rootDir: "/tmp/recruiting-ops-artifacts/shadow/x",
      governedDimensions: { rosterRows: 35, stageTaxonomyRows: 0 },
      persistence: [
        {
          runId: "t07_x",
          workflowId: "T07",
          outcome: "persisted",
          rowCounts: { evidenceRefs: 2, artifacts: 2, sourceGaps: 144, discrepancies: 144 },
        },
      ],
    })

    const response = await GET(request({ authorization: "Bearer test-cron-secret" }))
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.status).toBe("ran")
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "shadow" })
    )
    // Public-safe body: statuses and counts only.
    expect(JSON.stringify(body)).not.toMatch(/recruiter_name|candidate|email/i)
  })

  test("workflow failures surface as 500, never a silent 200", async () => {
    process.env.RECOPS_SHADOW_ENABLED = "true"
    mockRun.mockRejectedValueOnce(new Error("governed roster table is empty"))
    const response = await GET(request({ authorization: "Bearer test-cron-secret" }))
    expect(response.status).toBe(500)
  })
})
