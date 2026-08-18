import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

import {
  deliverableAutomationSeedMatrix,
  getDeliverableAutomationSeed,
  validateDeliverableAutomationSeedMatrix,
} from "../lib/recruiting-ops/automation-seed-matrix"
import { concreteOutputContracts } from "../lib/recruiting-ops/output-contracts"
import { outputContractRegistry } from "../lib/recruiting-ops/registries"

interface DocSeedRow {
  deliverableId: string
  capabilityId: string
  lane: string
  initialAutonomyState: string
  autoEligibility: string
  shadowRunRequirement: number
  blockedReason?: string
  neverAutoReason?: string
}

describe("recruiting ops automation deliverable seed matrix", () => {
  test("validates the source-controlled matrix contracts", () => {
    expect(validateDeliverableAutomationSeedMatrix()).toEqual({
      ok: true,
      count: deliverableAutomationSeedMatrix.length,
    })
  })

  test("covers every concrete output contract exactly once", () => {
    const matrixIds = deliverableAutomationSeedMatrix.map((row) => row.deliverableId).sort()
    const outputIds = outputContractRegistry.map((row) => row.id).sort()
    const concreteIds = concreteOutputContracts.map((row) => row.sourceContractId).sort()

    expect(matrixIds).toEqual(outputIds)
    expect(matrixIds).toEqual(concreteIds)
    expect(new Set(matrixIds).size).toBe(matrixIds.length)
  })

  test("keeps concrete output automation fields in sync with the seed matrix", () => {
    for (const contract of concreteOutputContracts) {
      const seed = getDeliverableAutomationSeed(contract.sourceContractId)
      expect(contract).toMatchObject({
        capabilityId: seed.capabilityId,
        lane: seed.lane,
        initialAutonomyState: seed.initialAutonomyState,
        freshnessTtlMinutes: seed.freshnessTtlMinutes,
        staleBehavior: seed.staleBehavior,
        recipientScopeRuleIds: seed.recipientScopeRuleIds,
        piiPolicy: seed.piiPolicy,
        deliveryLogRequired: true,
        deliveryAuthorizationRequired: true,
      })
    }
  })

  test("enforces auto-delivery candidate, blocked, and never-auto rationales", () => {
    for (const row of deliverableAutomationSeedMatrix) {
      if (row.autoEligibility === "candidate") {
        expect(row.lane, row.deliverableId).toBe("auto_delivery")
        expect(row.initialAutonomyState, row.deliverableId).toBe("shadow")
        expect(row.shadowRunRequirement, row.deliverableId).toBeGreaterThan(0)
      }
      if (row.autoEligibility === "blocked") {
        expect(row.blockedReason?.trim(), row.deliverableId).toBeTruthy()
      }
      if (row.autoEligibility === "never_auto") {
        expect(row.neverAutoReason?.trim(), row.deliverableId).toBeTruthy()
      }
      expect(row.eligibleAutonomyStates, row.deliverableId).toContain(row.initialAutonomyState)
    }
  })

  test("matches docs/recruiting-ops/AUTOMATION_DELIVERABLE_SEED_MATRIX.md", () => {
    const docsRows = parseDocSeedRows()
    const docsById = new Map(docsRows.map((row) => [row.deliverableId, row]))

    expect([...docsById.keys()].sort()).toEqual(deliverableAutomationSeedMatrix.map((row) => row.deliverableId).sort())
    for (const row of deliverableAutomationSeedMatrix) {
      const doc = docsById.get(row.deliverableId)
      expect(doc, row.deliverableId).toBeTruthy()
      expect(row).toMatchObject({
        capabilityId: doc!.capabilityId,
        lane: doc!.lane,
        initialAutonomyState: doc!.initialAutonomyState,
        autoEligibility: doc!.autoEligibility,
        shadowRunRequirement: doc!.shadowRunRequirement,
      })
      expect(normalizeOptional(row.blockedReason), row.deliverableId).toBe(normalizeOptional(doc!.blockedReason))
      expect(normalizeOptional(row.neverAutoReason), row.deliverableId).toBe(normalizeOptional(doc!.neverAutoReason))
    }
  })

  test("documents the doc/code authority model for fields not in the table", () => {
    const doc = readFileSync(
      join(process.cwd(), "docs/recruiting-ops/AUTOMATION_DELIVERABLE_SEED_MATRIX.md"),
      "utf8"
    )
    expect(doc).toMatch(/##\s+Authority Model/)
    expect(doc).toMatch(/code-authoritative/)
    for (const field of [
      "freshnessTtlMinutes",
      "staleBehavior",
      "recipientScopeRuleIds",
      "readinessStatesAllowed",
      "piiPolicy",
    ]) {
      expect(doc, field).toContain(field)
    }
  })
})

function parseDocSeedRows(): DocSeedRow[] {
  const doc = readFileSync(
    join(process.cwd(), "docs/recruiting-ops/AUTOMATION_DELIVERABLE_SEED_MATRIX.md"),
    "utf8"
  )
  return doc
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .filter((line) => line.split("|").slice(1, -1).length >= 8)
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
      return {
        deliverableId: unwrapCode(cells[0]),
        capabilityId: unwrapCode(cells[1]),
        lane: unwrapCode(cells[2]),
        initialAutonomyState: unwrapCode(cells[3]),
        autoEligibility: unwrapCode(cells[4]),
        shadowRunRequirement: Number(cells[5]),
        blockedReason: normalizeOptional(cells[6]),
        neverAutoReason: normalizeOptional(cells[7]),
      }
    })
}

function unwrapCode(value: string): string {
  return value.replace(/^`|`$/g, "")
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (!value || value === "N/A") return undefined
  return value
}
