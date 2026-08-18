import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import { resolveTeam } from "../dimensions/recruiter-team-hod"
import type {
  HarvestApplicationRecord,
  HarvestCandidateRecord,
  HarvestCustomField,
  HarvestDepartmentRecord,
  HarvestJobRecord,
  HarvestOfferRecord,
  HarvestPersonRef,
  HarvestUserRecord,
} from "../extractors/greenhouse-harvest-read-adapter"
import type {
  OfferLifecycleCustomFieldSource,
  OfferLifecycleExportSource,
  OfferLifecycleId,
  OfferLifecycleJsonValue,
  OfferLifecyclePersonSource,
} from "./offer-lifecycle-export"

type HarvestCustomFieldCollection =
  | readonly HarvestLifecycleCustomField[]
  | Readonly<Record<string, unknown>>

export interface HarvestLifecycleCustomField extends HarvestCustomField {
  key?: string
  type?: string
}

/** Offer-only fields retained by the lifecycle projection from flat Harvest v3. */
export interface HarvestOfferLifecycleRecord extends HarvestOfferRecord {
  start_date?: string | null
  updated_at?: string | null
  recruiter_of_record_id?: OfferLifecycleId | null
  recruiter_of_record?: HarvestPersonRef | null
  created_by_id?: OfferLifecycleId | null
  created_by?: HarvestPersonRef | null
  approver_id?: OfferLifecycleId | null
  approver?: HarvestPersonRef | null
  keyed_custom_fields?: HarvestCustomFieldCollection
}

export interface HarvestOfferLifecycleApplication extends HarvestApplicationRecord {
  /** Present in some compatibility fixtures; intentionally never used for offer attribution. */
  recruiter?: HarvestPersonRef | null
  source_id?: OfferLifecycleId | null
  rejected_at?: string | null
  rejection_reason_id?: OfferLifecycleId | null
  custom_fields?: HarvestCustomFieldCollection
  keyed_custom_fields?: HarvestCustomFieldCollection
}

/** Flat v3 `/referrers` row used by the legacy Final Offer sourcer column. */
export interface HarvestReferrerRecord {
  id?: OfferLifecycleId | null
  user_id?: OfferLifecycleId | null
  name?: string | null
}

export interface HarvestOfferLifecycleCandidate extends HarvestCandidateRecord {
  name?: string
  source_id?: OfferLifecycleId | null
  custom_fields?: HarvestCustomFieldCollection
  keyed_custom_fields?: HarvestCustomFieldCollection
}

export interface HarvestOfferLifecycleJob extends HarvestJobRecord {
  keyed_custom_fields?: HarvestCustomFieldCollection
}

/** Flat v3 /rejection_details projection. */
export interface HarvestRejectionDetailRecord {
  application_id?: OfferLifecycleId | null
  rejection_reason_id?: OfferLifecycleId | null
  rejected_at?: string | null
  rejected_by_id?: OfferLifecycleId | null
}

export interface HarvestRejectionReasonRecord {
  id?: OfferLifecycleId | null
  name?: string | null
  type?: string | { id?: OfferLifecycleId | null; key?: string | null; name?: string | null } | null
}

export interface HarvestCandidateSourceRecord {
  id?: OfferLifecycleId | null
  name?: string | null
  public_name?: string | null
  type?: string | { id?: OfferLifecycleId | null; name?: string | null } | null
}

/** Governed offer approval evidence, independent of application recruiter ownership. */
export interface HarvestOfferApproverRecord {
  offer_id?: OfferLifecycleId | null
  application_id?: OfferLifecycleId | null
  user_id?: OfferLifecycleId | null
  approver_id?: OfferLifecycleId | null
  approved_by_id?: OfferLifecycleId | null
  approver?: HarvestPersonRef | null
  approved_by?: HarvestPersonRef | null
  approved_at?: string | null
  status?: string | null
}

/** Governed department-to-HOD mapping when the roster is not the source of truth. */
export interface GovernedDepartmentHodRecord {
  department_id?: OfferLifecycleId | null
  department_name?: string | null
  hod_id?: OfferLifecycleId | null
  hod_name?: string | null
}

export interface HarvestOfferLifecycleJoinInput {
  offers: readonly HarvestOfferLifecycleRecord[]
  applications: readonly HarvestOfferLifecycleApplication[]
  candidates: readonly HarvestOfferLifecycleCandidate[]
  jobs: readonly HarvestOfferLifecycleJob[]
  users?: readonly HarvestUserRecord[]
  departments?: readonly HarvestDepartmentRecord[]
  sources?: readonly HarvestCandidateSourceRecord[]
  referrers?: readonly HarvestReferrerRecord[]
  rejectionDetails?: readonly HarvestRejectionDetailRecord[]
  rejectionReasons?: readonly HarvestRejectionReasonRecord[]
  offerApprovers?: readonly HarvestOfferApproverRecord[]
  departmentHods?: readonly GovernedDepartmentHodRecord[]
  recruiterRoster?: readonly RecruiterTeamHodEntry[]
}

