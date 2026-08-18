import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  n8nWorkflowSetupModuleDefinition,
  normalizeCustodyStatus,
  normalizeN8nCustodyPacketRows,
  runN8nWorkflowSetupModule,
  type MailgunCustodyFact,
  type N8nDryRunEventFact,
  type N8nWorkflowSetupFact,
} from "../lib/recruiting-ops/modules/t16-n8n-workflow-setup"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-t16-"))
  roots.push(root)
  return root
}

const workflowFacts: N8nWorkflowSetupFact[] = [
  {
    workflowId: "duplicate_candidate_n8n",
    workflowName: "Duplicate Candidate Check",
    exportStatus: "exported",
    activeState: "disabled_safe",
    owner: "Jordan",
    exportedAt: "2026-06-25T01:00:00.000Z",
  },
]

const mailgunFacts: MailgunCustodyFact[] = [
  {
    credentialId: "mailgun_primary_domain",
    sendingDomain: "mg.example.invalid",
    custodyStatus: "owner_confirmed",
    owner: "Jordan",
    observedAt: "2026-06-25T01:05:00.000Z",
  },
]

const dryRunEvents: N8nDryRunEventFact[] = [
  {
    eventId: "dry_run_1",
    workflowId: "duplicate_candidate_n8n",
    eventStatus: "passed",
    observedAt: "2026-06-25T01:10:00.000Z",
    sampleOutputCaptured: true,
    owner: "Jordan",
  },
]

describe("T16 n8n workflow setup module", () => {
  test("declares the expected workflow, artifact, and output contracts", () => {
    expect(n8nWorkflowSetupModuleDefinition).toEqual({
      moduleId: "t16-n8n-workflow-setup",
      workflowId: "T16",
      capabilityId: "automation_custody",
      title: "T16 n8n Workflow Setup",
      sourceIds: ["n8n", "mailgun"],
      queryIds: [],
      legacyArtifactIds: ["legacy_n8n_mailgun_custody_packet"],
      outputContractIds: ["n8n_custody_packet"],
    })
  })

  test("normalizes workflow, Mailgun, and dry-run custody facts", () => {
    expect(
      normalizeN8nCustodyPacketRows({
        workflowFacts,
        mailgunFacts,
        dryRunEvents,
      })
    ).toEqual([
      {
        row_type: "dry_run_event",
        entity_id: "dry_run_1",
        workflow_id: "duplicate_candidate_n8n",
        status: "captured",
        owner: "Jordan",
        observed_at: "2026-06-25T01:10:00.000Z",
        dry_run_status: "passed",
        evidence_captured: true,
        review_required: false,
        blocker_reason: "",
      },
      {
        row_type: "mailgun_custody",
        entity_id: "mailgun_primary_domain",
        workflow_id: "",
        status: "captured",
        owner: "Jordan",
        observed_at: "2026-06-25T01:05:00.000Z",
        dry_run_status: "not_run",
        evidence_captured: true,
        review_required: false,
        blocker_reason: "",
      },
      {
        row_type: "workflow_export",
        entity_id: "duplicate_candidate_n8n",
        workflow_id: "duplicate_candidate_n8n",
        status: "captured",
        owner: "Jordan",
        observed_at: "2026-06-25T01:00:00.000Z",
        dry_run_status: "not_run",
        evidence_captured: true,
        review_required: false,
        blocker_reason: "",
      },
    ])
  })

  test("normalizes common custody status labels", () => {
    expect(normalizeCustodyStatus("owner confirmed")).toBe("captured")
    expect(normalizeCustodyStatus("needs export")).toBe("export_required")
    expect(normalizeCustodyStatus("rotate")).toBe("rotation_required")
    expect(normalizeCustodyStatus("something else")).toBe("unknown")
  })

  test("runs locally and writes n8n custody JSON/CSV artifacts", async () => {
    const result = await runN8nWorkflowSetupModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T01:20:00.000Z",
      generatedAt: "2026-06-25T01:21:00.000Z",
      workflowFacts,
      mailgunFacts,
      dryRunEvents,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.normalizedRows).toHaveLength(3)
    expect(result.discrepancies).toHaveLength(0)
    expect(result.artifacts.map((artifact) => artifact.format).sort()).toEqual(["csv", "json"])
    expect(readFileSync(result.artifacts.find((artifact) => artifact.format === "csv")!.path, "utf8")).toContain(
      "Row type,Entity ID,Workflow ID,Status,Owner,Observed at,Dry-run status,Evidence captured,Review required,Blocker reason"
    )
  })

  test("classifies legacy custody status differences", async () => {
    const result = await runN8nWorkflowSetupModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T01:22:00.000Z",
      generatedAt: "2026-06-25T01:23:00.000Z",
      workflowFacts,
      mailgunFacts,
      dryRunEvents,
      legacyRows: [
        {
          entity_id: "duplicate_candidate_n8n",
          status: "export_required",
        },
        {
          entity_id: "dry_run_1",
          dry_run_status: "failed",
        },
      ],
    })

    expect(result.discrepancies.map((discrepancy) => discrepancy.class).sort()).toEqual([
      "business_definition_open",
      "stale_mapping",
    ])
  })

  test("blocks cutover when export, Mailgun custody, or dry-run evidence is missing", async () => {
    const result = await runN8nWorkflowSetupModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T01:24:00.000Z",
      generatedAt: "2026-06-25T01:25:00.000Z",
      workflowFacts: [],
      mailgunFacts: [],
      dryRunEvents: [
        {
          ...dryRunEvents[0],
          sampleOutputCaptured: false,
        },
      ],
    })

    expect(result.run.status).toBe("blocked")
    expect(result.run.discrepancySummary.byClass.source_gap).toBe(3)
    expect(result.sourceGaps.every((gap) => gap.blocksCutover)).toBe(true)
  })

  test("blocks preserve/export when a Mailgun credential needs rotation", async () => {
    const result = await runN8nWorkflowSetupModule({
      rootDir: tempRoot(),
      startedAt: "2026-06-25T01:30:00.000Z",
      generatedAt: "2026-06-25T01:31:00.000Z",
      workflowFacts,
      mailgunFacts: [{ ...mailgunFacts[0], custodyStatus: "rotate" }],
      dryRunEvents,
    })

    expect(result.run.status).toBe("blocked")
    expect(
      result.sourceGaps.some((gap) => gap.field === "credential_rotation" && gap.blocksCutover)
    ).toBe(true)
  })
})
