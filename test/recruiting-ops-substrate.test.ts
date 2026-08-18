import { describe, expect, test } from "vitest"

import {
  createPayloadFingerprint,
  createPseudonymousFingerprint,
  createStableChecksum,
  isSupportedFingerprint,
} from "../lib/recruiting-ops/checksums"
import { legacyArtifactRegistry, validateLegacyArtifactRegistry } from "../lib/recruiting-ops/legacy-artifact-registry"
import { validateLegacyArtifact } from "../lib/recruiting-ops/legacy-artifacts"
import {
  concreteOutputContracts,
  summarizeOutputReadinessAuthorization,
  validateConcreteOutputContract,
  validateConcreteOutputContracts,
} from "../lib/recruiting-ops/output-contracts"
import { registryCoverageSummary } from "../lib/recruiting-ops/substrate"
import { commandCenterWorkflowContracts, validateWorkflowContract } from "../lib/recruiting-ops/workflow-contracts"

describe("recruiting ops P1 substrate contracts", () => {
  test("materializes workflow contracts from the P0 workflow registry", () => {
    expect(commandCenterWorkflowContracts.length).toBeGreaterThan(20)
    expect(commandCenterWorkflowContracts.find((contract) => contract.id === "T07")).toMatchObject({
      title: "Final Offer Report",
      moduleReadiness: "not_started",
    })

    for (const contract of commandCenterWorkflowContracts) {
      expect(validateWorkflowContract(contract).ok).toBe(true)
    }
  })

  test("seeds implementation-ready legacy artifacts for the first vertical modules", () => {
    expect(validateLegacyArtifactRegistry()).toEqual({
      ok: true,
      count: legacyArtifactRegistry.length,
    })

    expect(legacyArtifactRegistry.map((artifact) => artifact.id).sort()).toEqual([
      "legacy_all_hires_apps_script",
      "legacy_apps_script_asset_registry",
      "legacy_duplicate_candidate_n8n_workflow",
      "legacy_elt_recruiting_update_doc",
      "legacy_handoff_readiness_tracker",
      "legacy_n8n_mailgun_custody_packet",
      "legacy_power_bi_dashboard_registry",
      "legacy_power_bi_rls_vendor_packet",
      "legacy_q01_q03_weekly_recruitment",
      "legacy_q04_q09_pipeline_family",
      "legacy_q10_pipeline_graph",
      "legacy_q11_rps_tracking",
      "legacy_q12_final_offer",
      "legacy_q13_q14_role_assignment",
      "legacy_q15_recruiter_daily_report",
      "legacy_rc_tracker_sheet",
      "legacy_recruiter_lead_slack_update_pattern",
      "legacy_s01_requisition_action_runbook",
      "legacy_s02_offer_action_runbook",
      "legacy_s03_greenhouse_clarification_log",
      "legacy_s04_recruiting_inbox_runbook",
      "legacy_s05_greenhouse_user_runbook",
      "legacy_s06_linkedin_user_runbook",
      "legacy_s07_google_groups_runbook",
      "legacy_validation_coordination_log",
    ])
  })

  test("seeds concrete local output contracts for target workflows", () => {
    expect(validateConcreteOutputContracts()).toEqual({
      ok: true,
      count: concreteOutputContracts.length,
    })

    for (const contract of concreteOutputContracts) {
      expect(contract.productionWriteEnabled).toBe(false)
      expect(contract.schemaVersion).toBe("1.0.0")
      expect(contract.columns.length).toBeGreaterThan(0)
      expect(contract.capabilityId).toMatch(/^[a-z_]+$/)
      expect(["auto_delivery", "review_assisted", "action_proposal"]).toContain(contract.lane)
      expect(contract.freshnessTtlMinutes).toBeGreaterThan(0)
      expect(contract.recipientScopeRuleIds.length).toBeGreaterThan(0)
      expect(contract.deliveryLogRequired).toBe(true)
      expect(contract.deliveryAuthorizationRequired).toBe(true)
    }
  })

  test("keeps output readiness separate from delivery authorization: Readiness != Delivery Authorization", () => {
    const actionProposalContract = concreteOutputContracts.find(
      (contract) => contract.sourceContractId === "offer_action_queue"
    )!

    expect(actionProposalContract.lane).toBe("action_proposal")
    expect(actionProposalContract.initialAutonomyState).toBe("never_auto")
    expect(summarizeOutputReadinessAuthorization(actionProposalContract, "ready_for_delivery")).toMatchObject({
      structurallyReady: true,
      deliveryAuthorizationRequired: true,
      deliveryAuthorized: false,
    })
  })

  test("stable checksums are insensitive to object key order", () => {
    expect(createStableChecksum({ b: 2, a: 1 })).toBe(createStableChecksum({ a: 1, b: 2 }))
  })

  test("separates raw SHA checksums from keyed local PII pseudonymous fingerprints", () => {
    expect(createPayloadFingerprint({ template: "weekly" })).toMatch(/^sha256:/)
    const first = createPseudonymousFingerprint("Avery Collins", {
      key: "local-test-key",
      context: "owner",
    })
    const second = createPseudonymousFingerprint("Avery Collins", {
      key: "local-test-key",
      context: "recipient",
    })

    expect(first).toMatch(/^hmac-sha256:/)
    expect(first).not.toBe(second)
    expect(isSupportedFingerprint(first)).toBe(true)
    expect(isSupportedFingerprint(createPayloadFingerprint({ template: "weekly" }))).toBe(true)
    expect(() =>
      createPseudonymousFingerprint("Avery Collins", {
        key: "",
        context: "owner",
      })
    ).toThrow("PII fingerprint key is required")
  })

  test("rejects unknown registry references and production write flags", () => {
    expect(() =>
      validateLegacyArtifact({
        ...legacyArtifactRegistry[0],
        workflowIds: ["T99"],
      })
    ).toThrow("Unknown workflow")

    expect(() =>
      validateConcreteOutputContract({
        ...concreteOutputContracts[0],
        productionWriteEnabled: true,
      } as never)
    ).toThrow("production writes disabled")

    expect(() =>
      validateConcreteOutputContract({
        ...concreteOutputContracts[0],
        freshnessTtlMinutes: 0,
      })
    ).toThrow("freshnessTtlMinutes must be a positive integer")

    expect(() =>
      validateConcreteOutputContract({
        ...concreteOutputContracts[0],
        staleBehavior: undefined,
      } as never)
    ).toThrow("staleBehavior is invalid")
  })

  test("reports P0 registry coverage counts for substrate consumers", () => {
    expect(registryCoverageSummary()).toMatchObject({
      sources: 13,
      workflows: 27,
      queries: 15,
      outputContracts: 27,
      scriptAssets: 5,
    })
  })
})