/**
 * Joins flat Harvest v3 collections into the shared offer-lifecycle source.
 * This function is pure: it performs no reads, writes, logging, or artifact math.
 * In particular, recruiter-of-record is read only from the offer object/custom
 * fields. Application recruiter ownership is deliberately outside this contract.
 */
export function mapHarvestToOfferLifecycleExportSources(
  input: HarvestOfferLifecycleJoinInput
): OfferLifecycleExportSource[] {
  const applicationsById = indexById(input.applications, (row) => row.id, "application")
  const candidatesById = indexById(input.candidates, (row) => row.id, "candidate")
  const jobsById = indexById(input.jobs, (row) => row.id, "job")
  const usersById = indexById(input.users ?? [], (row) => row.id, "user")
  const departmentsById = indexById(input.departments ?? [], (row) => row.id, "department")
  const sourcesById = indexById(input.sources ?? [], (row) => row.id, "candidate source")
  const referrersById = indexById(input.referrers ?? [], (row) => row.id, "referrer")
  const rejectionReasonsById = indexById(
    input.rejectionReasons ?? [],
    (row) => row.id,
    "rejection reason"
  )
  const rejectionByApplicationId = indexById(
    input.rejectionDetails ?? [],
    (row) => row.application_id,
    "application rejection"
  )
  const approversByOfferId = groupById(input.offerApprovers ?? [], (row) => row.offer_id)
  const approversByApplicationId = groupById(input.offerApprovers ?? [], (row) => row.application_id)
  const departmentHodById = indexById(
    input.departmentHods ?? [],
    (row) => row.department_id,
    "department HOD"
  )
  const departmentHodByName = indexByText(
    input.departmentHods ?? [],
    (row) => row.department_name,
    "department HOD"
  )
  const seenOfferIds = new Set<string>()

  return input.offers
    .map((offer) => {
      const offerId = requireId(offer.id, "offer.id")
      if (seenOfferIds.has(offerId)) {
        throw new Error("Harvest offer lifecycle join has duplicate offer ids")
      }
      seenOfferIds.add(offerId)
      const applicationId = requireId(offer.application_id, "offer.application_id")
      const application = applicationsById.get(applicationId)
      if (!application) throw new Error("Harvest offer lifecycle join is missing an application")

      const candidateId = requireId(application.candidate_id, "application.candidate_id")
      const jobId = requireId(application.job_id, "application.job_id")
      assertOptionalJoinedId(offer.candidate_id, candidateId, "candidate")
      assertOptionalJoinedId(offer.job_id, jobId, "job")
      const candidate = candidatesById.get(candidateId)
      const job = jobsById.get(jobId)
      if (!candidate) throw new Error("Harvest offer lifecycle join is missing a candidate")
      if (!job) throw new Error("Harvest offer lifecycle join is missing a job")

      const offerCustomFields = mergeCustomFields(offer.custom_fields, offer.keyed_custom_fields)
      const applicationCustomFields = mergeCustomFields(
        application.custom_fields,
        application.keyed_custom_fields
      )
      const candidateCustomFields = mergeCustomFields(candidate.custom_fields, candidate.keyed_custom_fields)
      const jobCustomFields = mergeCustomFields(job.custom_fields, job.keyed_custom_fields)

      const recruiterOfRecord =
        resolvePerson(offer.recruiter_of_record, offer.recruiter_of_record_id, usersById) ??
        personFromCustomField(
          offerCustomFields,
          ["recruiter_of_record", "offer_letter_recruiter", "offer_recruiter", "recruiter"],
          usersById
        )
      // The canonical Final Offer query labels the application referrer as
      // "sourcer". It does not use current job-owner assignments, which may
      // legitimately contain several people and change after the offer.
      const referrerId = optionalId(application.referrer_id)
      const sourcer = referrerId
        ? resolvePerson(
            undefined,
            referrersById.get(referrerId)?.user_id,
            usersById
          )
        : null
      const departmentId = optionalId(job.department_id)
      const departmentName =
        (departmentId ? optionalText(departmentsById.get(departmentId)?.name) : null) ??
        optionalText(job.departments?.[0]?.name)
      const hod = hodForDepartmentOrRecruiter({
        departmentId,
        departmentName,
        departmentHodById,
        departmentHodByName,
        recruiterName: recruiterOfRecord?.name ?? null,
        recruiterRoster: input.recruiterRoster ?? [],
      })
      const approver = approverForOffer({
        offer,
        offerId,
        applicationId,
        offerCustomFields,
        approversByOfferId,
        approversByApplicationId,
        usersById,
      })
      const rejectionDetail = rejectionByApplicationId.get(applicationId)
      const rejectionReasonId = optionalId(
        rejectionDetail?.rejection_reason_id ?? application.rejection_reason_id
      )
      const rejectionReason = rejectionReasonId
        ? rejectionReasonsById.get(rejectionReasonId)
        : undefined
      const sourceId = optionalId(application.source_id ?? candidate.source_id)
      const candidateSource = sourceId ? sourcesById.get(sourceId) : undefined

      return {
        sourceSystem: "greenhouse",
        offer: {
          id: offerId,
          applicationId: offer.application_id,
          candidateId: offer.candidate_id ?? application.candidate_id,
          jobId: offer.job_id ?? application.job_id,
          status: requireText(offer.status ?? offer.offer_status ?? offer.state, "offer.status"),
          createdAt: requireText(offer.created_at, "offer.created_at"),
          sentAt: offer.sent_at,
          resolvedAt: offer.resolved_at,
          startDate: offer.start_date ?? offer.starts_on,
          recruiterOfRecord,
          createdBy: resolvePerson(offer.created_by, offer.created_by_id, usersById),
          approver,
          customFields: offerCustomFields,
        },
        application: {
          id: applicationId,
          candidateId: application.candidate_id,
          jobId: application.job_id,
          status: application.status,
          stage: application.stage_name ?? application.current_stage?.name,
          recruiter: resolvePerson(application.recruiter, application.recruiter_id, usersById),
          rejection:
            rejectionDetail || rejectionReasonId || application.rejected_at
              ? {
                  reasonId: rejectionReasonId,
                  reasonName: rejectionReason?.name,
                  type: nestedNameOrText(rejectionReason?.type),
                  rejectedAt: rejectionDetail?.rejected_at ?? application.rejected_at,
                }
              : null,
          customFields: applicationCustomFields,
        },
        candidate: {
          id: candidateId,
          name: candidateName(candidate),
          source: sourceId
            ? {
                id: sourceId,
                name: candidateSource?.public_name ?? candidateSource?.name,
                type: nestedNameOrText(candidateSource?.type),
              }
            : null,
          customFields: candidateCustomFields,
        },
        job: {
          id: jobId,
          requisitionId: job.requisition_id,
          name: job.name,
          detailedTitle: customFieldText(jobCustomFields, ["detailed_job_title", "detailed_title"]),
          status: job.status,
          level:
            customFieldText(offerCustomFields, ["job_level", "level"]) ??
            customFieldText(jobCustomFields, ["job_level", "level"]),
          departmentName,
          hiringLocation: customFieldText(jobCustomFields, [
            "hiring_location_s",
            "hiring_locations",
            "hiring_location",
            "location",
          ]),
          customFields: jobCustomFields,
        },
        sourcer,
        hod,
      } satisfies OfferLifecycleExportSource
    })
    .sort((left, right) => String(left.offer.id).localeCompare(String(right.offer.id)))
}

