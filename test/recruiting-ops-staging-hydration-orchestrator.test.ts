import { describe, expect, test, vi } from "vitest"

import { createPayloadFingerprint } from "../lib/recruiting-ops/checksums"
import { buildReportingSourceCut } from "../lib/recruiting-ops/delivery-source/reporting-source-cut"
import type { StagingHydrationSourceCollections } from "../lib/recruiting-ops/delivery-source/staging-hydration-source-loader"
import type {
  HydrationArtifactAttempt,
  HydrationOrchestrationDatabaseClient,
} from "../lib/recruiting-ops/delivery/hydration-orchestration-store"
import {
  ALL_HYDRATION_ARTIFACTS,
  runReportingSourceCutProof,
  runStagingHydrationOrchestration,
} from "../lib/recruiting-ops/delivery/staging-hydration-orchestrator"
import type { ScheduledHydrationCycle } from "../lib/recruiting-ops/delivery/staging-maintenance-cadence"
import { deliveryRpsTargetSheetId } from "../lib/recruiting-ops/delivery/staging-structural-normalization"
import { createFixtureGreenhouseExecReadBoundary, emptyExecStateSources } from "../lib/recruiting-ops/extractors/greenhouse-exec-read-boundary"
import type {
  SourceExecutionDatabaseClient,
  SourceExecutionRecord,
} from "../lib/recruiting-ops/source-execution-store"

const KEY = "orchestration-test-fingerprint-key"
const RUN_ID = "11111111-1111-4111-8111-111111111111"
const OWNER = "22222222-2222-4222-8222-222222222222"

