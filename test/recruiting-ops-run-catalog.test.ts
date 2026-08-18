import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { buildActionProposal } from "../lib/recruiting-ops/action-proposals"
import { createLocalPiiFingerprint } from "../lib/recruiting-ops/checksums"
import { buildDiscrepancy } from "../lib/recruiting-ops/discrepancies"
import {
  buildLocalRunCatalog,
  filterCatalogActionProposals,
  filterCatalogGateResults,
  filterCatalogRuns,
  getCatalogRunLineage,
  readLocalRunCatalog,
  resolveLocalRunCatalogPath,
  validateLocalRunCatalog,
  writeLocalRunCatalog,
} from "../lib/recruiting-ops/run-catalog"
import {
  ownershipCapacityShadowDefinition,
  runOwnershipCapacityShadow,
} from "../lib/recruiting-ops/modules/ownership-capacity-shadow"
import {
  scorecardAccountabilityShadowDefinition,
  runScorecardAccountabilityShadow,
} from "../lib/recruiting-ops/modules/scorecard-accountability-shadow"
import { assertPublicSafe } from "../lib/recruiting-ops/safe-public-output"
import type { GreenhouseRpsFact } from "../lib/recruiting-ops/modules/t05-rps"
import type { GreenhouseOwnershipFact } from "../lib/recruiting-ops/modules/t09-ownership"

const fixtureRoot = join(process.cwd(), "test", "fixtures", "recruiting-ops")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-run-catalog-"))
  roots.push(root)
  return root
}

function readFixture<T>(fileName: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, fileName), "utf8")) as T
}

function rpsFacts(): GreenhouseRpsFact[] {
  return readFixture("greenhouse-rps.json")
}

function ownershipFacts(): GreenhouseOwnershipFact[] {
  return readFixture("greenhouse-ownership.json")
}

const ownershipRecipientFingerprint = createLocalPiiFingerprint("ownership_fixture_alpha", "test_recipient")
const scorecardRecipientFingerprint = createLocalPiiFingerprint("scorecard_fixture_alpha", "test_recipient")

async function buildFixtureCatalog() {
  const ownership = await runOwnershipCapacityShadow({
    rootDir: tempRoot(),
    startedAt: "2026-06-24T17:00:00.000Z",
    generatedAt: "2026-06-24T17:01:00.000Z",
    greenhouseFacts: ownershipFacts(),
    ownershipScope: {
      recipientFingerprint: ownershipRecipientFingerprint,
      teamName: "Team Avery",
    },
  })
  const blockedScorecard = await runScorecardAccountabilityShadow({
    rootDir: tempRoot(),
    startedAt: "2026-06-24T17:30:00.000Z",
    generatedAt: "2026-06-24T17:31:00.000Z",
    greenhouseFacts: rpsFacts(),
    scorecardScope: {
      recipientFingerprint: scorecardRecipientFingerprint,
      jobIds: [],
    },
  })
  const discrepancy = buildDiscrepancy({
    runId: ownership.run.runId,
    workflowId: ownershipCapacityShadowDefinition.workflowId,
    capabilityId: ownershipCapacityShadowDefinition.capabilityId,
    class: "stale_mapping",
    severity: "warning",
    entityKey: "job_fixture_1",
    field: "recruiter_name",
    modernValueSummary: "Fixture owner [REDACTED]",
    legacyValueSummary: "Legacy owner unmapped",
    evidenceRefs: [ownership.run.sourceRefs[0].id],
    resolutionStatus: "needs_owner",
    owner: "Jordan",
  })
  const actionProposal = buildActionProposal({
    workflowId: ownershipCapacityShadowDefinition.workflowId,
    capabilityId: ownershipCapacityShadowDefinition.capabilityId,
    targetSystem: "greenhouse",
    targetReference: "job_fixture_1",
    actionType: "requisition_update",
    actor: "recops_operator",
    reason: "Fixture ownership update requires manual review.",
    riskTier: "medium",
    approvalState: "needs_review",
    evidenceRefs: [ownership.run.runId],
    createdAt: "2026-06-24T17:02:00.000Z",
    proposedPayload: {
      field: "recruiter",
      ownerEmail: "avery@example.com",
      ownerLabel: "Avery Collins",
    },
  })
  const catalog = buildLocalRunCatalog({
    generatedAt: "2026-06-24T18:00:00.000Z",
    runs: [ownership.run, blockedScorecard.run],
    deliveryLedgerEntries: [ownership.deliveryLedgerEntry, blockedScorecard.deliveryLedgerEntry],
    discrepancies: [discrepancy],
    actionProposals: [actionProposal],
  })
  return { catalog, ownership, blockedScorecard, actionProposal }
}

