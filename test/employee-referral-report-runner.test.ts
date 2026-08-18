import { describe, expect, test, vi, type Mock } from "vitest"

import { EmailTransportError } from "../lib/email-notify"
import {
  buildEmployeeReferralReport,
  createEmployeeReferralReportPeriod,
  type EmployeeReferralReportPeriod,
  type EmployeeReferralSnapshot,
} from "../lib/recruiting-ops/employee-referral-report"
import {
  dueScheduledPeriods,
  previewEmployeeReferralReport,
  readEmployeeReferralRecipientConfig,
  runEmployeeReferralReport,
  runEmployeeReferralWatchdog,
  sendSyntheticEmployeeReferralTest,
  syncEmployeeReferralMasterSheet,
  type EmployeeReferralRunnerDependencies,
} from "../lib/recruiting-ops/employee-referral-report-runner"
import {
  EmployeeReferralReportStore,
  EmployeeReferralReportStoreError,
} from "../lib/recruiting-ops/employee-referral-report-store"
import type {
  EmployeeReferralDeliveryClaim,
  EmployeeReferralPrepareInput,
  EmployeeReferralRpcClient,
  EmployeeReferralWatchdogTarget,
} from "../lib/recruiting-ops/employee-referral-report-store"

const period = createEmployeeReferralReportPeriod("2026-04-01", "2026-07-01")
const requestFingerprint = `hmac-sha256:${"a".repeat(64)}`

type StoreMethodName =
  | "prepareAndClaim"
  | "startProviderAttempt"
  | "finalizeProviderAttempt"
  | "getPeriodState"
  | "listWatchdogTargets"
  | "listAuthoritativeHeads"
  | "recordProviderEvent"
  | "markDeliveryDeadline"
  | "openDataDrift"
  | "upsertReconciliationIssue"
  | "resolveReconciliationIssue"
  | "promoteCorrection"
type StoreMock = {
  [K in StoreMethodName]: EmployeeReferralReportStore[K] extends (...args: infer A) => infer R
    ? Mock<(...args: A) => R>
    : never
}
type LoadSnapshotMock = Mock<EmployeeReferralRunnerDependencies["loadSnapshot"]>
type SendMock = Mock<EmployeeReferralRunnerDependencies["send"]>
type RetrieveStatusMock = Mock<EmployeeReferralRunnerDependencies["retrieveStatus"]>
type LogMock = Mock<EmployeeReferralRunnerDependencies["log"]>
type SleepMock = Mock<EmployeeReferralRunnerDependencies["sleep"]>

function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => undefined)
}

async function advancePastCurrentPhaseDeadline(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(700_001)
}

function snapshot(selectedPeriod: EmployeeReferralReportPeriod, rowCount = 0): EmployeeReferralSnapshot {
  const hasRow = rowCount > 0
  return {
    period: selectedPeriod,
    currentOffers: hasRow
      ? [
          {
            id: 10,
            version: 1,
            resolved_at: `${selectedPeriod.periodStartLocal.slice(0, 8)}15T20:00:00Z`,
            application_id: 100,
            starts_on: selectedPeriod.periodEndLocalExclusive,
            job_id: 200,
            status: "Accepted",
            candidate_id: 300,
            custom_fields: { hiring_location: { value: "USA" } },
          },
        ]
      : [],
    allVersionOffers: [],
    applications: hasRow
      ? [
          {
            id: 100,
            candidate_id: 300,
            job_id: 200,
            status: "hired",
            source_id: 4000194004,
            referrer_id: 400,
          },
        ]
      : [],
    candidates: hasRow ? [{ id: 300, first_name: "Private", last_name: "Candidate" }] : [],
    jobs: hasRow ? [{ id: 200, name: "Engineer", department_id: 4069524004 }] : [],
    departments: hasRow ? [{ id: 4069524004, name: "R&D / Engineering" }] : [],
    referrers: hasRow ? [{ id: 400, user_id: 500, name: "Private Referrer" }] : [],
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
}

function claim(
  recipientSlot: "ta_lead" | "requesting_manager",
  overrides: Partial<EmployeeReferralDeliveryClaim> = {}
): EmployeeReferralDeliveryClaim {
  return {
    parentStatus: "sending",
    recipientSlot,
    deliveryStatus: "sending",
    claimed: true,
    leaseToken: `lease-${recipientSlot}`,
    attemptCount: 1,
    providerRequestFingerprint: null,
    idempotencyKey: null,
    idempotencyExpiresAt: null,
    providerMessageId: null,
    deadlineMissedAtCreation: false,
    ...overrides,
  }
}

function fakeStore(overrides: Partial<StoreMock> = {}): StoreMock {
  return {
    prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async () => [
      claim("ta_lead"),
      claim("requesting_manager"),
    ]),
    startProviderAttempt: vi.fn<EmployeeReferralReportStore["startProviderAttempt"]>(
      async () => undefined
    ),
    finalizeProviderAttempt: vi.fn<EmployeeReferralReportStore["finalizeProviderAttempt"]>(
      async () => "provider_accepted"
    ),
    getPeriodState: vi.fn<EmployeeReferralReportStore["getPeriodState"]>(async () => ({
      runs: [],
      deliveries: [],
      proposals: [],
      issues: [],
    })),
    listWatchdogTargets: vi.fn<EmployeeReferralReportStore["listWatchdogTargets"]>(async () => []),
    listAuthoritativeHeads: vi.fn<EmployeeReferralReportStore["listAuthoritativeHeads"]>(
      async () => []
    ),
    recordProviderEvent: vi.fn<EmployeeReferralReportStore["recordProviderEvent"]>(
      async () => "delivered"
    ),
    markDeliveryDeadline: vi.fn<EmployeeReferralReportStore["markDeliveryDeadline"]>(
      async () => "attention_required"
    ),
    openDataDrift: vi.fn<EmployeeReferralReportStore["openDataDrift"]>(
      async () => "proposal-id"
    ),
    upsertReconciliationIssue: vi.fn<EmployeeReferralReportStore["upsertReconciliationIssue"]>(
      async () => "historical_rediff_failed"
    ),
    resolveReconciliationIssue: vi.fn<
      EmployeeReferralReportStore["resolveReconciliationIssue"]
    >(async () => "historical_rediff_failed"),
    promoteCorrection: vi.fn<EmployeeReferralReportStore["promoteCorrection"]>(async () => 2),
    ...overrides,
  }
}

function committedManualState(input: EmployeeReferralPrepareInput) {
  const delivery = (recipientSlot: "ta_lead" | "requesting_manager") => ({
    period_start_local: input.period.periodStartLocal,
    period_end_local_exclusive: input.period.periodEndLocalExclusive,
    revision: input.revision,
    recipient_slot: recipientSlot,
    delivery_channel: "manual_corporate_email",
    status: "prepared",
    provider_request_fingerprint: null,
    idempotency_key: null,
    attempt_count: 0,
    lease_token: null,
    lease_expires_at: null,
    first_provider_attempt_at: null,
    idempotency_expires_at: null,
    provider_message_id: null,
    provider_last_event: null,
    manual_evidence_ref: null,
    error_code: null,
    provider_accepted_at: null,
    delivered_at: null,
  })
  return {
    runs: [
      {
        period_start_local: input.period.periodStartLocal,
        period_end_local_exclusive: input.period.periodEndLocalExclusive,
        revision: input.revision,
        supersedes_revision: input.supersedesRevision,
        status: "prepared",
        window_start_utc: input.period.windowStartUtc,
        window_end_utc: input.period.windowEndUtc,
        source_set_fingerprint: input.sourceSetFingerprint,
        payload_fingerprint: input.payloadFingerprint,
        recipient_scope_version: input.recipientScopeVersion,
        current_cohort_count: input.counts.currentCohortCount,
        deprecated_review_count: input.counts.deprecatedReviewCount,
        ungoverned_source_review_count: input.counts.ungovernedSourceReviewCount,
        total_row_count: input.counts.totalRowCount,
        mapping_review_count: input.counts.mappingReviewCount,
        policy_version: input.policyVersion,
        policy_export_sha256: input.policyExportSha256,
        correction_reason: input.correctionReason,
        manual_preparation_token: input.manualPreparationToken,
        delivery_deadline_at: input.deliveryDeadlineAt,
        deadline_missed_at_creation: false,
        delivered_at: null,
      },
    ],
    deliveries: [delivery("ta_lead"), delivery("requesting_manager")],
    proposals: [],
    issues: [],
  }
}