describe("staging hydration durable orchestrator", () => {
  test("rejects an overlap before source or Google clients are created", async () => {
    const orchestration = new FakeOrchestrationClient({ claimAcquired: false, status: "running" })
    const buildSourceCut = vi.fn()
    const createGoogleClients = vi.fn()

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({ orchestration, buildSourceCut, createGoogleClients }))

    expect(result).toMatchObject({ status: "failed", reason: "overlap_in_progress" })
    expect(buildSourceCut).not.toHaveBeenCalled()
    expect(createGoogleClients).not.toHaveBeenCalled()
  })

  test("uses one stable owner across Cloud Run task retries without sharing it across executions", async () => {
    const first = new FakeOrchestrationClient({ claimAcquired: false, status: "running" })
    const retry = new FakeOrchestrationClient({ claimAcquired: false, status: "running" })
    const other = new FakeOrchestrationClient({ claimAcquired: false, status: "running" })
    const base = {
      mode: "write" as const,
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY, CLOUD_RUN_EXECUTION: "job-execution-a" },
    }

    await runStagingHydrationOrchestration(base, dependencies({ orchestration: first }))
    await runStagingHydrationOrchestration(base, dependencies({ orchestration: retry }))
    await runStagingHydrationOrchestration({
      ...base,
      env: { ...base.env, CLOUD_RUN_EXECUTION: "job-execution-b" },
    }, dependencies({ orchestration: other }))

    expect(first.claimInputs[0].ownerToken).toBe(retry.claimInputs[0].ownerToken)
    expect(other.claimInputs[0].ownerToken).not.toBe(first.claimInputs[0].ownerToken)
    expect(first.claimInputs[0].ownerToken).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("deduplicates Scheduler retries by the original cycle across execution names and actual dates", async () => {
    const first = new FakeOrchestrationClient({ claimAcquired: false, status: "running" })
    const retry = new FakeOrchestrationClient({ claimAcquired: false, status: "running" })
    const cycle = scheduledCycle({
      dueArtifacts: ["delivery_roles_rps"],
      scheduledAt: "2026-07-14T06:30:00.000Z",
      lane: "weekday_evening",
      businessDate: "2026-07-13",
    })

    await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: cycle.dueArtifacts,
      scheduledCycle: cycle,
      nowMs: Date.parse("2026-07-14T06:35:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY, CLOUD_RUN_EXECUTION: "scheduler-attempt-a" },
    }, dependencies({ orchestration: first }))
    await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: cycle.dueArtifacts,
      scheduledCycle: cycle,
      nowMs: Date.parse("2026-07-15T08:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY, CLOUD_RUN_EXECUTION: "scheduler-attempt-b" },
    }, dependencies({ orchestration: retry }))

    expect(first.claimInputs[0].dedupeKey).toBe(
      "staging-hydration:v2:2026-07-14T06:30:00.000Z:write"
    )
    expect(retry.claimInputs[0].dedupeKey).toBe(first.claimInputs[0].dedupeKey)
    expect(retry.claimInputs[0].ownerToken).not.toBe(first.claimInputs[0].ownerToken)
    expect(retry.claimInputs[0].businessDate).toBe("2026-07-13")
  })

  test("uses the scheduled calendar for source and lifecycle selection while retaining the actual clock", async () => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const buildSourceCut = vi.fn(async () => cut)
    const mutationNow = Date.parse("2026-07-17T18:05:00Z")
    const scheduledAt = "2026-07-16T13:30:00.000Z"
    const cycle = scheduledCycle({
      dueArtifacts: ["weekly_progress"],
      scheduledAt,
      lane: "weekday_morning",
      businessDate: "2026-07-16",
    })
    const runRecurringSheetLifecycle = vi.fn(async () => ({
      runId: "weekly-progress-scheduled",
      mode: "dry_run" as const,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcome: { artifactKey: "weekly_progress" as const, status: "dry_run" as const },
    }))
    const runSheet = vi.fn(async (input) => ({
      runId: input.runId!,
      mode: "dry_run" as const,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      quarterStart: cut.payload.facts.quarterStart,
      sourceCounts: { candidateEvents: 0, offers: 0, scorecards: 0, reqWeeks: 0 },
      artifactOutcomes: [{
        artifactKey: "weekly_progress" as const,
        status: "dry_run" as const,
        plan: {
          artifactKey: "weekly_progress" as const,
          rangeCount: 1,
          changedRangeCount: 0,
          noOp: true,
          rowCount: 0,
          payloadFingerprint: `hmac-sha256:${"a".repeat(64)}`,
          structureHash: `sha256:${"b".repeat(64)}`,
        },
      }],
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: cycle.dueArtifacts,
      scheduledCycle: cycle,
      nowMs: Date.parse("2026-07-17T18:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut,
      createGoogleClients: vi.fn(async () => ({} as never)),
      runRecurringSheetLifecycle,
      runSheet,
      clock: () => mutationNow,
    }))

    expect(result.status).toBe("no_change")
    expect(buildSourceCut).toHaveBeenCalledWith({
      nowMs: Date.parse("2026-07-17T18:00:00Z"),
      fingerprintKey: KEY,
      artifactKeys: ["weekly_progress"],
      reportingWeekFriday: "2026-07-10",
      quarterStart: "2026-07-01",
      calendarValidationNowMs: Date.parse("2026-07-16T12:00:00Z"),
    })
    expect(runRecurringSheetLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      nowMs: Date.parse(scheduledAt),
      currentTimeMs: expect.any(Function),
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    }))
    expect(runSheet).toHaveBeenCalledWith(expect.objectContaining({ nowMs: mutationNow }))
  })

  test.each([
    {
      caseName: "Pacific evening after UTC midnight",
      nowIso: "2026-07-24T00:56:00.000Z",
      businessDate: "2026-07-23",
    },
    {
      caseName: "Friday after Pacific midnight",
      nowIso: "2026-07-24T08:05:00.000Z",
      businessDate: "2026-07-24",
    },
  ])("anchors an unscheduled lifecycle to its persisted reporting week: $caseName", async ({
    nowIso,
    businessDate,
  }) => {
    const nowMs = Date.parse(nowIso)
    const cut = await fixtureCut(nowIso, "2026-07-17")
    const orchestration = new FakeOrchestrationClient()
    const runRecurringSheetLifecycle = vi.fn(async () => ({
      runId: "weekly-progress-unscheduled",
      mode: "dry_run" as const,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcome: { artifactKey: "weekly_progress" as const, status: "dry_run" as const },
    }))
    const runSheet = vi.fn(async (input) => ({
      runId: input.runId!,
      mode: "dry_run" as const,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      quarterStart: cut.payload.facts.quarterStart,
      sourceCounts: { candidateEvents: 0, offers: 0, scorecards: 0, reqWeeks: 0 },
      artifactOutcomes: [{
        artifactKey: "weekly_progress" as const,
        status: "dry_run" as const,
        plan: {
          artifactKey: "weekly_progress" as const,
          rangeCount: 1,
          changedRangeCount: 0,
          noOp: true,
          rowCount: 0,
          payloadFingerprint: `hmac-sha256:${"a".repeat(64)}`,
          structureHash: `sha256:${"b".repeat(64)}`,
        },
      }],
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: ["weekly_progress"],
      nowMs,
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runRecurringSheetLifecycle,
      runSheet,
    }))

    expect(result.status).toBe("no_change")
    expect(orchestration.claimInputs[0].businessDate).toBe(businessDate)
    expect(runRecurringSheetLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      nowMs: Date.parse("2026-07-17T12:00:00.000Z"),
      reportingWeekFriday: "2026-07-17",
    }))
  })

  test("rejects a forged scheduled cycle before constructing orchestration dependencies", async () => {
    const orchestrationClient = vi.fn()
    const cycle = scheduledCycle({
      dueArtifacts: ["all_hires"],
      quarterStart: "2026-04-01",
    })

    await expect(runStagingHydrationOrchestration({
      artifactKeys: cycle.dueArtifacts,
      scheduledCycle: cycle,
    }, {
      ...dependencies({ orchestration: new FakeOrchestrationClient() }),
      orchestrationClient,
    })).rejects.toThrow("resolved cycle")
    expect(orchestrationClient).not.toHaveBeenCalled()
  })

  test("does not persist or bind a newly built source cut for the wrong scheduled calendar", async () => {
    const cut = await fixtureCut()
    const sources = new FakeSourceExecutionClient()
    const orchestration = new FakeOrchestrationClient()
    const createGoogleClients = vi.fn()
    const cycle = scheduledCycle({
      dueArtifacts: ["all_hires"],
      scheduledAt: "2026-07-09T13:30:00.000Z",
      businessDate: "2026-07-09",
      reportingWeekFriday: "2026-07-03",
    })

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: cycle.dueArtifacts,
      scheduledCycle: cycle,
      nowMs: Date.parse("2026-07-09T14:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients,
    }))

    expect(result.status).toBe("failed")
    expect(sources.row?.status).toBe("failed")
    expect(orchestration.claim).not.toHaveProperty("sourceExecutionId")
    expect(createGoogleClients).not.toHaveBeenCalled()
  })

  test("fails before Google access when a replayed source cut belongs to another scheduled calendar", async () => {
    const cut = await fixtureCut()
    const sourceExecutionId = "33333333-3333-4333-8333-333333333333"
    const sources = new FakeSourceExecutionClient(completedSource(sourceExecutionId, cut))
    const orchestration = new FakeOrchestrationClient({
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    })
    const createGoogleClients = vi.fn()
    const cycle = scheduledCycle({
      dueArtifacts: ["all_hires"],
      scheduledAt: "2026-07-09T13:30:00.000Z",
      lane: "weekday_morning",
      businessDate: "2026-07-09",
      reportingWeekFriday: "2026-07-03",
    })

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: cycle.dueArtifacts,
      scheduledCycle: cycle,
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(),
      createGoogleClients,
    }))

    expect(result.status).toBe("failed")
    expect(createGoogleClients).not.toHaveBeenCalled()
  })

  test("persists one source cut, gives every artifact its identity, and completes all no-op", async () => {
    const orchestration = new FakeOrchestrationClient()
    const sources = new FakeSourceExecutionClient()
    const cut = await fixtureCut()
    const buildSourceCut = vi.fn(async () => cut)
    const mutationNow = Date.parse("2026-07-15T20:12:00Z")
    const createGoogleClients = vi.fn(async () => ({} as never))
    const runElt = vi.fn(async () => ({
      artifactKey: "elt_doc" as const,
      mode: "dry_run" as const,
      status: "dry_run" as const,
      runId: cut.payload.eltSnapshot.run_id,
      sourceGeneratedAt: cut.payload.eltSnapshot.generated_at,
      planRevisionFingerprint: `sha256:${"a".repeat(64)}`,
      plan: eltEvidencePlan(cut, "planned_for_internal_review", "replace_top_week"),
    }))
    const runSheet = vi.fn(async (input) => ({
      runId: input.runId!,
      mode: "dry_run" as const,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      quarterStart: cut.payload.facts.quarterStart,
      sourceCounts: { candidateEvents: 0, offers: 0, scorecards: 0, reqWeeks: 0 },
      artifactOutcomes: [{
        artifactKey: input.artifactKeys![0],
        status: "dry_run" as const,
        plan: {
          artifactKey: input.artifactKeys![0],
          rangeCount: 1,
          changedRangeCount: 0,
          noOp: true,
          rowCount: 0,
          payloadFingerprint: `hmac-sha256:${"c".repeat(64)}`,
          structureHash: `sha256:${"d".repeat(64)}`,
        },
      }],
    }))
    const runRecurringSheetLifecycle = vi.fn(async (input: {
      artifactKey: string
      mode?: "dry_run" | "write"
      reportingWeekFriday?: string
      deliveryRpsReportDate?: string
      pipelineJobWeekRows?: readonly (readonly unknown[])[]
      weeklyProgressQuarterOpeningOffsets?: readonly {
        sheetId: number
        rowOffsets: readonly number[]
      }[]
      weeklyProgressQuarterClosingOffsets?: readonly {
        sheetId: number
        rowOffsets: readonly number[]
      }[]
    }) => ({
      runId: `${input.artifactKey}-recurring-test`,
      mode: input.mode ?? "dry_run",
      reportingWeekFriday: input.reportingWeekFriday!,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcome: {
        artifactKey: input.artifactKey,
        status: input.mode === "write" ? "already_normalized" as const : "dry_run" as const,
      },
    }))

    const orchestrationDependencies = dependencies({
      orchestration,
      sources,
      buildSourceCut,
      createGoogleClients,
      runElt,
      runSheet,
      runRecurringSheetLifecycle,
      clock: () => mutationNow,
    })
    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, orchestrationDependencies)

    expect(result.status).toBe("no_change")
    expect(buildSourceCut).toHaveBeenCalledOnce()
    expect(createGoogleClients).toHaveBeenCalledOnce()
    expect(runElt).toHaveBeenCalledOnce()
    expect(runSheet).toHaveBeenCalledTimes(10)
    expect(runElt).toHaveBeenCalledWith(expect.objectContaining({ nowMs: mutationNow }))
    expect(runSheet.mock.calls.every(([input]) => input.nowMs === mutationNow)).toBe(true)
    expect(orchestrationDependencies.runWeeklyRollover).toHaveBeenCalledWith(expect.objectContaining({
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      nowMs: Date.parse(`${cut.payload.facts.reportingWeekFriday}T12:00:00.000Z`),
    }))
    expect(orchestrationDependencies.runWeeklyRowLifecycle).toHaveBeenCalledOnce()
    expect(runRecurringSheetLifecycle).toHaveBeenCalledTimes(8)
    expect(runRecurringSheetLifecycle.mock.calls.map(([input]) => input.artifactKey)).toEqual([
      "weekly_progress",
      "pipeline_890",
      "pipeline_907",
      "pipeline_1026_1027",
      "pipeline_1118_1119",
      "final_offer",
      "rps_tracking",
      "delivery_roles_rps",
    ])
    expect(runRecurringSheetLifecycle.mock.calls
      .filter(([input]) => input.artifactKey.startsWith("pipeline_"))
      .map(([input]) => input.pipelineJobWeekRows!.map((row) => row[2]))).toEqual([
        ["890"],
        ["907"],
        ["1026", "1027"],
        ["1118", "1119"],
      ])
    expect(runRecurringSheetLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
        nowMs: Date.parse(`${cut.payload.facts.reportingWeekFriday}T12:00:00.000Z`),
        sourceGeneratedAt: cut.payload.facts.generatedAt,
      })
    )
    expect(runRecurringSheetLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactKey: "final_offer",
        quarterStart: cut.payload.facts.quarterStart,
      })
    )
    expect(runRecurringSheetLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactKey: "delivery_roles_rps",
        deliveryRpsReportDate: "2026-07-15",
      })
    )
    expect(runSheet).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactKeys: ["delivery_roles_rps"],
        deliveryRpsReportDate: "2026-07-15",
      })
    )
    expect(runRecurringSheetLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactKey: "weekly_progress",
        weeklyProgressQuarterOpeningOffsets: [
          { sheetId: 0, rowOffsets: [0, 0, 0, 0, 0, 0, 0] },
          { sheetId: 242118538, rowOffsets: [0, 0, 0, 0, 0, 0] },
          { sheetId: 1450892249, rowOffsets: [0, 0, 0, 0, 0, 0, 0] },
        ],
        weeklyProgressQuarterClosingOffsets: [
          { sheetId: 0, rowOffsets: [0, 0, 0, 0, 0, 0, 0] },
          { sheetId: 242118538, rowOffsets: [0, 0, 0, 0, 0, 0] },
          { sheetId: 1450892249, rowOffsets: [0, 0, 0, 0, 0, 0, 0] },
        ],
      })
    )
    expect(orchestration.attempts).toHaveLength(11)
    expect(new Set(orchestration.attempts.map((attempt) => attempt.sourceFingerprint))).toEqual(
      new Set([cut.payloadFingerprint])
    )
    expect(result.completedArtifacts).toEqual(ALL_HYDRATION_ARTIFACTS)
  })

  test("isolates a Thursday ELT failure while sibling artifacts share one deduplicated source", async () => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const buildSourceCut = vi.fn(async () => cut)
    const runElt = vi.fn(async () => {
      throw new Error("private ELT failure")
    })
    const runSheet = vi.fn(async (input: { runId?: string; artifactKeys?: readonly string[] }) => {
      const artifactKey = input.artifactKeys![0] as "all_hires" | "weekly_progress"
      return {
        runId: input.runId!,
        mode: "dry_run" as const,
        sourceGeneratedAt: cut.payload.facts.generatedAt,
        reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
        quarterStart: cut.payload.facts.quarterStart,
        sourceCounts: { candidateEvents: 0, offers: 0, scorecards: 0, reqWeeks: 0 },
        artifactOutcomes: [{
          artifactKey,
          status: "dry_run" as const,
          plan: {
            artifactKey,
            rangeCount: 1,
            changedRangeCount: 0,
            noOp: true,
            rowCount: 0,
            payloadFingerprint: `hmac-sha256:${"c".repeat(64)}`,
            structureHash: `sha256:${"d".repeat(64)}`,
          },
        }],
      }
    })
    const cycle = scheduledCycle({
      dueArtifacts: ["all_hires", "elt_doc", "weekly_progress"],
    })

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: cycle.dueArtifacts,
      scheduledCycle: cycle,
      nowMs: Date.parse("2026-07-16T13:30:30.000Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut,
      createGoogleClients: vi.fn(async () => ({} as never)),
      runElt,
      runSheet,
      clock: () => Date.parse("2026-07-16T13:30:30.000Z"),
    }))

    expect(result).toMatchObject({
      status: "partial",
      completedArtifacts: ["all_hires", "weekly_progress"],
      failedArtifacts: ["elt_doc"],
      replayed: false,
    })
    expect(buildSourceCut).toHaveBeenCalledOnce()
    expect(runElt).toHaveBeenCalledOnce()
    expect(runSheet).toHaveBeenCalledTimes(2)
    expect(orchestration.attempts).toHaveLength(3)
    expect(new Set(orchestration.attempts.map((attempt) => attempt.sourceFingerprint))).toEqual(
      new Set([cut.payloadFingerprint])
    )
  })

  test("persists exact ELT preimage evidence for a zero-mutation no-op", async () => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const preimageFingerprint = `hmac-sha256:${"a".repeat(64)}`
    const outsideFingerprint = `hmac-sha256:${"b".repeat(64)}`
    const runElt = vi.fn(async () => ({
      artifactKey: "elt_doc" as const,
      mode: "write" as const,
      status: "no_change" as const,
      runId: cut.payload.eltSnapshot.run_id,
      sourceGeneratedAt: cut.payload.eltSnapshot.generated_at,
      planRevisionFingerprint: `sha256:${"d".repeat(64)}`,
      plan: eltEvidencePlan(cut, "no_change", "no_op"),
      write: {
        status: "no_change" as const,
        mutationCallCount: 0,
        beforeRevisionFingerprint: `sha256:${"d".repeat(64)}`,
        afterRevisionFingerprint: `sha256:${"d".repeat(64)}`,
        beforeDriveVersion: "100",
        afterDriveVersion: "100",
        preimageFingerprint,
        beforePermissionFingerprint: `hmac-sha256:${"e".repeat(64)}`,
        afterPermissionFingerprint: `hmac-sha256:${"e".repeat(64)}`,
        afterOutsideContentFingerprint: outsideFingerprint,
        rollbackRequestCount: 0,
        rollbackAttempted: false as const,
      },
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["elt_doc"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runElt,
    }))

    expect(result).toMatchObject({
      status: "no_change",
      completedArtifacts: ["elt_doc"],
      failedArtifacts: [],
    })
    expect(orchestration.attempts.at(-1)).toMatchObject({
      outcome: "no_change",
      mutationCallCount: 0,
      certificationEvidence: {
        evidence_contract: "elt_fact_table_v1",
        pii_policy: "internal_review_identifiers",
        acl_policy: "exact_owner_and_service_writer",
        hydration_mode: "write",
        mutation_scope: "weekly_fact_table",
        plan_status: "no_change",
        plan_action: "no_op",
        dry_run_verified: false,
        preimage_fingerprint: preimageFingerprint,
        drive_version_before: "100",
        drive_version_after: "100",
        rollback_drive_version: null,
        permission_fingerprint: `hmac-sha256:${"e".repeat(64)}`,
        permission_fingerprint_after: `hmac-sha256:${"e".repeat(64)}`,
        rollback_permission_fingerprint: null,
        outside_content_fingerprint: outsideFingerprint,
        revision_before_fingerprint: `sha256:${"d".repeat(64)}`,
        revision_after_fingerprint: `sha256:${"d".repeat(64)}`,
        revision_guard_present: true,
        reporting_week: eltFixtureReportingWeek(cut),
        snapshot_run_id: cut.payload.eltSnapshot.run_id,
        snapshot_mode: "shadow",
        source_generated_at: cut.payload.eltSnapshot.generated_at,
        certification_status: "preimage_verified",
        rollback_request_count: 0,
        rollback_attempted: false,
        rollback_verified: false,
      },
    })
  })

  test("does not replan when Drive never publishes a later version", async () => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const waitForDriveVersionAdvance = vi.fn(async () => null)
    const runSheet = vi.fn(async () => ({
      artifactOutcomes: [{
        artifactKey: "weekly_progress" as const,
        status: "blocked" as const,
        failure: {
          failureStage: "preimage_validation" as const,
          mutationCallCount: 0,
          beforeDriveVersion: "44",
          afterDriveVersion: null,
          certificationStatus: "not_attempted" as const,
        },
      }],
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["weekly_progress"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runRecurringSheetLifecycle: vi.fn(async () => ({
        outcome: {
          artifactKey: "weekly_progress" as const,
          status: "normalized" as const,
          write: {
            mutationCallCount: 1,
            beforeDriveVersion: "42",
            afterDriveVersion: "44",
          },
        },
      })),
      waitForDriveVersionAdvance,
      runSheet,
    }))

    expect(result).toMatchObject({
      status: "failed",
      completedArtifacts: [],
      failedArtifacts: ["weekly_progress"],
    })
    expect(waitForDriveVersionAdvance).toHaveBeenCalledOnce()
    expect(runSheet).toHaveBeenCalledOnce()
    expect(orchestration.attempts.at(-1)).toMatchObject({
      outcome: "failed",
      failureStage: "preimage_validation",
      mutationCallCount: 1,
      certificationEvidence: {
        value_preimage_replan_count: 0,
      },
    })
  })

  test.each([
    {
      lane: "Thursday primary",
      generatedAt: "2026-07-16T13:30:00.000Z",
      scheduledAt: "2026-07-16T13:30:00.000Z",
      businessDate: "2026-07-16",
      topLevelReportingFriday: "2026-07-10",
    },
    {
      lane: "Friday refresh",
      generatedAt: "2026-07-17T13:30:00.000Z",
      scheduledAt: "2026-07-17T13:30:00.000Z",
      businessDate: "2026-07-17",
      topLevelReportingFriday: "2026-07-17",
    },
  ])("persists the artifact-specific ELT period and safe dry revision on $lane", async ({
    generatedAt,
    scheduledAt,
    businessDate,
    topLevelReportingFriday,
  }) => {
    const cut = await fixtureCut(generatedAt, topLevelReportingFriday)
    const orchestration = new FakeOrchestrationClient()
    const plan = eltEvidencePlan(cut, "planned_for_internal_review", "replace_top_week")
    const planRevisionFingerprint = `sha256:${"9".repeat(64)}`
    const runElt = vi.fn(async () => ({
      artifactKey: "elt_doc" as const,
      mode: "dry_run" as const,
      status: "dry_run" as const,
      runId: cut.payload.eltSnapshot.run_id,
      sourceGeneratedAt: cut.payload.eltSnapshot.generated_at,
      planRevisionFingerprint,
      plan,
    }))
    const cycle = scheduledCycle({
      dueArtifacts: ["elt_doc"],
      scheduledAt,
      businessDate,
      reportingWeekFriday: topLevelReportingFriday,
    })

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: cycle.dueArtifacts,
      scheduledCycle: cycle,
      nowMs: Date.parse(scheduledAt) + 30_000,
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runElt,
      clock: () => Date.parse(scheduledAt) + 30_000,
    }))

    expect(result).toMatchObject({
      status: "no_change",
      completedArtifacts: ["elt_doc"],
      failedArtifacts: [],
    })
    expect(orchestration.attempts.at(-1)).toMatchObject({
      outcome: "no_change",
      mutationCallCount: 0,
      versionBefore: planRevisionFingerprint,
      versionAfter: null,
      certificationEvidence: {
        artifact_status: "dry_run",
        evidence_contract: "elt_fact_table_v1",
        pii_policy: "internal_review_identifiers",
        acl_policy: "exact_owner_and_service_writer",
        hydration_mode: "dry_run",
        plan_status: "planned_for_internal_review",
        plan_action: "replace_top_week",
        dry_run_verified: true,
        preimage_fingerprint: plan.currentBlockFingerprint,
        drive_version_before: null,
        drive_version_after: null,
        rollback_drive_version: null,
        permission_fingerprint: null,
        permission_fingerprint_after: null,
        rollback_permission_fingerprint: null,
        outside_content_fingerprint: plan.outsideContentFingerprint,
        revision_before_fingerprint: planRevisionFingerprint,
        revision_after_fingerprint: null,
        reporting_week: plan.reportingWeek,
        snapshot_run_id: cut.payload.eltSnapshot.run_id,
        snapshot_mode: "shadow",
        source_generated_at: generatedAt,
        template_hash: plan.templateHash,
        certification_status: "dry_run_verified",
      },
    })
    expect(plan.reportingWeek).toBe("Jul 10, 2026 - Jul 16, 2026")
    if (topLevelReportingFriday === "2026-07-17") {
      expect(plan.reportingWeek).not.toBe("Jul 17, 2026 - Jul 23, 2026")
    }
  })

  test("refuses to finish a successful ELT outcome with incomplete evidence", async () => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const finishAttempt = vi.spyOn(orchestration, "finishAttempt")
    const runElt = vi.fn(async () => ({
      artifactKey: "elt_doc" as const,
      mode: "dry_run" as const,
      status: "dry_run" as const,
      runId: cut.payload.eltSnapshot.run_id,
      sourceGeneratedAt: cut.payload.eltSnapshot.generated_at,
      plan: {
        payloadFingerprint: `hmac-sha256:${"a".repeat(64)}`,
      },
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: ["elt_doc"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runElt,
    }))

    expect(result).toMatchObject({
      status: "failed",
      completedArtifacts: [],
      failedArtifacts: ["elt_doc"],
    })
    expect(finishAttempt).not.toHaveBeenCalled()
    expect(orchestration.attempts).toHaveLength(1)
    expect(orchestration.attempts[0]).toMatchObject({
      artifactKey: "elt_doc",
      status: "running",
      outcome: null,
    })
  })

  test("durably defers recurring values when dry-run structure must be created first", async () => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const runSheet = vi.fn()
    const structureFingerprint = `sha256:${"1".repeat(64)}`
    const runRecurringSheetLifecycle = vi.fn(async () => ({
      runId: "weekly-progress-lifecycle-test",
      mode: "dry_run" as const,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcome: {
        artifactKey: "weekly_progress" as const,
        status: "dry_run" as const,
        plan: {
          artifactKey: "weekly_progress" as const,
          reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
          normalizationId: "weekly_progress_rollover_20260710",
          status: "planned" as const,
          forwardRequestCount: 6,
          rollbackRequestCount: 3,
          structureFingerprint,
          driveVersion: "26",
          copyOnly: false as const,
          canonicalWriteAuthorized: true as const,
        },
      },
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: ["weekly_progress"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runRecurringSheetLifecycle,
      runSheet,
    }))

    expect(result).toMatchObject({
      status: "failed",
      completedArtifacts: [],
      failedArtifacts: ["weekly_progress"],
    })
    expect(runSheet).not.toHaveBeenCalled()
    expect(orchestration.attempts.at(-1)).toMatchObject({
      outcome: "failed",
      planFingerprint: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
      mutationCallCount: 0,
      versionBefore: "26",
      versionAfter: null,
      failureCode: "value_plan_deferred_pending_structure",
      failureStage: "planning",
      certificationEvidence: {
        artifact_status: "deferred_pending_structure",
        lifecycle: "recurring",
        lifecycle_plan_status: "planned",
        normalization_id: "weekly_progress_rollover_20260710",
        forward_request_count: 6,
        rollback_request_count: 3,
        observed_structure_fingerprint: structureFingerprint,
        value_plan_status: "deferred_pending_structure",
      },
    })
  })

  test("replans once after a normalized lifecycle has a delayed Drive publication", async () => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const runRecurringSheetLifecycle = vi.fn(async () => ({
      outcome: {
        artifactKey: "weekly_progress" as const,
        status: "normalized" as const,
        write: {
          mutationCallCount: 1,
          beforeDriveVersion: "42",
          afterDriveVersion: "44",
        },
      },
    }))
    const waitForDriveVersionAdvance = vi.fn(async () => "45")
    const runSheet = vi.fn()
      .mockResolvedValueOnce({
        artifactOutcomes: [{
          artifactKey: "weekly_progress" as const,
          status: "blocked" as const,
          failure: {
            failureStage: "preimage_validation" as const,
            mutationCallCount: 0,
            beforeDriveVersion: "44",
            afterDriveVersion: null,
            certificationStatus: "not_attempted" as const,
          },
        }],
      })
      .mockResolvedValueOnce({
        artifactOutcomes: [{
          artifactKey: "weekly_progress" as const,
          status: "no_change" as const,
          plan: {
            artifactKey: "weekly_progress" as const,
            rangeCount: 3,
            changedRangeCount: 0,
            noOp: true,
            rowCount: 20,
            payloadFingerprint: `hmac-sha256:${"a".repeat(64)}`,
            structureHash: `sha256:${"b".repeat(64)}`,
          },
          write: {
            mutationCallCount: 0,
            beforeDriveVersion: "45",
            afterDriveVersion: "45",
            structureCertification: "exact" as const,
            afterStructureHash: `sha256:${"b".repeat(64)}`,
          },
        }],
      })

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["weekly_progress"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runRecurringSheetLifecycle,
      waitForDriveVersionAdvance,
      runSheet,
    }))

    expect(result).toMatchObject({
      status: "succeeded",
      completedArtifacts: ["weekly_progress"],
      failedArtifacts: [],
    })
    expect(waitForDriveVersionAdvance).toHaveBeenCalledWith({
      artifactKey: "weekly_progress",
      clients: {},
      minimumDriveVersionExclusive: "44",
    })
    expect(runSheet).toHaveBeenCalledTimes(2)
    expect(orchestration.attempts.at(-1)).toMatchObject({
      outcome: "written",
      mutationCallCount: 1,
      versionBefore: "42",
      versionAfter: "45",
      certificationEvidence: {
        artifact_status: "no_change",
        recurring_lifecycle_status: "normalized",
        value_preimage_replan_count: 1,
      },
    })
  })

  test.each([
    {
      label: "the failed value read is not bound to the lifecycle version",
      failure: {
        failureStage: "preimage_validation" as const,
        mutationCallCount: 0,
        beforeDriveVersion: "45",
        afterDriveVersion: null,
        certificationStatus: "not_attempted" as const,
      },
    },
    {
      label: "the value writer recorded a mutation call",
      failure: {
        failureStage: "preimage_validation" as const,
        mutationCallCount: 1,
        beforeDriveVersion: "44",
        afterDriveVersion: null,
        certificationStatus: "not_attempted" as const,
      },
    },
    {
      label: "the value writer has non-pristine certification",
      failure: {
        failureStage: "preimage_validation" as const,
        mutationCallCount: 0,
        beforeDriveVersion: "44",
        afterDriveVersion: null,
        certificationStatus: "ambiguous" as const,
      },
    },
    {
      label: "the value writer observed an after-version",
      failure: {
        failureStage: "preimage_validation" as const,
        mutationCallCount: 0,
        beforeDriveVersion: "44",
        afterDriveVersion: "45",
        certificationStatus: "not_attempted" as const,
      },
    },
  ])("does not replan when $label", async ({ failure }) => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const waitForDriveVersionAdvance = vi.fn(async () => "45")
    const runSheet = vi.fn(async () => ({
      artifactOutcomes: [{
        artifactKey: "weekly_progress" as const,
        status: "blocked" as const,
        failure,
      }],
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["weekly_progress"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runRecurringSheetLifecycle: vi.fn(async () => ({
        outcome: {
          artifactKey: "weekly_progress" as const,
          status: "normalized" as const,
          write: {
            mutationCallCount: 1,
            beforeDriveVersion: "42",
            afterDriveVersion: "44",
          },
        },
      })),
      waitForDriveVersionAdvance,
      runSheet,
    }))

    expect(result).toMatchObject({
      status: "failed",
      completedArtifacts: [],
      failedArtifacts: ["weekly_progress"],
    })
    expect(waitForDriveVersionAdvance).not.toHaveBeenCalled()
    expect(runSheet).toHaveBeenCalledOnce()
  })

  test("replans once after a normalized Weekly Recruitment rollover has a delayed Drive publication", async () => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const runWeeklyRollover = vi.fn(async () => ({
      runId: "weekly-rollover-test",
      mode: "write" as const,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcomes: [{
        artifactKey: "weekly_recruitment" as const,
        status: "normalized" as const,
        write: {
          mutationCallCount: 1,
          beforeDriveVersion: "V1",
          afterDriveVersion: "V2",
        },
      }] as const,
    }))
    const runWeeklyRowLifecycle = vi.fn(async (input: {
      mode?: "dry_run" | "write"
      reportingWeekFriday: string
    }) => ({
      runId: "weekly-row-lifecycle-test",
      mode: input.mode ?? "write",
      reportingWeekFriday: input.reportingWeekFriday,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcomes: [{
        artifactKey: "weekly_recruitment" as const,
        status: "already_normalized" as const,
      }] as const,
    }))
    const waitForDriveVersionAdvance = vi.fn(async () => "V3")
    const runSheet = vi.fn()
      .mockResolvedValueOnce({
        artifactOutcomes: [{
          artifactKey: "weekly_recruitment" as const,
          status: "blocked" as const,
          failure: {
            failureStage: "preimage_validation" as const,
            mutationCallCount: 0,
            beforeDriveVersion: "V2",
            afterDriveVersion: null,
            certificationStatus: "not_attempted" as const,
          },
        }],
      })
      .mockResolvedValueOnce({
        artifactOutcomes: [{
          artifactKey: "weekly_recruitment" as const,
          status: "no_change" as const,
          plan: {
            artifactKey: "weekly_recruitment" as const,
            rangeCount: 3,
            changedRangeCount: 0,
            noOp: true,
            rowCount: 20,
            payloadFingerprint: `hmac-sha256:${"a".repeat(64)}`,
            structureHash: `sha256:${"b".repeat(64)}`,
          },
          write: {
            mutationCallCount: 0,
            beforeDriveVersion: "V3",
            afterDriveVersion: "V3",
            structureCertification: "exact" as const,
            afterStructureHash: `sha256:${"b".repeat(64)}`,
          },
        }],
      })

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["weekly_recruitment"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runWeeklyRollover,
      runWeeklyRowLifecycle,
      waitForDriveVersionAdvance,
      runSheet,
    }))

    expect(result).toMatchObject({
      status: "succeeded",
      completedArtifacts: ["weekly_recruitment"],
      failedArtifacts: [],
    })
    expect(waitForDriveVersionAdvance).toHaveBeenCalledOnce()
    expect(waitForDriveVersionAdvance).toHaveBeenCalledWith({
      artifactKey: "weekly_recruitment",
      clients: {},
      minimumDriveVersionExclusive: "V2",
    })
    expect(runSheet).toHaveBeenCalledTimes(2)
    expect(orchestration.attempts.at(-1)).toMatchObject({
      outcome: "written",
      certificationEvidence: {
        artifact_status: "no_change",
        rollover_status: "normalized",
        value_preimage_replan_count: 1,
      },
    })
  })

  test.each([
    {
      label: "the failed value read is not bound to the rollover version",
      failure: {
        failureStage: "preimage_validation" as const,
        mutationCallCount: 0,
        beforeDriveVersion: "V3",
        afterDriveVersion: null,
        certificationStatus: "not_attempted" as const,
      },
      rolloverStatus: "normalized" as const,
    },
    {
      label: "the failure stage is not preimage validation",
      failure: {
        failureStage: "mutation" as const,
        mutationCallCount: 0,
        beforeDriveVersion: "V2",
        afterDriveVersion: null,
        certificationStatus: "not_attempted" as const,
      },
      rolloverStatus: "normalized" as const,
    },
    {
      label: "the rollover was already normalized with no write",
      failure: {
        failureStage: "preimage_validation" as const,
        mutationCallCount: 0,
        beforeDriveVersion: "V2",
        afterDriveVersion: null,
        certificationStatus: "not_attempted" as const,
      },
      rolloverStatus: "already_normalized" as const,
    },
  ])("does not replan Weekly Recruitment when $label", async ({ failure, rolloverStatus }) => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const waitForDriveVersionAdvance = vi.fn(async () => "V3")
    const runSheet = vi.fn(async () => ({
      artifactOutcomes: [{
        artifactKey: "weekly_recruitment" as const,
        status: "blocked" as const,
        failure,
      }],
    }))
    const runWeeklyRollover = vi.fn(async () => ({
      runId: "weekly-rollover-test",
      mode: "write" as const,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcomes: rolloverStatus === "already_normalized"
        ? [{
            artifactKey: "weekly_recruitment" as const,
            status: "already_normalized" as const,
          }] as const
        : [{
            artifactKey: "weekly_recruitment" as const,
            status: "normalized" as const,
            write: {
              mutationCallCount: 1,
              beforeDriveVersion: "V1",
              afterDriveVersion: "V2",
            },
          }] as const,
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["weekly_recruitment"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runWeeklyRollover,
      waitForDriveVersionAdvance,
      runSheet,
    }))

    expect(result).toMatchObject({
      status: "failed",
      completedArtifacts: [],
      failedArtifacts: ["weekly_recruitment"],
    })
    expect(waitForDriveVersionAdvance).not.toHaveBeenCalled()
    expect(runSheet).toHaveBeenCalledOnce()
  })

  test("terminalizes a second preimage rejection without a third plan", async () => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const runSheet = vi.fn()
      .mockResolvedValueOnce({
        artifactOutcomes: [{
          artifactKey: "weekly_progress" as const,
          status: "blocked" as const,
          failure: {
            failureStage: "preimage_validation" as const,
            mutationCallCount: 0,
            beforeDriveVersion: "44",
            afterDriveVersion: null,
            certificationStatus: "not_attempted" as const,
          },
        }],
      })
      .mockResolvedValueOnce({
        artifactOutcomes: [{
          artifactKey: "weekly_progress" as const,
          status: "blocked" as const,
          failure: {
            failureStage: "preimage_validation" as const,
            mutationCallCount: 0,
            beforeDriveVersion: "45",
            afterDriveVersion: null,
            certificationStatus: "not_attempted" as const,
          },
        }],
      })

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["weekly_progress"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runRecurringSheetLifecycle: vi.fn(async () => ({
        outcome: {
          artifactKey: "weekly_progress" as const,
          status: "normalized" as const,
          write: {
            mutationCallCount: 1,
            beforeDriveVersion: "42",
            afterDriveVersion: "44",
          },
        },
      })),
      waitForDriveVersionAdvance: vi.fn(async () => "45"),
      runSheet,
    }))

    expect(result).toMatchObject({
      status: "failed",
      completedArtifacts: [],
      failedArtifacts: ["weekly_progress"],
    })
    expect(runSheet).toHaveBeenCalledTimes(2)
    expect(orchestration.attempts.at(-1)).toMatchObject({
      outcome: "failed",
      failureStage: "preimage_validation",
      mutationCallCount: 1,
      certificationEvidence: {
        value_preimage_replan_count: 1,
      },
    })
  })

  test("completes an absent-target Delivery dry run from an exact projected plan without mutation", async () => {
    const cut = await fixtureCut("2026-07-16T06:29:00.000Z")
    const orchestration = new FakeOrchestrationClient()
    const googleClients = {} as never
    const runSheet = vi.fn()
    const reportDate = "2026-07-15"
    const target = {
      targetSheetId: deliveryRpsTargetSheetId(reportDate),
      targetSheetTitle: "15 Jul 2026",
      templateSheetId: 2061940582,
      templateSheetTitle: "09 Jul 2026",
      firstValueRow: 3 as const,
      preservedValueRowCount: 2 as const,
    }
    const structure = {
      kind: "projected_post_normalization" as const,
      normalizationId: "delivery_rps_dated_rollover_20260715",
      normalizationFingerprint: `sha256:${"1".repeat(64)}`,
      observedDriveVersion: "62",
      observedStructureFingerprint: `sha256:${"2".repeat(64)}`,
      expectedAfterStateFingerprint: `sha256:${"3".repeat(64)}`,
      forwardRequestsFingerprint: `sha256:${"4".repeat(64)}`,
      rollbackRequestsFingerprint: `sha256:${"5".repeat(64)}`,
    }
    const runRecurringSheetLifecycle = vi.fn(async () => ({
      runId: "delivery-projected-lifecycle-test",
      mode: "dry_run" as const,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcome: {
        artifactKey: "delivery_roles_rps" as const,
        status: "dry_run" as const,
        plan: {
          artifactKey: "delivery_roles_rps" as const,
          reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
          normalizationId: structure.normalizationId,
          status: "planned" as const,
          forwardRequestCount: 4,
          rollbackRequestCount: 2,
          structureFingerprint: structure.observedStructureFingerprint,
          driveVersion: structure.observedDriveVersion,
          copyOnly: false as const,
          canonicalWriteAuthorized: true as const,
          projectedDryRun: { target, structure },
        },
      },
    }))
    const planProjectedDeliveryRps = vi.fn(async () => ({
      plan: { planFingerprint: `hmac-sha256:${"a".repeat(64)}` },
      publicSummary: {
        artifactKey: "delivery_roles_rps" as const,
        rangeCount: 3,
        projectedChangedRangeCount: 1,
        projectedValueNoOp: false,
        projectedPreimageFingerprint: `hmac-sha256:${"b".repeat(64)}`,
        desiredPayloadFingerprint: `hmac-sha256:${"c".repeat(64)}`,
        formatFingerprint: `sha256:${"6".repeat(64)}`,
      },
    }))
    const cycle = scheduledCycle({
      scheduledAt: "2026-07-16T06:30:00.000Z",
      lane: "weekday_evening",
      businessDate: reportDate,
      dueArtifacts: ["delivery_roles_rps"],
    })

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: cycle.dueArtifacts,
      scheduledCycle: cycle,
      nowMs: Date.parse("2026-07-16T06:30:30.000Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => googleClients),
      runRecurringSheetLifecycle,
      planProjectedDeliveryRps,
      runSheet,
      clock: () => Date.parse("2026-07-16T06:30:30.000Z"),
    }))

    expect(result).toMatchObject({
      status: "no_change",
      completedArtifacts: ["delivery_roles_rps"],
      failedArtifacts: [],
    })
    expect(planProjectedDeliveryRps).toHaveBeenCalledWith({
      runId: RUN_ID,
      facts: cut.payload.facts,
      roster: cut.payload.roster,
      clients: googleClients,
      deliveryRpsReportDate: reportDate,
      target,
      structure,
    })
    expect(runSheet).not.toHaveBeenCalled()
    expect(orchestration.attempts.at(-1)).toMatchObject({
      outcome: "no_change",
      planFingerprint: `hmac-sha256:${"a".repeat(64)}`,
      mutationCallCount: 0,
      versionBefore: "62",
      versionAfter: null,
      failureCode: null,
      failureStage: null,
      certificationEvidence: {
        artifact_status: "projected_dry_run",
        projection_certification: "exact_preimage_plus_deterministic_requests",
        postimage_observed: false,
        target_absent_observed: true,
        observed_drive_version: "62",
        drive_version_stable: true,
        normalization_id: structure.normalizationId,
        target_sheet_id: target.targetSheetId,
        target_sheet_title: target.targetSheetTitle,
        range_count: 3,
        projected_changed_range_count: 1,
        projected_value_no_op: false,
        value_plan_status: "projected",
      },
    })
  })

  test("rejects a stale source before certifying an absent-target Delivery projection", async () => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const planProjectedDeliveryRps = vi.fn()
    const reportDate = "2026-07-15"
    const target = {
      targetSheetId: deliveryRpsTargetSheetId(reportDate),
      targetSheetTitle: "15 Jul 2026",
      templateSheetId: 2061940582,
      templateSheetTitle: "09 Jul 2026",
      firstValueRow: 3 as const,
      preservedValueRowCount: 2 as const,
    }
    const structure = {
      kind: "projected_post_normalization" as const,
      normalizationId: "delivery_rps_dated_rollover_20260715",
      normalizationFingerprint: `sha256:${"1".repeat(64)}`,
      observedDriveVersion: "62",
      observedStructureFingerprint: `sha256:${"2".repeat(64)}`,
      expectedAfterStateFingerprint: `sha256:${"3".repeat(64)}`,
      forwardRequestsFingerprint: `sha256:${"4".repeat(64)}`,
      rollbackRequestsFingerprint: `sha256:${"5".repeat(64)}`,
    }
    const runRecurringSheetLifecycle = vi.fn(async () => ({
      runId: "delivery-stale-projection-test",
      mode: "dry_run" as const,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcome: {
        artifactKey: "delivery_roles_rps" as const,
        status: "dry_run" as const,
        plan: {
          artifactKey: "delivery_roles_rps" as const,
          reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
          normalizationId: structure.normalizationId,
          status: "planned" as const,
          forwardRequestCount: 4,
          rollbackRequestCount: 2,
          structureFingerprint: structure.observedStructureFingerprint,
          driveVersion: structure.observedDriveVersion,
          copyOnly: false as const,
          canonicalWriteAuthorized: true as const,
          projectedDryRun: { target, structure },
        },
      },
    }))
    const cycle = scheduledCycle({
      scheduledAt: "2026-07-16T06:30:00.000Z",
      lane: "weekday_evening",
      businessDate: reportDate,
      dueArtifacts: ["delivery_roles_rps"],
    })

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: cycle.dueArtifacts,
      scheduledCycle: cycle,
      nowMs: Date.parse("2026-07-16T06:30:30.000Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runRecurringSheetLifecycle,
      planProjectedDeliveryRps,
      clock: () => Date.parse("2026-07-16T06:30:30.000Z"),
    }))

    expect(result).toMatchObject({
      status: "failed",
      completedArtifacts: [],
      failedArtifacts: ["delivery_roles_rps"],
    })
    expect(planProjectedDeliveryRps).not.toHaveBeenCalled()
    expect(orchestration.attempts.at(-1)).toMatchObject({
      outcome: "failed",
      failureCode: "artifact_execution_failed",
    })
  })

  test("durably defers Weekly Recruitment values when dry-run rollover is planned", async () => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()
    const runSheet = vi.fn()
    const runWeeklyRowLifecycle = vi.fn()
    const structureFingerprint = `sha256:${"2".repeat(64)}`
    const runWeeklyRollover = vi.fn(async () => ({
      runId: "weekly-rollover-test",
      mode: "dry_run" as const,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcomes: [{
        artifactKey: "weekly_recruitment" as const,
        status: "dry_run" as const,
        plan: {
          artifactKey: "weekly_recruitment" as const,
          reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
          targetSheetId: 1,
          targetSheetTitle: "target",
          predecessorSheetId: 2,
          predecessorSheetTitle: "predecessor",
          normalizationId: "weekly_recruitment_rollover_20260710",
          status: "planned" as const,
          forwardRequestCount: 1,
          rollbackRequestCount: 1,
          structureFingerprint,
          preimageFingerprint: `sha256:${"3".repeat(64)}`,
          afterStateFingerprint: `sha256:${"4".repeat(64)}`,
          forwardRequestsFingerprint: `sha256:${"5".repeat(64)}`,
          rollbackRequestsFingerprint: `sha256:${"6".repeat(64)}`,
          driveVersion: "41",
          literalRangeCount: 0,
          literalCellUpperBound: 0,
          copyOnly: false as const,
          canonicalWriteAuthorized: true as const,
        },
      }] as const,
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: ["weekly_recruitment"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runWeeklyRollover,
      runWeeklyRowLifecycle,
      runSheet,
    }))

    expect(result).toMatchObject({
      status: "failed",
      completedArtifacts: [],
      failedArtifacts: ["weekly_recruitment"],
    })
    expect(runSheet).not.toHaveBeenCalled()
    expect(runWeeklyRowLifecycle).not.toHaveBeenCalled()
    expect(orchestration.attempts.at(-1)).toMatchObject({
      outcome: "failed",
      mutationCallCount: 0,
      versionBefore: "41",
      versionAfter: null,
      failureCode: "value_plan_deferred_pending_structure",
      failureStage: "planning",
      certificationEvidence: {
        artifact_status: "deferred_pending_structure",
        lifecycle: "weekly_rollover",
        observed_structure_fingerprint: structureFingerprint,
        value_plan_status: "deferred_pending_structure",
      },
    })
  })

  test("resume skips certified success and retries an interrupted artifact from the persisted source", async () => {
    const cut = await fixtureCut()
    const sourceExecutionId = "33333333-3333-4333-8333-333333333333"
    const sources = new FakeSourceExecutionClient(completedSource(sourceExecutionId, cut))
    const certified = certifiedEltPersistenceAttempt(cut, sourceExecutionId)
    const interrupted = attempt("all_hires", 1, "running", null, null, sourceExecutionId, cut.payloadFingerprint)
    const orchestration = new FakeOrchestrationClient({
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    }, [certified, interrupted])
    const runElt = vi.fn()
    const runSheet = vi.fn(async (input) => ({
      runId: input.runId!,
      mode: "write" as const,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      quarterStart: cut.payload.facts.quarterStart,
      sourceCounts: { candidateEvents: 0, offers: 0, scorecards: 0, reqWeeks: 0 },
      artifactOutcomes: [{
        artifactKey: "all_hires" as const,
        status: "no_change" as const,
        plan: {
          artifactKey: "all_hires" as const,
          rangeCount: 1,
          changedRangeCount: 0,
          noOp: true,
          rowCount: 0,
          payloadFingerprint: `hmac-sha256:${"e".repeat(64)}`,
          structureHash: `sha256:${"f".repeat(64)}`,
        },
        write: {
          artifactKey: "all_hires" as const,
          runId: input.runId!,
          status: "no_change" as const,
          changedRangeCount: 0,
          mutationCallCount: 0,
          beforeStructureHash: `sha256:${"f".repeat(64)}`,
          afterStructureHash: `sha256:${"f".repeat(64)}`,
          structureCertification: "exact" as const,
          beforeDriveVersion: "20",
          afterDriveVersion: "20",
          compensationAttempted: false,
        },
      }],
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["elt_doc", "all_hires"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runElt,
      runSheet,
    }))

    expect(result.status).toBe("succeeded")
    expect(runElt).not.toHaveBeenCalled()
    expect(runSheet).toHaveBeenCalledOnce()
    expect(orchestration.attempts.find((value: HydrationArtifactAttempt) => value.artifactKey === "all_hires" && value.attemptNo === 1)?.outcome).toBe("timed_out")
    expect(orchestration.attempts.find((value: HydrationArtifactAttempt) => value.artifactKey === "all_hires" && value.attemptNo === 2)?.outcome).toBe("no_change")
  })

  test("resume never retries ELT after an uncertified mutation call", async () => {
    const cut = await fixtureCut()
    const sourceExecutionId = "33333333-3333-4333-8333-333333333333"
    const sources = new FakeSourceExecutionClient(completedSource(sourceExecutionId, cut))
    const ambiguous = {
      ...attempt(
        "elt_doc",
        1,
        "terminal",
        "certification_failed",
        { artifact_status: "blocked" },
        sourceExecutionId,
        cut.payloadFingerprint
      ),
      mutationCallCount: 1,
      failureCode: "elt_doc_write_failed",
      failureStage: "certification",
    } satisfies HydrationArtifactAttempt
    const orchestration = new FakeOrchestrationClient({
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    }, [ambiguous])
    const runElt = vi.fn()
    const createGoogleClients = vi.fn()

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["elt_doc"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(),
      createGoogleClients,
      runElt,
    }))

    expect(result).toMatchObject({
      status: "failed",
      completedArtifacts: [],
      failedArtifacts: ["elt_doc"],
      replayed: true,
    })
    expect(createGoogleClients).not.toHaveBeenCalled()
    expect(runElt).not.toHaveBeenCalled()
    expect(orchestration.attempts).toEqual([ambiguous])
  })

  test("resume never retries an interrupted ELT attempt with no persisted mutation count", async () => {
    const cut = await fixtureCut()
    const sourceExecutionId = "33333333-3333-4333-8333-333333333333"
    const sources = new FakeSourceExecutionClient(completedSource(sourceExecutionId, cut))
    const interrupted = attempt(
      "elt_doc",
      1,
      "running",
      null,
      null,
      sourceExecutionId,
      cut.payloadFingerprint
    )
    const orchestration = new FakeOrchestrationClient({
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    }, [interrupted])
    const runElt = vi.fn()
    const createGoogleClients = vi.fn()

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["elt_doc"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(),
      createGoogleClients,
      runElt,
    }))

    expect(result).toMatchObject({
      status: "timed_out",
      completedArtifacts: [],
      failedArtifacts: ["elt_doc"],
      replayed: true,
    })
    expect(createGoogleClients).not.toHaveBeenCalled()
    expect(runElt).not.toHaveBeenCalled()
    expect(orchestration.attempts).toHaveLength(1)
    expect(orchestration.attempts[0]).toMatchObject({
      status: "terminal",
      outcome: "timed_out",
      mutationCallCount: null,
    })
  })

  test.each([
    "pipeline_890",
    "pipeline_907",
    "pipeline_1026_1027",
    "pipeline_1118_1119",
    "final_offer",
    "rps_tracking",
  ] as const)("resumes interrupted %s from the persisted cut as a zero-mutation no-op", async (artifactKey) => {
    const cut = await fixtureCut()
    const sourceExecutionId = "33333333-3333-4333-8333-333333333333"
    const sources = new FakeSourceExecutionClient(completedSource(sourceExecutionId, cut))
    const orchestration = new FakeOrchestrationClient({
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    }, [attempt(artifactKey, 1, "running", null, null, sourceExecutionId, cut.payloadFingerprint)])
    const buildSourceCut = vi.fn()
    const runSheet = vi.fn(async (input: { runId?: string }) => ({
      artifactOutcomes: [{
        artifactKey,
        status: "no_change" as const,
        plan: {
          artifactKey,
          rangeCount: 1,
          changedRangeCount: 0,
          noOp: true,
          rowCount: 1,
          payloadFingerprint: `hmac-sha256:${"b".repeat(64)}`,
          structureHash: `sha256:${"c".repeat(64)}`,
        },
        write: {
          artifactKey,
          runId: input.runId!,
          status: "no_change" as const,
          changedRangeCount: 0,
          mutationCallCount: 0,
          beforeStructureHash: `sha256:${"c".repeat(64)}`,
          afterStructureHash: `sha256:${"c".repeat(64)}`,
          structureCertification: "exact" as const,
          beforeDriveVersion: "20",
          afterDriveVersion: "20",
          compensationAttempted: false,
        },
      }],
    }))
    const orchestrationDependencies = dependencies({
      orchestration,
      sources,
      buildSourceCut,
      createGoogleClients: vi.fn(async () => ({} as never)),
      runSheet,
    })

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: [artifactKey],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, orchestrationDependencies)

    expect(result).toMatchObject({
      status: "no_change",
      sourceExecutionId,
      completedArtifacts: [artifactKey],
      failedArtifacts: [],
      replayed: true,
    })
    expect(buildSourceCut).not.toHaveBeenCalled()
    expect(runSheet).toHaveBeenCalledOnce()
    expect(orchestrationDependencies.runRecurringSheetLifecycle).toHaveBeenCalledOnce()
    expect(orchestration.attempts).toHaveLength(2)
    expect(orchestration.attempts[0]).toMatchObject({
      artifactKey,
      attemptNo: 1,
      status: "terminal",
      outcome: "timed_out",
    })
    expect(orchestration.attempts[1]).toMatchObject({
      artifactKey,
      attemptNo: 2,
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      status: "terminal",
      outcome: "no_change",
      planFingerprint: `hmac-sha256:${"b".repeat(64)}`,
      mutationCallCount: 0,
      versionBefore: "20",
      versionAfter: "20",
      certificationEvidence: {
        artifact_status: "no_change",
        recurring_lifecycle_status: "already_normalized",
      },
    })
  })

  test("reconciles known terminal evidence before timing out an ambiguous persistence response", async () => {
    const cut = await fixtureCut()
    const sourceExecutionId = "33333333-3333-4333-8333-333333333333"
    const sources = new FakeSourceExecutionClient(completedSource(sourceExecutionId, cut))
    const certified = certifiedEltPersistenceAttempt(cut, sourceExecutionId)
    const orchestration = new FakeOrchestrationClient({
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    }, [certified])
    const persistAttempt = orchestration.finishAttempt.bind(orchestration)
    vi.spyOn(orchestration, "finishAttempt")
      .mockRejectedValueOnce(new Error("database response unavailable"))
      .mockRejectedValueOnce(new Error("database response still unavailable"))
      .mockImplementation(persistAttempt)
    const runSheet = vi.fn(async (input) => ({
      runId: input.runId!,
      mode: "write" as const,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      quarterStart: cut.payload.facts.quarterStart,
      sourceCounts: { candidateEvents: 0, offers: 0, scorecards: 0, reqWeeks: 0 },
      artifactOutcomes: [{
        artifactKey: "all_hires" as const,
        status: "no_change" as const,
        plan: {
          artifactKey: "all_hires" as const,
          rangeCount: 1,
          changedRangeCount: 0,
          noOp: true,
          rowCount: 0,
          payloadFingerprint: `hmac-sha256:${"b".repeat(64)}`,
          structureHash: `sha256:${"c".repeat(64)}`,
        },
        write: {
          artifactKey: "all_hires" as const,
          runId: input.runId!,
          status: "no_change" as const,
          changedRangeCount: 0,
          mutationCallCount: 0,
          beforeStructureHash: `sha256:${"c".repeat(64)}`,
          afterStructureHash: `sha256:${"c".repeat(64)}`,
          structureCertification: "exact" as const,
          beforeDriveVersion: "20",
          afterDriveVersion: "20",
          compensationAttempted: false,
        },
      }],
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["elt_doc", "all_hires"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runSheet,
    }))

    expect(result).toMatchObject({
      status: "succeeded",
      sourceExecutionId,
      completedArtifacts: ["elt_doc", "all_hires"],
      failedArtifacts: [],
      replayed: true,
    })
    expect(orchestration.terminalOutcome).toBe("succeeded")
    expect(orchestration.attempts.find((value) => value.artifactKey === "all_hires")).toMatchObject({
      status: "terminal",
      outcome: "no_change",
      mutationCallCount: 0,
      versionBefore: "20",
      versionAfter: "20",
    })
    expect(orchestration.attempts.some((value) => value.status === "running")).toBe(false)
  })

  test.each([
    {
      lane: "Sheet value writer",
      artifactKey: "all_hires" as const,
      runnerOverrides: {
        runSheet: vi.fn(async () => ({
          artifactOutcomes: [{
            artifactKey: "all_hires" as const,
            status: "blocked" as const,
            reason: "public writer failure",
            failure: {
              failureStage: "writer_unknown" as const,
              mutationCallCount: null,
              beforeDriveVersion: "10",
              afterDriveVersion: null,
              certificationStatus: "ambiguous" as const,
            },
          }],
        })),
      },
      expected: {
        mutationCallCount: null,
        versionBefore: "10",
        versionAfter: null,
        failureCode: "blocked",
        failureStage: "writer_unknown",
        certificationStatus: "ambiguous",
      },
    },
    {
      lane: "Docs writer",
      artifactKey: "elt_doc" as const,
      runnerOverrides: {
        runElt: vi.fn(async () => ({
          artifactKey: "elt_doc" as const,
          mode: "write" as const,
          status: "blocked" as const,
          runId: "elt-run",
          sourceGeneratedAt: "2026-07-15T20:00:00.000Z",
          blockCode: "write_failed" as const,
          failureStage: "postimage_validation" as const,
          failure: {
            failureStage: "postimage_validation" as const,
            mutationCallCount: 1,
            providerHttpStatus: 400,
            providerRequestIndex: 137,
            beforeRevisionFingerprint: createPayloadFingerprint("revision-10"),
            afterRevisionFingerprint: createPayloadFingerprint("revision-11"),
            certificationStatus: "postimage_rejected" as const,
          },
        })),
      },
      expected: {
        mutationCallCount: 1,
        versionBefore: createPayloadFingerprint("revision-10"),
        versionAfter: createPayloadFingerprint("revision-11"),
        failureCode: "write_failed",
        failureStage: "postimage_validation",
        certificationStatus: "postimage_rejected",
      },
    },
    {
      lane: "recurring lifecycle",
      artifactKey: "weekly_progress" as const,
      runnerOverrides: {
        runRecurringSheetLifecycle: vi.fn(async () => ({
          outcome: {
            artifactKey: "weekly_progress" as const,
            status: "blocked" as const,
            failure: {
              failureStage: "postimage_validation" as const,
              mutationCallCount: 1,
              beforeDriveVersion: "20",
              afterDriveVersion: "21",
              certificationStatus: "postimage_rejected" as const,
            },
          },
        })),
      },
      expected: {
        mutationCallCount: 1,
        versionBefore: "20",
        versionAfter: "21",
        failureCode: "recurring_sheet_lifecycle_blocked",
        failureStage: "postimage_validation",
        certificationStatus: "postimage_rejected",
      },
    },
    {
      lane: "weekly rollover",
      artifactKey: "weekly_recruitment" as const,
      runnerOverrides: {
        runWeeklyRollover: vi.fn(async () => ({
          outcomes: [{
            artifactKey: "weekly_recruitment" as const,
            status: "blocked" as const,
            failure: {
              failureStage: "ambiguous_settlement" as const,
              mutationCallCount: 1,
              beforeDriveVersion: "30",
              afterDriveVersion: "31",
              certificationStatus: "ambiguous" as const,
            },
          }],
        })),
      },
      expected: {
        mutationCallCount: 1,
        versionBefore: "30",
        versionAfter: "31",
        failureCode: "weekly_rollover_blocked",
        failureStage: "ambiguous_settlement",
        certificationStatus: "ambiguous",
      },
    },
    {
      lane: "weekly row lifecycle",
      artifactKey: "weekly_recruitment" as const,
      runnerOverrides: {
        runSheet: vi.fn(async () => ({
          artifactOutcomes: [{
            artifactKey: "weekly_recruitment" as const,
            status: "no_change" as const,
          }],
        })),
        runWeeklyRowLifecycle: vi.fn(async () => ({
          outcomes: [{
            artifactKey: "weekly_recruitment" as const,
            status: "blocked" as const,
            failure: {
              failureStage: "rollback" as const,
              mutationCallCount: 2,
              beforeDriveVersion: "40",
              afterDriveVersion: "41",
              certificationStatus: "rollback_unverified" as const,
            },
          }],
        })),
      },
      expected: {
        mutationCallCount: 2,
        versionBefore: "40",
        versionAfter: "41",
        failureCode: "weekly_row_lifecycle_blocked",
        failureStage: "rollback",
        certificationStatus: "rollback_unverified",
      },
    },
  ])("persists $lane mutation and certification evidence", async ({
    artifactKey,
    runnerOverrides,
    expected,
  }) => {
    const cut = await fixtureCut()
    const orchestration = new FakeOrchestrationClient()

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: [artifactKey],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources: new FakeSourceExecutionClient(),
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      ...runnerOverrides,
    }))

    expect(result.status).toBe("failed")
    expect(orchestration.attempts.at(-1)).toMatchObject({
      status: "terminal",
      outcome: "certification_failed",
      mutationCallCount: expected.mutationCallCount,
      versionBefore: expected.versionBefore,
      versionAfter: expected.versionAfter,
      failureCode: expected.failureCode,
      failureStage: expected.failureStage,
      certificationEvidence: {
        ...(artifactKey === "elt_doc"
          ? { provider_http_status: 400, provider_request_index: 137 }
          : {}),
        certification_status: expected.certificationStatus,
      },
    })
  })

  test("source-only proof completes without any Google dependency", async () => {
    const cut = await fixtureCut()
    const sources = new FakeSourceExecutionClient()
    const buildSourceCut = vi.fn(async () => cut)

    const result = await runReportingSourceCutProof({
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, { sourceExecutionClient: () => sources, buildSourceCut })

    expect(result.status).toBe("completed")
    expect(result.sourceFingerprint).toBe(cut.payloadFingerprint)
    expect(buildSourceCut).toHaveBeenCalledOnce()
  })

  test("adopts a deterministic source completed before run binding without pulling again", async () => {
    const cut = await fixtureCut()
    const sources = new FakeSourceExecutionClient(completedSource(RUN_ID, cut))
    const orchestration = new FakeOrchestrationClient()
    const buildSourceCut = vi.fn()
    const runSheet = vi.fn(async (input) => ({
      runId: input.runId!,
      mode: "dry_run" as const,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
      reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
      quarterStart: cut.payload.facts.quarterStart,
      sourceCounts: { candidateEvents: 0, offers: 0, scorecards: 0, reqWeeks: 0 },
      artifactOutcomes: [{
        artifactKey: "all_hires" as const,
        status: "dry_run" as const,
        plan: {
          artifactKey: "all_hires" as const,
          rangeCount: 1,
          changedRangeCount: 0,
          noOp: true,
          rowCount: 0,
          payloadFingerprint: `hmac-sha256:${"c".repeat(64)}`,
          structureHash: `sha256:${"d".repeat(64)}`,
        },
      }],
    }))

    const result = await runStagingHydrationOrchestration({
      mode: "dry_run",
      artifactKeys: ["all_hires"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY, CLOUD_RUN_EXECUTION: "retry-execution" },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut,
      createGoogleClients: vi.fn(async () => ({} as never)),
      runSheet,
    }))

    expect(result).toMatchObject({ status: "no_change", sourceExecutionId: RUN_ID, replayed: false })
    expect(buildSourceCut).not.toHaveBeenCalled()
    expect(runSheet).toHaveBeenCalledOnce()
  })

  test("claims with a short liveness lease and renews run and source leases through the heartbeat", async () => {
    const cut = await fixtureCut()
    const sources = new FakeSourceExecutionClient()
    const orchestration = new FakeOrchestrationClient()
    const registeredNames: string[] = []
    const renewals = new Map<string, () => Promise<boolean>>()
    let stopped = false
    let stoppedBeforeFinish = false
    const heartbeat = {
      register: (name: string, renew: () => Promise<boolean>) => {
        registeredNames.push(name)
        renewals.set(name, renew)
        return () => {}
      },
      lostLeases: () => new Set<string>(),
      tick: async () => {},
      stop: () => { stopped = true },
    }
    const finishRun = orchestration.finishRun.bind(orchestration)
    orchestration.finishRun = async (input) => {
      stoppedBeforeFinish = stopped
      return finishRun(input)
    }
    const runSheet = vi.fn(async (input) => noChangeAllHiresOutcome(cut, input.runId!))

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["all_hires"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runSheet,
      createHeartbeat: () => heartbeat,
    }))

    // The sole artifact certifies with nothing to write, so the run's terminal
    // outcome is no_change — a completed run, not a failure.
    expect(result.status).toBe("no_change")
    expect(result.failedArtifacts).toEqual([])
    expect(orchestration.claimInputs[0]?.leaseSeconds).toBe(600)
    expect(registeredNames).toEqual(["hydration_run", "source_execution"])
    // Renewal stops before the run is sealed, so a tick cannot renew against a
    // nulled lease and report a loss on a run that succeeded.
    expect(stoppedBeforeFinish).toBe(true)
    expect(stopped).toBe(true)

    // One renewal is the orchestrator's own pre-flight probe; the second is the
    // registered renewal invoked here, standing in for an interval tick.
    const renewalInput = {
      runId: RUN_ID,
      ownerToken: orchestration.claimInputs[0]?.ownerToken,
      leaseSeconds: 600,
    }
    expect(orchestration.heartbeatInputs).toEqual([renewalInput])
    await expect(renewals.get("hydration_run")!()).resolves.toBe(true)
    expect(orchestration.heartbeatInputs).toEqual([renewalInput, renewalInput])
    await renewals.get("source_execution")!()
    expect(sources.heartbeatInputs).toEqual([{
      sourceExecutionId: RUN_ID,
      ownerToken: orchestration.claimInputs[0]?.ownerToken,
      leaseSeconds: 600,
    }])
  })

  test("a run that dies mid-flight is reclaimed by the next execution once its lease lapses", async () => {
    const cut = await fixtureCut()
    const sourceExecutionId = "33333333-3333-4333-8333-333333333333"
    const sources = new FakeSourceExecutionClient(completedSource(sourceExecutionId, cut))
    const deadOwner = "99999999-9999-4999-8999-999999999999"
    const now = () => Date.parse("2026-07-15T20:00:00Z")
    const orchestration = new LeasedFakeOrchestrationClient(now, {
      runId: RUN_ID,
      status: "running",
      outcome: null,
      ownerToken: deadOwner,
      // The crashed container stopped renewing eight minutes ago, so the
      // short liveness lease has lapsed and the row is reclaimable in place.
      leasedUntil: Date.parse("2026-07-15T19:52:00Z"),
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    }, [
      certifiedEltPersistenceAttempt(cut, sourceExecutionId),
      attempt("all_hires", 1, "running", null, null, sourceExecutionId, cut.payloadFingerprint),
    ])
    const runElt = vi.fn()
    const runSheet = vi.fn(async (input) => noChangeAllHiresOutcome(cut, input.runId!))

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["elt_doc", "all_hires"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runElt,
      runSheet,
      clock: now,
    }))

    expect(result.status).toBe("succeeded")
    expect(result.reason).toBeUndefined()
    expect(orchestration.run.ownerToken).not.toBe(deadOwner)
    expect(orchestration.run.status).toBe("terminal")
    expect(runElt).not.toHaveBeenCalled()
    expect(runSheet).toHaveBeenCalledOnce()
    expect(orchestration.attempts.find((value: HydrationArtifactAttempt) => value.artifactKey === "all_hires" && value.attemptNo === 1)?.outcome).toBe("timed_out")
    expect(orchestration.attempts.find((value: HydrationArtifactAttempt) => value.artifactKey === "all_hires" && value.attemptNo === 2)?.outcome).toBe("no_change")
  })

  test("an unexpired lease held by another live execution still rejects a concurrent claim", async () => {
    const now = () => Date.parse("2026-07-15T20:00:00Z")
    const orchestration = new LeasedFakeOrchestrationClient(now, {
      runId: RUN_ID,
      status: "running",
      outcome: null,
      ownerToken: "99999999-9999-4999-8999-999999999999",
      leasedUntil: Date.parse("2026-07-15T20:08:00Z"),
      sourceExecutionId: null,
      sourceFingerprint: null,
      sourceGeneratedAt: null,
    }, [])
    const buildSourceCut = vi.fn()
    const createGoogleClients = vi.fn()

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["all_hires"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({ orchestration, buildSourceCut, createGoogleClients, clock: now }))

    expect(result.status).toBe("failed")
    expect(result.reason).toBe("overlap_in_progress")
    expect(buildSourceCut).not.toHaveBeenCalled()
    expect(createGoogleClients).not.toHaveBeenCalled()
    expect(orchestration.run.ownerToken).toBe("99999999-9999-4999-8999-999999999999")
  })

  test("halts before any artifact attempt once the run lease is lost", async () => {
    const cut = await fixtureCut()
    const sourceExecutionId = "33333333-3333-4333-8333-333333333333"
    const sources = new FakeSourceExecutionClient(completedSource(sourceExecutionId, cut))
    const orchestration = new FakeOrchestrationClient({
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    })
    const stop = vi.fn()
    const heartbeat = {
      register: () => () => {},
      lostLeases: () => new Set(["hydration_run"]),
      tick: async () => {},
      stop,
    }
    const runSheet = vi.fn()

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["all_hires"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runSheet,
      createHeartbeat: () => heartbeat,
    }))

    expect(result.status).toBe("failed")
    expect(result.reason).toBe("execution_failed")
    expect(runSheet).not.toHaveBeenCalled()
    // Stopped on the way out, whichever exit path ran. stop() is idempotent, so
    // the failure path calling it and the finally calling it again is correct.
    expect(stop).toHaveBeenCalled()
  })

  // The source lease stops mattering the moment its cut is persisted, and the
  // completion RPC already fails closed if that lease lapsed mid-build. Only
  // the run's own lease governs whether the artifact loop may keep writing.
  test("a lost source lease alone does not halt the artifact loop", async () => {
    const cut = await fixtureCut()
    const sourceExecutionId = "33333333-3333-4333-8333-333333333333"
    const sources = new FakeSourceExecutionClient(completedSource(sourceExecutionId, cut))
    const orchestration = new FakeOrchestrationClient({
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    })
    const heartbeat = {
      register: () => () => {},
      lostLeases: () => new Set(["source_execution"]),
      tick: async () => {},
      stop: () => {},
    }
    const runSheet = vi.fn(async (input) => noChangeAllHiresOutcome(cut, input.runId!))

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["all_hires"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runSheet,
      createHeartbeat: () => heartbeat,
    }))

    expect(result.status).toBe("no_change")
    expect(result.failedArtifacts).toEqual([])
    expect(runSheet).toHaveBeenCalledOnce()
  })

  // Deploy ordering: the image can reach production before migration 030 adds
  // the heartbeat RPCs. A short lease nobody can renew would kill every run ten
  // minutes in, so an unavailable RPC re-claims the pre-heartbeat window and the
  // run completes exactly as it did before the lease-heartbeat change.
  test("falls back to the long lease when the liveness RPCs are not deployed yet", async () => {
    const cut = await fixtureCut()
    const sources = new FakeSourceExecutionClient()
    const orchestration = new FakeOrchestrationClient()
    orchestration.heartbeatRun = async () => {
      throw new Error("hydration run heartbeat failed: function does not exist")
    }
    const runSheet = vi.fn(async (input) => noChangeAllHiresOutcome(cut, input.runId!))

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["all_hires"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(async () => cut),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runSheet,
    }))

    expect(result.status).toBe("no_change")
    expect(runSheet).toHaveBeenCalledOnce()
    expect(orchestration.claimInputs.map((value) => value.leaseSeconds)).toEqual([600, 3600])
    expect(orchestration.claimInputs[0]?.dedupeKey).toBe(orchestration.claimInputs[1]?.dedupeKey)
    expect(sources.claimInputs.at(-1)?.leaseSeconds).toBe(3600)
  })

  test("fails closed when the run lease is already gone at the first renewal", async () => {
    const cut = await fixtureCut()
    const sources = new FakeSourceExecutionClient()
    const orchestration = new FakeOrchestrationClient()
    orchestration.heartbeatRun = async () => false
    const runSheet = vi.fn()
    const buildSourceCut = vi.fn(async () => cut)

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["all_hires"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut,
      createGoogleClients: vi.fn(async () => ({} as never)),
      runSheet,
    }))

    expect(result.status).toBe("failed")
    expect(result.reason).toBe("execution_failed")
    expect(buildSourceCut).not.toHaveBeenCalled()
    expect(runSheet).not.toHaveBeenCalled()
  })

  // A snapshot written by an older image can never be replayed by this one, so
  // the run needs a fresh nonce rather than another retry. The durable summary
  // has to say which of those two it is.
  test("names a rejected source replay instead of reporting a generic failure", async () => {
    const cut = await fixtureCut()
    const sourceExecutionId = "33333333-3333-4333-8333-333333333333"
    const stale = completedSource(sourceExecutionId, cut)
    // A cut written by an older image: intact and correctly checksummed, but
    // carrying a payload contract this build no longer accepts.
    const stalePayload = {
      ...(stale.sourcePayload as Record<string, unknown>),
      schemaVersion: 99,
    }
    const sources = new FakeSourceExecutionClient({
      ...stale,
      sourcePayload: stalePayload,
      sourcePayloadChecksum: createPayloadFingerprint(stalePayload),
    })
    const orchestration = new FakeOrchestrationClient({
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    })
    const finishRun = vi.spyOn(orchestration, "finishRun")

    const result = await runStagingHydrationOrchestration({
      mode: "write",
      artifactKeys: ["all_hires"],
      nowMs: Date.parse("2026-07-15T20:00:00Z"),
      env: { RECOPS_PII_FINGERPRINT_SALT: KEY },
    }, dependencies({
      orchestration,
      sources,
      buildSourceCut: vi.fn(),
      createGoogleClients: vi.fn(async () => ({} as never)),
      runSheet: vi.fn(),
    }))

    expect(result.status).toBe("failed")
    expect(finishRun.mock.calls[0][0].publicSummary.failure_code).toBe("source_replay_rejected")
  })
})