describe("local run catalog", () => {
  test("indexes local runs, artifacts, delivery logs, gates, discrepancies, source gaps, and action proposals", async () => {
    const { catalog, ownership, blockedScorecard } = await buildFixtureCatalog()

    expect(catalog.publicSummary).toMatchObject({
      runCount: 2,
      artifactCount: 4,
      deliveryLogCount: 2,
      gateResultCount: 22,
      sourceGapCount: 2,
      blockingSourceGapCount: 2,
      discrepancyCount: 1,
      actionProposalCount: 1,
      openActionProposalCount: 1,
    })
    expect(() => validateLocalRunCatalog(catalog)).not.toThrow()
    expect(catalog.runs.map((run) => run.runId).sort()).toEqual(
      [ownership.run.runId, blockedScorecard.run.runId].sort()
    )
    expect(catalog.deliveryLogs.map((entry) => entry.deliveryMechanism)).toEqual(["local_jsonl", "local_jsonl"])
    expect(catalog.actionProposals[0]).toMatchObject({
      noLiveExecution: true,
      evidenceRunIds: [ownership.run.runId],
    })
    expect(catalog.discrepancies[0].ownerFingerprint).toMatch(/^hmac-sha256:/)
    expect(JSON.stringify(catalog.discrepancies)).not.toContain("\"owner\":\"the operator\"")
    expect(JSON.stringify(catalog.discrepancies)).not.toMatch(/Avery Collins/i)
  })

  test("filters catalog evidence by capability, deliverable, gate status, and action proposal state", async () => {
    const { catalog, ownership } = await buildFixtureCatalog()

    expect(filterCatalogRuns(catalog, { capabilityId: "ownership_capacity_management" }).map((run) => run.runId)).toEqual([
      ownership.run.runId,
    ])
    expect(filterCatalogRuns(catalog, { deliverableId: "rps_tracking_sheet" })).toHaveLength(1)
    expect(
      filterCatalogGateResults(catalog, {
        deliverableId: "rps_tracking_sheet",
        gateId: "source_gap",
        status: "fail",
      })
    ).toHaveLength(1)
    expect(filterCatalogActionProposals(catalog, { approvalState: "needs_review", riskTier: "medium" })).toHaveLength(1)
  })

  test("returns run lineage without exposing raw candidate payloads", async () => {
    const { catalog, ownership, actionProposal } = await buildFixtureCatalog()

    const lineage = getCatalogRunLineage(catalog, ownership.run.runId)

    expect(lineage.run.moduleId).toBe(ownershipCapacityShadowDefinition.moduleId)
    expect(lineage.artifacts).toHaveLength(2)
    expect(lineage.deliveryLogs).toHaveLength(1)
    expect(lineage.gateResults).toHaveLength(11)
    expect(lineage.discrepancies).toHaveLength(1)
    expect(lineage.sourceGaps).toHaveLength(0)
    expect(lineage.actionProposals.map((proposal) => proposal.proposalId)).toEqual([actionProposal.proposalId])
    expect(() => assertPublicSafe(catalog.publicSummary)).not.toThrow()
    expect(() => assertPublicSafe(lineage.actionProposals[0].redactedPayloadSummary)).not.toThrow()
    expect(JSON.stringify(lineage.actionProposals[0])).not.toMatch(/avery@example\.com|Avery Collins|candidate_email|phone/i)
    expect(JSON.stringify(lineage.discrepancies)).not.toContain("\"owner\":\"the operator\"")
    expect(JSON.stringify(lineage.discrepancies)).not.toMatch(/Avery Collins/i)
  })

  test("writes and reads the catalog only through local filesystem paths", async () => {
    const { catalog } = await buildFixtureCatalog()
    const rootDir = tempRoot()
    const writeResult = await writeLocalRunCatalog({ rootDir, catalog })

    expect(existsSync(writeResult.path)).toBe(true)
    expect(writeResult.catalogId).toBe(catalog.catalogId)
    await expect(readLocalRunCatalog({ rootDir })).resolves.toMatchObject({ catalogId: catalog.catalogId })
    expect(() => resolveLocalRunCatalogPath({ rootDir: "https://example.test/catalogs" })).toThrow(
      /local filesystem path/
    )
    expect(() => resolveLocalRunCatalogPath({ rootDir, fileName: "../run-catalog.json" })).toThrow(
      /Unsafe run catalog file name/
    )
  })

  test("rejects delivery-log lineage that references an artifact outside the catalog", async () => {
    const { catalog } = await buildFixtureCatalog()
    const brokenCatalog = {
      ...catalog,
      deliveryLogs: catalog.deliveryLogs.map((entry, index) =>
        index === 0 ? { ...entry, artifactIds: ["missing_artifact"] } : entry
      ),
    }

    expect(() => validateLocalRunCatalog(brokenCatalog)).toThrow(/references unknown catalog entry: missing_artifact/)
  })

  test("retains capability-first bindings for Phase 2 catalog consumers", async () => {
    const { catalog } = await buildFixtureCatalog()

    expect(catalog.runs.find((run) => run.moduleId === scorecardAccountabilityShadowDefinition.moduleId)).toMatchObject({
      capabilityId: scorecardAccountabilityShadowDefinition.capabilityId,
      workflowId: scorecardAccountabilityShadowDefinition.workflowId,
    })
    expect(catalog.artifacts.every((artifact) => artifact.capabilityId)).toBe(true)
    expect(catalog.deliveryLogs.every((entry) => entry.capabilityId && entry.deliverableId)).toBe(true)
  })
})
