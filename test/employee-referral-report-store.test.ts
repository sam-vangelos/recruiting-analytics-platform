import { describe, expect, test, vi } from "vitest"

import {
  EmployeeReferralReportStore,
  EmployeeReferralReportStoreError,
  type EmployeeReferralRpcClient,
} from "../lib/recruiting-ops/employee-referral-report-store"
import { createEmployeeReferralReportPeriod } from "../lib/recruiting-ops/employee-referral-report"

function clientReturning(
  data: unknown,
  error: unknown = null,
  status = error ? 400 : 200
) {
  return {
    rpc: vi.fn().mockResolvedValue({ data, error, status, statusText: "" }),
  } satisfies EmployeeReferralRpcClient
}

const prepareInput = {
  period: createEmployeeReferralReportPeriod("2026-04-01", "2026-07-01"),
  revision: 1,
  supersedesRevision: null,
  sourceSetFingerprint: `sha256:${"a".repeat(64)}`,
  payloadFingerprint: `hmac-sha256:${"b".repeat(64)}`,
  recipientScopeVersion: "scope-v1",
  counts: {
    currentCohortCount: 12,
    deprecatedReviewCount: 1,
    ungovernedSourceReviewCount: 1,
    amountMappedCount: 10,
    mappingReviewCount: 2,
    totalRowCount: 14,
  },
  policyVersion: "2026-04-14",
  policyExportSha256: "c".repeat(64),
  correctionReason: null,
  deliveryDeadlineAt: "2026-07-28T00:00:00.000Z",
  requestFingerprints: {
    ta_lead: `hmac-sha256:${"d".repeat(64)}`,
    requesting_manager: `hmac-sha256:${"e".repeat(64)}`,
  },
  idempotencyKeys: {
    ta_lead: `employee-referral-${"1".repeat(64)}`,
    requesting_manager: `employee-referral-${"2".repeat(64)}`,
  },
} as const