function noChangeAllHiresOutcome(cut: Awaited<ReturnType<typeof fixtureCut>>, runId: string) {
  return {
    runId,
    mode: "write" as const,
    sourceGeneratedAt: cut.payload.facts.generatedAt,
    reportingWeekFriday: cut.payload.facts.reportingWeekFriday,
    quarterStart: cut.payload.facts.quarterStart,
    sourceCounts: { candidateEvents: 0, offers: 0, scorecards: 0, reqWeeks: 0 },
    artifactOutcomes: [{
      artifactKey: "all_hires" as const,
      status: "no_change" as const,
      plan: {
        artifactKey: "all_hires" as const,
        rangeCount: 1,
        changedRangeCount: 0,
        noOp: true,
        rowCount: 0,
        payloadFingerprint: `hmac-sha256:${"e".repeat(64)}`,
        structureHash: `sha256:${"f".repeat(64)}`,
      },
      write: {
        artifactKey: "all_hires" as const,
        runId,
        status: "no_change" as const,
        changedRangeCount: 0,
        mutationCallCount: 0,
        beforeStructureHash: `sha256:${"f".repeat(64)}`,
        afterStructureHash: `sha256:${"f".repeat(64)}`,
        structureCertification: "exact" as const,
        beforeDriveVersion: "20",
        afterDriveVersion: "20",
        compensationAttempted: false,
      },
    }],
  }
}

