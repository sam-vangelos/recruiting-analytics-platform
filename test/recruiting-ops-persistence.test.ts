import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

import { buildActionProposal } from "../lib/recruiting-ops/action-proposals"
import { buildDiscrepancy } from "../lib/recruiting-ops/discrepancies"
import {
  actionProposalPersistenceRow,
  discrepancyPersistenceRows,
  legacyArtifactPersistenceRows,
  outputContractPersistenceRows,
  runArtifactPersistenceRows,
  runEvidenceRefPersistenceRows,
  runPersistenceRow,
  sourceGapPersistenceRows,
  workflowRegistryPersistenceRows,
} from "../lib/recruiting-ops/persistence"
import { buildCommandCenterRun } from "../lib/recruiting-ops/runs"

const migrationFiles = [
  "015_recruiting_ops_command_center.sql",
  "016_recruiting_ops_capability_provenance.sql",
  "017_recruiting_ops_pre_integration_contract_parity.sql",
]
const migration = migrationFiles
  .map((file) => readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8"))
  .join("\n")
const actionProposalApprovalStates = [
  "drafted",
  "needs_review",
  "approved_for_manual_execution",
  "rejected",
  "deferred",
  "blocked",
  "executed_manually",
] as const

describe("recruiting ops persistence substrate", () => {
  test("migration creates the command-center registry and ledger tables", () => {
    for (const table of [
      "recruiting_ops_workflow_registry",
      "recruiting_ops_legacy_artifacts",
      "recruiting_ops_output_contracts",
      "recruiting_ops_runs",
      "recruiting_ops_run_evidence_refs",
      "recruiting_ops_run_artifacts",
      "recruiting_ops_source_gaps",
      "recruiting_ops_discrepancy_classes",
      "recruiting_ops_discrepancies",
      "recruiting_ops_action_proposals",
    ]) {
      expect(migration).toContain(`create table if not exists ${table}`)
    }
  })

  test("migration preserves non-production boundaries", () => {
    expect(migration).toContain("production_write_enabled boolean not null default false")
    expect(migration).toContain("check (production_write_enabled = false)")
    expect(migration).toContain("no_live_execution boolean not null default true")
    expect(migration).toContain("check (no_live_execution = true)")
    expect(migration).not.toMatch(/candidate_payload|raw_candidate|greenhouse_write/i)
  })

  test("migration DDL covers TypeScript output-contract and action-proposal row contracts", () => {
    const outputRow = outputContractPersistenceRows().find((row) => row.source_contract_id === "google_groups_action_queue")
    expect(outputRow).toBeDefined()
    for (const column of [
      "capability_id",
      "lane",
      "initial_autonomy_state",
      "freshness_ttl_minutes",
      "stale_behavior",
      "recipient_scope_rule_ids",
      "delivery_log_required",
      "delivery_authorization_required",
    ] satisfies readonly (keyof NonNullable<typeof outputRow>)[]) {
      expect(migration).toMatch(new RegExp(`\\b${column}\\b`))
    }

    const proposal = buildActionProposal({
      workflowId: "S01",
      capabilityId: "requisition_lifecycle_control",
      targetSystem: "greenhouse",
      targetReference: "req_123",
      actionType: "requisition_update",
      actor: "Jordan",
      reason: "dry-run DDL parity test",
      riskTier: "medium",
      approvalState: "executed_manually",
      evidenceRefs: ["legacy_s01_requisition_action_runbook"],
      proposedPayload: {
        requisitionId: "req_123",
      },
      createdAt: "2026-06-25T07:02:00.000Z",
      manualExecutionAttestedAt: "2026-06-25T07:30:00.000Z",
      manualExecutionAttestedBy: "Jordan",
      externalReference: "greenhouse:req_123",
    })
    const proposalRow = actionProposalPersistenceRow(proposal)
    for (const column of Object.keys(proposalRow)) {
      expect(migration).toMatch(new RegExp(`\\b${column}\\b`))
    }
    for (const state of actionProposalApprovalStates) {
      expect(migration).toContain(`'${state}'`)
    }
  })

  test("maps registries to persistence rows without changing IDs", () => {
    expect(workflowRegistryPersistenceRows().some((row) => row.id === "T20/T21")).toBe(true)
    expect(legacyArtifactPersistenceRows().some((row) => row.id === "legacy_handoff_readiness_tracker")).toBe(true)
    expect(
      outputContractPersistenceRows().find((row) => row.source_contract_id === "google_groups_action_queue")
    ).toMatchObject({
      capability_id: "access_and_identity_administration",
      lane: "action_proposal",
      initial_autonomy_state: "never_auto",
      delivery_log_required: true,
      delivery_authorization_required: true,
    })
  })

  test("maps run, evidence, artifact, source gap, and discrepancy rows", () => {
    const run = buildCommandCenterRun({
      workflowId: "T07",
      capabilityId: "offer_and_hire_lifecycle_intelligence",
      moduleId: "t07-final-offer",
      mode: "fixture",
      status: "blocked",
      startedAt: "2026-06-25T07:00:00.000Z",
      completedAt: "2026-06-25T07:01:00.000Z",
      sourceRefs: [
        {
          id: "legacy_q12_final_offer",
          sourceId: "looker_sql_runner",
          adapter: "legacy_artifact",
          label: "Q12 final offer evidence.",
          artifactId: "legacy_q12_final_offer",
        },
      ],
      legacyArtifactRefs: ["legacy_q12_final_offer"],
      normalizedRows: [{ application_id: "app_1" }],
      artifactRefs: [
        {
          artifactId: "artifact_1",
          runId: "t07_20260625070000000",
          workflowId: "T07",
          format: "json",
          path: "/tmp/artifact.json",
          rowCount: 1,
          checksum: "sha256:artifact",
          schemaVersion: "1.0.0",
          sourceRefs: ["legacy_q12_final_offer"],
          publicSummary: { workflowId: "T07" },
        },
      ],
      sourceGaps: [
        {
          id: "gap_t07_owner",
          workflowId: "T07",
          sourceId: "greenhouse",
          field: "owner",
          reason: "Owner missing.",
          blocksCutover: true,
        },
      ],
      discrepancies: [],
      publicSummary: { workflowId: "T07" },
    })
    const discrepancy = buildDiscrepancy({
      runId: run.runId,
      workflowId: "T07",
      capabilityId: "offer_and_hire_lifecycle_intelligence",
      class: "source_gap",
      severity: "blocking",
      entityKey: "source_gap:gap_t07_owner",
      field: "owner",
      modernValueSummary: "Owner missing.",
      legacyValueSummary: "Legacy sheet may contain owner.",
      evidenceRefs: ["legacy_q12_final_offer"],
      resolutionStatus: "open",
      owner: "Jordan",
    })

    expect(runPersistenceRow(run)).toMatchObject({
      run_id: run.runId,
      workflow_id: "T07",
      capability_id: "offer_and_hire_lifecycle_intelligence",
      normalized_row_count: 1,
    })
    expect(runEvidenceRefPersistenceRows(run)[0]).toMatchObject({
      run_id: run.runId,
      evidence_ref_id: "legacy_q12_final_offer",
    })
    // The run stamps its capability onto every nested artifact and source gap, so
    // persistence never sees an unattributed record.
    expect(runArtifactPersistenceRows(run)[0]).toMatchObject({
      artifact_id: "artifact_1",
      run_id: "t07_20260625070000000",
      capability_id: "offer_and_hire_lifecycle_intelligence",
    })
    expect(sourceGapPersistenceRows(run)[0]).toMatchObject({
      // Gap ids repeat across runs (deterministic per record/field), so the
      // persisted primary key is runId-scoped.
      id: "t07_20260625070000000__gap_t07_owner",
      blocks_cutover: true,
      capability_id: "offer_and_hire_lifecycle_intelligence",
    })
    expect(discrepancyPersistenceRows([discrepancy])[0]).toMatchObject({
      id: discrepancy.id,
      class: "source_gap",
      resolution_status: "open",
      capability_id: "offer_and_hire_lifecycle_intelligence",
    })
  })

  test("maps dry-run action proposals with redacted payload summaries only", () => {
    const proposal = buildActionProposal({
      workflowId: "S01",
      capabilityId: "requisition_lifecycle_control",
      targetSystem: "greenhouse",
      targetReference: "req_123",
      actionType: "requisition_update",
      actor: "Jordan",
      reason: "dry-run test",
      riskTier: "high",
      approvalState: "needs_review",
      evidenceRefs: ["legacy_s01_requisition_action_runbook"],
      proposedPayload: {
        requisitionId: "req_123",
        token: "must redact",
      },
      createdAt: "2026-06-25T07:02:00.000Z",
    })

    expect(actionProposalPersistenceRow(proposal)).toMatchObject({
      proposal_id: proposal.proposalId,
      capability_id: "requisition_lifecycle_control",
      no_live_execution: true,
      redacted_payload_summary: {
        requisitionId: "req_123",
        redacted_field_1: "[REDACTED]",
      },
    })

    const attestedProposal = buildActionProposal({
      workflowId: "S01",
      capabilityId: "requisition_lifecycle_control",
      targetSystem: "greenhouse",
      targetReference: "req_123",
      actionType: "requisition_update",
      actor: "Jordan",
      reason: "manual execution attestation test",
      riskTier: "high",
      approvalState: "executed_manually",
      evidenceRefs: ["legacy_s01_requisition_action_runbook"],
      proposedPayload: {
        requisitionId: "req_123",
      },
      createdAt: "2026-06-25T07:03:00.000Z",
      manualExecutionAttestedAt: "2026-06-25T07:30:00.000Z",
      manualExecutionAttestedBy: "Jordan",
      externalReference: "greenhouse:req_123",
    })

    expect(actionProposalPersistenceRow(attestedProposal)).toMatchObject({
      manual_execution_attested_at: "2026-06-25T07:30:00.000Z",
      manual_execution_attested_by: "Jordan",
      external_reference: "greenhouse:req_123",
      no_live_execution: true,
    })
  })
})