function approverForOffer(input: {
  offer: HarvestOfferLifecycleRecord
  offerId: string
  applicationId: string
  offerCustomFields: readonly OfferLifecycleCustomFieldSource[]
  approversByOfferId: ReadonlyMap<string, readonly HarvestOfferApproverRecord[]>
  approversByApplicationId: ReadonlyMap<string, readonly HarvestOfferApproverRecord[]>
  usersById: ReadonlyMap<string, HarvestUserRecord>
}): OfferLifecyclePersonSource | null {
  const direct = resolvePerson(input.offer.approver, input.offer.approver_id, input.usersById)
  if (direct) return direct

  const custom = personFromCustomField(
    input.offerCustomFields,
    ["approver_name", "offer_approver", "approver", "approved_by"],
    input.usersById
  )
  if (custom) return custom

  const records =
    input.approversByOfferId.get(input.offerId) ??
    input.approversByApplicationId.get(input.applicationId) ??
    []
  const record = selectApprover(records)
  return record
    ? resolvePerson(
        record.approved_by ?? record.approver,
        record.approved_by_id ?? record.approver_id ?? record.user_id,
        input.usersById
      )
    : null
}

function selectApprover(
  records: readonly HarvestOfferApproverRecord[]
): HarvestOfferApproverRecord | undefined {
  const withIdentity = records.filter(
    (record) =>
      record.approved_by ||
      record.approver ||
      optionalId(record.approved_by_id ?? record.approver_id ?? record.user_id)
  )
  return [...withIdentity].sort((left, right) => {
    const leftApproved = timestampRank(left.approved_at)
    const rightApproved = timestampRank(right.approved_at)
    if (leftApproved !== rightApproved) return rightApproved - leftApproved
    return optionalText(left.status)?.localeCompare(optionalText(right.status) ?? "") ?? 0
  })[0]
}

