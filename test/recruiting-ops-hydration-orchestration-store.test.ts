import { describe, expect, test, vi } from "vitest"

import {
  aggregateHydrationOutcome,
  bindHydrationRunSource,
  claimHydrationRun,
  isCertifiedHydrationAttempt,
  prepareHydrationResume,
  startHydrationArtifactAttempt,
  type HydrationArtifactAttempt,
  type HydrationOrchestrationDatabaseClient,
} from "../lib/recruiting-ops/delivery/hydration-orchestration-store"
import { deliveryRpsTargetSheetId } from "../lib/recruiting-ops/delivery/staging-structural-normalization"

const HMAC = `hmac-sha256:${"a".repeat(64)}`

describe("hydration orchestration store", () => {
  test("uses one deterministic daily claim and reports an overlap without changing its owner", async () => {
    const claimRun = vi
      .fn<HydrationOrchestrationDatabaseClient["claimRun"]>()
      .mockResolvedValueOnce(claimRow(true))
      .mockResolvedValueOnce(claimRow(false))
    const client = fakeClient({ claimRun })

    const first = await claimHydrationRun({
      businessDate: "2026-07-15",
      mode: "write",
      requestedArtifacts: ["all_hires", "weekly_recruitment"],
      ownerToken: "11111111-1111-4111-8111-111111111111",
    }, client)
    const overlap = await claimHydrationRun({
      businessDate: "2026-07-15",
      mode: "write",
      requestedArtifacts: ["all_hires", "weekly_recruitment"],
      ownerToken: "22222222-2222-4222-8222-222222222222",
    }, client)

    expect(first.claimAcquired).toBe(true)
    expect(overlap.claimAcquired).toBe(false)
    expect(claimRun.mock.calls.map(([input]) => input.dedupeKey)).toEqual([
      "staging-hydration:v1:2026-07-15:write:all_hires,weekly_recruitment",
      "staging-hydration:v1:2026-07-15:write:all_hires,weekly_recruitment",
    ])
  })

  test("gives different artifact tiers independent durable claims", async () => {
    const claimRun = vi.fn<HydrationOrchestrationDatabaseClient["claimRun"]>()
      .mockResolvedValue(claimRow(true))
    const client = fakeClient({ claimRun })

    await claimHydrationRun({
      businessDate: "2026-07-15",
      mode: "write",
      requestedArtifacts: ["all_hires"],
      ownerToken: "11111111-1111-4111-8111-111111111111",
    }, client)
    await claimHydrationRun({
      businessDate: "2026-07-15",
      mode: "write",
      requestedArtifacts: ["weekly_recruitment"],
      ownerToken: "22222222-2222-4222-8222-222222222222",
    }, client)

    expect(claimRun.mock.calls.map(([input]) => input.dedupeKey)).toEqual([
      "staging-hydration:v1:2026-07-15:write:all_hires",
      "staging-hydration:v1:2026-07-15:write:weekly_recruitment",
    ])
  })

  test("allows an operator to create one fresh manual source cut after a sealed run", async () => {
    const claimRun = vi.fn<HydrationOrchestrationDatabaseClient["claimRun"]>()
      .mockResolvedValue(claimRow(true))

    await claimHydrationRun({
      businessDate: "2026-08-06",
      mode: "dry_run",
      requestedArtifacts: ["all_hires"],
      runNonce: "cutover-20260806-01",
    }, fakeClient({ claimRun }))

    expect(claimRun.mock.calls[0][0].dedupeKey).toBe(
      "staging-hydration:v1:2026-08-06:dry_run:all_hires:cutover-20260806-01"
    )
  })

  test("normalizes one scheduled instant into a v2 claim independent of its artifact tier", async () => {
    const claimRun = vi.fn<HydrationOrchestrationDatabaseClient["claimRun"]>()
      .mockResolvedValue(claimRow(true))
    const client = fakeClient({ claimRun })

    await claimHydrationRun({
      businessDate: "2026-07-16",
      mode: "write",
      requestedArtifacts: ["all_hires"],
      scheduledAt: "2026-07-16T06:30:00-07:00",
    }, client)
    await claimHydrationRun({
      businessDate: "2026-07-16",
      mode: "write",
      requestedArtifacts: ["weekly_recruitment"],
      scheduledAt: "2026-07-16T13:30:00.000Z",
    }, client)

    expect(claimRun.mock.calls.map(([input]) => input.dedupeKey)).toEqual([
      "staging-hydration:v2:2026-07-16T13:30:00.000Z:write",
      "staging-hydration:v2:2026-07-16T13:30:00.000Z:write",
    ])
  })

  // A scheduled run that terminated succeeded/no_change replays its stored
  // outcome forever. Re-running a bad Thursday for real has to be one command
  // against the same slot, not an invented artifact list that happens to mint a
  // different dedupe key.
  test("a run nonce reruns one scheduled slot without disturbing its calendar identity", async () => {
    const claimRun = vi.fn<HydrationOrchestrationDatabaseClient["claimRun"]>()
      .mockResolvedValue(claimRow(true))
    const client = fakeClient({ claimRun })

    await claimHydrationRun({
      businessDate: "2026-07-16",
      mode: "write",
      requestedArtifacts: ["all_hires"],
      scheduledAt: "2026-07-16T13:30:00.000Z",
    }, client)
    await claimHydrationRun({
      businessDate: "2026-07-16",
      mode: "write",
      requestedArtifacts: ["all_hires"],
      scheduledAt: "2026-07-16T13:30:00.000Z",
      runNonce: "rerun-20260716-01",
    }, client)

    expect(claimRun.mock.calls.map(([input]) => input.dedupeKey)).toEqual([
      "staging-hydration:v2:2026-07-16T13:30:00.000Z:write",
      "staging-hydration:v2:2026-07-16T13:30:00.000Z:write:rerun-20260716-01",
    ])
  })

  test.each(["short", "has space", "no/slashes"])(
    "rejects a malformed rerun nonce %j on a scheduled claim",
    async (runNonce) => {
      await expect(claimHydrationRun({
        businessDate: "2026-07-16",
        mode: "write",
        requestedArtifacts: ["all_hires"],
        scheduledAt: "2026-07-16T13:30:00.000Z",
        runNonce,
      }, fakeClient({}))).rejects.toThrow("runNonce")
    }
  )

  test.each([
    "",
    "2026-07-16",
    "2026-02-30T13:30:00Z",
    "2026-07-16T13:30:00",
  ])("rejects invalid scheduled claim timestamp %j", async (scheduledAt) => {
    const claimRun = vi.fn<HydrationOrchestrationDatabaseClient["claimRun"]>()
    await expect(claimHydrationRun({
      businessDate: "2026-07-16",
      mode: "write",
      requestedArtifacts: ["all_hires"],
      scheduledAt,
    }, fakeClient({ claimRun }))).rejects.toThrow("scheduledAt")
    expect(claimRun).not.toHaveBeenCalled()
  })

  test("binds one HMAC source identity only through the active lease", async () => {
    const bindRunSource = vi.fn(async () => true)
    const client = fakeClient({ bindRunSource })
    const claim = { ...claimRow(true), ownerToken: "11111111-1111-4111-8111-111111111111" }

    await bindHydrationRunSource({
      claim,
      sourceExecutionId: "33333333-3333-4333-8333-333333333333",
      sourceFingerprint: HMAC,
      sourceGeneratedAt: "2026-07-15T20:00:00.000Z",
    }, client)
    expect(bindRunSource).toHaveBeenCalledOnce()

    await expect(bindHydrationRunSource({
      claim: { ...claim, claimAcquired: false },
      sourceExecutionId: "33333333-3333-4333-8333-333333333333",
      sourceFingerprint: HMAC,
      sourceGeneratedAt: "2026-07-15T20:00:00.000Z",
    }, client)).rejects.toThrow("active run lease")
  })

  test("recovers an interrupted attempt and skips only certified written/no-change outcomes", async () => {
    const attempts: HydrationArtifactAttempt[] = [
      attempt("all_hires", 1, "running", null, null),
      certifiedAttempt("weekly_recruitment", 1, "written"),
      attempt("weekly_progress", 1, "terminal", "no_change", { artifact_status: "no_change" }),
    ]
    const client = fakeClient({
      async timeoutRunningAttempts() {
        attempts[0] = { ...attempts[0], status: "terminal", outcome: "timed_out", completedAt: "2026-07-15T21:00:00Z" }
      },
      async listAttempts() { return attempts },
    })

    const resumed = await prepareHydrationResume(
      "run-1",
      "11111111-1111-4111-8111-111111111111",
      client,
      "2026-07-15T21:00:00Z"
    )
    expect(resumed.attempts[0].outcome).toBe("timed_out")
    expect([...resumed.completedArtifacts]).toEqual(["weekly_recruitment"])
  })

  test("does not skip an artifact when its latest attempt supersedes an older certification", async () => {
    const attempts: HydrationArtifactAttempt[] = [
      certifiedAttempt("all_hires", 1, "written"),
      attempt("all_hires", 2, "terminal", "failed", { artifact_status: "blocked" }),
    ]
    const resumed = await prepareHydrationResume(
      "run-1",
      "11111111-1111-4111-8111-111111111111",
      fakeClient({ async listAttempts() { return attempts } })
    )

    expect([...resumed.completedArtifacts]).toEqual([])
  })

  test("never retries a latest uncertified ELT attempt after a mutation call", async () => {
    const ambiguous = {
      ...attempt("elt_doc", 2, "terminal", "certification_failed", {
        artifact_status: "blocked",
      }),
      mutationCallCount: 1,
      failureCode: "elt_doc_write_failed",
      failureStage: "certification",
    } satisfies HydrationArtifactAttempt
    const resumed = await prepareHydrationResume(
      "run-1",
      "11111111-1111-4111-8111-111111111111",
      fakeClient({ async listAttempts() { return [ambiguous] } })
    )

    expect([...resumed.completedArtifacts]).toEqual([])
    expect([...resumed.nonRetryableArtifacts]).toEqual(["elt_doc"])
  })

  test("never retries an interrupted ELT attempt whose mutation boundary is unknowable", async () => {
    const attempts = [
      attempt("elt_doc", 1, "running", null, null),
    ]
    const resumed = await prepareHydrationResume(
      "run-1",
      "11111111-1111-4111-8111-111111111111",
      fakeClient({
        async timeoutRunningAttempts() {
          attempts[0] = {
            ...attempts[0],
            status: "terminal",
            outcome: "timed_out",
            completedAt: "2026-07-15T21:00:00Z",
          }
        },
        async listAttempts() { return attempts },
      })
    )

    expect([...resumed.completedArtifacts]).toEqual([])
    expect([...resumed.nonRetryableArtifacts]).toEqual(["elt_doc"])
  })

  test("never retries ELT when an older attempt crossed the mutation boundary", async () => {
    const mutated = {
      ...attempt("elt_doc", 1, "terminal", "certification_failed", null),
      mutationCallCount: 1,
    } satisfies HydrationArtifactAttempt
    const latest = attempt(
      "elt_doc",
      2,
      "terminal",
      "failed",
      { artifact_status: "blocked" }
    )
    const resumed = await prepareHydrationResume(
      "run-1",
      "11111111-1111-4111-8111-111111111111",
      fakeClient({ async listAttempts() { return [mutated, latest] } })
    )

    expect([...resumed.completedArtifacts]).toEqual([])
    expect([...resumed.nonRetryableArtifacts]).toEqual(["elt_doc"])
  })

  test("numbers retries per artifact and computes terminal aggregate outcomes", async () => {
    const inserted: unknown[] = []
    const previous = [attempt("all_hires", 1, "terminal", "timed_out", null)]
    const client = fakeClient({ async insertAttempt(input) { inserted.push(input) } })
    const retry = await startHydrationArtifactAttempt({
      runId: "run-1",
      artifactKey: "all_hires",
      sourceExecutionId: "source-1",
      sourceFingerprint: HMAC,
      ownerToken: "11111111-1111-4111-8111-111111111111",
      previousAttempts: previous,
      startedAt: "2026-07-15T21:00:00Z",
    }, client)
    expect(retry.attemptNo).toBe(2)
    expect(inserted).toHaveLength(1)

    expect(aggregateHydrationOutcome([
      certifiedAttempt("all_hires", 2, "written"),
      certifiedAttempt("weekly_recruitment", 1, "no_change"),
    ], ["all_hires", "weekly_recruitment"])).toBe("succeeded")
    expect(aggregateHydrationOutcome([
      certifiedAttempt("all_hires", 2, "written"),
      attempt("weekly_recruitment", 1, "terminal", "certification_failed", null),
    ], ["all_hires", "weekly_recruitment"])).toBe("partial")
  })

  test("matches the SQL certification shape before treating an attempt as complete", () => {
    const certified = certifiedAttempt("all_hires", 1, "no_change")
    expect(isCertifiedHydrationAttempt(certified)).toBe(true)
    expect(isCertifiedHydrationAttempt({ ...certified, planFingerprint: null })).toBe(false)
    expect(isCertifiedHydrationAttempt({ ...certified, certificationEvidence: {} })).toBe(false)
    expect(isCertifiedHydrationAttempt({ ...certified, certificationEvidence: { certified: true } })).toBe(false)
    expect(aggregateHydrationOutcome([
      { ...certified, planFingerprint: null },
    ], ["all_hires"])).toBe("failed")
  })

  test("requires exact outcome-specific ELT fact-table evidence", async () => {
    const dry = certifiedEltAttempt("dry_run")
    const noChange = certifiedEltAttempt("no_change")
    const written = certifiedEltAttempt("written")

    expect(isCertifiedHydrationAttempt(dry)).toBe(true)
    expect(isCertifiedHydrationAttempt(noChange)).toBe(true)
    expect(isCertifiedHydrationAttempt(written)).toBe(true)

    const dryEvidence = dry.certificationEvidence!
    const noChangeEvidence = noChange.certificationEvidence!
    const writtenEvidence = written.certificationEvidence!
    const rejected: HydrationArtifactAttempt[] = [
      { ...dry, certificationEvidence: null },
      { ...dry, versionBefore: null },
      { ...dry, mutationCallCount: null },
      { ...dry, certificationEvidence: { ...dryEvidence, certification_status: "not_attempted" } },
      { ...dry, certificationEvidence: { ...dryEvidence, reporting_week: "Jul 17, 2026 - Jul 23, 2026" } },
      { ...dry, certificationEvidence: { ...dryEvidence, snapshot_run_id: "e01_wrong" } },
      { ...dry, certificationEvidence: { ...dryEvidence, snapshot_mode: "live" } },
      { ...dry, certificationEvidence: { ...dryEvidence, preimage_fingerprint: "hmac-sha256:bad" } },
      { ...dry, certificationEvidence: { ...dryEvidence, revision_before_fingerprint: `sha256:${"9".repeat(64)}` } },
      { ...dry, certificationEvidence: { ...dryEvidence, unexpected: true } },
      { ...noChange, mutationCallCount: 1 },
      { ...noChange, certificationEvidence: { ...noChangeEvidence, permission_fingerprint: null } },
      { ...noChange, certificationEvidence: { ...noChangeEvidence, permission_fingerprint_after: `hmac-sha256:${"d".repeat(64)}` } },
      { ...noChange, certificationEvidence: { ...noChangeEvidence, drive_version_before: "0", drive_version_after: "0" } },
      { ...noChange, certificationEvidence: { ...noChangeEvidence, drive_version_before: 100, drive_version_after: 100 } },
      { ...noChange, certificationEvidence: { ...noChangeEvidence, plan_action: "replace_top_week" } },
      { ...written, versionAfter: written.versionBefore },
      { ...written, certificationEvidence: { ...writtenEvidence, drive_version_after: writtenEvidence.drive_version_before } },
      { ...written, certificationEvidence: { ...writtenEvidence, drive_version_before: "0100" } },
      { ...written, certificationEvidence: { ...writtenEvidence, rollback_request_count: 0 } },
      { ...written, certificationEvidence: { ...writtenEvidence, rollback_verified: true } },
    ]
    expect(rejected.every((value) => !isCertifiedHydrationAttempt(value))).toBe(true)

    const resumed = await prepareHydrationResume(
      "run-1",
      "11111111-1111-4111-8111-111111111111",
      fakeClient({
        async listAttempts() {
          return [{ ...dry, certificationEvidence: {
            ...dryEvidence,
            certification_status: "not_attempted",
          } }]
        },
      })
    )
    expect([...resumed.completedArtifacts]).toEqual([])
  })

  test("requires complete zero-mutation evidence for a projected Delivery dry run", () => {
    const evidence = {
      artifact_status: "projected_dry_run",
      lifecycle: "recurring",
      lifecycle_plan_status: "planned",
      projection_certification: "exact_preimage_plus_deterministic_requests",
      postimage_observed: false,
      target_absent_observed: true,
      observed_drive_version: "62",
      drive_version_stable: true,
      value_plan_status: "projected",
      normalization_id: "delivery_rps_dated_rollover_20260715",
      target_sheet_id: deliveryRpsTargetSheetId("2026-07-15"),
      target_sheet_title: "15 Jul 2026",
      range_count: 3,
      projected_changed_range_count: 1,
      projected_value_no_op: false,
      projected_preimage_fingerprint: `hmac-sha256:${"b".repeat(64)}`,
      desired_payload_fingerprint: `hmac-sha256:${"c".repeat(64)}`,
      normalization_fingerprint: `sha256:${"1".repeat(64)}`,
      observed_structure_fingerprint: `sha256:${"2".repeat(64)}`,
      expected_after_state_fingerprint: `sha256:${"3".repeat(64)}`,
      forward_requests_fingerprint: `sha256:${"4".repeat(64)}`,
      rollback_requests_fingerprint: `sha256:${"5".repeat(64)}`,
      format_fingerprint: `sha256:${"6".repeat(64)}`,
    }
    const projected: HydrationArtifactAttempt = {
      ...attempt("delivery_roles_rps", 1, "terminal", "no_change", evidence),
      planFingerprint: HMAC,
      mutationCallCount: 0,
      versionBefore: "62",
      versionAfter: null,
    }

    expect(isCertifiedHydrationAttempt(projected)).toBe(true)
    const evidenceWithout = (key: keyof typeof evidence) => {
      const copy: Record<string, unknown> = { ...evidence }
      delete copy[key]
      return { ...projected, certificationEvidence: copy }
    }
    const rejected: HydrationArtifactAttempt[] = [
      { ...projected, artifactKey: "all_hires" },
      { ...projected, outcome: "written" },
      { ...projected, mutationCallCount: 1 },
      { ...projected, mutationCallCount: null },
      { ...projected, versionBefore: "" },
      { ...projected, versionBefore: `sha256:${"7".repeat(64)}` },
      { ...projected, versionAfter: "63" },
      { ...projected, failureCode: "unexpected" },
      { ...projected, failureStage: "planning" },
      { ...projected, certificationEvidence: { ...evidence, postimage_observed: true } },
      { ...projected, certificationEvidence: { ...evidence, after_structure_hash: `sha256:${"8".repeat(64)}` } },
      { ...projected, certificationEvidence: { ...evidence, observed_drive_version: "61" } },
      { ...projected, certificationEvidence: { ...evidence, target_sheet_title: "14 Jul 2026" } },
      { ...projected, certificationEvidence: { ...evidence, target_sheet_id: 1 } },
      { ...projected, certificationEvidence: { ...evidence, range_count: 2 } },
      { ...projected, certificationEvidence: { ...evidence, projected_changed_range_count: 0 } },
      { ...projected, certificationEvidence: { ...evidence, projected_value_no_op: true } },
      { ...projected, certificationEvidence: { ...evidence, format_fingerprint: "sha256:bad" } },
      { ...projected, certificationEvidence: { ...evidence, unexpected: "not-certified" } },
      { ...projected, certificationEvidence: { ...evidence, normalization_id: [evidence.normalization_id] } },
      { ...projected, certificationEvidence: {
        ...evidence,
        projected_preimage_fingerprint: [evidence.projected_preimage_fingerprint],
      } },
      { ...projected, certificationEvidence: {
        ...evidence,
        normalization_fingerprint: [evidence.normalization_fingerprint],
      } },
      evidenceWithout("projection_certification"),
      evidenceWithout("projected_preimage_fingerprint"),
      evidenceWithout("desired_payload_fingerprint"),
      evidenceWithout("normalization_fingerprint"),
      evidenceWithout("observed_structure_fingerprint"),
      evidenceWithout("expected_after_state_fingerprint"),
      evidenceWithout("forward_requests_fingerprint"),
      evidenceWithout("rollback_requests_fingerprint"),
    ]
    expect(rejected.every((value) => !isCertifiedHydrationAttempt(value))).toBe(true)
  })
})