function dependencies(overrides: Record<string, unknown>) {
  return {
    orchestrationClient: () => (overrides.orchestration as HydrationOrchestrationDatabaseClient),
    sourceExecutionClient: () => (overrides.sources as SourceExecutionDatabaseClient | undefined) ?? new FakeSourceExecutionClient(),
    buildSourceCut: overrides.buildSourceCut as never,
    createGoogleClients: overrides.createGoogleClients as never,
    runSheet: (overrides.runSheet ?? vi.fn()) as never,
    runElt: (overrides.runElt ?? vi.fn()) as never,
    runRecurringSheetLifecycle: (overrides.runRecurringSheetLifecycle ?? vi.fn(async (input: {
      artifactKey: "weekly_progress" | "pipeline_890" | "pipeline_907" | "pipeline_1026_1027" | "pipeline_1118_1119"
      mode?: "dry_run" | "write"
      reportingWeekFriday?: string
    }) => ({
      runId: `${input.artifactKey}-recurring-test`,
      mode: input.mode ?? "dry_run",
      reportingWeekFriday: input.reportingWeekFriday!,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcome: {
        artifactKey: input.artifactKey,
        status: input.mode === "write" ? "already_normalized" as const : "dry_run" as const,
      },
    }))) as never,
    waitForDriveVersionAdvance:
      (overrides.waitForDriveVersionAdvance ?? vi.fn(async () => null)) as never,
    planProjectedDeliveryRps: (overrides.planProjectedDeliveryRps ?? vi.fn()) as never,
    runWeeklyRollover: (overrides.runWeeklyRollover ?? vi.fn(async (input: {
      mode?: "dry_run" | "write"
      reportingWeekFriday?: string
    }) => ({
      runId: "weekly-rollover-test",
      mode: input.mode ?? "dry_run",
      reportingWeekFriday: input.reportingWeekFriday!,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcomes: [{
        artifactKey: "weekly_recruitment" as const,
        status: input.mode === "write" ? "already_normalized" as const : "dry_run" as const,
      }] as const,
    }))) as never,
    runWeeklyRowLifecycle: (overrides.runWeeklyRowLifecycle ?? vi.fn(async (input: {
      mode?: "dry_run" | "write"
      reportingWeekFriday: string
    }) => ({
      runId: "weekly-row-lifecycle-test",
      mode: input.mode ?? "dry_run",
      reportingWeekFriday: input.reportingWeekFriday,
      copyOnly: false as const,
      canonicalWriteAuthorized: true as const,
      outcomes: [{
        artifactKey: "weekly_recruitment" as const,
        status: input.mode === "write" ? "already_normalized" as const : "dry_run" as const,
      }] as const,
    }))) as never,
    createHeartbeat: (overrides.createHeartbeat ?? (() => manualHeartbeat())) as never,
    clock: (overrides.clock ?? (() => Date.parse("2026-07-15T20:05:00Z"))) as () => number,
  }
}