describe("employee referral report store", () => {
  test("maps a non-PII parent and two delivery claims to the claim RPC", async () => {
    const client = clientReturning([
      {
        parent_status: "sending",
        recipient_slot: "ta_lead",
        delivery_status: "sending",
        claimed: true,
        lease_token: "00000000-0000-4000-8000-000000000001",
        attempt_count: 1,
        provider_request_fingerprint: null,
        idempotency_key: null,
        idempotency_expires_at: null,
        provider_message_id: null,
        deadline_missed_at_creation: false,
      },
      {
        parent_status: "sending",
        recipient_slot: "requesting_manager",
        delivery_status: "sending",
        claimed: true,
        lease_token: "00000000-0000-4000-8000-000000000002",
        attempt_count: 1,
        provider_request_fingerprint: null,
        idempotency_key: null,
        idempotency_expires_at: null,
        provider_message_id: null,
        deadline_missed_at_creation: false,
      },
    ])
    const store = new EmployeeReferralReportStore(client)
    const claims = await store.prepareAndClaim(prepareInput)
    expect(claims).toHaveLength(2)
    expect(claims.every((claim) => claim.claimed)).toBe(true)
    expect(client.rpc).toHaveBeenCalledWith(
      "employee_referral_prepare_and_claim",
      expect.objectContaining({
        p_period_start_local: "2026-04-01",
        p_period_end_local_exclusive: "2026-07-01",
        p_current_cohort_count: 12,
        p_total_row_count: 14,
        p_delivery_channel: "resend",
      })
    )
    const serializedArgs = JSON.stringify(client.rpc.mock.calls[0][1])
    expect(serializedArgs).not.toMatch(/candidate|referrer|@example\.com|recipient@/i)
  })

  test("starts and finalizes a provider attempt through lease-token compare-and-set RPCs", async () => {
    const client = clientReturning([])
    const store = new EmployeeReferralReportStore(client)
    await store.startProviderAttempt({
      periodStartLocal: "2026-04-01",
      periodEndLocalExclusive: "2026-07-01",
      revision: 1,
      recipientSlot: "ta_lead",
      leaseToken: "lease",
      providerRequestFingerprint: `hmac-sha256:${"d".repeat(64)}`,
      idempotencyKey: `employee-referral-${"3".repeat(64)}`,
    })
    client.rpc.mockResolvedValueOnce({ data: "sending", error: null })
    await expect(
      store.finalizeProviderAttempt({
        periodStartLocal: "2026-04-01",
        periodEndLocalExclusive: "2026-07-01",
        revision: 1,
        recipientSlot: "ta_lead",
        leaseToken: "lease",
        status: "provider_accepted",
        providerMessageId: "email_123",
      })
    ).resolves.toBe("sending")
    expect(client.rpc.mock.calls.map((call) => call[0])).toEqual([
      "employee_referral_start_provider_attempt",
      "employee_referral_finalize_provider_attempt",
    ])
  })

  test("never propagates a database error body that may contain PII", async () => {
    const canary = "candidate@example.com SECRET REPORT CONTENT"
    const client = clientReturning(null, { message: canary, details: canary })
    const store = new EmployeeReferralReportStore(client)
    const error = await store.prepareAndClaim(prepareInput).catch((caught) => caught)
    expect(error).toBeInstanceOf(EmployeeReferralReportStoreError)
    expect(error).toMatchObject({ outcome: "rejected" })
    expect(String(error)).not.toContain(canary)
    expect(JSON.stringify(error)).not.toContain(canary)
  })

  test("classifies a missing RPC outcome as unknown without exposing the transport error", async () => {
    const canary = "candidate@example.com SECRET REPORT CONTENT"
    const client = {
      rpc: vi.fn().mockRejectedValue(new Error(canary)),
    } satisfies EmployeeReferralRpcClient
    const store = new EmployeeReferralReportStore(client)

    const error = await store.prepareAndClaim(prepareInput).catch((caught) => caught)

    expect(error).toBeInstanceOf(EmployeeReferralReportStoreError)
    expect(error).toMatchObject({ outcome: "unknown" })
    expect(String(error)).not.toContain(canary)
    expect(JSON.stringify(error)).not.toContain(canary)
  })

  test("classifies a resolved status-zero PostgREST failure as outcome unknown", async () => {
    const canary = "candidate@example.com SECRET REPORT CONTENT"
    const client = clientReturning(
      null,
      { message: canary, details: canary, code: "" },
      0
    )
    const store = new EmployeeReferralReportStore(client)

    const error = await store.prepareAndClaim(prepareInput).catch((caught) => caught)

    expect(error).toBeInstanceOf(EmployeeReferralReportStoreError)
    expect(error).toMatchObject({ outcome: "unknown" })
    expect(String(error)).not.toContain(canary)
    expect(JSON.stringify(error)).not.toContain(canary)
  })

  test.each([408, 425, 429, 499, 500, 502, 503, 504])(
    "classifies ambiguous HTTP %s RPC failure as outcome unknown",
    async (status) => {
      const client = clientReturning(null, { message: "suppressed" }, status)
      const store = new EmployeeReferralReportStore(client)

      await expect(store.prepareAndClaim(prepareInput)).rejects.toMatchObject({
        outcome: "unknown",
      })
    }
  )

  test("rejects malformed fingerprints before making an RPC", async () => {
    const client = clientReturning([])
    const store = new EmployeeReferralReportStore(client)
    await expect(
      store.prepareAndClaim({ ...prepareInput, payloadFingerprint: "sha256:not-hmac" })
    ).rejects.toMatchObject({ code: "invalid_payload_fingerprint" })
    expect(client.rpc).not.toHaveBeenCalled()
  })

  test("requires a UUID preparation token only for the manual delivery channel", async () => {
    const client = clientReturning([])
    const store = new EmployeeReferralReportStore(client)
    const manualInput = {
      ...prepareInput,
      deliveryChannel: "manual_corporate_email" as const,
      requestFingerprints: {},
      idempotencyKeys: {},
    }

    await expect(store.prepareAndClaim(manualInput)).rejects.toMatchObject({
      code: "invalid_manual_preparation_token",
    })
    expect(client.rpc).not.toHaveBeenCalled()

    const manualPreparationToken = "00000000-0000-4000-8000-000000000077"
    await expect(
      store.prepareAndClaim({ ...manualInput, manualPreparationToken })
    ).resolves.toEqual([])
    expect(client.rpc).toHaveBeenCalledWith(
      "employee_referral_prepare_and_claim",
      expect.objectContaining({
        p_delivery_channel: "manual_corporate_email",
        p_manual_preparation_token: manualPreparationToken,
      })
    )

    await expect(
      store.prepareAndClaim({
        ...prepareInput,
        manualPreparationToken,
      })
    ).rejects.toMatchObject({ code: "invalid_manual_preparation_token" })
  })

  test("exposes only aggregate period/watchdog state", async () => {
    const client = clientReturning({ runs: [], deliveries: [], proposals: [], issues: [] })
    const store = new EmployeeReferralReportStore(client)
    await expect(store.getPeriodState("2026-04-01", "2026-07-01")).resolves.toEqual({
      runs: [],
      deliveries: [],
      proposals: [],
      issues: [],
    })
    client.rpc.mockResolvedValueOnce({ data: [], error: null })
    await expect(store.listWatchdogTargets("2026-07-22T00:00:00Z")).resolves.toEqual([])
  })

  test("requires the database to identify the authoritative watchdog head", async () => {
    const target = {
      period_start_local: "2026-07-01",
      period_end_local_exclusive: "2026-08-01",
      revision: 1,
      authoritative_head: true,
      parent_status: "provider_accepted",
      recipient_slot: "ta_lead",
      delivery_status: "provider_accepted",
      provider_message_id: "email_123",
      first_provider_attempt_at: "2026-08-03T19:00:00.000Z",
      idempotency_expires_at: "2026-08-04T19:00:00.000Z",
      recovery_eligible_at: "2026-08-04T19:00:00.000Z",
      observation_expires_at: "2026-09-02T19:00:00.000Z",
    }
    const client = clientReturning([target])
    const store = new EmployeeReferralReportStore(client)

    await expect(store.listWatchdogTargets("2026-08-04T00:00:00Z")).resolves.toEqual([
      target,
    ])
    client.rpc.mockResolvedValueOnce({
      data: [{ ...target, authoritative_head: undefined }],
      error: null,
    })
    await expect(
      store.listWatchdogTargets("2026-08-04T00:00:00Z")
    ).rejects.toMatchObject({ operation: "list_watchdog_targets" })
  })

  test("passes a caller deadline signal into the Supabase RPC request", async () => {
    const result = { data: { runs: [], deliveries: [], proposals: [], issues: [] }, error: null }
    const fallback = Promise.resolve(result)
    const abortSignal = vi.fn(async () => result)
    const request = {
      then: fallback.then.bind(fallback),
      abortSignal,
    }
    const client = { rpc: vi.fn(() => request) } satisfies EmployeeReferralRpcClient
    const store = new EmployeeReferralReportStore(client)
    const controller = new AbortController()

    await expect(
      store.getPeriodState("2026-04-01", "2026-07-01", { signal: controller.signal })
    ).resolves.toEqual(result.data)
    expect(abortSignal).toHaveBeenCalledWith(controller.signal)
  })
})
