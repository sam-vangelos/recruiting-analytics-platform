export type OfferLifecycleId = string | number

export type OfferLifecycleJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly OfferLifecycleJsonValue[]
  | { readonly [key: string]: OfferLifecycleJsonValue }

export interface OfferLifecyclePersonSource {
  id?: OfferLifecycleId | null
  name?: string | null
}

export interface OfferLifecycleCustomFieldSource {
  key?: string | null
  name: string
  type?: string | null
  value: OfferLifecycleJsonValue
}

export interface OfferLifecycleCustomFieldMetadata {
  entity: "offer" | "application" | "candidate" | "job"
  key: string
  name: string
  type: string | null
  value: OfferLifecycleJsonValue
}

export interface OfferLifecycleSourceAttribution {
  id?: OfferLifecycleId | null
  name?: string | null
  type?: string | null
}

export interface OfferLifecycleRejectionSource {
  reasonId?: OfferLifecycleId | null
  reasonName?: string | null
  type?: string | null
  rejectedAt?: string | null
}

export interface OfferLifecycleExportSource {
  sourceSystem?: string
  offer: {
    id: OfferLifecycleId
    applicationId?: OfferLifecycleId | null
    candidateId?: OfferLifecycleId | null
    jobId?: OfferLifecycleId | null
    status: string
    createdAt: string
    sentAt?: string | null
    resolvedAt?: string | null
    startDate?: string | null
    recruiterOfRecord?: OfferLifecyclePersonSource | null
    createdBy?: OfferLifecyclePersonSource | null
    approver?: OfferLifecyclePersonSource | null
    customFields?: readonly OfferLifecycleCustomFieldSource[]
  }
  application: {
    id: OfferLifecycleId
    candidateId?: OfferLifecycleId | null
    jobId?: OfferLifecycleId | null
    status?: string | null
    stage?: string | null
    /** Current application recruiter; never used as offer recruiter-of-record. */
    recruiter?: OfferLifecyclePersonSource | null
    rejection?: OfferLifecycleRejectionSource | null
    customFields?: readonly OfferLifecycleCustomFieldSource[]
  }
  candidate: {
    id: OfferLifecycleId
    name?: string | null
    source?: OfferLifecycleSourceAttribution | null
    customFields?: readonly OfferLifecycleCustomFieldSource[]
  }
  job: {
    id: OfferLifecycleId
    requisitionId?: OfferLifecycleId | null
    name?: string | null
    detailedTitle?: string | null
    status?: string | null
    level?: string | null
    departmentName?: string | null
    hiringLocation?: string | null
    customFields?: readonly OfferLifecycleCustomFieldSource[]
  }
  sourcer?: OfferLifecyclePersonSource | null
  hod?: OfferLifecyclePersonSource | null
}

/**
 * Artifact-agnostic offer lifecycle row. It preserves joined source facts but
 * deliberately excludes sheet-specific month labels, ordinals, and display
 * vocabulary; those belong to separately governed platform projections.
 */
export interface OfferLifecycleExportRow {
  source_system: string
  offer_id: string
  offer_status: string
  application_id: string
  application_status: string | null
  application_stage: string | null
  application_recruiter_id?: string | null
  application_recruiter_name?: string | null
  candidate_id: string
  candidate_name: string | null
  job_id: string
  requisition_id: string | null
  job_name: string | null
  detailed_job_title: string | null
  job_status: string | null
  job_level: string | null
  department_name: string | null
  hiring_location: string | null
  recruiter_of_record_id: string | null
  recruiter_of_record_name: string | null
  sourcer_id: string | null
  sourcer_name: string | null
  hod_id: string | null
  hod_name: string | null
  created_by_id: string | null
  created_by_name: string | null
  approver_id: string | null
  approver_name: string | null
  rejection_reason_id: string | null
  rejection_reason_name: string | null
  rejection_type: string | null
  rejected_at: string | null
  candidate_source_id: string | null
  candidate_source_name: string | null
  candidate_source_type: string | null
  created_at: string
  sent_at: string | null
  resolved_at: string | null
  start_date: string | null
  custom_field_metadata: readonly OfferLifecycleCustomFieldMetadata[]
}

export function emitOfferLifecycleExportRows(
  sources: readonly OfferLifecycleExportSource[]
): OfferLifecycleExportRow[] {
  const rows = sources.map(buildOfferLifecycleExportRow)
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.offer_id)) {
      throw new Error(`Duplicate offer lifecycle source for offer_id ${row.offer_id}`)
    }
    seen.add(row.offer_id)
  }
  return rows.sort((left, right) => left.offer_id.localeCompare(right.offer_id))
}