function env(values: Record<string, string> = {}) {
  const configured = {
    EMPLOYEE_REFERRAL_REPORT_SEND_ENABLED: "true",
    EMPLOYEE_REFERRAL_REPORT_RECIPIENTS: JSON.stringify({
      ta_lead: "lead@example.com",
      requesting_manager: "manager@example.com",
    }),
    EMPLOYEE_REFERRAL_REPORT_RECIPIENT_SCOPE_VERSION: "scope-v1",
    EMPLOYEE_REFERRAL_MASTER_SPREADSHEET_ID: "1abcdefghijklmnopqrstuvwxyzABCDE",
    NOTIFY_EMAIL_FROM: "TA Ops <ta-ops@example.com>",
    EMPLOYEE_REFERRAL_REPORT_FIRST_SCHEDULED_PERIOD: "2099-01-01",
    ...values,
  }
  return (name: string) => configured[name as keyof typeof configured]
}

function dependencies(input: {
  store?: ReturnType<typeof fakeStore>
  rowCount?: number
  send?: SendMock
  retrieveStatus?: RetrieveStatusMock
  env?: (name: string) => string | undefined
  now?: Date
  clock?: () => number
  loadSnapshot?: LoadSnapshotMock
  log?: LogMock
} = {}): Partial<EmployeeReferralRunnerDependencies> & {
  store: EmployeeReferralReportStore
  send: SendMock
  loadSnapshot: LoadSnapshotMock
  log: LogMock
  sleep: SleepMock
} {
  const store = input.store ?? fakeStore()
  const loadSnapshot =
    input.loadSnapshot ??
    vi.fn<EmployeeReferralRunnerDependencies["loadSnapshot"]>(async (selectedPeriod) =>
      snapshot(selectedPeriod, input.rowCount)
    )
  return {
    store: store as unknown as EmployeeReferralReportStore,
    loadSnapshot,
    buildReport: buildEmployeeReferralReport,
    send:
      input.send ??
      vi.fn<EmployeeReferralRunnerDependencies["send"]>(async () => "provider-message-id"),
    retrieveStatus:
      input.retrieveStatus ??
      vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(async () => "delivered"),
    writeMasterSheet: vi.fn<EmployeeReferralRunnerDependencies["writeMasterSheet"]>(
      async (report) => ({
        spreadsheetId: "1abcdefghijklmnopqrstuvwxyzABCDE",
        spreadsheetUrl:
          "https://docs.google.com/spreadsheets/d/1abcdefghijklmnopqrstuvwxyzABCDE/edit",
        updatedTabs: [report.period.periodStartLocal.slice(0, 7)],
        currentCohortRowCount: report.counts.currentCohortCount,
      })
    ),
    env: input.env ?? env(),
    now: () => input.now ?? new Date("2026-07-22T12:00:00.000Z"),
    clock: input.clock ?? Date.now,
    piiFingerprint: () => requestFingerprint,
    sleep: vi.fn<EmployeeReferralRunnerDependencies["sleep"]>(async () => undefined),
    log: input.log ?? vi.fn<EmployeeReferralRunnerDependencies["log"]>(),
  }
}

