import { describe, expect, test, vi } from "vitest"

import {
  ProductionDeliveryDisabledError,
  createDisabledProductionDeliveryAdapter,
  evaluateProductionDeliveryPreflight,
  productionDeliveryAdapterContracts,
  validateProductionDeliveryAdapterContract,
  validateProductionDeliveryAdapterContracts,
  type ProductionDeliveryAdapterContract,
} from "../lib/recruiting-ops/production-delivery-adapters"

const request = {
  deliverableId: "weekly_progress_sheet",
  runId: "t03_20260624120000000",
  recipientFingerprint: "sha256:recipient_fixture_alpha",
  payloadFingerprint: "sha256:payload_fixture_alpha",
  publicSummary: {
    deliverableId: "weekly_progress_sheet",
    rowCount: 2,
  },
}

describe("Phase 5 production delivery adapter contracts", () => {
  test("declares only disabled production-delivery adapters", () => {
    expect(validateProductionDeliveryAdapterContracts()).toEqual({
      ok: true,
      count: productionDeliveryAdapterContracts.length,
    })
    expect(productionDeliveryAdapterContracts.map((contract) => contract.targetSystem).sort()).toEqual([
      "gmail",
      "google_docs",
      "google_sheets",
      "greenhouse",
      "linkedin",
      "n8n",
      "power_bi",
      "slack",
    ])
    expect(
      productionDeliveryAdapterContracts.every(
        (contract) =>
          contract.disabledByDefault === true &&
          contract.sendsEnabled === false &&
          contract.writesEnabled === false &&
          contract.noLiveExecution === true
      )
    ).toBe(true)
  })

  test("disabled adapters reject send/write before any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    for (const contract of productionDeliveryAdapterContracts) {
      const adapter = createDisabledProductionDeliveryAdapter(contract)
      await expect(adapter.send({ ...request, deliverableId: contract.supportedDeliverableIds[0] })).rejects.toBeInstanceOf(
        ProductionDeliveryDisabledError
      )
      await expect(adapter.write({ ...request, deliverableId: contract.supportedDeliverableIds[0] })).rejects.toBeInstanceOf(
        ProductionDeliveryDisabledError
      )
    }

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  test("preflight blocks production delivery even when a deliverable is structurally ready", () => {
    const contract = productionDeliveryAdapterContracts.find((item) => item.adapterId === "google_sheets_delivery_disabled")!
    const result = evaluateProductionDeliveryPreflight({
      contract,
      deliverableId: "weekly_progress_sheet",
      runId: request.runId,
      requestedAt: "2026-06-24T12:02:00.000Z",
      requestedBy: "sam",
      readinessState: "ready_for_delivery",
      autonomyState: "auto_eligible",
      externalAdapterApproved: false,
      uiMutationControlEnabled: false,
    })

    expect(result).toMatchObject({
      status: "blocked",
      deliveryAuthorized: false,
      sendReachable: false,
      writeReachable: false,
    })
    expect(result.checks.find((check) => check.checkId === "phase_5_boundary")).toMatchObject({
      status: "fail",
    })
    expect(result.checks.find((check) => check.checkId === "adapter_disabled")).toMatchObject({
      status: "pass",
    })
  })

  test("preflight remains blocked if approval or UI mutation state is accidentally enabled", () => {
    const contract = productionDeliveryAdapterContracts.find((item) => item.adapterId === "slack_delivery_disabled")!
    const result = evaluateProductionDeliveryPreflight({
      contract,
      deliverableId: "recruiter_lead_slack_draft",
      runId: "t18_20260624120000000",
      requestedAt: "2026-06-24T12:02:00.000Z",
      requestedBy: "sam",
      readinessState: "ready_for_delivery",
      autonomyState: "auto_delivering",
      externalAdapterApproved: true,
      uiMutationControlEnabled: true,
    })

    expect(result.status).toBe("blocked")
    expect(result.deliveryAuthorized).toBe(false)
    expect(result.checks.filter((check) => check.status === "fail").map((check) => check.checkId)).toEqual([
      "phase_5_boundary",
      "sam_approval",
      "ui_mutation_controls",
      "kill_switch",
    ])
  })

  test("validator rejects any adapter contract that exposes live send/write flags", () => {
    const contract = productionDeliveryAdapterContracts[0]

    expect(() =>
      validateProductionDeliveryAdapterContract({
        ...contract,
        sendsEnabled: true,
      } as unknown as ProductionDeliveryAdapterContract)
    ).toThrow(/sendsEnabled must remain false/)
    expect(() =>
      validateProductionDeliveryAdapterContract({
        ...contract,
        writesEnabled: true,
      } as unknown as ProductionDeliveryAdapterContract)
    ).toThrow(/writesEnabled must remain false/)
  })
})