export function buildOfferLifecycleExportRow(source: OfferLifecycleExportSource): OfferLifecycleExportRow {
  const offerId = requiredId(source.offer.id, "offer.id")
  const applicationId = requiredId(source.application.id, "application.id")
  const candidateId = requiredId(source.candidate.id, "candidate.id")
  const jobId = requiredId(source.job.id, "job.id")

  assertJoinedId("offer.applicationId", source.offer.applicationId, applicationId)
  assertJoinedId("offer.candidateId", source.offer.candidateId, candidateId)
  assertJoinedId("offer.jobId", source.offer.jobId, jobId)
  assertJoinedId("application.candidateId", source.application.candidateId, candidateId)
  assertJoinedId("application.jobId", source.application.jobId, jobId)

  const recruiter = personOf(source.offer.recruiterOfRecord)
  const applicationRecruiter = personOf(source.application.recruiter)
  const sourcer = personOf(source.sourcer)
  const hod = personOf(source.hod)
  const createdBy = personOf(source.offer.createdBy)
  const approver = personOf(source.offer.approver)
  const rejection = source.application.rejection
  const candidateSource = source.candidate.source

  return {
    source_system: optionalText(source.sourceSystem) ?? "greenhouse",
    offer_id: offerId,
    offer_status: requiredText(source.offer.status, "offer.status"),
    application_id: applicationId,
    application_status: optionalText(source.application.status),
    application_stage: optionalText(source.application.stage),
    application_recruiter_id: applicationRecruiter.id,
    application_recruiter_name: applicationRecruiter.name,
    candidate_id: candidateId,
    candidate_name: optionalText(source.candidate.name),
    job_id: jobId,
    requisition_id: optionalId(source.job.requisitionId),
    job_name: optionalText(source.job.name),
    detailed_job_title: optionalText(source.job.detailedTitle),
    job_status: optionalText(source.job.status),
    job_level: optionalText(source.job.level),
    department_name: optionalText(source.job.departmentName),
    hiring_location: optionalText(source.job.hiringLocation),
    recruiter_of_record_id: recruiter.id,
    recruiter_of_record_name: recruiter.name,
    sourcer_id: sourcer.id,
    sourcer_name: sourcer.name,
    hod_id: hod.id,
    hod_name: hod.name,
    created_by_id: createdBy.id,
    created_by_name: createdBy.name,
    approver_id: approver.id,
    approver_name: approver.name,
    rejection_reason_id: optionalId(rejection?.reasonId),
    rejection_reason_name: optionalText(rejection?.reasonName),
    rejection_type: optionalText(rejection?.type),
    rejected_at: optionalTimestamp(rejection?.rejectedAt, "application.rejection.rejectedAt"),
    candidate_source_id: optionalId(candidateSource?.id),
    candidate_source_name: optionalText(candidateSource?.name),
    candidate_source_type: optionalText(candidateSource?.type),
    created_at: requiredTimestamp(source.offer.createdAt, "offer.createdAt"),
    sent_at: optionalTimestamp(source.offer.sentAt, "offer.sentAt"),
    resolved_at: optionalTimestamp(source.offer.resolvedAt, "offer.resolvedAt"),
    start_date: optionalDate(source.offer.startDate, "offer.startDate"),
    custom_field_metadata: customFieldMetadataOf(source),
  }
}

function customFieldMetadataOf(source: OfferLifecycleExportSource): OfferLifecycleCustomFieldMetadata[] {
  const entities = [
    ["offer", source.offer.customFields],
    ["application", source.application.customFields],
    ["candidate", source.candidate.customFields],
    ["job", source.job.customFields],
  ] as const

  return entities
    .flatMap(([entity, fields]) =>
      (fields ?? []).map((field) => {
        const name = requiredText(field.name, `${entity}.customFields.name`)
        return {
          entity,
          key: optionalText(field.key) ?? name,
          name,
          type: optionalText(field.type),
          value: canonicalJson(field.value),
        }
      })
    )
    .sort((left, right) =>
      [left.entity, left.key, left.name].join("|").localeCompare([right.entity, right.key, right.name].join("|"))
    )
}

function personOf(person: OfferLifecyclePersonSource | null | undefined): {
  id: string | null
  name: string | null
} {
  return { id: optionalId(person?.id), name: optionalText(person?.name) }
}

function requiredId(value: OfferLifecycleId, field: string): string {
  const id = optionalId(value)
  if (!id) throw new Error(`${field} is required`)
  return id
}

function optionalId(value: OfferLifecycleId | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const id = String(value).trim()
  return id && id.toLowerCase() !== "unknown" ? id : null
}

function assertJoinedId(field: string, sourceValue: OfferLifecycleId | null | undefined, expected: string): void {
  if (sourceValue === undefined || sourceValue === null) return
  const actual = requiredId(sourceValue, field)
  if (actual !== expected) throw new Error(`${field} ${actual} does not match joined id ${expected}`)
}

function requiredText(value: string, field: string): string {
  const text = optionalText(value)
  if (!text) throw new Error(`${field} is required`)
  return text
}

function optionalText(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text ? text : null
}

function requiredTimestamp(value: string, field: string): string {
  const timestamp = optionalTimestamp(value, field)
  if (!timestamp) throw new Error(`${field} is required`)
  return timestamp
}

function optionalTimestamp(value: string | null | undefined, field: string): string | null {
  const text = optionalText(value)
  if (!text) return null
  const timestamp = new Date(text)
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${field} must be a valid timestamp`)
  return timestamp.toISOString()
}

function optionalDate(value: string | null | undefined, field: string): string | null {
  const text = optionalText(value)
  if (!text) return null
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : text)
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date`)
  return date.toISOString().slice(0, 10)
}

function canonicalJson(value: OfferLifecycleJsonValue): OfferLifecycleJsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJson(nested)])
    )
  }
  return value
}
