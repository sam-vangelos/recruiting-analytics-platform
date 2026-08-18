import { describe, expect, test } from "vitest"

import { getRecruitingOpsConsoleData, getRecruitingOpsLaneConsoleData } from "../lib/recruiting-ops/console-data"
import { requiredWorkflowIds } from "../lib/recruiting-ops/registries"

describe("recruiting ops console data", () => {
  test("covers every required workflow with local-ready status", () => {
    const data = getRecruitingOpsConsoleData("2026-06-25T08:00:00.000Z")
    const ids = new Set(data.workflowRows.map((row) => row.id))

    for (const id of requiredWorkflowIds) expect(ids.has(id)).toBe(true)
    expect(data.counts.localReadyWorkflowCount).toBe(data.counts.requiredWorkflowCount)
    expect(data.workflowRows.every((row) => row.implementationStatus === "local_ready")).toBe(true)
  })

  test("reports non-production boundaries and persistence panels", () => {
    const data = getRecruitingOpsConsoleData("2026-06-25T08:00:00.000Z")

    expect(data.boundaries).toEqual({
      productionWritesEnabled: false,
      liveGreenhouseWritesEnabled: false,
      externalNetworkCallsEnabled: false,
      broadPiiPersistenceEnabled: false,
      uiMutationControlsEnabled: false,
      externalDeliveryAdapterApproved: false,
    })
    expect(data.counts.productionOutputWriteCount).toBe(0)
    expect(data.ledgerPanels.map((panel) => panel.tableName)).toEqual([
      "recruiting_ops_runs",
      "recruiting_ops_run_evidence_refs",
      "recruiting_ops_discrepancies",
      "recruiting_ops_action_proposals",
      "supabase_adapter",
    ])
  })

  test("labels the synthetic catalog as fixture provenance — an operator must never read it as observed runtime state", () => {
    const data = getRecruitingOpsConsoleData("2026-06-25T08:00:00.000Z")

    expect(data.automation.catalogProvenance.mode).toBe("fixture")
    expect(data.automation.catalogProvenance.detail).toMatch(/no real shadow run/i)
  })

  test("reports the read-only automation control-plane catalog snapshot", () => {
    const data = getRecruitingOpsConsoleData("2026-06-25T08:00:00.000Z")

    expect(data.automation.counts).toMatchObject({
      catalogRunCount: 3,
      catalogArtifactCount: 6,
      catalogDeliveryLogCount: 3,
      actionProposalCount: 1,
      autoDeliveryAuthorizedCount: 0,
      externalDeliveryAttemptCount: 0,
    })
    expect(data.automation.laneRows.map((row) => row.lane)).toEqual([
      "auto_delivery",
      "review_assisted",
      "action_proposal",
    ])
    expect(data.automation.laneRows.every((row) => row.externalAdapterApproved === false)).toBe(true)
    expect(data.automation.laneRows.find((row) => row.lane === "auto_delivery")).toMatchObject({
      actionProposalCount: 0,
    })
    expect(data.automation.laneRows.find((row) => row.lane === "action_proposal")).toMatchObject({
      actionProposalCount: 1,
    })
    expect(data.automation.gateFailures.map((gate) => gate.deliverableId)).toContain("rps_tracking_sheet")
    expect(JSON.stringify(data.automation.actionProposals)).not.toMatch(/@|candidate_email|phone|Avery Collins/i)
    expect(JSON.stringify(data)).not.toMatch(/avery@example\.com/i)
  })

  test("filters lane detail data without crossing delivery authorization boundaries", () => {
    const autoLane = getRecruitingOpsLaneConsoleData("auto_delivery", "2026-06-25T08:00:00.000Z")
    const actionLane = getRecruitingOpsLaneConsoleData("action_proposal", "2026-06-25T08:00:00.000Z")

    expect(autoLane.deliveryLogs.every((entry) => entry.lane === "auto_delivery")).toBe(true)
    expect(autoLane.runs).toHaveLength(3)
    expect(autoLane.gateFailures.map((gate) => gate.gateId)).toEqual(
      expect.arrayContaining(["source_gap", "recipient_scope"])
    )
    expect(actionLane.deliverables.every((deliverable) => deliverable.lane === "action_proposal")).toBe(true)
    expect(autoLane.actionProposals).toHaveLength(0)
    expect(actionLane.actionProposals).toHaveLength(1)
    expect(actionLane.actionProposals[0]).toMatchObject({
      actionType: "requisition_update",
      noLiveExecution: true,
    })
    expect(actionLane.boundaries).toMatchObject({
      productionWritesEnabled: false,
      externalDeliveryAdapterApproved: false,
      uiMutationControlsEnabled: false,
    })
  })
})