function manualHeartbeat() {
  const lost = new Set<string>()
  return {
    register: () => () => {},
    lostLeases: () => lost,
    tick: async () => {},
    stop: () => {},
  }
}

function scheduledCycle(
  overrides: Partial<ScheduledHydrationCycle> & Pick<ScheduledHydrationCycle, "dueArtifacts">
): ScheduledHydrationCycle {
  return {
    scheduledAt: "2026-07-16T13:30:00.000Z",
    lane: "weekday_morning",
    businessDate: "2026-07-16",
    reportingWeekFriday: "2026-07-10",
    quarterStart: "2026-07-01",
    ...overrides,
  }
}

class FakeOrchestrationClient implements HydrationOrchestrationDatabaseClient {
  readonly attempts: HydrationArtifactAttempt[]
  readonly claim: Record<string, unknown>
  terminalOutcome: string | null = null
  readonly claimInputs: Parameters<HydrationOrchestrationDatabaseClient["claimRun"]>[0][] = []
  readonly heartbeatInputs: Parameters<HydrationOrchestrationDatabaseClient["heartbeatRun"]>[0][] = []

  constructor(claim: Record<string, unknown> = {}, attempts: HydrationArtifactAttempt[] = []) {
    this.claim = claim
    this.attempts = attempts
  }

