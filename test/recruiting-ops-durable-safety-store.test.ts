import { describe, expect, test, vi } from "vitest"

import { createKillSwitchOperatorEvent } from "../lib/recruiting-ops/autonomy-operator-controls"
import { createPayloadFingerprint } from "../lib/recruiting-ops/checksums"
import {
  appendDurableDeliveryLedgerEntry,
  collectDurableShadowLedgerHistory,
  readCurrentAutonomyState,
  readKillSwitchStates,
  recordKillSwitchEvent,
  type SafetyStoreDatabaseClient,
} from "../lib/recruiting-ops/durable-safety-store"
import {
  DURABLE_DELIVERY_LEDGER_MECHANISM,
  buildDeliveryLogId,
  type LocalDeliveryLedgerEntry,
} from "../lib/recruiting-ops/delivery-ledger"
import {
  evaluateProductionDeliveryPreflight,
  productionDeliveryAdapterContracts,
} from "../lib/recruiting-ops/production-delivery-adapters"
import { deliverableAutomationSeedMatrix } from "../lib/recruiting-ops/automation-seed-matrix"

class FakeSafetyStoreClient implements SafetyStoreDatabaseClient {
  readonly ledger: { delivery_log_id: string; deliverable_id: string; content_fingerprint: string; entry: unknown }[] = []
  readonly killSwitchEvents: { event_id: string; entry: unknown }[] = []
  readonly autonomyEvents: { promotion_id: string; deliverable_id: string; entry: unknown }[] = []

  async selectDeliveryLedgerRows(deliverableId: string) {
    return this.ledger.filter((row) => row.deliverable_id === deliverableId)
  }
  async insertDeliveryLedgerRow(row: Record<string, unknown>) {
    this.ledger.push(row as (typeof this.ledger)[number])
  }
  async selectKillSwitchEventRows() {
    return this.killSwitchEvents
  }
  async insertKillSwitchEventRow(row: Record<string, unknown>) {
    this.killSwitchEvents.push(row as (typeof this.killSwitchEvents)[number])
  }
  async selectAutonomyEventRows(deliverableId: string) {
    return this.autonomyEvents.filter((row) => row.deliverable_id === deliverableId)
  }
  async insertAutonomyEventRow(row: Record<string, unknown>) {
    this.autonomyEvents.push(row as (typeof this.autonomyEvents)[number])
  }
}

const seed = deliverableAutomationSeedMatrix[0]

function shadowEntry(runId: string, payloadFingerprint: string, createdAt: string): LocalDeliveryLedgerEntry {
  return {
    deliveryLogId: buildDeliveryLogId(seed.deliverableId, runId, "shadow_run"),
    capabilityId: seed.capabilityId,
    deliverableId: seed.deliverableId,
    runId,
    lane: seed.lane,
    autonomyState: "shadow",
    readinessState: "ready_for_review",
    recipientFingerprint: createPayloadFingerprint({ recipient: "test" }),
    payloadFingerprint,
    gateResults: [],
    status: "shadowed",
    createdAt,
    createdBy: "test",
    eventType: "shadow_run",
    deliveryMechanism: DURABLE_DELIVERY_LEDGER_MECHANISM,
    artifactIds: [],
    publicSummary: { deliverableId: seed.deliverableId },
  }
}

