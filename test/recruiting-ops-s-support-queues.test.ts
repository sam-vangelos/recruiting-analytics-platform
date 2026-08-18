import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  normalizeGreenhouseClarificationRows,
  normalizeRecruitingInboxRows,
  normalizeSupportStatus,
  runSupportQueueModule,
  supportQueueConfigs,
  type GreenhouseClarificationFact,
  type RecruitingInboxTriageFact,
} from "../lib/recruiting-ops/modules/s-support-queues"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-s-support-"))
  roots.push(root)
  return root
}

const clarificationFacts: GreenhouseClarificationFact[] = [
  {
    caseId: "gh_case_1",
    topic: "Offer approval boundary",
    status: "ready",
    owner: "Jordan",
    evidenceIds: ["legacy_s03_greenhouse_clarification_log"],
    decisionRequired: true,
  },
]

const inboxFacts: RecruitingInboxTriageFact[] = [
  {
    itemId: "inbox_item_1",
    category: "candidate_reply",
    status: "drafted",
    owner: "Jordan",
    evidenceIds: ["legacy_s04_recruiting_inbox_runbook"],
    draftResponse: "Thanks for the note. the operator will review and respond through the approved inbox flow.",
    humanSendRequired: true,
  },
]

describe("S03/S04 support queue modules", () => {
  test("declares local support configs for Greenhouse clarifications and recruiting inbox", () => {
    expect(Object.keys(supportQueueConfigs).sort()).toEqual(["S03", "S04"])
    expect(supportQueueConfigs.S03.definition).toMatchObject({
      moduleId: "s03-greenhouse-clarification-log",
      workflowId: "S03",
      outputContractIds: ["greenhouse_clarification_log"],
    })
    expect(supportQueueConfigs.S04.definition).toMatchObject({
      moduleId: "s04-recruiting-inbox-queue",
      workflowId: "S04",
      sourceIds: ["gmail"],
    })
  })

  test("normalizes Greenhouse clarification facts into local support rows", () => {
    expect(normalizeGreenhouseClarificationRows(clarificationFacts)).toEqual([
      {
        item_id: "gh_case_1",
        workflow_id: "S03",
        source_system: "greenhouse",
        category: "Offer approval boundary",
        status: "ready",
        owner: "Jordan",
        evidence_count: 1,
        draft_response: "",
        human_action_required: true,
        review_required: true,
        next_gate: "Request human owner review.",
      },
    ])
  })

  test("normalizes recruiting inbox facts into human-send draft rows", () => {
    expect(normalizeRecruitingInboxRows(inboxFacts)).toEqual([
      {
        item_id: "inbox_item_1",
        workflow_id: "S04",
        source_system: "gmail",
        category: "candidate_reply",
        status: "ready",
        owner: "Jordan",
        evidence_count: 1,
        draft_response: "Thanks for the note. the operator will review and respond through the approved inbox flow.",
        human_action_required: true,
        review_required: true,
        next_gate: "Request human owner review.",
      },
    ])
    expect(normalizeSupportStatus("closed")).toBe("accepted")
  })

  test("runs S03 and S04 locally and writes support JSON/CSV artifacts", async () => {
    const s03 = await runSupportQueueModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T06:00:00.000Z",
      generatedAt: "2026-06-25T06:01:00.000Z",
      workflowId: "S03",
      clarificationFacts,
    })
    const s04 = await runSupportQueueModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T06:02:00.000Z",
      generatedAt: "2026-06-25T06:03:00.000Z",
      workflowId: "S04",
      inboxFacts,
    })

    expect(s03.normalizedRows).toHaveLength(1)
    expect(s04.normalizedRows).toHaveLength(1)
    expect(s04.normalizedRows[0].human_action_required).toBe(true)
    expect(s03.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(s04.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Item ID,Workflow ID,Source system,Category,Status,Owner,Evidence count,Draft response,Human action required,Review required,Next gate"
    )
  })

  test("classifies legacy support status differences", async () => {
    const result = await runSupportQueueModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T06:04:00.000Z",
      generatedAt: "2026-06-25T06:05:00.000Z",
      workflowId: "S03",
      clarificationFacts,
      legacyRows: [
        {
          item_id: "gh_case_1",
          status: "accepted",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class)).toEqual(["business_definition_open"])
  })

  test("blocks support queues when evidence, owner, status, or inbox draft is missing", async () => {
    const s03 = await runSupportQueueModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T06:06:00.000Z",
      generatedAt: "2026-06-25T06:07:00.000Z",
      workflowId: "S03",
      clarificationFacts: [
        {
          ...clarificationFacts[0],
          owner: "",
          evidenceIds: [],
          status: "blocked",
        },
      ],
    })
    const s04 = await runSupportQueueModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T06:08:00.000Z",
      generatedAt: "2026-06-25T06:09:00.000Z",
      workflowId: "S04",
      inboxFacts: [
        {
          ...inboxFacts[0],
          draftResponse: "",
          evidenceIds: [],
        },
      ],
    })

    expect(s03.run.status).toBe("blocked")
    expect(s03.sourceGaps.map((gap) => gap.field).sort()).toEqual(["evidence_count", "owner", "status"])
    expect(s04.run.status).toBe("blocked")
    expect(s04.sourceGaps.map((gap) => gap.field).sort()).toEqual(["draft_response", "evidence_count"])
  })
})
