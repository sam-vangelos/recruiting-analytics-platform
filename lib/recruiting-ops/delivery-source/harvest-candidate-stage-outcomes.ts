import type {
  HarvestApplicationRecord,
  HarvestPersonRef,
  HarvestUserRecord,
} from "../extractors/greenhouse-harvest-read-adapter"
import type {
  CandidateStageOutcomeDirection,
  CandidateStageOutcomeSource,
} from "./candidate-stage-events"

type HarvestOutcomeId = string | number

export interface HarvestCandidateStageRejectionType {
  key?: string | null
  name?: string | null
}

/** Actual v3 rejection-reason shape, accepted both nested on an application and as a joined catalog row. */
export interface HarvestCandidateStageRejectionReason {
  id?: HarvestOutcomeId | null
  name?: string | null
  type?: string | HarvestCandidateStageRejectionType | null
}

/**
 * Delivery-local extension of the current application projection. Keeping these
 * optional fields here avoids widening every existing Harvest consumer before
 * the live read boundary is deliberately expanded.
 */
export interface HarvestCandidateStageOutcomeApplication extends HarvestApplicationRecord {
  rejected_at?: string | null
  rejection_reason_id?: HarvestOutcomeId | null
  rejection_reason_name?: string | null
  rejection_reason?: string | HarvestCandidateStageRejectionReason | null
  rejected_by?: HarvestOutcomeId | HarvestPersonRef | null
  /** Optional direct structured direction from a compatible live projection. */
  rejection_direction?: CandidateStageOutcomeDirection | string | null
  /** Optional raw legacy narrative; direction is still resolved independently. */
  withdrew?: string | null
}

export interface HarvestCandidateStageDirectionEvidence {
  application_id: HarvestOutcomeId
  direction?: CandidateStageOutcomeDirection | string | null
  withdrew?: string | null
}

export interface MapHarvestCandidateStageOutcomesInput {
  applications: readonly HarvestCandidateStageOutcomeApplication[]
  rejectionReasons?: readonly HarvestCandidateStageRejectionReason[]
  directionEvidence?: readonly HarvestCandidateStageDirectionEvidence[]
  users?: readonly HarvestUserRecord[]
}

interface DirectionResolution {
  direction: CandidateStageOutcomeDirection | null
  withdrew: string | null
}

/**
 * Pure Harvest-v3 join into CandidateStageOutcomeSource.
 *
 * Fail-closed evidence contract:
 * - current status must be terminal (`rejected` or `withdrawn`);
 * - `rejected_at` must be a valid explicit timestamp;
 * - direction must be explicit and unambiguous, either from governed evidence,
 *   a structured application field, or rejection-reason type metadata.
 *
 * Status alone, a reason label alone, an actor alone, or a timestamp without a
 * direction never fabricates an outcome.
 */
export function mapHarvestApplicationsToCandidateStageOutcomes(
  input: MapHarvestCandidateStageOutcomesInput
): CandidateStageOutcomeSource[] {
  const reasonsById = indexReasons(input.rejectionReasons ?? [])
  const evidenceByApplicationId = groupDirectionEvidence(input.directionEvidence ?? [])
  const userNameById = indexUserNames(input.users ?? [])
  const outcomes: CandidateStageOutcomeSource[] = []
  const seenApplicationIds = new Set<string>()

  for (const application of [...input.applications].sort(compareApplications)) {
    const applicationId = idOf(application.id)
    if (!applicationId || seenApplicationIds.has(applicationId)) continue
    seenApplicationIds.add(applicationId)
    if (!isTerminalStatus(application.status)) continue

    const rejectedAt = timestampOf(application.rejected_at)
    if (!rejectedAt) continue

    const nestedReason = objectReason(application.rejection_reason)
    const rejectionReasonId =
      idOf(application.rejection_reason_id) ?? idOf(nestedReason?.id) ?? null
    const catalogReason = rejectionReasonId ? reasonsById.get(rejectionReasonId) : undefined
    const rejectionReason =
      textOf(application.rejection_reason_name) ??
      scalarReasonName(application.rejection_reason) ??
      textOf(nestedReason?.name) ??
      textOf(catalogReason?.name)
    const direction = resolveDirection({
      application,
      nestedReason,
      catalogReason,
      evidence: evidenceByApplicationId.get(applicationId) ?? [],
    })
    if (!direction.direction) continue

    outcomes.push({
      id: `harvest-application-outcome:${applicationId}`,
      application_id: applicationId,
      event_type: direction.direction === "candidate_withdrew" ? "withdrawn" : "rejected",
      event_at: rejectedAt,
      stage_id: idOf(application.stage_id),
      stage_name: textOf(application.stage_name) ?? textOf(application.current_stage?.name),
      rejection_reason_id: rejectionReasonId,
      rejection_reason: rejectionReason,
      withdrew: direction.direction === "candidate_withdrew" ? direction.withdrew : null,
      rejected_by: rejectedByName(application.rejected_by, userNameById),
    })
  }

  return outcomes.sort(
    (left, right) =>
      left.event_at.localeCompare(right.event_at) ||
      String(left.application_id).localeCompare(String(right.application_id), undefined, { numeric: true })
  )
}

