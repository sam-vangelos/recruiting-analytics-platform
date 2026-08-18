import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  buildDraftBody,
  normalizeRecruiterLeadSlackDraftRows,
  recruiterLeadSlackUpdatesModuleDefinition,
  runRecruiterLeadSlackUpdatesModule,
  type RecruiterLeadUpdateFact,
} from "../lib/recruiting-ops/modules/t18-recruiter-lead-slack-updates"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t18-"))
  roots.push(root)
  return root
}

const updateFacts: RecruiterLeadUpdateFact[] = [
  {
    leadId: "lead_1",
    leadName: "Ari",
    reqGroup: "FDL Brazil",
    weekBucket: "2026-W26",
    movementCount: 12,
    stalledCount: 2,
    offerCount: 1,
    targetChannelLabel: "recruiter_leads",
    sourceWorkflowIds: ["T02", "T03"],
  },
]

describe("T18 recruiter lead Slack updates module", () => {
  test("declares the expected workflow, artifact, and output contracts", () => {
    expect(recruiterLeadSlackUpdatesModuleDefinition).toEqual({
      moduleId: "t18-recruiter-lead-slack-updates",
      workflowId: "T18",
      capabilityId: "stakeholder_narrative_generation",
      title: "T18 Recruiter Lead Slack Updates",
      sourceIds: ["slack", "google_sheets"],
      queryIds: [],
      legacyArtifactIds: ["legacy_recruiter_lead_slack_update_pattern"],
      outputContractIds: ["recruiter_lead_slack_draft"],
    })
  })

  test("normalizes facts into human-send Slack draft rows", () => {
    expect(normalizeRecruiterLeadSlackDraftRows({ updateFacts })).toEqual([
      {
        lead_id: "lead_1",
        lead_name: "Ari",
        target_channel_label: "recruiter_leads",
        req_group: "FDL Brazil",
        week_bucket: "2026-W26",
        movement_count: 12,
        stalled_count: 2,
        offer_count: 1,
        draft_body:
          "Ari: FDL Brazil update for 2026-W26. 12 stage movements, 2 stalled items, 1 offers. Please review before sending. Source: T02, T03.",
        source_workflow_ids: "T02|T03",
        human_send_required: true,
        review_required: false,
      },
    ])
  })

  test("builds deterministic review-gated draft bodies", () => {
    expect(buildDraftBody(updateFacts[0])).toBe(
      "Ari: FDL Brazil update for 2026-W26. 12 stage movements, 2 stalled items, 1 offers. Please review before sending. Source: T02, T03."
    )
  })

  test("runs locally and writes Slack draft JSON/CSV artifacts", async () => {
    const result = await runRecruiterLeadSlackUpdatesModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T03:00:00.000Z",
      generatedAt: "2026-06-25T03:01:00.000Z",
      updateFacts,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(1)
    expect(result.normalizedRows[0].human_send_required).toBe(true)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Lead ID,Lead name,Target channel label,Req group,Week,Movement count,Stalled count,Offer count,Draft body,Source workflows,Human send required,Review required"
    )
  })

  test("classifies legacy Slack update metric differences", async () => {
    const result = await runRecruiterLeadSlackUpdatesModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T03:02:00.000Z",
      generatedAt: "2026-06-25T03:03:00.000Z",
      updateFacts,
      legacyRows: [
        {
          lead_id: "lead_1",
          movement_count: 8,
          stalled_count: 3,
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class)).toEqual([
      "business_definition_open",
      "business_definition_open",
    ])
  })

  test("blocks cutover when source lineage or metric evidence is invalid", async () => {
    const result = await runRecruiterLeadSlackUpdatesModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T03:04:00.000Z",
      generatedAt: "2026-06-25T03:05:00.000Z",
      updateFacts: [
        {
          ...updateFacts[0],
          leadName: "",
          movementCount: -1,
          sourceWorkflowIds: [],
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.sourceGaps.map((gap) => gap.field).sort()).toEqual(["lead_name", "metrics", "source_workflow_ids"])
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(3)
  })
})
