import {
  assertBlockersAndGate,
  assertKnownOutputContractIds,
  assertKnownQueryIds,
  assertKnownScriptAssetIds,
  assertKnownSourceIds,
  assertKnownWorkflowIds,
  assertProvenance,
  validateId,
  type ProvenanceReference,
  type ValidationSummary,
} from "./substrate"

export type LegacyArtifactType =
  | "query_tab"
  | "sheet"
  | "doc"
  | "apps_script"
  | "n8n_workflow"
  | "power_bi_dashboard"
  | "slack_pattern"
  | "manual_export"
  | "reference_packet"

export type LegacyArtifactCustodyStatus =
  | "captured"
  | "export_required"
  | "owner_confirm_required"
  | "reference_only"

export type LegacyArtifactAccessStatus = "available" | "manual" | "unknown" | "blocked"

export interface LegacyArtifact {
  id: string
  artifactType: LegacyArtifactType
  workflowIds: readonly string[]
  queryIds: readonly string[]
  scriptAssetIds: readonly string[]
  outputContractIds: readonly string[]
  sourceId: string
  title: string
  locationLabel: string
  custodyStatus: LegacyArtifactCustodyStatus
  accessStatus: LegacyArtifactAccessStatus
  expectedHeaders: readonly string[]
  provenance: readonly ProvenanceReference[]
  blockers: readonly string[]
  nextGate: string
}

export function validateLegacyArtifact(artifact: LegacyArtifact): ValidationSummary {
  validateId(artifact.id, "legacyArtifact.id")
  assertKnownWorkflowIds(artifact.workflowIds, `${artifact.id}.workflowIds`)
  assertKnownSourceIds([artifact.sourceId], `${artifact.id}.sourceId`)
  assertKnownQueryIds(artifact.queryIds, `${artifact.id}.queryIds`)
  assertKnownScriptAssetIds(artifact.scriptAssetIds, `${artifact.id}.scriptAssetIds`)
  assertKnownOutputContractIds(artifact.outputContractIds, `${artifact.id}.outputContractIds`)
  assertProvenance(artifact.provenance, `${artifact.id}.provenance`)
  assertBlockersAndGate(artifact)
  assertHeadersOrOpenBlocker(artifact)
  return {
    ok: true,
    id: artifact.id,
    checked: ["ids", "references", "provenance", "blockers", "expectedHeaders"],
  }
}

function assertHeadersOrOpenBlocker(artifact: LegacyArtifact): void {
  if (artifact.expectedHeaders.length > 0) return
  const hasOpenEvidence =
    artifact.provenance.some((item) => item.label === "OPEN") ||
    artifact.blockers.some((blocker) => /\bOPEN\b/i.test(blocker))
  if (!hasOpenEvidence) {
    throw new Error(`${artifact.id}.expectedHeaders requires headers or an OPEN blocker`)
  }
}
