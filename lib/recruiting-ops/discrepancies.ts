import { createPayloadFingerprint } from "./checksums"
import {
  assertKnownDiscrepancyClass,
  assertKnownWorkflowIds,
  assertNonEmptyString,
  validateId,
  type DiscrepancyClass,
  type ValidationSummary,
} from "./substrate"
import { assertPublicSafe, redactPublicText } from "./safe-public-output"

export type DiscrepancySeverity = "info" | "warning" | "blocking"
export type DiscrepancyResolutionStatus = "open" | "accepted" | "rejected" | "needs_owner" | "resolved"

export interface Discrepancy {
  id: string
  runId: string
  workflowId: string
  /** Capability provenance is REQUIRED on nested records, mirroring the run (P6/CAPABILITY-SPINE-3). */
  capabilityId: string
  class: DiscrepancyClass
  severity: DiscrepancySeverity
  entityKey: string
  field: string
  modernValueSummary: string
  legacyValueSummary: string
  evidenceRefs: readonly string[]
  resolutionStatus: DiscrepancyResolutionStatus
  owner: string
}

export interface DiscrepancySummary {
  total: number
  blocking: number
  byClass: Record<DiscrepancyClass, number>
}

export function buildDiscrepancy(input: Omit<Discrepancy, "id"> & { id?: string }): Discrepancy {
  const id =
    input.id ??
    `disc_${createPayloadFingerprint({
      runId: input.runId,
      workflowId: input.workflowId,
      class: input.class,
      entityKey: input.entityKey,
      field: input.field,
    }).slice(7, 23)}`
  // Value summaries are public projections of the difference (validateDiscrepancy asserts
  // them public-safe). Redact person-name shapes at composition so full-fidelity values
  // never enter the record graph — fidelity for adjudication lives behind evidenceRefs.
  const discrepancy = {
    ...input,
    id,
    modernValueSummary: redactPublicText(input.modernValueSummary),
    legacyValueSummary: redactPublicText(input.legacyValueSummary),
  }
  validateDiscrepancy(discrepancy)
  return discrepancy
}

export function validateDiscrepancy(discrepancy: Discrepancy): ValidationSummary {
  validateId(discrepancy.id, "discrepancy.id")
  validateId(discrepancy.runId, `${discrepancy.id}.runId`)
  // Explicit runtime guard (not assertNonEmptyString, which assumes a string and would
  // crash on undefined): hand-built records bypassing the types must fail by name (P6).
  if (typeof discrepancy.capabilityId !== "string" || !discrepancy.capabilityId.trim()) {
    throw new Error(`${discrepancy.id}.capabilityId is required on nested records`)
  }
  assertKnownWorkflowIds([discrepancy.workflowId], `${discrepancy.id}.workflowId`)
  assertKnownDiscrepancyClass(discrepancy.class)
  assertNonEmptyString(discrepancy.entityKey, `${discrepancy.id}.entityKey`)
  assertNonEmptyString(discrepancy.field, `${discrepancy.id}.field`)
  assertNonEmptyString(discrepancy.modernValueSummary, `${discrepancy.id}.modernValueSummary`)
  assertNonEmptyString(discrepancy.legacyValueSummary, `${discrepancy.id}.legacyValueSummary`)
  if (discrepancy.evidenceRefs.length === 0) throw new Error(`${discrepancy.id}.evidenceRefs must not be empty`)
  assertPublicSafe(
    {
      entityKey: discrepancy.entityKey,
      field: discrepancy.field,
      modernValueSummary: discrepancy.modernValueSummary,
      legacyValueSummary: discrepancy.legacyValueSummary,
    },
    `${discrepancy.id}.publicSummary`
  )
  return {
    ok: true,
    id: discrepancy.id,
    checked: ["id", "workflow", "class", "values", "evidence", "publicSafety"],
  }
}

export function summarizeDiscrepancies(discrepancies: readonly Discrepancy[]): DiscrepancySummary {
  const byClass = {
    legacy_bug: 0,
    stale_mapping: 0,
    source_gap: 0,
    intentional_modernization: 0,
    modern_bug: 0,
    business_definition_open: 0,
  } satisfies Record<DiscrepancyClass, number>

  for (const discrepancy of discrepancies) {
    validateDiscrepancy(discrepancy)
    byClass[discrepancy.class] += 1
  }

  return {
    total: discrepancies.length,
    blocking: discrepancies.filter((item) => item.severity === "blocking").length,
    byClass,
  }
}

export function assertAllDifferencesClassified(
  differences: readonly { class?: DiscrepancyClass | null; id?: string }[]
): void {
  for (const difference of differences) {
    if (!difference.class) throw new Error(`Unclassified difference blocks cutover: ${difference.id ?? "unknown"}`)
    assertKnownDiscrepancyClass(difference.class)
  }
}