  async claimRun(input: Parameters<HydrationOrchestrationDatabaseClient["claimRun"]>[0]) {
    this.claimInputs.push(input)
    return {
      runId: RUN_ID,
      claimAcquired: true,
      status: "loading_source" as const,
      outcome: null,
      sourceExecutionId: null,
      sourceFingerprint: null,
      sourceGeneratedAt: null,
      ...this.claim,
    } as never
  }

  async bindRunSource(input: Parameters<HydrationOrchestrationDatabaseClient["bindRunSource"]>[0]) {
    Object.assign(this.claim, {
      sourceExecutionId: input.sourceExecutionId,
      sourceFingerprint: input.sourceFingerprint,
      sourceGeneratedAt: input.sourceGeneratedAt,
    })
    return true
  }

  async heartbeatRun(input: Parameters<HydrationOrchestrationDatabaseClient["heartbeatRun"]>[0]) {
    this.heartbeatInputs.push(input)
    return true
  }

  async listAttempts() { return this.attempts }

  async timeoutRunningAttempts(input: Parameters<HydrationOrchestrationDatabaseClient["timeoutRunningAttempts"]>[0]) {
    for (let index = 0; index < this.attempts.length; index += 1) {
      if (this.attempts[index].status === "running") {
        this.attempts[index] = { ...this.attempts[index], status: "terminal", outcome: "timed_out", completedAt: input.completedAt }
      }
    }
  }

