import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  adminActionQueueConfigs,
  buildAdminActionProposals,
  runAdminActionQueueModule,
  type AdminActionRequestFact,
  type AdminActionWorkflowId,
} from "../lib/recruiting-ops/modules/s-admin-action-queues"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-s-admin-"))
  roots.push(root)
  return root
}

const baseRequest = {
  actor: "Jordan",
  reason: "command-center dry-run proposal with human approval boundary",
  riskTier: "high",
  approvalState: "needs_review",
  evidenceRefs: ["legacy_s01_requisition_action_runbook"],
  createdAt: "2026-06-25T05:00:00.000Z",
} as const

const requests: Record<AdminActionWorkflowId, AdminActionRequestFact> = {
  S01: {
    ...baseRequest,
    workflowId: "S01",
    targetSystem: "greenhouse",
    targetReference: "req_123",
    actionType: "requisition_update",
    proposedPayload: { requisitionId: "req_123", proposedOwner: "Jordan" },
  },
  S02: {
    ...baseRequest,
    workflowId: "S02",
    targetSystem: "greenhouse",
    targetReference: "offer_123",
    actionType: "offer_approval_review",
    riskTier: "never",
    proposedPayload: { offerId: "offer_123", reviewOnly: true },
  },
  S05: {
    ...baseRequest,
    workflowId: "S05",
    targetSystem: "greenhouse",
    targetReference: "gh_user_123",
    actionType: "greenhouse_user_update",
    proposedPayload: { greenhouseUserId: "gh_user_123", proposedRole: "recruiter" },
  },
  S06: {
    ...baseRequest,
    workflowId: "S06",
    targetSystem: "linkedin",
    targetReference: "linkedin_seat_123",
    actionType: "linkedin_user_checklist",
    proposedPayload: { seatId: "linkedin_seat_123", checklistOnly: true },
  },
  S07: {
    ...baseRequest,
    workflowId: "S07",
    targetSystem: "google_admin",
    targetReference: "ta_group_123",
    actionType: "google_group_membership_update",
    proposedPayload: { groupId: "ta_group_123", memberCountDelta: 1 },
  },
}

describe("S admin action queue modules", () => {
  test("declares dry-run configs for S01, S02, S05, S06, and S07", () => {
    expect(Object.keys(adminActionQueueConfigs).sort()).toEqual(["S01", "S02", "S05", "S06", "S07"])
    expect(adminActionQueueConfigs.S01.definition).toMatchObject({
      moduleId: "s01-requisition-action-queue",
      workflowId: "S01",
      outputContractIds: ["requisition_action_queue"],
    })
    expect(adminActionQueueConfigs.S07.definition).toMatchObject({
      moduleId: "s07-google-groups-action-queue",
      workflowId: "S07",
      sourceIds: ["google_admin"],
    })
  })

  test("builds dry-run action proposals without live execution", () => {
    const proposals = buildAdminActionProposals([requests.S01], "requisition_lifecycle_control")
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({
      workflowId: "S01",
      targetSystem: "greenhouse",
      actionType: "requisition_update",
      noLiveExecution: true,
    })
  })

  test("runs each admin workflow locally and writes proposal JSON/CSV artifacts", async () => {
    for (const workflowId of Object.keys(requests) as AdminActionWorkflowId[]) {
      const result = await runAdminActionQueueModule({
        rootDir: tempRoot(),
        startedAt: "2026-06-25T05:10:00.000Z",
        generatedAt: "2026-06-25T05:11:00.000Z",
        workflowId,
        actionRequests: [requests[workflowId]],
      })

      expect(result.definition.workflowId).toBe(workflowId)
      expect(result.normalizedRows).toHaveLength(1)
      expect(result.normalizedRows[0].no_live_execution).toBe(true)
      expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
      expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
        "Proposal ID,Workflow ID,Target system,Target reference,Action type,Risk tier,Approval state,Evidence count,Payload fingerprint,Defer until,Defer reason,Manual execution attested at,Manual execution attested by,External reference,No live execution,Review required"
      )
    }
  })

  test("blocks never-tier and missing-evidence admin proposals", async () => {
    const neverTier = await runAdminActionQueueModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T05:12:00.000Z",
      generatedAt: "2026-06-25T05:13:00.000Z",
      workflowId: "S02",
      actionRequests: [requests.S02],
    })
    const missingEvidence = await runAdminActionQueueModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T05:14:00.000Z",
      generatedAt: "2026-06-25T05:15:00.000Z",
      workflowId: "S01",
      actionRequests: [
        {
          ...requests.S01,
          evidenceRefs: [],
        },
      ],
    })

    expect(neverTier.run.status).toBe("blocked")
    expect(neverTier.sourceGaps.some((gap) => gap.field === "riskTier")).toBe(true)
    expect(missingEvidence.run.status).toBe("blocked")
    expect(missingEvidence.sourceGaps.some((gap) => gap.field === "evidenceRefs")).toBe(true)
  })

  test("blocks target-system mismatches and missing scoped requests", async () => {
    const mismatched = await runAdminActionQueueModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T05:16:00.000Z",
      generatedAt: "2026-06-25T05:17:00.000Z",
      workflowId: "S07",
      actionRequests: [
        {
          ...requests.S07,
          targetSystem: "greenhouse",
        },
      ],
    })
    const missing = await runAdminActionQueueModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T05:18:00.000Z",
      generatedAt: "2026-06-25T05:19:00.000Z",
      workflowId: "S05",
      actionRequests: [requests.S01],
    })

    expect(mismatched.run.status).toBe("blocked")
    expect(mismatched.sourceGaps.some((gap) => gap.field === "targetSystem")).toBe(true)
    expect(missing.run.status).toBe("blocked")
    expect(missing.sourceGaps).toEqual([
      expect.objectContaining({
        field: "actionRequests",
        blocksCutover: true,
      }),
    ])
  })
})
