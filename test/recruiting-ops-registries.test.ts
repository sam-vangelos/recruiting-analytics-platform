import { describe, expect, test } from "vitest"

import {
  getOutputContract,
  getQuery,
  getSource,
  getWorkflow,
  outputContractRegistry,
  queryRegistry,
  requiredQueryIds,
  requiredWorkflowIds,
  scriptAssetRegistry,
  sourceRegistry,
  validateP0Registries,
  workflowRegistry,
} from "../lib/recruiting-ops/registries"

function ids(rows: readonly { id: string }[]): string[] {
  return rows.map((row) => row.id).sort()
}

function expectUnique(rows: readonly { id: string }[]) {
  expect(new Set(ids(rows)).size).toBe(rows.length)
}

describe("recruiting ops P0 registries", () => {
  test("validateP0Registries returns counts for every registry", () => {
    expect(validateP0Registries()).toEqual({
      ok: true,
      counts: {
        sources: sourceRegistry.length,
        workflows: workflowRegistry.length,
        queries: queryRegistry.length,
        scriptAssets: scriptAssetRegistry.length,
        outputContracts: outputContractRegistry.length,
      },
    })
  })

  test("covers required workflow IDs without duplicate registry IDs", () => {
    expect(ids(workflowRegistry)).toEqual([...requiredWorkflowIds].sort())
    expectUnique(sourceRegistry)
    expectUnique(workflowRegistry)
    expectUnique(queryRegistry)
    expectUnique(scriptAssetRegistry)
    expectUnique(outputContractRegistry)
  })

  test("covers Q01-Q15 as legacy evidence and not canonical truth", () => {
    expect(ids(queryRegistry)).toEqual([...requiredQueryIds].sort())
    for (const query of queryRegistry) {
      expect(query.legacyEvidence).toBe(true)
      expect(query.canonicalTruth).toBe(false)
      expect(query.freeFormSqlAllowed).toBe(false)
      expect(query.defaultAdapter).not.toBe("looker_api")
      expect(query.currentRole).toMatch(/Legacy semantic artifact/)
    }
  })

  test("every row carries provenance, blockers, and a next gate", () => {
    const rows = [
      ...sourceRegistry,
      ...workflowRegistry,
      ...queryRegistry,
      ...scriptAssetRegistry,
      ...outputContractRegistry,
    ]
    for (const row of rows) {
      expect(row.provenance.length, row.id).toBeGreaterThan(0)
      expect(row.blockers.length, row.id).toBeGreaterThan(0)
      expect(row.nextGate.trim(), row.id).not.toBe("")
    }
  })

  test("P0 posture excludes warehouse-first, free-form SQL, and production writes", () => {
    for (const source of sourceRegistry) {
      expect(source.adapters).not.toContain("warehouse_read")
    }
    for (const query of queryRegistry) {
      expect(query.freeFormSqlAllowed).toBe(false)
      expect(query.canonicalTruth).toBe(false)
    }
    for (const output of outputContractRegistry) {
      expect(output.productionWriteEnabled).toBe(false)
    }
  })

  test("lookups return exact rows and throw for unknown ids", () => {
    expect(getWorkflow("T07")).toBe(workflowRegistry.find((row) => row.id === "T07"))
    expect(getQuery("Q12")).toBe(queryRegistry.find((row) => row.id === "Q12"))
    expect(getSource("greenhouse")).toBe(sourceRegistry.find((row) => row.id === "greenhouse"))
    expect(getOutputContract("final_offer_sheet")).toBe(
      outputContractRegistry.find((row) => row.id === "final_offer_sheet")
    )

    expect(() => getWorkflow("T11")).toThrow("Unknown workflow: T11")
    expect(() => getQuery("Q99")).toThrow("Unknown query: Q99")
    expect(() => getSource("warehouse_read")).toThrow("Unknown source: warehouse_read")
    expect(() => getOutputContract("production_sheet_writer")).toThrow(
      "Unknown output contract: production_sheet_writer"
    )
  })

  test("script assets make custody/export blockers explicit", () => {
    expect(scriptAssetRegistry.length).toBeGreaterThan(0)
    for (const asset of scriptAssetRegistry) {
      expect(["export_required", "custody_required", "reference_only"]).toContain(asset.exportStatus)
      expect(asset.blockers.join(" ")).toMatch(/Source export|credential|trigger|secret/i)
    }
  })
})