function resolveDirection(input: {
  application: HarvestCandidateStageOutcomeApplication
  nestedReason: HarvestCandidateStageRejectionReason | null
  catalogReason: HarvestCandidateStageRejectionReason | undefined
  evidence: readonly HarvestCandidateStageDirectionEvidence[]
}): DirectionResolution {
  const directions = new Set<CandidateStageOutcomeDirection>()
  addDirection(directions, input.application.rejection_direction)
  addReasonTypeDirection(directions, input.nestedReason?.type)
  addReasonTypeDirection(directions, input.catalogReason?.type)

  const withdrawalNarratives = new Set<string>()
  const applicationWithdrew = textOf(input.application.withdrew)
  if (applicationWithdrew) {
    directions.add("candidate_withdrew")
    withdrawalNarratives.add(applicationWithdrew)
  }
  for (const evidence of input.evidence) {
    addDirection(directions, evidence.direction)
    const withdrew = textOf(evidence.withdrew)
    if (withdrew) {
      directions.add("candidate_withdrew")
      withdrawalNarratives.add(withdrew)
    }
  }

  if (directions.size !== 1) return { direction: null, withdrew: null }
  const direction = [...directions][0]
  return {
    direction,
    withdrew:
      direction === "candidate_withdrew"
        ? [...withdrawalNarratives].sort((left, right) => left.localeCompare(right))[0] ?? null
        : null,
  }
}

function addReasonTypeDirection(
  directions: Set<CandidateStageOutcomeDirection>,
  type: HarvestCandidateStageRejectionReason["type"]
): void {
  if (typeof type === "string") {
    addDirection(directions, type)
    return
  }
  if (!type) return
  addDirection(directions, type.key)
  addDirection(directions, type.name)
}

function addDirection(
  directions: Set<CandidateStageOutcomeDirection>,
  value: string | null | undefined
): void {
  const normalized = normalizeDirection(value)
  if (normalized) directions.add(normalized)
}

function normalizeDirection(value: string | null | undefined): CandidateStageOutcomeDirection | null {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
  if (!normalized) return null
  if (
    [
      "they_rejected_us",
      "candidate",
      "candidate_withdrew",
      "candidate_withdrawn",
      "candidate_declined",
    ].includes(normalized)
  ) {
    return "candidate_withdrew"
  }
  if (
    [
      "we_rejected_them",
      "company",
      "company_rejected",
      "employer_rejected",
      "org_rejected",
    ].includes(normalized)
  ) {
    return "company_rejected"
  }
  return null
}

function groupDirectionEvidence(
  evidence: readonly HarvestCandidateStageDirectionEvidence[]
): Map<string, HarvestCandidateStageDirectionEvidence[]> {
  const grouped = new Map<string, HarvestCandidateStageDirectionEvidence[]>()
  for (const row of evidence) {
    const applicationId = idOf(row.application_id)
    if (!applicationId) continue
    const bucket = grouped.get(applicationId) ?? []
    bucket.push(row)
    grouped.set(applicationId, bucket)
  }
  return grouped
}

function indexReasons(
  reasons: readonly HarvestCandidateStageRejectionReason[]
): Map<string, HarvestCandidateStageRejectionReason> {
  const indexed = new Map<string, HarvestCandidateStageRejectionReason>()
  for (const reason of reasons) {
    const id = idOf(reason.id)
    if (id && !indexed.has(id)) indexed.set(id, reason)
  }
  return indexed
}

function indexUserNames(users: readonly HarvestUserRecord[]): Map<string, string> {
  const indexed = new Map<string, string>()
  for (const user of users) {
    const id = idOf(user.id)
    const name = personName(user)
    if (id && name) indexed.set(id, name)
  }
  return indexed
}

function rejectedByName(
  rejectedBy: HarvestCandidateStageOutcomeApplication["rejected_by"],
  userNameById: ReadonlyMap<string, string>
): string | null {
  if (rejectedBy === null || rejectedBy === undefined) return null
  if (typeof rejectedBy === "object") {
    const rejectedById = idOf(rejectedBy.id)
    return personName(rejectedBy) ?? (rejectedById ? userNameById.get(rejectedById) ?? null : null)
  }
  const id = idOf(rejectedBy)
  if (id && userNameById.has(id)) return userNameById.get(id) ?? null
  if (typeof rejectedBy === "number" || /^\d+$/.test(String(rejectedBy).trim())) return null
  return textOf(String(rejectedBy))
}

function objectReason(
  reason: HarvestCandidateStageOutcomeApplication["rejection_reason"]
): HarvestCandidateStageRejectionReason | null {
  return reason && typeof reason === "object" ? reason : null
}

function scalarReasonName(
  reason: HarvestCandidateStageOutcomeApplication["rejection_reason"]
): string | null {
  return typeof reason === "string" ? textOf(reason) : null
}

function compareApplications(
  left: HarvestCandidateStageOutcomeApplication,
  right: HarvestCandidateStageOutcomeApplication
): number {
  return (idOf(left.id) ?? "").localeCompare(idOf(right.id) ?? "", undefined, { numeric: true })
}

function isTerminalStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toLowerCase()
  return normalized === "rejected" || normalized === "withdrawn"
}

function timestampOf(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function idOf(value: HarvestOutcomeId | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function textOf(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text || null
}

function personName(person: { name?: string; first_name?: string; last_name?: string }): string | null {
  return textOf(person.name) ?? textOf([person.first_name, person.last_name].filter(Boolean).join(" "))
}