describe("durable safety stores (migration 019)", () => {
  test("delivery ledger appends are content-aware idempotent and refuse dangling lineage", async () => {
    const client = new FakeSafetyStoreClient()
    const entry = shadowEntry("run_1", createPayloadFingerprint({ payload: 1 }), "2026-07-01T00:00:00.000Z")

    const first = await appendDurableDeliveryLedgerEntry(entry, client)
    expect(first.outcome).toBe("appended")
    const replay = await appendDurableDeliveryLedgerEntry(entry, client)
    expect(replay.outcome).toBe("already_recorded")
    expect(client.ledger).toHaveLength(1)

    // Same id, different content — never silently dropped or overwritten.
    const mutated = { ...entry, payloadFingerprint: createPayloadFingerprint({ payload: 2 }) }
    await expect(appendDurableDeliveryLedgerEntry(mutated, client)).rejects.toThrow(/different content/)

    // Lineage references must resolve within the deliverable's ledger.
    const dangling = {
      ...shadowEntry("run_2", createPayloadFingerprint({ payload: 3 }), "2026-07-01T01:00:00.000Z"),
      eventType: "correction" as const,
      status: "correction_recorded" as const,
      correctionOf: "delivery_missing_entry",
    }
    await expect(appendDurableDeliveryLedgerEntry(dangling, client)).rejects.toThrow(/unknown ledger entry/)
  })

  test("shadow history derives from durable entries exactly like the local ledger", async () => {
    const client = new FakeSafetyStoreClient()
    await appendDurableDeliveryLedgerEntry(
      shadowEntry("run_1", createPayloadFingerprint({ payload: 1 }), "2026-07-01T00:00:00.000Z"),
      client
    )
    await appendDurableDeliveryLedgerEntry(
      shadowEntry("run_2", createPayloadFingerprint({ payload: 2 }), "2026-07-01T10:00:00.000Z"),
      client
    )

    const history = await collectDurableShadowLedgerHistory(
      {
        deliverableId: seed.deliverableId,
        evaluatedAt: "2026-07-01T10:30:00.000Z",
        windowMinutes: 60,
      },
      client
    )
    // Only the in-window payload counts toward idempotency; ALL clean shadow
    // runs count toward the trust window.
    expect(history.priorPayloadFingerprintsInWindow).toEqual([createPayloadFingerprint({ payload: 2 })])
    expect(history.priorCleanShadowRuns).toBe(2)
  })

  test("kill-switch state is the latest event per scope, and engage/disengage round-trips", async () => {
    const client = new FakeSafetyStoreClient()
    const engage = createKillSwitchOperatorEvent({
      scope: "global",
      scopeId: "global",
      enabled: true,
      reason: "Operator engaged the global switch.",
      updatedAt: "2026-07-01T00:00:00.000Z",
      updatedBy: "sam",
    })
    const disengage = createKillSwitchOperatorEvent({
      scope: "global",
      scopeId: "global",
      enabled: false,
      reason: "Operator disengaged after verification.",
      updatedAt: "2026-07-01T02:00:00.000Z",
      updatedBy: "sam",
    })

    await recordKillSwitchEvent(engage, client)
    let states = await readKillSwitchStates(client)
    expect(states).toHaveLength(1)
    expect(states[0].enabled).toBe(true)

    await recordKillSwitchEvent(disengage, client)
    states = await readKillSwitchStates(client)
    expect(states).toHaveLength(1)
    expect(states[0].enabled).toBe(false)

    // Replaying an identical event is a no-op; same id with different content throws.
    const replay = await recordKillSwitchEvent(disengage, client)
    expect(replay.outcome).toBe("already_recorded")
  })

  test("kill-switch reads retry a transient store failure and remain bounded", async () => {
    vi.useFakeTimers()
    try {
      const recovered = new FakeSafetyStoreClient()
      const recoveredRead = vi.spyOn(recovered, "selectKillSwitchEventRows")
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue([])
      const recovery = readKillSwitchStates(recovered)
      await vi.runAllTimersAsync()
      await expect(recovery).resolves.toEqual([])
      expect(recoveredRead).toHaveBeenCalledTimes(2)

      const unavailable = new FakeSafetyStoreClient()
      const unavailableRead = vi.spyOn(unavailable, "selectKillSwitchEventRows")
        .mockRejectedValue(new Error("unavailable"))
      const failure = readKillSwitchStates(unavailable)
      const rejected = expect(failure).rejects.toThrow("unavailable")
      await vi.runAllTimersAsync()
      await rejected
      expect(unavailableRead).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  test("kill-switch recording retries a transient read before appending", async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeSafetyStoreClient()
      const read = vi.spyOn(client, "selectKillSwitchEventRows")
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue([])
      const event = createKillSwitchOperatorEvent({
        scope: "global",
        scopeId: "global",
        enabled: true,
        reason: "Operator engaged the global switch.",
        updatedAt: "2026-07-01T00:00:00.000Z",
        updatedBy: "sam",
      })

      const recording = recordKillSwitchEvent(event, client)
      await vi.runAllTimersAsync()

      await expect(recording).resolves.toMatchObject({ outcome: "appended" })
      expect(read).toHaveBeenCalledTimes(2)
      expect(client.killSwitchEvents).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("no approved promotions means null autonomy state (contract initial state governs)", async () => {
    const client = new FakeSafetyStoreClient()
    expect(await readCurrentAutonomyState(seed.deliverableId, client)).toBeNull()
  })

  test("an exact-timestamp engage/disengage tie cannot enter via the writer, and reads resolve to ENGAGED", async () => {
    const client = new FakeSafetyStoreClient()
    const at = "2026-07-01T00:00:00.000Z"
    const engage = createKillSwitchOperatorEvent({
      scope: "global",
      scopeId: "global",
      enabled: true,
      reason: "Engage at the same instant.",
      updatedAt: at,
      updatedBy: "sam",
    })
    const disengage = createKillSwitchOperatorEvent({
      scope: "global",
      scopeId: "global",
      enabled: false,
      reason: "Disengage at the same instant.",
      updatedAt: at,
      updatedBy: "sam",
    })

    // Same-instant events share an event id, so the P8 writer refuses the
    // conflicting second event outright — the tie cannot be RECORDED.
    await recordKillSwitchEvent(engage, client)
    await expect(recordKillSwitchEvent(disengage, client)).rejects.toThrow(/different content/)

    // Defense in depth: rows that arrive outside the writer (backfill, manual
    // SQL) with an exact-timestamp tie read as ENGAGED regardless of order.
    const backfilled = new FakeSafetyStoreClient()
    await backfilled.insertKillSwitchEventRow({ event_id: "backfill_engage", entry: engage })
    await backfilled.insertKillSwitchEventRow({ event_id: "backfill_disengage", entry: disengage })
    const states = await readKillSwitchStates(backfilled)
    expect(states).toHaveLength(1)
    expect(states[0].enabled).toBe(true)
  })

  test("the send-chokepoint kill_switch check passes ONLY on affirmative durable evidence", () => {
    const contract = productionDeliveryAdapterContracts[0]
    const base = {
      contract,
      deliverableId: contract.supportedDeliverableIds[0],
      runId: "run_preflight_1",
      requestedAt: "2026-07-01T00:00:00.000Z",
      requestedBy: "sam",
      readinessState: "ready_for_review" as const,
      autonomyState: "shadow" as const,
    }

    // No evidence -> fail closed (the pre-C2 behavior stays locked elsewhere).
    const noEvidence = evaluateProductionDeliveryPreflight(base)
    expect(noEvidence.checks.find((item) => item.checkId === "kill_switch")?.status).toBe("fail")

    // Unreachable store -> fail closed.
    const unreachable = evaluateProductionDeliveryPreflight({
      ...base,
      killSwitchEvidence: { storeReachable: false, states: [], readAt: "2026-07-01T00:00:00.000Z" },
    })
    expect(unreachable.checks.find((item) => item.checkId === "kill_switch")?.status).toBe("fail")

    // Reachable + engaged applicable switch -> fail.
    const engaged = evaluateProductionDeliveryPreflight({
      ...base,
      killSwitchEvidence: {
        storeReachable: true,
        states: [
          {
            scope: "global",
            scopeId: "global",
            enabled: true,
            reason: "engaged",
            updatedAt: "2026-07-01T00:00:00.000Z",
            updatedBy: "sam",
          },
        ],
        readAt: "2026-07-01T00:00:00.000Z",
      },
    })
    expect(engaged.checks.find((item) => item.checkId === "kill_switch")?.status).toBe("fail")

    // Reachable + provably disengaged -> the kill_switch check passes (the
    // phase_5 boundary still blocks the preflight overall).
    const disengaged = evaluateProductionDeliveryPreflight({
      ...base,
      killSwitchEvidence: {
        storeReachable: true,
        states: [
          {
            scope: "global",
            scopeId: "global",
            enabled: false,
            reason: "disengaged",
            updatedAt: "2026-07-01T00:00:00.000Z",
            updatedBy: "sam",
          },
        ],
        readAt: "2026-07-01T00:00:00.000Z",
      },
    })
    expect(disengaged.checks.find((item) => item.checkId === "kill_switch")?.status).toBe("pass")
    expect(disengaged.status).toBe("blocked")
    expect(disengaged.deliveryAuthorized).toBe(false)
  })
})