  async insertAttempt(input: Parameters<HydrationOrchestrationDatabaseClient["insertAttempt"]>[0]) {
    this.attempts.push({ ...input, status: "running", outcome: null, completedAt: null })
  }

  async finishAttempt(input: Parameters<HydrationOrchestrationDatabaseClient["finishAttempt"]>[0]) {
    const index = this.attempts.findIndex((attempt) => attempt.attemptId === input.attemptId)
    if (index < 0) return false
    this.attempts[index] = { ...this.attempts[index], ...input, status: "terminal" }
    return true
  }

  async finishRun(input: Parameters<HydrationOrchestrationDatabaseClient["finishRun"]>[0]) {
    this.terminalOutcome = input.outcome
    return true
  }
}

interface LeasedRunRow {
  runId: string
  status: "queued" | "loading_source" | "running" | "terminal"
  outcome: string | null
  ownerToken: string
  leasedUntil: number | null
  sourceExecutionId: string | null
  sourceFingerprint: string | null
  sourceGeneratedAt: string | null
}

/**
 * Models the lease arithmetic that migrations 024/026 implement in SQL: a claim
 * is refused while another owner's lease is unexpired, an expired lease is
 * reclaimable in place by anyone, and every write past the claim re-checks that
 * the caller still owns an unexpired lease. Without that clock the heartbeat
 * tests would only prove the orchestrator calls an RPC, not that a dead run
 * actually becomes claimable.
 */
class LeasedFakeOrchestrationClient implements HydrationOrchestrationDatabaseClient {
  readonly run: LeasedRunRow
  readonly attempts: HydrationArtifactAttempt[]
  readonly claimInputs: Parameters<HydrationOrchestrationDatabaseClient["claimRun"]>[0][] = []
  readonly heartbeatInputs: Parameters<HydrationOrchestrationDatabaseClient["heartbeatRun"]>[0][] = []
  private readonly now: () => number