function claimRow(claimAcquired: boolean) {
  return {
    runId: "run-1",
    claimAcquired,
    status: "loading_source" as const,
    outcome: null,
    sourceExecutionId: null,
    sourceFingerprint: null,
    sourceGeneratedAt: null,
  }
}

function attempt(
  artifactKey: HydrationArtifactAttempt["artifactKey"],
  attemptNo: number,
  status: HydrationArtifactAttempt["status"],
  outcome: HydrationArtifactAttempt["outcome"],
  certificationEvidence: HydrationArtifactAttempt["certificationEvidence"]
): HydrationArtifactAttempt {
  return {
    attemptId: `${artifactKey}-${attemptNo}`,
    runId: "run-1",
    artifactKey,
    attemptNo,
    sourceExecutionId: "source-1",
    sourceFingerprint: HMAC,
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

function certifiedAttempt(
  artifactKey: HydrationArtifactAttempt["artifactKey"],
  attemptNo: number,
  outcome: "written" | "no_change"
): HydrationArtifactAttempt {
  return {
    ...attempt(artifactKey, attemptNo, "terminal", outcome, { artifact_status: outcome }),
    planFingerprint: HMAC,
  }
}

function certifiedEltAttempt(
  status: "dry_run" | "no_change" | "written"
): HydrationArtifactAttempt {
  const sourceGeneratedAt = "2026-07-17T13:30:00.000Z"
  const revisionBefore = `sha256:${"d".repeat(64)}`
  const revisionAfter = status === "written" ? `sha256:${"e".repeat(64)}` : revisionBefore
  const evidence = {
    artifact_status: status,
    evidence_contract: "elt_fact_table_v1",
    pii_policy: "internal_review_identifiers",
    acl_policy: "exact_owner_and_service_writer",
    hydration_mode: status === "dry_run" ? "dry_run" : "write",
    block_code: null,
    mutation_scope: "weekly_fact_table",
    plan_status: status === "no_change" ? "no_change" : "planned_for_internal_review",
    plan_action: status === "no_change" ? "no_op" : "replace_top_week",
    dry_run_verified: status === "dry_run",
    preimage_fingerprint: `hmac-sha256:${"b".repeat(64)}`,
    drive_version_before: status === "dry_run" ? null : "100",
    drive_version_after:
      status === "dry_run" ? null : status === "written" ? "101" : "100",
    rollback_drive_version: null,
    permission_fingerprint: status === "dry_run"
      ? null
      : `hmac-sha256:${"c".repeat(64)}`,
    permission_fingerprint_after: status === "dry_run"
      ? null
      : `hmac-sha256:${"c".repeat(64)}`,
    rollback_permission_fingerprint: null,
    outside_content_fingerprint: `hmac-sha256:${"d".repeat(64)}`,
    revision_before_fingerprint: revisionBefore,
    revision_after_fingerprint: status === "dry_run" ? null : revisionAfter,
    revision_guard_present: true,
    reporting_week: "Jul 10, 2026 - Jul 16, 2026",
    snapshot_run_id: "e01_20260717133000000",
    snapshot_mode: "shadow",
    source_generated_at: sourceGeneratedAt,
    template_hash: `sha256:${"f".repeat(64)}`,
    rollback_request_count: status === "written" ? 2 : 0,
    rollback_attempted: false,
    rollback_verified: false,
    certification_status: status === "dry_run"
      ? "dry_run_verified"
      : status === "no_change"
        ? "preimage_verified"
        : "postimage_verified",
  }
  return {
    ...attempt(
      "elt_doc",
      1,
      "terminal",
      status === "written" ? "written" : "no_change",
      evidence
    ),
    planFingerprint: HMAC,
    mutationCallCount: status === "written" ? 1 : 0,
    versionBefore: revisionBefore,
    versionAfter: status === "dry_run" ? null : revisionAfter,
  }
}

function fakeClient(
  overrides: Partial<HydrationOrchestrationDatabaseClient>
): HydrationOrchestrationDatabaseClient {
  return {
    claimRun: async () => claimRow(true),
    bindRunSource: async () => true,
    heartbeatRun: async () => true,
    listAttempts: async () => [],
    timeoutRunningAttempts: async () => {},
    insertAttempt: async () => {},
    finishAttempt: async () => true,
    finishRun: async () => true,
    ...overrides,
  }
}