describe("employee referral report runner", () => {
  test("fails closed at the send gate before Greenhouse, Supabase, or email", async () => {
    const store = fakeStore()
    const deps = dependencies({ store, env: env({ EMPLOYEE_REFERRAL_REPORT_SEND_ENABLED: "false" }) })

    await expect(runEmployeeReferralReport({ period }, deps)).rejects.toMatchObject({
      code: "send_gate_disabled",
    })
    expect(deps.loadSnapshot).not.toHaveBeenCalled()
    expect(store.prepareAndClaim).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("updates the master sheet before claiming or sending email", async () => {
    const store = fakeStore()
    const deps = dependencies({ store, rowCount: 1 })
    deps.writeMasterSheet = vi.fn<
      EmployeeReferralRunnerDependencies["writeMasterSheet"]
    >(async () => {
      throw new Error("sheet unavailable")
    })

    await expect(runEmployeeReferralReport({ period }, deps)).rejects.toThrow(
      "sheet unavailable"
    )
    expect(store.prepareAndClaim).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("requires exactly two distinct corporate recipient slots and an opaque scope version", () => {
    expect(readEmployeeReferralRecipientConfig(env())).toMatchObject({
      ta_lead: "lead@example.com",
      requesting_manager: "manager@example.com",
      scopeVersion: "scope-v1",
    })
    expect(() =>
      readEmployeeReferralRecipientConfig(
        env({
          EMPLOYEE_REFERRAL_REPORT_RECIPIENTS: JSON.stringify({
            ta_lead: "same@example.com",
            requesting_manager: "same@example.com",
          }),
        })
      )
    ).toThrow("distinct")
    expect(() =>
      readEmployeeReferralRecipientConfig(
        env({
          EMPLOYEE_REFERRAL_REPORT_RECIPIENTS: JSON.stringify({
            ta_lead: "personal@personal-mail.example",
            requesting_manager: "manager@example.com",
          }),
        })
      )
    ).toThrow("corporate")
    expect(() =>
      readEmployeeReferralRecipientConfig(
        env({ EMPLOYEE_REFERRAL_REPORT_RECIPIENT_SCOPE_VERSION: "manager@example.com" })
      )
    ).toThrow("scope")
  })

  test("preview reads and renders only; it never claims or sends", async () => {
    const store = fakeStore()
    const deps = dependencies({ store, rowCount: 1 })
    const preview = await previewEmployeeReferralReport(period, {}, deps)

    expect(preview.report.counts.currentCohortCount).toBe(1)
    expect(preview.payloadFingerprint).toBe(requestFingerprint)
    expect(store.prepareAndClaim).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("syncs the previous completed month without email configuration or delivery state", async () => {
    const store = fakeStore()
    const deps = dependencies({
      store,
      rowCount: 1,
      now: new Date("2026-08-03T16:00:00.000Z"),
      env: (name) =>
        name === "EMPLOYEE_REFERRAL_MASTER_SPREADSHEET_ID"
          ? "1abcdefghijklmnopqrstuvwxyzABCDE"
          : undefined,
    })

    const result = await syncEmployeeReferralMasterSheet(undefined, deps)

    expect(result).toMatchObject({
      status: "sheet_updated",
      periodStartLocal: "2026-07-01",
      periodEndLocalExclusive: "2026-08-01",
      updatedTabs: ["2026-07"],
      currentCohortRowCount: 1,
    })
    expect(deps.writeMasterSheet).toHaveBeenCalledOnce()
    expect(store.prepareAndClaim).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("stops a send when the regenerated payload differs from the approved preview", async () => {
    const store = fakeStore()
    const deps = dependencies({ store, rowCount: 1 })

    await expect(
      runEmployeeReferralReport(
        { period, expectedPayloadFingerprint: `hmac-sha256:${"f".repeat(64)}` },
        deps
      )
    ).rejects.toMatchObject({ code: "approved_preview_mismatch" })
    expect(store.prepareAndClaim).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("exhausted extraction budget fails before a database claim or provider attempt", async () => {
    const store = fakeStore()
    const startedAt = Date.parse("2026-07-22T12:00:00.000Z")
    let elapsedMs = 0
    const loadSnapshot = vi.fn<EmployeeReferralRunnerDependencies["loadSnapshot"]>(
      async (selectedPeriod) => {
        elapsedMs = 671_000
        return snapshot(selectedPeriod, 1)
      }
    )
    const deps = dependencies({
      store,
      loadSnapshot,
      clock: () => startedAt + elapsedMs,
    })

    await expect(runEmployeeReferralReport({ period }, deps)).rejects.toMatchObject({
      code: "current_phase_deadline_exhausted",
    })
    expect(store.prepareAndClaim).not.toHaveBeenCalled()
    expect(store.startProviderAttempt).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("aborts a stalled manual precheck before extraction or artifact creation", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"))
      const store = fakeStore({
        getPeriodState: vi.fn<EmployeeReferralReportStore["getPeriodState"]>(() =>
          neverResolves()
        ),
      })
      const writer = vi.fn(async () => ({ rollback: vi.fn(async () => undefined) }))
      const deps = dependencies({ store })
      const outcome = runEmployeeReferralReport(
        { period, mode: "prepare_manual", manualArtifactWriter: writer },
        deps
      ).catch((error) => error)

      await advancePastCurrentPhaseDeadline()
      await expect(outcome).resolves.toMatchObject({ code: "phase_deadline_exhausted" })
      expect(store.getPeriodState.mock.calls[0]?.[2]?.signal?.aborted).toBe(true)
      expect(deps.loadSnapshot).not.toHaveBeenCalled()
      expect(writer).not.toHaveBeenCalled()
      expect(deps.send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test("aborts a stalled correction promotion without claiming or sending", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"))
      const store = fakeStore({
        promoteCorrection: vi.fn<EmployeeReferralReportStore["promoteCorrection"]>(() =>
          neverResolves()
        ),
      })
      const deps = dependencies({ store })
      const outcome = runEmployeeReferralReport(
        {
          period,
          revision: 2,
          supersedesRevision: 1,
          correctionReason: "Approved correction",
          promoteCorrection: true,
        },
        deps
      ).catch((error) => error)

      await advancePastCurrentPhaseDeadline()
      await expect(outcome).resolves.toMatchObject({ code: "phase_deadline_exhausted" })
      expect(store.promoteCorrection.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
      expect(store.prepareAndClaim).not.toHaveBeenCalled()
      expect(deps.send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test("aborts a stalled claim without starting a provider request", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"))
      const store = fakeStore({
        prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(() =>
          neverResolves()
        ),
      })
      const deps = dependencies({ store })
      const outcome = runEmployeeReferralReport({ period }, deps).catch((error) => error)

      await advancePastCurrentPhaseDeadline()
      await expect(outcome).resolves.toMatchObject({ code: "phase_deadline_exhausted" })
      expect(store.prepareAndClaim.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
      expect(store.startProviderAttempt).not.toHaveBeenCalled()
      expect(deps.send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test("aborts a stalled provider-start fence before the provider POST", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"))
      const store = fakeStore({
        prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async () => [
          claim("ta_lead"),
          claim("requesting_manager", { claimed: false, leaseToken: null }),
        ]),
        startProviderAttempt: vi.fn<EmployeeReferralReportStore["startProviderAttempt"]>(() =>
          neverResolves()
        ),
      })
      const deps = dependencies({ store })
      const outcome = runEmployeeReferralReport({ period }, deps).catch((error) => error)

      await advancePastCurrentPhaseDeadline()
      await expect(outcome).resolves.toMatchObject({ code: "delivery_attempt_failed" })
      expect(store.startProviderAttempt.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
      expect(deps.send).not.toHaveBeenCalled()
      expect(store.finalizeProviderAttempt).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test("bounds a stalled acceptance finalize after exactly one provider POST", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"))
      const store = fakeStore({
        prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async () => [
          claim("ta_lead"),
          claim("requesting_manager", { claimed: false, leaseToken: null }),
        ]),
        finalizeProviderAttempt: vi.fn<
          EmployeeReferralReportStore["finalizeProviderAttempt"]
        >(() => neverResolves()),
      })
      const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>(async () => "provider-id")
      const deps = dependencies({ store, send })
      const outcome = runEmployeeReferralReport({ period }, deps).catch((error) => error)

      await advancePastCurrentPhaseDeadline()
      await expect(outcome).resolves.toMatchObject({ code: "delivery_attempt_failed" })
      expect(send).toHaveBeenCalledOnce()
      expect(store.finalizeProviderAttempt).toHaveBeenCalledOnce()
      expect(store.finalizeProviderAttempt.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test("bounds the post-dispatch readback without another provider POST", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"))
      const store = fakeStore({
        prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async () => [
          claim("ta_lead"),
          claim("requesting_manager", { claimed: false, leaseToken: null }),
        ]),
        getPeriodState: vi.fn<EmployeeReferralReportStore["getPeriodState"]>(() =>
          neverResolves()
        ),
      })
      const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>(async () => "provider-id")
      const deps = dependencies({ store, send })
      const outcome = runEmployeeReferralReport({ period }, deps).catch((error) => error)

      await advancePastCurrentPhaseDeadline()
      await expect(outcome).resolves.toMatchObject({ code: "phase_deadline_exhausted" })
      expect(send).toHaveBeenCalledOnce()
      expect(store.finalizeProviderAttempt).toHaveBeenCalledOnce()
      expect(store.getPeriodState.mock.calls[0]?.[2]?.signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test("prepares the initial manual fallback without a provider call or sender configuration", async () => {
    const store = fakeStore()
    const rollback = vi.fn(async () => undefined)
    const writer = vi.fn(async () => ({ rollback }))
    const deps = dependencies({
      store,
      env: env({ NOTIFY_EMAIL_FROM: "" }),
    })
    const result = await runEmployeeReferralReport(
      { period, mode: "prepare_manual", manualArtifactWriter: writer },
      deps
    )

    expect(result.status).toBe("manual_prepared")
    expect(store.prepareAndClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryChannel: "manual_corporate_email",
        manualPreparationToken: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        ),
        requestFingerprints: {},
        idempotencyKeys: {},
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(writer).toHaveBeenCalledOnce()
    expect(rollback).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("rolls back a slow artifact before the prepare RPC when claim budget is exhausted", async () => {
    const startedAt = Date.parse("2026-07-22T12:00:00.000Z")
    let elapsedMs = 0
    const store = fakeStore()
    const rollback = vi.fn(async () => undefined)
    const writer = vi.fn(async () => {
      elapsedMs = 696_000
      return { rollback }
    })
    const deps = dependencies({
      store,
      clock: () => startedAt + elapsedMs,
      env: env({ NOTIFY_EMAIL_FROM: "" }),
    })

    await expect(
      runEmployeeReferralReport(
        { period, mode: "prepare_manual", manualArtifactWriter: writer },
        deps
      )
    ).rejects.toMatchObject({ code: "current_phase_deadline_before_claim" })
    expect(rollback).toHaveBeenCalledOnce()
    expect(store.getPeriodState).toHaveBeenCalledOnce()
    expect(store.prepareAndClaim).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("alerts when a late manual backfill is created without claiming provider slots", async () => {
    const store = fakeStore({
      prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async () => [
        claim("ta_lead", {
          parentStatus: "prepared",
          deliveryStatus: "prepared",
          claimed: false,
          leaseToken: null,
          attemptCount: 0,
          deadlineMissedAtCreation: true,
        }),
        claim("requesting_manager", {
          parentStatus: "prepared",
          deliveryStatus: "prepared",
          claimed: false,
          leaseToken: null,
          attemptCount: 0,
          deadlineMissedAtCreation: true,
        }),
      ]),
    })
    const writer = vi.fn(async () => ({ rollback: vi.fn(async () => undefined) }))
    const log = vi.fn<EmployeeReferralRunnerDependencies["log"]>()
    const deps = dependencies({
      store,
      log,
      env: env({ NOTIFY_EMAIL_FROM: "" }),
    })

    const result = await runEmployeeReferralReport(
      { period, mode: "prepare_manual", manualArtifactWriter: writer },
      deps
    )

    expect(result.status).toBe("manual_prepared")
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("employee_referral_delivery_deadline_missed_at_creation")
    )
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("preserves a staged manual artifact when an unknown claim outcome reads back empty", async () => {
    const rollback = vi.fn(async () => undefined)
    const writer = vi.fn(async () => ({ rollback }))
    const log = vi.fn<EmployeeReferralRunnerDependencies["log"]>()
    const store = fakeStore({
      prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async () => {
        throw new Error("outcome unknown")
      }),
    })
    const deps = dependencies({ store, log })

    await expect(
      runEmployeeReferralReport(
        { period, mode: "prepare_manual", manualArtifactWriter: writer },
        deps
      )
    ).rejects.toMatchObject({ code: "manual_delivery_commit_unconfirmed" })
    expect(writer).toHaveBeenCalledOnce()
    expect(rollback).not.toHaveBeenCalled()
    expect(store.getPeriodState).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("employee_referral_manual_prepare_commit_unconfirmed")
    )
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("recovers a committed manual preparation from a resolved status-zero response", async () => {
    let prepareArgs: Record<string, unknown> | undefined
    let readCount = 0
    const client = {
      rpc: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
        if (name === "employee_referral_prepare_and_claim") {
          prepareArgs = args
          return {
            data: null,
            error: { message: "FetchError: response lost", code: "" },
            status: 0,
            statusText: "",
          }
        }
        if (name !== "employee_referral_get_period_state") {
          throw new Error(`unexpected RPC: ${name}`)
        }
        readCount += 1
        if (readCount === 1) {
          return {
            data: { runs: [], deliveries: [], proposals: [], issues: [] },
            error: null,
            status: 200,
            statusText: "OK",
          }
        }
        if (!prepareArgs) throw new Error("prepare input missing")
        const prepared: EmployeeReferralPrepareInput = {
          period,
          revision: Number(prepareArgs.p_revision),
          supersedesRevision: prepareArgs.p_supersedes_revision as number | null,
          sourceSetFingerprint: String(prepareArgs.p_source_set_fingerprint),
          payloadFingerprint: String(prepareArgs.p_payload_fingerprint),
          recipientScopeVersion: String(prepareArgs.p_recipient_scope_version),
          counts: {
            currentCohortCount: Number(prepareArgs.p_current_cohort_count),
            deprecatedReviewCount: Number(prepareArgs.p_deprecated_review_count),
            ungovernedSourceReviewCount: Number(
              prepareArgs.p_ungoverned_source_review_count
            ),
            amountMappedCount: 0,
            mappingReviewCount: Number(prepareArgs.p_mapping_review_count),
            totalRowCount: Number(prepareArgs.p_total_row_count),
          },
          policyVersion: String(prepareArgs.p_policy_version),
          policyExportSha256: String(prepareArgs.p_policy_export_sha256),
          correctionReason: prepareArgs.p_correction_reason as string | null,
          deliveryDeadlineAt: String(prepareArgs.p_delivery_deadline_at),
          deliveryChannel: "manual_corporate_email",
          manualPreparationToken: String(prepareArgs.p_manual_preparation_token),
          requestFingerprints: {},
          idempotencyKeys: {},
        }
        return {
          data: committedManualState(prepared),
          error: null,
          status: 200,
          statusText: "OK",
        }
      }),
    } satisfies EmployeeReferralRpcClient
    const store = new EmployeeReferralReportStore(client)
    const rollback = vi.fn(async () => undefined)
    const writer = vi.fn(async () => ({ rollback }))
    const log = vi.fn<EmployeeReferralRunnerDependencies["log"]>()
    const deps = dependencies({
      store: store as unknown as ReturnType<typeof fakeStore>,
      log,
      env: env({ NOTIFY_EMAIL_FROM: "" }),
    })

    const result = await runEmployeeReferralReport(
      { period, mode: "prepare_manual", manualArtifactWriter: writer },
      deps
    )

    expect(result.status).toBe("manual_prepared")
    expect(result.recipientSlots).toEqual([
      {
        recipientSlot: "ta_lead",
        deliveryStatus: "prepared",
        providerMessageId: null,
      },
      {
        recipientSlot: "requesting_manager",
        deliveryStatus: "prepared",
        providerMessageId: null,
      },
    ])
    expect(rollback).not.toHaveBeenCalled()
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "employee_referral_get_period_state",
      "employee_referral_prepare_and_claim",
      "employee_referral_get_period_state",
    ])
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("employee_referral_manual_prepare_response_recovered")
    )
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("rolls back an identical concurrent manual loser after a returned database rejection", async () => {
    let prepared: EmployeeReferralPrepareInput | undefined
    let readCount = 0
    const store = fakeStore({
      prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async (input) => {
        prepared = input
        throw new EmployeeReferralReportStoreError(
          "employee_referral_prepare_and_claim",
          "employee_referral_store_rpc_rejected",
          "rejected"
        )
      }),
      getPeriodState: vi.fn<EmployeeReferralReportStore["getPeriodState"]>(async () => {
        readCount += 1
        if (readCount === 1) {
          return { runs: [], deliveries: [], proposals: [], issues: [] }
        }
        if (!prepared) throw new Error("prepare input missing")
        return committedManualState(prepared)
      }),
    })
    const rollback = vi.fn(async () => undefined)
    const writer = vi.fn(async () => ({ rollback }))
    const deps = dependencies({
      store,
      env: env({ NOTIFY_EMAIL_FROM: "" }),
    })

    await expect(
      runEmployeeReferralReport(
        { period, mode: "prepare_manual", manualArtifactWriter: writer },
        deps
      )
    ).rejects.toMatchObject({
      code: "employee_referral_store_rpc_rejected",
      outcome: "rejected",
    })
    expect(rollback).toHaveBeenCalledOnce()
    expect(store.getPeriodState).toHaveBeenCalledOnce()
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("does not adopt an identical manual ledger owned by another invocation token", async () => {
    let prepared: EmployeeReferralPrepareInput | undefined
    let readCount = 0
    const store = fakeStore({
      prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async (input) => {
        prepared = input
        throw new EmployeeReferralReportStoreError(
          "employee_referral_prepare_and_claim",
          "employee_referral_store_rpc_failed",
          "unknown"
        )
      }),
      getPeriodState: vi.fn<EmployeeReferralReportStore["getPeriodState"]>(async () => {
        readCount += 1
        if (readCount === 1) {
          return { runs: [], deliveries: [], proposals: [], issues: [] }
        }
        if (!prepared) throw new Error("prepare input missing")
        return committedManualState({
          ...prepared,
          manualPreparationToken: "00000000-0000-4000-8000-000000000099",
        })
      }),
    })
    const rollback = vi.fn(async () => undefined)
    const writer = vi.fn(async () => ({ rollback }))
    const deps = dependencies({
      store,
      env: env({ NOTIFY_EMAIL_FROM: "" }),
    })

    await expect(
      runEmployeeReferralReport(
        { period, mode: "prepare_manual", manualArtifactWriter: writer },
        deps
      )
    ).rejects.toMatchObject({ code: "manual_delivery_already_exists" })
    expect(rollback).toHaveBeenCalledOnce()
    expect(store.getPeriodState).toHaveBeenCalledTimes(2)
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("preserves the staged manual artifact when commit readback is unavailable", async () => {
    let readCount = 0
    const store = fakeStore({
      prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async () => {
        throw new Error("response lost after possible commit")
      }),
      getPeriodState: vi.fn<EmployeeReferralReportStore["getPeriodState"]>(async () => {
        readCount += 1
        if (readCount === 1) {
          return { runs: [], deliveries: [], proposals: [], issues: [] }
        }
        throw new Error("readback unavailable")
      }),
    })
    const rollback = vi.fn(async () => undefined)
    const writer = vi.fn(async () => ({ rollback }))
    const log = vi.fn<EmployeeReferralRunnerDependencies["log"]>()
    const deps = dependencies({
      store,
      log,
      env: env({ NOTIFY_EMAIL_FROM: "" }),
    })

    await expect(
      runEmployeeReferralReport(
        { period, mode: "prepare_manual", manualArtifactWriter: writer },
        deps
      )
    ).rejects.toMatchObject({
      code: "manual_delivery_commit_unconfirmed",
      publicDiagnostics: { payload_fingerprint: requestFingerprint },
    })
    expect(rollback).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("employee_referral_manual_prepare_commit_unconfirmed")
    )
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("rejects manual fallback outside the initial period before creating ledger state", async () => {
    const store = fakeStore()
    const july = createEmployeeReferralReportPeriod("2026-07-01", "2026-08-01")
    const deps = dependencies({ store })

    await expect(
      runEmployeeReferralReport({ period: july, mode: "prepare_manual" }, deps)
    ).rejects.toMatchObject({ code: "manual_period_forbidden" })
    expect(store.prepareAndClaim).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("rejects replaying manual preparation before reading Greenhouse or writing another artifact", async () => {
    const store = fakeStore({
      getPeriodState: vi.fn<EmployeeReferralReportStore["getPeriodState"]>(async () => ({
        runs: [{ revision: 1, status: "delivered" }],
        deliveries: [],
        proposals: [],
        issues: [],
      })),
    })
    const writer = vi.fn(async () => ({ rollback: vi.fn(async () => undefined) }))
    const deps = dependencies({ store })

    await expect(
      runEmployeeReferralReport(
        { period, mode: "prepare_manual", manualArtifactWriter: writer },
        deps
      )
    ).rejects.toMatchObject({ code: "manual_delivery_already_exists" })
    expect(deps.loadSnapshot).not.toHaveBeenCalled()
    expect(store.prepareAndClaim).not.toHaveBeenCalled()
    expect(writer).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  test("two concurrent invocations make exactly one provider call per durable slot", async () => {
    let claimInvocation = 0
    const store = fakeStore({
      prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async () => {
        claimInvocation += 1
        if (claimInvocation === 1) return [claim("ta_lead"), claim("requesting_manager")]
        return [
          claim("ta_lead", { claimed: false, leaseToken: null }),
          claim("requesting_manager", { claimed: false, leaseToken: null }),
        ]
      }),
    })
    const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>(
      async (to) => `provider-${to.split("@")[0]}`
    )
    const deps = dependencies({ store, send, rowCount: 1 })

    const results = await Promise.all([
      runEmployeeReferralReport({ period }, deps),
      runEmployeeReferralReport({ period }, deps),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(["in_progress", "provider_accepted"])
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.map((call) => call[0]).sort()).toEqual([
      "lead@example.com",
      "manager@example.com",
    ])
    expect(store.startProviderAttempt).toHaveBeenCalledTimes(2)
    expect(store.finalizeProviderAttempt).toHaveBeenCalledTimes(2)
    expect(
      store.finalizeProviderAttempt.mock.calls.every(
        ([input]) => (input as { status: string }).status === "provider_accepted"
      )
    ).toBe(true)
    for (const [, , , options] of send.mock.calls) {
      expect(options).toMatchObject({
        idempotencyKey: expect.stringMatching(/^employee-referral-[0-9a-f]{64}$/),
        timeoutMs: 20_000,
        attachment: { filename: expect.stringMatching(/-r1\.csv$/) },
      })
    }
  })

  test("an identical retry of a delivered revision makes no provider call or attempt mutation", async () => {
    const store = fakeStore({
      prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async () => [
        claim("ta_lead", {
          parentStatus: "delivered",
          deliveryStatus: "delivered",
          claimed: false,
          leaseToken: null,
          attemptCount: 1,
          providerMessageId: "provider-ta_lead",
        }),
        claim("requesting_manager", {
          parentStatus: "delivered",
          deliveryStatus: "delivered",
          claimed: false,
          leaseToken: null,
          attemptCount: 1,
          providerMessageId: "provider-manager",
        }),
      ]),
    })
    const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>()
    const result = await runEmployeeReferralReport(
      { period },
      dependencies({ store, send, rowCount: 1 })
    )

    expect(result.status).toBe("already_delivered")
    expect(result.recipientSlots).toEqual([
      {
        recipientSlot: "ta_lead",
        deliveryStatus: "delivered",
        providerMessageId: "provider-ta_lead",
      },
      {
        recipientSlot: "requesting_manager",
        deliveryStatus: "delivered",
        providerMessageId: "provider-manager",
      },
    ])
    expect(send).not.toHaveBeenCalled()
    expect(store.startProviderAttempt).not.toHaveBeenCalled()
    expect(store.finalizeProviderAttempt).not.toHaveBeenCalled()
    expect(store.getPeriodState).not.toHaveBeenCalled()
  })

  test("alerts before dispatch when the database marks a first run as created late", async () => {
    const store = fakeStore({
      prepareAndClaim: vi.fn<EmployeeReferralReportStore["prepareAndClaim"]>(async () => [
        claim("ta_lead", { deadlineMissedAtCreation: true }),
        claim("requesting_manager", { deadlineMissedAtCreation: true }),
      ]),
    })
    const log = vi.fn<EmployeeReferralRunnerDependencies["log"]>()
    const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>(async () => "provider-id")

    await runEmployeeReferralReport({ period }, dependencies({ store, log, send }))

    const lateAlertCall = log.mock.invocationCallOrder.find(
      (_, index) =>
        String(log.mock.calls[index]?.[0]).includes(
          "employee_referral_delivery_deadline_missed_at_creation"
        )
    )
    expect(lateAlertCall).toBeDefined()
    expect(lateAlertCall).toBeLessThan(send.mock.invocationCallOrder[0])
    expect(send).toHaveBeenCalledTimes(2)
  })

  test.each([
    [
      "provider rejection",
      new EmailTransportError({
        code: "resend_http_422",
        kind: "provider_rejected",
        message: "safe rejection",
        status: 422,
      }),
      "transport_failed",
      "resend_http_422",
    ],
    [
      "ambiguous provider response",
      new EmailTransportError({
        code: "resend_http_503",
        kind: "ambiguous",
        message: "safe ambiguous response",
        status: 503,
      }),
      "ambiguous",
      "resend_http_503",
    ],
    ["ambiguous network loss", new Error("private canary"), "ambiguous", "unexpected_dispatch_failure"],
  ])("records %s durably and returns failure", async (_label, failure, status, errorCode) => {
    const store = fakeStore()
    const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>(async () => {
      throw failure
    })

    await expect(
      runEmployeeReferralReport({ period }, dependencies({ store, send }))
    ).rejects.toMatchObject({ code: "delivery_attempt_incomplete" })
    expect(send).toHaveBeenCalledTimes(2)
    expect(store.finalizeProviderAttempt).toHaveBeenCalledTimes(2)
    expect(store.finalizeProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status, errorCode }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  test("sends an explicit zero-row success report to both slots", async () => {
    const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>(async () => "provider-id")
    const result = await runEmployeeReferralReport(
      { period },
      dependencies({ send, rowCount: 0 })
    )

    expect(result).toMatchObject({ status: "provider_accepted", counts: { totalRowCount: 0 } })
    expect(send).toHaveBeenCalledTimes(2)
    for (const [, subject, html, options] of send.mock.calls) {
      expect(subject).toContain("0 current - 0 review")
      expect(html).toContain("Zero current accepted employee referrals")
      expect(options?.attachment?.content.toString().split("\r\n").filter(Boolean)).toHaveLength(1)
    }
  })

  test("historical drift opens a proposal without another provider call", async () => {
    const historicalPeriod = createEmployeeReferralReportPeriod("2026-03-01", "2026-04-01")
    const historicalReport = buildEmployeeReferralReport(snapshot(historicalPeriod, 0))
    const store = fakeStore({
      listAuthoritativeHeads: vi.fn<EmployeeReferralReportStore["listAuthoritativeHeads"]>(async () => [
        {
          period_start_local: historicalPeriod.periodStartLocal,
          period_end_local_exclusive: historicalPeriod.periodEndLocalExclusive,
          revision: 1,
          status: "delivered",
          payload_fingerprint: `hmac-sha256:${"b".repeat(64)}`,
          policy_version: historicalReport.policyVersion,
          policy_export_sha256: historicalReport.policyExportSha256,
        },
      ]),
    })
    const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>(async () => "provider-id")
    const log = vi.fn<EmployeeReferralRunnerDependencies["log"]>()
    const result = await runEmployeeReferralReport(
      { period },
      dependencies({ store, send, log })
    )

    expect(result.historicalReconciliation).toEqual({
      checkedPeriodCount: 1,
      driftCount: 1,
      issueCount: 0,
    })
    expect(store.openDataDrift).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(2)
    expect(log.mock.calls.flat().join("\n")).toContain(
      "employee_referral_correction_proposal_opened"
    )
    expect(log.mock.calls.flat().join("\n")).toContain("historical_data_drift")
  })

  test("retries a historical rediff against the new authoritative head and clears ancestral issues", async () => {
    const historicalPeriod = createEmployeeReferralReportPeriod("2026-03-01", "2026-04-01")
    const historicalReport = buildEmployeeReferralReport(snapshot(historicalPeriod, 0))
    const oldHead = {
      period_start_local: historicalPeriod.periodStartLocal,
      period_end_local_exclusive: historicalPeriod.periodEndLocalExclusive,
      revision: 1,
      status: "delivered" as const,
      payload_fingerprint: `hmac-sha256:${"b".repeat(64)}`,
      policy_version: historicalReport.policyVersion,
      policy_export_sha256: historicalReport.policyExportSha256,
    }
    const newHead = {
      ...oldHead,
      revision: 2,
      payload_fingerprint: requestFingerprint,
    }
    let inventoryCall = 0
    const store = fakeStore({
      listAuthoritativeHeads: vi.fn<EmployeeReferralReportStore["listAuthoritativeHeads"]>(
        async () => {
          inventoryCall += 1
          return inventoryCall === 1 ? [oldHead] : [newHead]
        }
      ),
      openDataDrift: vi.fn<EmployeeReferralReportStore["openDataDrift"]>(async () => {
        throw new Error("stale authoritative head")
      }),
      getPeriodState: vi.fn<EmployeeReferralReportStore["getPeriodState"]>(
        async (periodStart) =>
          periodStart === historicalPeriod.periodStartLocal
            ? {
                runs: [],
                deliveries: [],
                proposals: [],
                issues: [
                  {
                    revision: 1,
                    issue_code: "historical_rediff_failed",
                    status: "open",
                  },
                ],
              }
            : { runs: [], deliveries: [], proposals: [], issues: [] }
      ),
    })
    const result = await runEmployeeReferralReport({ period }, dependencies({ store }))

    expect(result.historicalReconciliation).toEqual({
      checkedPeriodCount: 1,
      driftCount: 0,
      issueCount: 0,
    })
    expect(store.openDataDrift).toHaveBeenCalledWith(
      expect.objectContaining({ predecessorRevision: 1 })
    )
    expect(store.resolveReconciliationIssue).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1, reason: "successful_historical_rediff" })
    )
    expect(store.upsertReconciliationIssue).not.toHaveBeenCalled()
  })

  test("a historical extraction failure records an issue without failing the current delivery", async () => {
    const historicalPeriod = createEmployeeReferralReportPeriod("2026-03-01", "2026-04-01")
    const currentReport = buildEmployeeReferralReport(snapshot(period, 0))
    const store = fakeStore({
      listAuthoritativeHeads: vi.fn<EmployeeReferralReportStore["listAuthoritativeHeads"]>(async () => [
        {
          period_start_local: historicalPeriod.periodStartLocal,
          period_end_local_exclusive: historicalPeriod.periodEndLocalExclusive,
          revision: 1,
          status: "delivered",
          payload_fingerprint: requestFingerprint,
          policy_version: currentReport.policyVersion,
          policy_export_sha256: currentReport.policyExportSha256,
        },
      ]),
    })
    const loadSnapshot = vi.fn<EmployeeReferralRunnerDependencies["loadSnapshot"]>(async (selected) => {
      if (selected.periodStartLocal === historicalPeriod.periodStartLocal) throw new Error("private")
      return snapshot(selected)
    })
    const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>(async () => "provider-id")
    const result = await runEmployeeReferralReport(
      { period },
      dependencies({ store, send, loadSnapshot })
    )

    expect(result.status).toBe("provider_accepted")
    expect(result.historicalReconciliation.issueCount).toBe(1)
    expect(store.upsertReconciliationIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issueCode: "historical_rediff_failed" })
    )
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe("employee referral synthetic test", () => {
  const syntheticEnv = env({
    EMPLOYEE_REFERRAL_REPORT_OPERATOR_MODE: "true",
    EMPLOYEE_REFERRAL_REPORT_TEST_RECIPIENT: "jordan.rivera@example.com",
    EMPLOYEE_REFERRAL_REPORT_IMAGE_DIGEST: `sha256:${"d".repeat(64)}`,
  })

  test("uses the production renderer and attachment exactly once with no Greenhouse or database call", async () => {
    const store = fakeStore()
    const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>(async () => "email-synthetic")
    const retrieveStatus = vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(
      async () => "delivered"
    )
    const deps = dependencies({ store, send, retrieveStatus, env: syntheticEnv })

    await expect(sendSyntheticEmployeeReferralTest(deps)).resolves.toMatchObject({
      status: "delivered",
      providerMessageId: "email-synthetic",
      event: "delivered",
    })
    expect(deps.loadSnapshot).not.toHaveBeenCalled()
    expect(store.prepareAndClaim).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(
      "jordan.rivera@example.com",
      expect.stringMatching(/^TEST - SYNTHETIC DATA - NOT FOR PAYROLL/),
      expect.stringContaining("TEST - SYNTHETIC DATA - NOT FOR PAYROLL"),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^employee-referral-synthetic-[0-9a-f]{64}$/),
        attachment: expect.objectContaining({
          filename: "TEST-SYNTHETIC-employee-referrals.csv",
          contentType: "text/csv; charset=utf-8",
        }),
      })
    )
    expect(String(send.mock.calls[0]?.[3]?.attachment?.content)).toContain(
      "TEST - SYNTHETIC DATA - NOT FOR PAYROLL"
    )
  })

  test("is idempotent for an image digest and never leaks the test address or body to logs", async () => {
    const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>(async () => "email-synthetic")
    const log = vi.fn<EmployeeReferralRunnerDependencies["log"]>()
    const deps = dependencies({ send, log, env: syntheticEnv })
    await sendSyntheticEmployeeReferralTest(deps)
    await sendSyntheticEmployeeReferralTest(deps)

    const firstKey = send.mock.calls[0]?.[3]?.idempotencyKey
    expect(firstKey).toMatch(/^employee-referral-synthetic-[0-9a-f]{64}$/)
    expect(send.mock.calls[1]?.[3]?.idempotencyKey).toBe(firstKey)
    expect(JSON.stringify(log.mock.calls)).not.toContain("jordan.rivera@example.com")
    expect(JSON.stringify(log.mock.calls)).not.toContain("Synthetic Candidate")
  })

  test("keeps worst-case synthetic status polling inside the 870-second launcher ceiling", async () => {
    const retrieveStatus = vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(
      async () => "sent"
    )
    const deps = dependencies({ retrieveStatus, env: syntheticEnv })

    await expect(sendSyntheticEmployeeReferralTest(deps)).rejects.toMatchObject({
      code: "synthetic_delivery_unconfirmed",
    })

    expect(retrieveStatus).toHaveBeenCalledTimes(27)
    expect(deps.sleep).toHaveBeenCalledTimes(26)
    const lookupBudgetMs = retrieveStatus.mock.calls.reduce(
      (total, call) => total + (call[1]?.timeoutMs ?? 0),
      0
    )
    const sleepBudgetMs = deps.sleep.mock.calls.reduce(
      (total, call) => total + call[0],
      0
    )
    const providerSendBudgetMs = 20_000
    expect(providerSendBudgetMs + lookupBudgetMs + sleepBudgetMs).toBe(680_000)
    expect(providerSendBudgetMs + lookupBudgetMs + sleepBudgetMs).toBeLessThan(870_000)
  })

  test.each(["complained", "failed", "delivery_failed", "bounced", "suppressed", "canceled"])(
    "fails immediately on terminal provider event %s",
    async (event) => {
      const retrieveStatus = vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(
        async () => event
      )
      const deps = dependencies({ retrieveStatus, env: syntheticEnv })

      await expect(sendSyntheticEmployeeReferralTest(deps)).rejects.toMatchObject({
        code: "synthetic_delivery_failed",
        publicDiagnostics: { providerEvent: event },
      })
      expect(retrieveStatus).toHaveBeenCalledOnce()
      expect(deps.sleep).not.toHaveBeenCalled()
    }
  )

  test("rejects a non-corporate recipient before rendering or dispatch", async () => {
    const store = fakeStore()
    const send = vi.fn<EmployeeReferralRunnerDependencies["send"]>()
    const deps = dependencies({
      store,
      send,
      env: env({
        EMPLOYEE_REFERRAL_REPORT_OPERATOR_MODE: "true",
        EMPLOYEE_REFERRAL_REPORT_TEST_RECIPIENT: "jordan@personal-mail.example",
        EMPLOYEE_REFERRAL_REPORT_IMAGE_DIGEST: `sha256:${"d".repeat(64)}`,
      }),
    })

    await expect(sendSyntheticEmployeeReferralTest(deps)).rejects.toMatchObject({
      code: "corporate_recipient_required",
    })
    expect(deps.loadSnapshot).not.toHaveBeenCalled()
    expect(store.prepareAndClaim).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})

function watchdogTarget(
  overrides: Partial<EmployeeReferralWatchdogTarget> = {}
): EmployeeReferralWatchdogTarget {
  return {
    period_start_local: "2026-07-01",
    period_end_local_exclusive: "2026-08-01",
    revision: 1,
    authoritative_head: true,
    parent_status: "provider_accepted",
    recipient_slot: "ta_lead",
    delivery_status: "provider_accepted",
    provider_message_id: "email-1",
    first_provider_attempt_at: "2026-08-01T18:00:00.000Z",
    idempotency_expires_at: "2026-08-02T18:00:00.000Z",
    recovery_eligible_at: "2026-08-03T18:00:00.000Z",
    observation_expires_at: "2026-08-30T18:00:00.000Z",
    ...overrides,
  }
}

describe("employee referral watchdog", () => {
  test.each(["delivered", "opened", "clicked", "complained"])(
    "treats %s as delivery evidence",
    async (providerEvent) => {
      const store = fakeStore({
        listWatchdogTargets: vi.fn<EmployeeReferralReportStore["listWatchdogTargets"]>(async () => [
          watchdogTarget(),
        ]),
        recordProviderEvent: vi.fn<EmployeeReferralReportStore["recordProviderEvent"]>(
          async () => "delivered"
        ),
      })
      const result = await runEmployeeReferralWatchdog(
        dependencies({
          store,
          retrieveStatus: vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(
            async () => providerEvent
          ),
          now: new Date("2026-08-04T00:00:00.000Z"),
        })
      )

      expect(store.recordProviderEvent).toHaveBeenCalledWith(
        expect.objectContaining({ providerEvent })
      )
      expect(result.status).toBe("healthy")
      expect(result.complaintCount).toBe(providerEvent === "complained" ? 1 : 0)
    }
  )

  test.each([
    "sent",
    "queued",
    "scheduled",
    "delivery_delayed",
    "failed",
    "delivery_failed",
    "bounced",
    "suppressed",
    "canceled",
    "future_unknown_event",
  ])("passes %s through fail-closed and remains unhealthy", async (providerEvent) => {
    const store = fakeStore({
      listWatchdogTargets: vi.fn<EmployeeReferralReportStore["listWatchdogTargets"]>(async () => [
        watchdogTarget(),
      ]),
      recordProviderEvent: vi.fn<EmployeeReferralReportStore["recordProviderEvent"]>(
        async () => "attention_required"
      ),
    })
    const result = await runEmployeeReferralWatchdog(
      dependencies({
        store,
        retrieveStatus: vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(
          async () => providerEvent
        ),
        now: new Date("2026-08-04T00:00:00.000Z"),
      })
    )

    expect(store.recordProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ providerEvent })
    )
    expect(result.status).toBe("unhealthy")
  })

  test("marks pending status at the recovery deadline", async () => {
    const store = fakeStore({
      listWatchdogTargets: vi.fn<EmployeeReferralReportStore["listWatchdogTargets"]>(async () => [
        watchdogTarget(),
      ]),
      recordProviderEvent: vi.fn<EmployeeReferralReportStore["recordProviderEvent"]>(
        async () => "provider_accepted"
      ),
    })
    const result = await runEmployeeReferralWatchdog(
      dependencies({
        store,
        retrieveStatus: vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(
          async () => "queued"
        ),
        now: new Date("2026-08-04T00:00:00.000Z"),
      })
    )

    expect(store.markDeliveryDeadline).toHaveBeenCalledOnce()
    expect(result.status).toBe("unhealthy")
  })

  test("bounds failed status lookups, opens recovery, and reports only counts", async () => {
    const store = fakeStore({
      listWatchdogTargets: vi.fn<EmployeeReferralReportStore["listWatchdogTargets"]>(async () => [
        watchdogTarget(),
      ]),
    })
    const retrieveStatus = vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(async () => {
      throw new Error("private provider response")
    })
    const log = vi.fn<EmployeeReferralRunnerDependencies["log"]>()
    const deps = dependencies({
      store,
      retrieveStatus,
      log,
      now: new Date("2026-08-04T00:00:00.000Z"),
    })
    const result = await runEmployeeReferralWatchdog(deps)

    expect(retrieveStatus).toHaveBeenCalledTimes(3)
    expect(deps.sleep).toHaveBeenCalledTimes(2)
    expect(store.markDeliveryDeadline).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: "unhealthy", lookupFailureCount: 1 })
    expect(JSON.stringify(log.mock.calls)).not.toContain("private provider response")
  })

  test("observes superseded provider messages without making an authoritative successor unhealthy", async () => {
    const store = fakeStore({
      listWatchdogTargets: vi.fn<EmployeeReferralReportStore["listWatchdogTargets"]>(async () => [
        watchdogTarget({
          revision: 1,
          authoritative_head: false,
          parent_status: "attention_required",
        }),
      ]),
      recordProviderEvent: vi.fn<EmployeeReferralReportStore["recordProviderEvent"]>(
        async () => "attention_required"
      ),
    })
    const result = await runEmployeeReferralWatchdog(
      dependencies({
        store,
        retrieveStatus: vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(
          async () => "queued"
        ),
        now: new Date("2026-08-04T00:00:00.000Z"),
      })
    )

    expect(store.recordProviderEvent).toHaveBeenCalledOnce()
    expect(store.markDeliveryDeadline).not.toHaveBeenCalled()
    expect(result.status).toBe("healthy")
  })

  test("alerts only once when a complaint remains the provider's latest event", async () => {
    const store = fakeStore({
      listWatchdogTargets: vi.fn<EmployeeReferralReportStore["listWatchdogTargets"]>(async () => [
        watchdogTarget({
          authoritative_head: false,
          parent_status: "delivered",
          delivery_status: "complained",
        }),
      ]),
      recordProviderEvent: vi.fn<EmployeeReferralReportStore["recordProviderEvent"]>(
        async () => "delivered"
      ),
    })
    const log = vi.fn<EmployeeReferralRunnerDependencies["log"]>()
    const result = await runEmployeeReferralWatchdog(
      dependencies({
        store,
        log,
        retrieveStatus: vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(
          async () => "complained"
        ),
        now: new Date("2026-08-04T00:00:00.000Z"),
      })
    )

    expect(result).toMatchObject({ status: "healthy", complaintCount: 0 })
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "employee_referral_recipient_complaint"
    )
  })

  test("opens dispatch recovery for an expired authoritative ambiguity without a provider ID", async () => {
    const log = vi.fn<EmployeeReferralRunnerDependencies["log"]>()
    const store = fakeStore({
      listWatchdogTargets: vi.fn<EmployeeReferralReportStore["listWatchdogTargets"]>(async () => [
        watchdogTarget({
          parent_status: "ambiguous",
          delivery_status: "ambiguous",
          provider_message_id: null,
          observation_expires_at: null,
          idempotency_expires_at: "2026-08-03T00:00:00.000Z",
        }),
      ]),
    })

    const result = await runEmployeeReferralWatchdog(
      dependencies({ store, log, now: new Date("2026-08-04T00:00:00.000Z") })
    )

    expect(store.markDeliveryDeadline).toHaveBeenCalledOnce()
    expect(result.status).toBe("unhealthy")
    expect(JSON.stringify(log.mock.calls)).toContain(
      "employee_referral_correction_proposal_opened"
    )
    expect(JSON.stringify(log.mock.calls)).toContain("dispatch_unresolved")
  })

  test("recomputes aggregate health when the second recipient completes delivery in the same tick", async () => {
    let recorded = 0
    const store = fakeStore({
      listWatchdogTargets: vi.fn<EmployeeReferralReportStore["listWatchdogTargets"]>(async () => [
        watchdogTarget({ recipient_slot: "ta_lead", provider_message_id: "email-1" }),
        watchdogTarget({
          recipient_slot: "requesting_manager",
          provider_message_id: "email-2",
        }),
      ]),
      recordProviderEvent: vi.fn<EmployeeReferralReportStore["recordProviderEvent"]>(
        async () => {
          recorded += 1
          return recorded === 1 ? "partially_delivered" : "delivered"
        }
      ),
    })

    const result = await runEmployeeReferralWatchdog(
      dependencies({
        store,
        retrieveStatus: vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(
          async () => "delivered"
        ),
        now: new Date("2026-08-04T00:00:00.000Z"),
      })
    )

    expect(store.recordProviderEvent).toHaveBeenCalledTimes(2)
    expect(result.status).toBe("healthy")
  })

  test("checks four correction slots concurrently inside the watchdog ceiling", async () => {
    let active = 0
    let maximumActive = 0
    const targets = [
      watchdogTarget({ revision: 1, authoritative_head: false, recipient_slot: "ta_lead" }),
      watchdogTarget({
        revision: 1,
        authoritative_head: false,
        recipient_slot: "requesting_manager",
        provider_message_id: "email-2",
      }),
      watchdogTarget({ revision: 2, recipient_slot: "ta_lead", provider_message_id: "email-3" }),
      watchdogTarget({
        revision: 2,
        recipient_slot: "requesting_manager",
        provider_message_id: "email-4",
      }),
    ]
    const store = fakeStore({
      listWatchdogTargets: vi.fn<EmployeeReferralReportStore["listWatchdogTargets"]>(
        async () => targets
      ),
    })
    const retrieveStatus = vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(
      async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await Promise.resolve()
        active -= 1
        throw new Error("provider unavailable")
      }
    )

    const result = await runEmployeeReferralWatchdog(
      dependencies({
        store,
        retrieveStatus,
        now: new Date("2026-08-02T00:00:00.000Z"),
      })
    )

    expect(maximumActive).toBe(4)
    expect(retrieveStatus).toHaveBeenCalledTimes(12)
    expect(result.lookupFailureCount).toBe(4)
  })

  test("alerts on a newly observed terminal event for a superseded provider message", async () => {
    const log = vi.fn<EmployeeReferralRunnerDependencies["log"]>()
    const store = fakeStore({
      listWatchdogTargets: vi.fn<EmployeeReferralReportStore["listWatchdogTargets"]>(async () => [
        watchdogTarget({
          authoritative_head: false,
          parent_status: "delivered",
          delivery_status: "delivered",
        }),
      ]),
      recordProviderEvent: vi.fn<EmployeeReferralReportStore["recordProviderEvent"]>(
        async () => "delivered"
      ),
    })

    const result = await runEmployeeReferralWatchdog(
      dependencies({
        store,
        log,
        retrieveStatus: vi.fn<EmployeeReferralRunnerDependencies["retrieveStatus"]>(
          async () => "bounced"
        ),
        now: new Date("2026-08-04T00:00:00.000Z"),
      })
    )

    expect(result.status).toBe("healthy")
    expect(JSON.stringify(log.mock.calls)).toContain(
      "employee_referral_provider_terminal_observed"
    )
  })

  test("flags a scheduled period with no durable run after its deadline", async () => {
    const store = fakeStore()
    const result = await runEmployeeReferralWatchdog(
      dependencies({
        store,
        now: new Date("2026-08-04T00:00:00.000Z"),
        env: env({ EMPLOYEE_REFERRAL_REPORT_FIRST_SCHEDULED_PERIOD: "2026-07-01" }),
      })
    )

    expect(result).toMatchObject({
      status: "unhealthy",
      missingDuePeriod: true,
      checkedSlotCount: 0,
    })
  })

  test("calculates only complete, deadline-due Los Angeles months", () => {
    expect(
      dueScheduledPeriods(
        new Date("2026-08-03T18:59:59.999Z"),
        env({ EMPLOYEE_REFERRAL_REPORT_FIRST_SCHEDULED_PERIOD: "2026-07-01" })
      )
    ).toEqual([])
    expect(
      dueScheduledPeriods(
        new Date("2026-08-03T19:00:00.000Z"),
        env({ EMPLOYEE_REFERRAL_REPORT_FIRST_SCHEDULED_PERIOD: "2026-07-01" })
      ).map((due) => due.periodStartLocal)
    ).toEqual(["2026-07-01"])
  })
})