  constructor(now: () => number, run: LeasedRunRow, attempts: HydrationArtifactAttempt[] = []) {
    this.now = now
    this.run = { ...run }
    this.attempts = attempts
  }

  private leaseHeld(ownerToken: string): boolean {
    return this.run.ownerToken === ownerToken
      && this.run.status !== "terminal"
      && this.run.leasedUntil !== null
      && this.run.leasedUntil > this.now()
  }

  private claimView(claimAcquired: boolean) {
    return {
      runId: this.run.runId,
      claimAcquired,
      status: this.run.status,
      outcome: this.run.outcome,
      sourceExecutionId: this.run.sourceExecutionId,
      sourceFingerprint: this.run.sourceFingerprint,
      sourceGeneratedAt: this.run.sourceGeneratedAt,
    } as never
  }

  async claimRun(input: Parameters<HydrationOrchestrationDatabaseClient["claimRun"]>[0]) {
    this.claimInputs.push(input)
    // Completed success replays its stored outcome instead of re-running (026).
    if (this.run.status === "terminal" && (this.run.outcome === "succeeded" || this.run.outcome === "no_change")) {
      return this.claimView(false)
    }
    const heldByAnother = this.run.status !== "terminal"
      && this.run.ownerToken !== input.ownerToken
      && this.run.leasedUntil !== null
      && this.run.leasedUntil > this.now()
    if (heldByAnother) return this.claimView(false)

    this.run.ownerToken = input.ownerToken
    this.run.leasedUntil = this.now() + input.leaseSeconds * 1000
    if (this.run.status === "queued") {
      this.run.status = "loading_source"
    } else if (this.run.status === "terminal") {
      this.run.status = this.run.sourceExecutionId === null ? "loading_source" : "running"
      this.run.outcome = null
    }
    return this.claimView(true)
  }

  async bindRunSource(input: Parameters<HydrationOrchestrationDatabaseClient["bindRunSource"]>[0]) {
    if (!this.leaseHeld(input.ownerToken) || this.run.status !== "loading_source") return false
    this.run.sourceExecutionId = input.sourceExecutionId
    this.run.sourceFingerprint = input.sourceFingerprint
    this.run.sourceGeneratedAt = input.sourceGeneratedAt
    this.run.status = "running"
    return true
  }

  async heartbeatRun(input: Parameters<HydrationOrchestrationDatabaseClient["heartbeatRun"]>[0]) {
    this.heartbeatInputs.push(input)
    if (!this.leaseHeld(input.ownerToken)) return false
    this.run.leasedUntil = this.now() + input.leaseSeconds * 1000
    return true
  }

  async listAttempts() { return this.attempts }

  async timeoutRunningAttempts(input: Parameters<HydrationOrchestrationDatabaseClient["timeoutRunningAttempts"]>[0]) {
    if (!this.leaseHeld(input.ownerToken)) return
    for (let index = 0; index < this.attempts.length; index += 1) {
      if (this.attempts[index].status === "running") {
        this.attempts[index] = {
          ...this.attempts[index],
          status: "terminal",
          outcome: "timed_out",
          completedAt: input.completedAt,
        }
      }
    }
  }

  async insertAttempt(input: Parameters<HydrationOrchestrationDatabaseClient["insertAttempt"]>[0]) {
    if (!this.leaseHeld(input.ownerToken)) {
      throw new Error("hydration attempt insert lost its active run lease")
    }
    this.attempts.push({ ...input, status: "running", outcome: null, completedAt: null })
  }

  async finishAttempt(input: Parameters<HydrationOrchestrationDatabaseClient["finishAttempt"]>[0]) {
    if (!this.leaseHeld(input.ownerToken)) return false
    const index = this.attempts.findIndex((value) => value.attemptId === input.attemptId)
    if (index < 0) return false
    this.attempts[index] = { ...this.attempts[index], ...input, status: "terminal" }
    return true
  }

  async finishRun(input: Parameters<HydrationOrchestrationDatabaseClient["finishRun"]>[0]) {
    if (!this.leaseHeld(input.ownerToken)) return false
    this.run.status = "terminal"
    this.run.outcome = input.outcome
    this.run.leasedUntil = null
    return true
  }
}

class FakeSourceExecutionClient implements SourceExecutionDatabaseClient {
  row: SourceExecutionRecord | null
  readonly heartbeatInputs: Parameters<SourceExecutionDatabaseClient["heartbeat"]>[0][] = []
  readonly claimInputs: Parameters<SourceExecutionDatabaseClient["claim"]>[0][] = []

  constructor(row: SourceExecutionRecord | null = null) { this.row = row }

  async claim(input: Parameters<SourceExecutionDatabaseClient["claim"]>[0]) {
    this.claimInputs.push(input)
    if (this.row?.status === "running" || this.row?.status === "completed") return null
    this.row = {
      sourceExecutionId: input.sourceExecutionId,
      ownerToken: input.ownerToken,
      status: "running",
      acquiredAt: "2026-07-15T20:00:00Z",
      leasedUntil: "2026-07-15T21:00:00Z",
      completedAt: null,
      sourceGeneratedAt: null,
      sourceFingerprint: null,
      sourceCounts: null,
      publicDiagnostics: {},
      sourcePayload: null,
      sourcePayloadSchemaVersion: null,
      sourcePayloadChecksum: null,
    }
    return this.row
  }

  async complete(input: Parameters<SourceExecutionDatabaseClient["complete"]>[0]) {
    this.row = {
      ...this.row!,
      ...input,
      status: "completed",
      completedAt: "2026-07-15T20:01:00Z",
    }
    return this.row
  }

  async fail(input: Parameters<SourceExecutionDatabaseClient["fail"]>[0]) {
    this.row = { ...this.row!, status: "failed", publicDiagnostics: input.publicDiagnostics }
    return this.row
  }

  async heartbeat(input: Parameters<SourceExecutionDatabaseClient["heartbeat"]>[0]) {
    this.heartbeatInputs.push(input)
    return true
  }

  async reapStale() { return 0 }
  async selectCompleted(sourceExecutionId: string) {
    return this.row?.status === "completed" && this.row.sourceExecutionId === sourceExecutionId ? this.row : null
  }
}

async function fixtureCut(generatedAt?: string, reportingWeekFriday?: string) {
  return buildReportingSourceCut({
    createGreenhouseClient: () => ({ list: vi.fn(async () => []) }),
    loadRoster: async () => [],
    loadStageTaxonomy: async () => [],
    fingerprintKey: KEY,
  }, {}, {
    loadCollections: vi.fn(async () => fixtureCollections(generatedAt, reportingWeekFriday)),
    createExecBoundary: () => createFixtureGreenhouseExecReadBoundary({}),
  })
}

function fixtureCollections(
  generatedAt = "2026-07-15T20:00:00.000Z",
  reportingWeekFriday = "2026-07-10"
): StagingHydrationSourceCollections {
  return {
    generatedAt,
    reportingWeekFriday,
    quarterStart: "2026-07-01",
    jobs: [], openings: [], jobOwners: [], users: [], departments: [], applications: [],
    applicationStages: [], jobInterviewStages: [], jobInterviews: [], interviewKits: [],
    scorecards: [], scheduledInterviews: [], offers: [], candidates: [], candidateSources: [],
    referrers: [], rejectionReasons: [], diagnostics: [], execSources: emptyExecStateSources(), execSourceGaps: [],
  }
}

function eltEvidencePlan(
  cut: Awaited<ReturnType<typeof fixtureCut>>,
  status: "planned_for_internal_review" | "no_change",
  action: "insert_top_week" | "replace_top_week" | "no_op"
) {
  const reportingWeek = eltFixtureReportingWeek(cut)
  return {
    status,
    action,
    mutationScope: "weekly_fact_table" as const,
    payloadFingerprint: `hmac-sha256:${"b".repeat(64)}`,
    currentBlockFingerprint: `hmac-sha256:${"a".repeat(64)}`,
    outsideContentFingerprint: `hmac-sha256:${"b".repeat(64)}`,
    templateHash: `sha256:${"c".repeat(64)}`,
    revisionGuardPresent: true,
    reportingWeek,
    snapshotRunId: cut.payload.eltSnapshot.run_id,
    snapshotMode: "shadow",
  }
}

function eltFixtureReportingWeek(
  cut: Awaited<ReturnType<typeof fixtureCut>>
): string {
  const facts = cut.payload.eltSnapshot.elt_facts as { weekLabel?: unknown } | null
  if (!facts || typeof facts.weekLabel !== "string" || !facts.weekLabel) {
    throw new Error("ELT evidence fixture requires one reporting week.")
  }
  return facts.weekLabel
}

function certifiedEltPersistenceAttempt(
  cut: Awaited<ReturnType<typeof fixtureCut>>,
  sourceExecutionId: string
): HydrationArtifactAttempt {
  const revisionBefore = `sha256:${"d".repeat(64)}`
  const revisionAfter = `sha256:${"e".repeat(64)}`
  const plan = eltEvidencePlan(cut, "planned_for_internal_review", "replace_top_week")
  return {
    ...attempt(
      "elt_doc",
      1,
      "terminal",
      "written",
      {
        artifact_status: "written",
        evidence_contract: "elt_fact_table_v1",
        pii_policy: "internal_review_identifiers",
        acl_policy: "exact_owner_and_service_writer",
        hydration_mode: "write",
        block_code: null,
        mutation_scope: "weekly_fact_table",
        plan_status: plan.status,
        plan_action: plan.action,
        dry_run_verified: false,
        preimage_fingerprint: `hmac-sha256:${"a".repeat(64)}`,
        drive_version_before: "100",
        drive_version_after: "101",
        rollback_drive_version: null,
        permission_fingerprint: `hmac-sha256:${"b".repeat(64)}`,
        permission_fingerprint_after: `hmac-sha256:${"b".repeat(64)}`,
        rollback_permission_fingerprint: null,
        outside_content_fingerprint: `hmac-sha256:${"c".repeat(64)}`,
        revision_before_fingerprint: revisionBefore,
        revision_after_fingerprint: revisionAfter,
        revision_guard_present: true,
        reporting_week: plan.reportingWeek,
        snapshot_run_id: cut.payload.eltSnapshot.run_id,
        snapshot_mode: "shadow",
        source_generated_at: cut.payload.eltSnapshot.generated_at,
        template_hash: plan.templateHash,
        rollback_request_count: 2,
        rollback_attempted: false,
        rollback_verified: false,
        certification_status: "postimage_verified",
      },
      sourceExecutionId,
      cut.payloadFingerprint
    ),
    planFingerprint: `hmac-sha256:${"a".repeat(64)}`,
    mutationCallCount: 1,
    versionBefore: revisionBefore,
    versionAfter: revisionAfter,
  }
}

function completedSource(sourceExecutionId: string, cut: Awaited<ReturnType<typeof fixtureCut>>): SourceExecutionRecord {
  const payload = JSON.parse(JSON.stringify(cut.payload))
  return {
    sourceExecutionId,
    ownerToken: OWNER,
    status: "completed",
    acquiredAt: "2026-07-15T20:00:00Z",
    leasedUntil: "2026-07-15T21:00:00Z",
    completedAt: "2026-07-15T20:01:00Z",
    sourceGeneratedAt: cut.payload.facts.generatedAt,
    sourceFingerprint: cut.payloadFingerprint,
    sourceCounts: {},
    publicDiagnostics: {},
    sourcePayload: payload,
    sourcePayloadSchemaVersion: 1,
    sourcePayloadChecksum: createPayloadFingerprint(payload),
  }
}

function attempt(
  artifactKey: HydrationArtifactAttempt["artifactKey"],
  attemptNo: number,
  status: HydrationArtifactAttempt["status"],
  outcome: HydrationArtifactAttempt["outcome"],
  certificationEvidence: HydrationArtifactAttempt["certificationEvidence"],
  sourceExecutionId: string,
  sourceFingerprint: string
): HydrationArtifactAttempt {
  return {
    attemptId: `${artifactKey}-${attemptNo}`,
    runId: RUN_ID,
    artifactKey,
    attemptNo,
    sourceExecutionId,
    sourceFingerprint,
    status,
    outcome,
    planFingerprint: null,
    mutationCallCount: null,
    versionBefore: null,
    versionAfter: null,
    certificationEvidence,
    failureCode: null,
    failureStage: null,
    startedAt: "2026-07-15T20:00:00Z",
    completedAt: status === "terminal" ? "2026-07-15T20:01:00Z" : null,
  }
}