function hodForDepartmentOrRecruiter(input: {
  departmentId: string | null
  departmentName: string | null
  departmentHodById: ReadonlyMap<string, GovernedDepartmentHodRecord>
  departmentHodByName: ReadonlyMap<string, GovernedDepartmentHodRecord>
  recruiterName: string | null
  recruiterRoster: readonly RecruiterTeamHodEntry[]
}): OfferLifecyclePersonSource | null {
  const governed =
    (input.departmentId ? input.departmentHodById.get(input.departmentId) : undefined) ??
    (input.departmentName
      ? input.departmentHodByName.get(input.departmentName.toLowerCase())
      : undefined)
  if (governed) {
    const id = optionalId(governed.hod_id)
    const name = optionalText(governed.hod_name)
    return id || name ? { id, name } : null
  }
  const resolution = resolveTeam({ recruiterName: input.recruiterName }, input.recruiterRoster)
  return resolution.status === "resolved" && resolution.hod_name
    ? { name: resolution.hod_name }
    : null
}

function resolvePerson(
  person: HarvestPersonRef | null | undefined,
  idValue: OfferLifecycleId | null | undefined,
  usersById: ReadonlyMap<string, HarvestUserRecord>
): OfferLifecyclePersonSource | null {
  const id = optionalId(idValue ?? person?.id)
  const user = id ? usersById.get(id) : undefined
  const name = personName(person) ?? userName(user)
  return id || name ? { id, name } : null
}

function personFromCustomField(
  fields: readonly OfferLifecycleCustomFieldSource[],
  aliases: readonly string[],
  usersById: ReadonlyMap<string, HarvestUserRecord>
): OfferLifecyclePersonSource | null {
  const field = findCustomField(fields, aliases)
  if (!field) return null
  return personFromJsonValue(field.value, usersById)
}

function personFromJsonValue(
  value: OfferLifecycleJsonValue,
  usersById: ReadonlyMap<string, HarvestUserRecord>
): OfferLifecyclePersonSource | null {
  if (Array.isArray(value)) {
    if (value.length > 1) {
      throw new Error("Harvest offer lifecycle join has an ambiguous offer person custom field")
    }
    return value.length === 1 ? personFromJsonValue(value[0], usersById) : null
  }
  if (isJsonObject(value)) {
    const id = jsonId(value.id)
    const joinedName = [jsonText(value.first_name), jsonText(value.last_name)]
      .filter(Boolean)
      .join(" ")
      .trim()
    const name = jsonText(value.name) ?? optionalText(joinedName)
    return resolvePerson(name ? { id: id ?? undefined, name } : undefined, id, usersById)
  }
  if (typeof value === "number") return resolvePerson(undefined, value, usersById)
  if (typeof value === "string") {
    const text = optionalText(value)
    if (!text) return null
    const matchedUser = usersById.get(text)
    return matchedUser ? resolvePerson(undefined, text, usersById) : { name: text }
  }
  return null
}

function mergeCustomFields(
  fields: HarvestCustomFieldCollection | undefined,
  keyedFields: HarvestCustomFieldCollection | undefined
): OfferLifecycleCustomFieldSource[] {
  const merged = new Map<string, OfferLifecycleCustomFieldSource>()
  for (const field of [...customFieldsOf(fields), ...customFieldsOf(keyedFields)]) {
    merged.set(`${normalizeKey(field.key ?? field.name)}|${normalizeKey(field.name)}`, field)
  }
  return [...merged.values()].sort((left, right) =>
    [left.key ?? "", left.name].join("|").localeCompare([right.key ?? "", right.name].join("|"))
  )
}

function customFieldsOf(
  fields: HarvestCustomFieldCollection | undefined
): OfferLifecycleCustomFieldSource[] {
  if (!fields) return []
  if (Array.isArray(fields)) {
    return fields.flatMap((field) => {
      const name = optionalText(field.name)
      const value = jsonValue(field.value)
      if (!name || value === undefined) return []
      return [{ key: optionalText(field.key), name, type: optionalText(field.type), value }]
    })
  }
  return Object.entries(fields).flatMap(([key, raw]) => {
    const record = isRecord(raw) ? raw : undefined
    const name = optionalText(typeof record?.name === "string" ? record.name : key)
    const type = optionalText(typeof record?.type === "string" ? record.type : undefined)
    const value = jsonValue(record && "value" in record ? record.value : raw)
    if (!name || value === undefined) return []
    return [{ key, name, type, value }]
  })
}

