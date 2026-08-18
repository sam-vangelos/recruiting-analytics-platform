import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  normalizeCoordinationStatus,
  normalizePaymentStatus,
  normalizePowerBiRlsCoordinationRows,
  powerBiRlsVendorCoordinationModuleDefinition,
  runPowerBiRlsVendorCoordinationModule,
  type VendorCoordinationFact,
  type PowerBiRlsAccessFact,
} from "../lib/recruiting-ops/modules/t14-power-bi-rls-coordination"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t14-"))
  roots.push(root)
  return root
}

const rlsAccessFacts: PowerBiRlsAccessFact[] = [
  {
    accessId: "rls_1",
    workspaceName: "TA Ops",
    dashboardId: "pbi_1",
    accessScope: "Recruiting leadership",
    status: "confirmed",
    owner: "Owner One",
  },
]

const vendorFacts: VendorCoordinationFact[] = [
  {
    coordinationId: "vendor_payment",
    vendorName: "the BI vendor",
    topic: "Payment and RLS context",
    status: "pending",
    owner: "Jordan",
    paymentStatus: "open",
  },
]

describe("T14 Power BI RLS / the BI vendor coordination module", () => {
  test("declares the expected workflow, artifact, and output contracts", () => {
    expect(powerBiRlsVendorCoordinationModuleDefinition).toEqual({
      moduleId: "t14-power-bi-rls-coordination",
      workflowId: "T14",
      capabilityId: "external_artifact_monitoring",
      title: "T14 Power BI RLS / the BI vendor Coordination",
      sourceIds: ["power_bi", "google_sheets", "vendor"],
      queryIds: [],
      legacyArtifactIds: ["legacy_power_bi_rls_vendor_packet"],
      outputContractIds: ["power_bi_rls_matrix"],
    })
  })

  test("normalizes RLS access and vendor coordination rows", () => {
    expect(normalizeCoordinationStatus("done")).toBe("confirmed")
    expect(normalizeCoordinationStatus("waiting")).toBe("pending")
    expect(normalizeCoordinationStatus("stuck")).toBe("blocked")
    expect(normalizeCoordinationStatus("custom")).toBe("unknown")
    expect(normalizePaymentStatus("unpaid")).toBe("open")
    expect(normalizePaymentStatus("assigned")).toBe("owned")

    expect(
      normalizePowerBiRlsCoordinationRows({
        rlsAccessFacts,
        vendorFacts,
      })
    ).toEqual([
      {
        row_type: "rls_access",
        entity_id: "rls_1",
        status: "confirmed",
        owner: "Owner One",
        workspace_name: "TA Ops",
        dashboard_id: "pbi_1",
        access_scope: "Recruiting leadership",
        vendor_name: "",
        coordination_topic: "",
        payment_status: "not_applicable",
        review_required: false,
      },
      {
        row_type: "vendor_coordination",
        entity_id: "vendor_payment",
        status: "pending",
        owner: "Jordan",
        workspace_name: "",
        dashboard_id: "",
        access_scope: "",
        vendor_name: "the BI vendor",
        coordination_topic: "Payment and RLS context",
        payment_status: "open",
        review_required: true,
      },
    ])
  })

  test("runs locally and writes RLS/vendor coordination artifacts", async () => {
    const result = await runPowerBiRlsVendorCoordinationModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:28:00.000Z",
      generatedAt: "2026-06-25T00:29:00.000Z",
      rlsAccessFacts,
      vendorFacts,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(2)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Row type,Entity ID,Status,Owner,Workspace,Dashboard ID,Access scope,Vendor,Coordination topic,Payment status,Review required"
    )
  })

  test("classifies legacy RLS/the BI vendor coordination differences", async () => {
    const result = await runPowerBiRlsVendorCoordinationModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:30:00.000Z",
      generatedAt: "2026-06-25T00:31:00.000Z",
      rlsAccessFacts,
      vendorFacts,
      legacyRows: [
        {
          entity_id: "vendor_payment",
          status: "confirmed",
          review_required: false,
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "stale_mapping",
    ])
  })

  test("blocks cutover when RLS matrix or vendor evidence is missing", async () => {
    const result = await runPowerBiRlsVendorCoordinationModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T00:32:00.000Z",
      generatedAt: "2026-06-25T00:33:00.000Z",
      rlsAccessFacts: [],
      vendorFacts: [],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.sourceGaps.map((gap) => gap.field).sort()).toEqual(["rlsAccessFacts", "vendorFacts"])
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(2)
  })
})
