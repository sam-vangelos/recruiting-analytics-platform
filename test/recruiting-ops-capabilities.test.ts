import { describe, expect, test } from "vitest"

import {
  capabilityForModule,
  capabilityRegistry,
  getCapability,
  requiredCapabilityIds,
  validateCapabilityRegistry,
  type CapabilityRegistryRow,
} from "../lib/recruiting-ops/capabilities"
import {
  outputContractRegistry,
  requiredWorkflowIds,
  workflowRegistry,
} from "../lib/recruiting-ops/registries"

function capabilityIds(rows: readonly CapabilityRegistryRow[]): string[] {
  return rows.map((row) => row.capabilityId).sort()
}

describe("recruiting ops capability registry", () => {
  test("validateCapabilityRegistry returns durable/transitional counts", () => {
    expect(validateCapabilityRegistry()).toEqual({
      ok: true,
      counts: {
        capabilities: capabilityRegistry.length,
        durable: capabilityRegistry.filter((row) => row.durability === "durable").length,
        transitional: capabilityRegistry.filter((row) => row.durability === "transitional").length,
      },
    })
  })

  test("registry exactly matches the required capability IDs without duplicates", () => {
    expect(capabilityIds(capabilityRegistry)).toEqual([...requiredCapabilityIds].sort())
    expect(new Set(capabilityIds(capabilityRegistry)).size).toBe(capabilityRegistry.length)
  })

  test("every capability declares a complete audience/deliverable contract", () => {
    for (const row of capabilityRegistry) {
      expect(row.outcome.trim(), row.capabilityId).not.toBe("")
      expect(row.automationBoundary.trim(), row.capabilityId).not.toBe("")
      expect(row.audiences.length, row.capabilityId).toBeGreaterThan(0)
      expect(row.consumptionPurposes.length, row.capabilityId).toBeGreaterThan(0)
      expect(row.deliverableIds.length, row.capabilityId).toBeGreaterThan(0)
      expect(row.humanGates.length, row.capabilityId).toBeGreaterThan(0)
      expect(row.evidenceRefs.length, row.capabilityId).toBeGreaterThan(0)
      expect(row.workflowIds.length, row.capabilityId).toBeGreaterThan(0)
      expect(row.moduleIds.length, row.capabilityId).toBeGreaterThan(0)
      for (const audience of row.audiences) {
        expect(audience.audience.trim(), row.capabilityId).not.toBe("")
        expect(audience.consumptionPurpose.trim(), row.capabilityId).not.toBe("")
        expect(audience.deliveryMechanism.trim(), row.capabilityId).not.toBe("")
        expect(audience.humanGate.trim(), row.capabilityId).not.toBe("")
        expect(audience.deliverableIds.length, row.capabilityId).toBeGreaterThan(0)
      }
    }
  })

  test("transitional capabilities declare a sunset state; durable ones do not", () => {
    for (const row of capabilityRegistry) {
      if (row.durability === "transitional") {
        expect(row.sunsetState, row.capabilityId).toBeTruthy()
      } else {
        expect(row.sunsetState, row.capabilityId).toBeUndefined()
      }
    }
  })

  test("every required workflow is covered by exactly one capability", () => {
    const owners = new Map<string, string>()
    for (const row of capabilityRegistry) {
      for (const workflowId of row.workflowIds) {
        expect(owners.has(workflowId), `${workflowId} mapped twice`).toBe(false)
        owners.set(workflowId, row.capabilityId)
      }
    }
    expect([...owners.keys()].sort()).toEqual([...requiredWorkflowIds].sort())
  })

  test("every mapped workflow and deliverable resolves to a known registry row", () => {
    const knownWorkflowIds = new Set(workflowRegistry.map((row) => row.id))
    const knownDeliverableIds = new Set(outputContractRegistry.map((row) => row.id))
    for (const row of capabilityRegistry) {
      for (const workflowId of row.workflowIds) {
        expect(knownWorkflowIds.has(workflowId), `${row.capabilityId} -> ${workflowId}`).toBe(true)
      }
      for (const deliverableId of row.deliverableIds) {
        expect(knownDeliverableIds.has(deliverableId), `${row.capabilityId} -> ${deliverableId}`).toBe(true)
      }
    }
  })

  test("module IDs are owned by exactly one capability and are resolvable", () => {
    const owners = new Map<string, string>()
    for (const row of capabilityRegistry) {
      for (const moduleId of row.moduleIds) {
        expect(owners.has(moduleId), `${moduleId} mapped twice`).toBe(false)
        owners.set(moduleId, row.capabilityId)
        expect(capabilityForModule(moduleId)?.capabilityId).toBe(row.capabilityId)
      }
    }
  })

  test("lookups return exact rows and throw for unknown ids", () => {
    expect(getCapability("scorecard_accountability")).toBe(
      capabilityRegistry.find((row) => row.capabilityId === "scorecard_accountability")
    )
    expect(() => getCapability("not_a_capability")).toThrow("Unknown capability: not_a_capability")
  })
})