function customFieldText(
  fields: readonly OfferLifecycleCustomFieldSource[],
  aliases: readonly string[]
): string | null {
  const value = findCustomField(fields, aliases)?.value
  if (typeof value === "string") return optionalText(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string")
    return parts.length ? parts.join(", ") : null
  }
  return null
}

function findCustomField(
  fields: readonly OfferLifecycleCustomFieldSource[],
  aliases: readonly string[]
): OfferLifecycleCustomFieldSource | undefined {
  const keys = new Set(aliases.map(normalizeKey))
  return fields.find(
    (field) => keys.has(normalizeKey(field.key ?? "")) || keys.has(normalizeKey(field.name))
  )
}

function indexById<T>(
  rows: readonly T[],
  idOf: (row: T) => OfferLifecycleId | null | undefined,
  entity: string
): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    const id = optionalId(idOf(row))
    if (!id) continue
    if (result.has(id)) throw new Error(`Harvest offer lifecycle join has duplicate ${entity} ids`)
    result.set(id, row)
  }
  return result
}

function indexByText<T>(
  rows: readonly T[],
  textOf: (row: T) => string | null | undefined,
  entity: string
): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    const key = optionalText(textOf(row))?.toLowerCase()
    if (!key) continue
    if (result.has(key)) throw new Error(`Harvest offer lifecycle join has duplicate ${entity} names`)
    result.set(key, row)
  }
  return result
}

function groupById<T>(
  rows: readonly T[],
  idOf: (row: T) => OfferLifecycleId | null | undefined
): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const row of rows) {
    const id = optionalId(idOf(row))
    if (!id) continue
    const group = result.get(id) ?? []
    group.push(row)
    result.set(id, group)
  }
  return result
}

function requireId(value: OfferLifecycleId | null | undefined, field: string): string {
  const id = optionalId(value)
  if (!id) throw new Error(`${field} is required for the Harvest offer lifecycle join`)
  return id
}

function assertOptionalJoinedId(
  value: OfferLifecycleId | null | undefined,
  expected: string,
  entity: string
): void {
  const id = optionalId(value)
  if (id && id !== expected) {
    throw new Error(`Harvest offer lifecycle join has a mismatched offer ${entity}`)
  }
}

function optionalId(value: OfferLifecycleId | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return optionalText(String(value))
}

function requireText(value: string | null | undefined, field: string): string {
  const text = optionalText(value)
  if (!text) throw new Error(`${field} is required for the Harvest offer lifecycle join`)
  return text
}

function optionalText(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text ? text : null
}

function personName(person: HarvestPersonRef | null | undefined): string | null {
  return (
    optionalText(person?.name) ??
    optionalText([person?.first_name, person?.last_name].filter(Boolean).join(" "))
  )
}

function userName(user: HarvestUserRecord | undefined): string | null {
  return (
    optionalText(user?.name) ??
    optionalText([user?.first_name, user?.last_name].filter(Boolean).join(" "))
  )
}

function candidateName(candidate: HarvestOfferLifecycleCandidate): string | null {
  return (
    optionalText(candidate.name) ??
    optionalText([candidate.first_name, candidate.last_name].filter(Boolean).join(" "))
  )
}

function nestedNameOrText(
  value: string | { id?: OfferLifecycleId | null; key?: string | null; name?: string | null } | null | undefined
): string | null {
  return typeof value === "string"
    ? optionalText(value)
    : optionalText(value?.name) ?? optionalText(value?.key)?.replaceAll("_", " ") ?? null
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

function timestampRank(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function jsonId(value: OfferLifecycleJsonValue | undefined): OfferLifecycleId | null {
  return typeof value === "string" || typeof value === "number" ? value : null
}

function jsonText(value: OfferLifecycleJsonValue | undefined): string | null {
  return typeof value === "string" ? optionalText(value) : null
}

function jsonValue(value: unknown): OfferLifecycleJsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const normalized = jsonValue(entry)
      return normalized === undefined ? [] : [normalized]
    })
  }
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const normalized = jsonValue(entry)
      return normalized === undefined ? [] : [[key, normalized]]
    })
  )
}

function isJsonObject(
  value: OfferLifecycleJsonValue
): value is { readonly [key: string]: OfferLifecycleJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
