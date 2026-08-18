import {
  greenhouseGetAll,
  type GreenhouseRequestOptions,
} from "../greenhouse-client"
import {
  EMPLOYEE_REFERRAL_POLICY,
  resolveEmployeeReferralPolicy,
} from "./employee-referral-policy"

export const EMPLOYEE_REFERRAL_REPORT_TIME_ZONE = "America/Los_Angeles"

export type EmployeeReferralRecordType =
  | "CURRENT_ACCEPTED_COHORT"
  | "DEPRECATED_SIGNING_REVIEW"
  | "UNGOVERNED_REFERRAL_SOURCE_REVIEW"

export interface EmployeeReferralReportPeriod {
  periodStartLocal: string
  periodEndLocalExclusive: string
  windowStartUtc: string
  windowEndUtc: string
  timeZone: typeof EMPLOYEE_REFERRAL_REPORT_TIME_ZONE
  label: string
}

export type EmployeeReferralPreliminaryEligibility =
  | "PRELIMINARILY ELIGIBLE"
  | "PENDING - 90 DAYS NOT COMPLETED"
  | "LIKELY INELIGIBLE"
  | "NEEDS REVIEW"

export interface EmployeeReferralReportRow {
  recordType: EmployeeReferralRecordType
  rowKey: string
  candidateName: string | null
  offerResolvedAt: string | null
  greenhousePlannedStartDate: string | null
  currentApplicationStatus: string | null
  currentOfferStatus: string | null
  referringEmployeeName: string | null
  hiringManagerNames: string[]
  offerJobTitle: string | null
  offerJobFunction: string | null
  currentApplicationJob: string | null
  policyFunctionBand: string | null
  greenhouseHiringLocation: string | null
  policyCountry: string | null
  policyReferenceBonusAmount: number | null
  policyReferenceCurrency: string | null
  bonusResolutionStatus:
    | "PAYROLL_CONVERSION_REQUIRED - Payroll"
    | "POLICY_MAPPING_REQUIRED - Policy DRI/People Ops"
  preliminaryEligibility: EmployeeReferralPreliminaryEligibility
  eligibilityReason: string
  estimatedNinetyDayDate: string | null
  mappingReviewStatusReason: string
  greenhouseApplicationId: string
  greenhouseOfferIdAndVersion: string
}

export interface EmployeeReferralReportCounts {
  currentCohortCount: number
  deprecatedReviewCount: number
  ungovernedSourceReviewCount: number
  amountMappedCount: number
  mappingReviewCount: number
  totalRowCount: number
}

export interface EmployeeReferralReport {
  period: EmployeeReferralReportPeriod
  rows: EmployeeReferralReportRow[]
  counts: EmployeeReferralReportCounts
  observedReferralSourceIds: string[]
  policyVersion: string
  policyExportSha256: string
  subject: string
  html: string
  csv: string
  publicDiagnostics: {
    correlationId: string
    periodStartLocal: string
    periodEndLocalExclusive: string
    policyVersion: string
    currentCohortCount: number
    deprecatedReviewCount: number
    ungovernedSourceReviewCount: number
    mappingReviewCount: number
    totalRowCount: number
  }
}

export type GreenhouseId = string | number

export interface EmployeeReferralRawOffer {
  id?: GreenhouseId | null
  version?: GreenhouseId | null
  resolved_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  application_id?: GreenhouseId | null
  opening_id?: GreenhouseId | null
  starts_on?: string | null
  job_id?: GreenhouseId | null
  status?: string | null
  candidate_id?: GreenhouseId | null
  custom_fields?: Readonly<Record<string, unknown>> | readonly unknown[] | null
}

export interface EmployeeReferralRawApplication {
  id?: GreenhouseId | null
  candidate_id?: GreenhouseId | null
  job_id?: GreenhouseId | null
  status?: string | null
  source_id?: GreenhouseId | null
  referrer_id?: GreenhouseId | null
}

export interface EmployeeReferralRawCandidate {
  id?: GreenhouseId | null
  first_name?: string | null
  last_name?: string | null
}

export interface EmployeeReferralRawJob {
  id?: GreenhouseId | null
  name?: string | null
  department_id?: GreenhouseId | null
  custom_fields?:
    | Readonly<Record<string, unknown>>
    | readonly {
        name?: string | null
        name_key?: string | null
        value?: unknown
      }[]
    | null
}

export interface EmployeeReferralRawDepartment {
  id?: GreenhouseId | null
  name?: string | null
}

export interface EmployeeReferralRawReferrer {
  id?: GreenhouseId | null
  user_id?: GreenhouseId | null
  name?: string | null
}

export interface EmployeeReferralRawJobOwner {
  id?: GreenhouseId | null
  user_id?: GreenhouseId | null
  job_id?: GreenhouseId | null
  type?: string | null
  responsible?: boolean | null
}

export interface EmployeeReferralRawUser {
  id?: GreenhouseId | null
  name?: string | null
  first_name?: string | null
  last_name?: string | null
  deactivated?: boolean | null
}

export interface EmployeeReferralRawSource {
  id?: GreenhouseId | null
  name?: string | null
  type?:
    | string
    | {
        id?: GreenhouseId | null
        name?: string | null
      }
    | null
}

export interface EmployeeReferralRawCustomField {
  id?: GreenhouseId | null
  name?: string | null
  name_key?: string | null
  field_type?: string | { name?: string | null } | null
  entity?: string | null
  active?: boolean | null
}

export interface EmployeeReferralSnapshot {
  period: EmployeeReferralReportPeriod
  currentOffers: EmployeeReferralRawOffer[]
  allVersionOffers: EmployeeReferralRawOffer[]
  applications: EmployeeReferralRawApplication[]
  candidates: EmployeeReferralRawCandidate[]
  jobs: EmployeeReferralRawJob[]
  departments: EmployeeReferralRawDepartment[]
  referrers: EmployeeReferralRawReferrer[]
  jobOwners?: EmployeeReferralRawJobOwner[]
  users?: EmployeeReferralRawUser[]
  sources: EmployeeReferralRawSource[]
  customFields: EmployeeReferralRawCustomField[]
}

export type EmployeeReferralGreenhouseGetAll = <T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  options?: GreenhouseRequestOptions
) => Promise<T[]>

const OFFER_FIELDS =
  "id,version,resolved_at,created_at,updated_at,application_id,opening_id,starts_on,job_id,status,candidate_id,custom_fields"

const CSV_COLUMNS: readonly {
  header: string
  value: (row: EmployeeReferralReportRow) => string | number | null
}[] = [
  { header: "record_type", value: (row) => row.recordType },
  { header: "candidate_name", value: (row) => row.candidateName },
  { header: "offer_resolved_date", value: (row) => row.offerResolvedAt },
  {
    header: "greenhouse_planned_start_date",
    value: (row) => row.greenhousePlannedStartDate,
  },
  { header: "current_application_status", value: (row) => row.currentApplicationStatus },
  { header: "current_offer_status", value: (row) => row.currentOfferStatus },
  { header: "referring_employee_name", value: (row) => row.referringEmployeeName },
  {
    header: "hiring_manager_names",
    value: (row) => row.hiringManagerNames.join(" | "),
  },
  { header: "offer_job_title", value: (row) => row.offerJobTitle },
  { header: "offer_job_function", value: (row) => row.offerJobFunction },
  { header: "current_application_job", value: (row) => row.currentApplicationJob },
  { header: "policy_function_band", value: (row) => row.policyFunctionBand },
  { header: "greenhouse_hiring_location", value: (row) => row.greenhouseHiringLocation },
  { header: "policy_country", value: (row) => row.policyCountry },
  {
    header: "policy_reference_bonus_amount",
    value: (row) => row.policyReferenceBonusAmount,
  },
  { header: "policy_reference_currency", value: (row) => row.policyReferenceCurrency },
  { header: "bonus_resolution_status_owner", value: (row) => row.bonusResolutionStatus },
  {
    header: "preliminary_eligibility",
    value: (row) => row.preliminaryEligibility,
  },
  {
    header: "eligibility_reason",
    value: (row) => row.eligibilityReason,
  },
  {
    header: "estimated_90_day_date",
    value: (row) => row.estimatedNinetyDayDate,
  },
  { header: "mapping_review_status_reason", value: (row) => row.mappingReviewStatusReason },
  { header: "greenhouse_application_id", value: (row) => row.greenhouseApplicationId },
  {
    header: "greenhouse_offer_id_and_version",
    value: (row) => row.greenhouseOfferIdAndVersion,
  },
] as const

export function createEmployeeReferralReportPeriod(
  periodStartLocal: string,
  periodEndLocalExclusive: string
): EmployeeReferralReportPeriod {
  assertMonthBoundary(periodStartLocal, "period start")
  assertMonthBoundary(periodEndLocalExclusive, "period end")
  if (periodEndLocalExclusive <= periodStartLocal) {
    throw new Error("Employee referral report period end must be after start")
  }
  return {
    periodStartLocal,
    periodEndLocalExclusive,
    windowStartUtc: localMidnightToUtc(periodStartLocal),
    windowEndUtc: localMidnightToUtc(periodEndLocalExclusive),
    timeZone: EMPLOYEE_REFERRAL_REPORT_TIME_ZONE,
    label: periodLabel(periodStartLocal, periodEndLocalExclusive),
  }
}

export function createPreviousEmployeeReferralMonth(
  now: Date = new Date()
): EmployeeReferralReportPeriod {
  const local = datePartsInZone(now)
  const currentMonthStart = `${local.year}-${two(local.month)}-01`
  const previousMonthDate = new Date(Date.UTC(local.year, local.month - 2, 1))
  const previousMonthStart = `${previousMonthDate.getUTCFullYear()}-${two(
    previousMonthDate.getUTCMonth() + 1
  )}-01`
  return createEmployeeReferralReportPeriod(previousMonthStart, currentMonthStart)
}

export function employeeReferralLocalDate(now: Date = new Date()): string {
  const local = datePartsInZone(now)
  return `${local.year}-${two(local.month)}-${two(local.day)}`
}

export function employeeReferralLocalDateTimeToUtc(
  localDate: string,
  hour: number,
  minute = 0
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error("Employee referral local date must use YYYY-MM-DD")
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("Employee referral local hour must be between 0 and 23")
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("Employee referral local minute must be between 0 and 59")
  }
  const [year, month, day] = localDate.split("-").map(Number)
  const targetWallClock = Date.UTC(year, month - 1, day, hour, minute, 0)
  let candidate = targetWallClock
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = datePartsInZone(new Date(candidate))
    const representedWallClock = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    )
    candidate += targetWallClock - representedWallClock
  }
  const verified = datePartsInZone(new Date(candidate))
  if (
    verified.year !== year ||
    verified.month !== month ||
    verified.day !== day ||
    verified.hour !== hour ||
    verified.minute !== minute ||
    verified.second !== 0
  ) {
    throw new Error(
      `Could not resolve ${localDate} ${two(hour)}:${two(minute)} in ${EMPLOYEE_REFERRAL_REPORT_TIME_ZONE}`
    )
  }
  return new Date(candidate).toISOString()
}

export async function loadEmployeeReferralSnapshot(
  period: EmployeeReferralReportPeriod,
  getAll: EmployeeReferralGreenhouseGetAll = greenhouseGetAll,
  requestOptions: GreenhouseRequestOptions = {}
): Promise<EmployeeReferralSnapshot> {
  validatePeriod(period)
  const offerParams = {
    per_page: 500,
    "resolved_at[gte]": period.windowStartUtc,
    "resolved_at[lt]": period.windowEndUtc,
    fields: OFFER_FIELDS,
  } as const

  const [currentOffers, allVersionOffers, sources, customFields] = await Promise.all([
    getAll<EmployeeReferralRawOffer>("/offers", {
      ...offerParams,
      status: "Accepted",
      current_only: true,
    }, requestOptions),
    getAll<EmployeeReferralRawOffer>("/offers", {
      ...offerParams,
      current_only: false,
    }, requestOptions),
    getAll<EmployeeReferralRawSource>("/sources", {
      per_page: 500,
      fields: "id,name,type",
    }, requestOptions),
    getAll<EmployeeReferralRawCustomField>(
      "/custom_fields",
      { per_page: 500 },
      requestOptions
    ),
  ])

  const deprecatedOffers = allVersionOffers.filter(
    (offer) => offer.status?.toLocaleLowerCase("en-US") === "deprecated"
  )
  const scannedOffers = [...currentOffers, ...deprecatedOffers]
  const applicationIds = scannedOffers.map((offer) => requiredOfferApplicationId(offer))
  const applications = await loadIdBatches<EmployeeReferralRawApplication>(
    getAll,
    "/applications",
    applicationIds,
    "id,candidate_id,job_id,status,source_id,referrer_id",
    requestOptions
  )
  const applicationsById = indexRows(applications, "application")
  for (const offer of scannedOffers) {
    const applicationId = requiredOfferApplicationId(offer)
    if (!applicationsById.has(applicationId)) {
      throw new Error(`Incomplete Greenhouse extraction: unresolved application ${applicationId}`)
    }
  }

  const candidateIds = uniqueIds([
    ...applications.map((application) => idString(application.candidate_id)),
    ...scannedOffers.map((offer) => idString(offer.candidate_id)),
  ])
  const jobIds = uniqueIds([
    ...applications.map((application) => idString(application.job_id)),
    ...scannedOffers.map((offer) => idString(offer.job_id)),
  ])
  const referrerIds = uniqueIds(applications.map((application) => idString(application.referrer_id)))

  const [candidates, jobs, referrers, allJobOwners] = await Promise.all([
    loadIdBatches<EmployeeReferralRawCandidate>(
      getAll,
      "/candidates",
      candidateIds,
      "id,first_name,last_name",
      requestOptions
    ),
    loadIdBatches<EmployeeReferralRawJob>(
      getAll,
      "/jobs",
      jobIds,
      "id,name,department_id,custom_fields",
      requestOptions
    ),
    loadIdBatches<EmployeeReferralRawReferrer>(
      getAll,
      "/referrers",
      referrerIds,
      "id,user_id,name",
      requestOptions
    ),
    getAll<EmployeeReferralRawJobOwner>(
      "/job_owners",
      { per_page: 500, fields: "id,user_id,job_id,type,responsible" },
      requestOptions
    ),
  ])
  const jobIdSet = new Set(jobIds)
  const jobOwners = allJobOwners.filter((owner) => {
    const jobId = idString(owner.job_id)
    return jobId !== null && jobIdSet.has(jobId)
  })
  const userIds = uniqueIds([
    ...jobOwners.map((owner) => idString(owner.user_id)),
    ...referrers.map((referrer) => idString(referrer.user_id)),
  ])
  const users = await loadIdBatches<EmployeeReferralRawUser>(
    getAll,
    "/users",
    userIds,
    "id,name,first_name,last_name,deactivated",
    requestOptions
  )
  const departmentIds = uniqueIds(jobs.map((job) => idString(job.department_id)))
  const departments = await loadIdBatches<EmployeeReferralRawDepartment>(
    getAll,
    "/departments",
    departmentIds,
    "id,name",
    requestOptions
  )

  return {
    period,
    currentOffers,
    allVersionOffers,
    applications,
    candidates,
    jobs,
    departments,
    referrers,
    jobOwners,
    users,
    sources,
    customFields,
  }
}

export interface EmployeeReferralReportBuildOptions {
  correlationId?: string
  revision?: number
  supersedesRevision?: number | null
  assessmentDateLocal?: string
  masterSpreadsheetId?: string | null
}

export function buildEmployeeReferralReport(
  snapshot: EmployeeReferralSnapshot,
  options: EmployeeReferralReportBuildOptions = {}
): EmployeeReferralReport {
  validatePeriod(snapshot.period)
  const correlationId = options.correlationId?.trim() || "not-supplied"
  const assessmentDateLocal =
    options.assessmentDateLocal ?? employeeReferralLocalDate()
  assertDateOnly(assessmentDateLocal, "eligibility assessment date")
  const sourcesById = indexRows(snapshot.sources, "source")
  const applicationsById = indexRows(snapshot.applications, "application")
  const candidatesById = indexRows(snapshot.candidates, "candidate")
  const jobsById = indexRows(snapshot.jobs, "job")
  const departmentsById = indexRows(snapshot.departments, "department")
  const referrersById = indexRows(snapshot.referrers, "referrer")
  const usersById = indexRows(snapshot.users ?? [], "user")
  const jobOwnersByJobId = groupJobOwnersByJobId(snapshot.jobOwners ?? [])
  validateGovernedSources(sourcesById)
  validateStableHiringLocationField(snapshot.customFields)
  for (const offer of [...snapshot.currentOffers, ...snapshot.allVersionOffers]) {
    validateOfferResolvedAt(offer, snapshot.period)
  }

  const referralSourceIds = [...sourcesById.values()]
    .filter(isReferralSource)
    .map((source) => requiredId(source.id, "source"))
    .sort(compareIds)
  const referralSourceIdSet = new Set(referralSourceIds)
  const governedSourceIdSet = new Set<string>(EMPLOYEE_REFERRAL_POLICY.governedSourceIds)

  const selected: {
    recordType: EmployeeReferralRecordType
    offer: EmployeeReferralRawOffer
    application: EmployeeReferralRawApplication
  }[] = []

  for (const offer of snapshot.currentOffers) {
    if (offer.status?.toLocaleLowerCase("en-US") !== "accepted") {
      throw new Error("Incomplete Greenhouse extraction: current offer query returned non-Accepted row")
    }
    const application = resolveOfferApplication(offer, applicationsById)
    const sourceId = referencedSourceId(application, sourcesById)
    if (!sourceId || !referralSourceIdSet.has(sourceId)) continue
    selected.push({
      recordType: governedSourceIdSet.has(sourceId)
        ? "CURRENT_ACCEPTED_COHORT"
        : "UNGOVERNED_REFERRAL_SOURCE_REVIEW",
      offer,
      application,
    })
  }

  for (const offer of snapshot.allVersionOffers) {
    if (offer.status?.toLocaleLowerCase("en-US") !== "deprecated") continue
    const application = resolveOfferApplication(offer, applicationsById)
    const sourceId = referencedSourceId(application, sourcesById)
    if (!sourceId || !referralSourceIdSet.has(sourceId)) continue
    selected.push({ recordType: "DEPRECATED_SIGNING_REVIEW", offer, application })
  }

  const duplicateCurrentCandidateIds = findDuplicateCurrentCandidateIds(selected)
  const rows = selected.map(({ recordType, offer, application }) =>
    buildRow({
      recordType,
      offer,
      application,
      governedSourceIdSet,
      candidatesById,
      jobsById,
      departmentsById,
      referrersById,
      usersById,
      jobOwnersByJobId,
      duplicateCurrentCandidateIds,
      assessmentDateLocal,
    })
  )
  rows.sort(compareRows)
  assertUniqueRows(rows)

  const counts: EmployeeReferralReportCounts = {
    currentCohortCount: rows.filter((row) => row.recordType === "CURRENT_ACCEPTED_COHORT")
      .length,
    deprecatedReviewCount: rows.filter(
      (row) => row.recordType === "DEPRECATED_SIGNING_REVIEW"
    ).length,
    ungovernedSourceReviewCount: rows.filter(
      (row) => row.recordType === "UNGOVERNED_REFERRAL_SOURCE_REVIEW"
    ).length,
    amountMappedCount: rows.filter((row) => row.policyReferenceBonusAmount !== null).length,
    mappingReviewCount: rows.filter((row) => row.mappingReviewStatusReason !== "NONE").length,
    totalRowCount: rows.length,
  }
  if (
    counts.totalRowCount !==
    counts.currentCohortCount +
      counts.deprecatedReviewCount +
      counts.ungovernedSourceReviewCount
  ) {
    throw new Error("Employee referral report typed-row count invariant failed")
  }

  const subject = subjectFor(snapshot.period, counts, options)
  const csv = renderEmployeeReferralCsv(rows)
  const html = renderEmployeeReferralHtml({
    period: snapshot.period,
    rows,
    counts,
    observedReferralSourceIds: referralSourceIds,
    subject,
    revision: options.revision ?? 1,
    supersedesRevision: options.supersedesRevision ?? null,
    masterSpreadsheetId: options.masterSpreadsheetId ?? null,
  })
  return {
    period: snapshot.period,
    rows,
    counts,
    observedReferralSourceIds: referralSourceIds,
    policyVersion: EMPLOYEE_REFERRAL_POLICY.version,
    policyExportSha256: EMPLOYEE_REFERRAL_POLICY.sourceDocumentExportSha256,
    subject,
    html,
    csv,
    publicDiagnostics: {
      correlationId,
      periodStartLocal: snapshot.period.periodStartLocal,
      periodEndLocalExclusive: snapshot.period.periodEndLocalExclusive,
      policyVersion: EMPLOYEE_REFERRAL_POLICY.version,
      currentCohortCount: counts.currentCohortCount,
      deprecatedReviewCount: counts.deprecatedReviewCount,
      ungovernedSourceReviewCount: counts.ungovernedSourceReviewCount,
      mappingReviewCount: counts.mappingReviewCount,
      totalRowCount: counts.totalRowCount,
    },
  }
}

export function renderEmployeeReferralCsv(rows: readonly EmployeeReferralReportRow[]): string {
  const header = CSV_COLUMNS.map((column) => csvCell(column.header)).join(",")
  const body = rows.map((row) =>
    CSV_COLUMNS.map((column) => {
      const value = column.value(row)
      return typeof value === "number" ? String(value) : csvCell(value ?? "")
    }).join(",")
  )
  return [header, ...body].join("\r\n") + "\r\n"
}

export function renderEmployeeReferralHtml(input: {
  period: EmployeeReferralReportPeriod
  rows: readonly EmployeeReferralReportRow[]
  counts: EmployeeReferralReportCounts
  observedReferralSourceIds: readonly string[]
  subject: string
  revision: number
  supersedesRevision: number | null
  masterSpreadsheetId: string | null
}): string {
  const current = input.rows.filter((row) => row.recordType === "CURRENT_ACCEPTED_COHORT")
  const review = input.rows.filter((row) => row.recordType !== "CURRENT_ACCEPTED_COHORT")
  const correction = input.supersedesRevision
    ? `<p><strong>CORRECTION:</strong> revision ${input.revision} supersedes revision ${input.supersedesRevision}.</p>`
    : ""
  const masterSheetLink = input.masterSpreadsheetId
    ? `<p><strong>Master referral tracker:</strong> <a href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(input.masterSpreadsheetId)}/edit">open the Google Sheet</a>. This month’s tab is keyed by offer-accepted month.</p>`
    : ""
  return [
    "<!doctype html>",
    '<html><body style="font-family:Arial,sans-serif;color:#202124">',
    `<h1>${htmlEscape(input.subject)}</h1>`,
    correction,
    masterSheetLink,
    `<p><strong>Reporting window:</strong> ${htmlEscape(input.period.periodStartLocal)} through ${htmlEscape(input.period.periodEndLocalExclusive)} (end exclusive), ${htmlEscape(input.period.timeZone)}. UTC: ${htmlEscape(input.period.windowStartUtc)} through ${htmlEscape(input.period.windowEndUtc)}.</p>`,
    `<p><strong>Source and policy:</strong> governed application source IDs ${htmlEscape(EMPLOYEE_REFERRAL_POLICY.governedSourceIds.join(", "))}; observed Referral-type source IDs ${htmlEscape(input.observedReferralSourceIds.join(", ") || "none")}; policy version ${htmlEscape(EMPLOYEE_REFERRAL_POLICY.version)}.</p>`,
    "<p>Application source is current as of extraction. Offer resolved date is a current Accepted-offer signed-date proxy only; Greenhouse planned start date is not proof of actual start.</p>",
    "<p><strong>This accepted-offer cohort is not payout authorization.</strong> The automated eligibility assessment is a first pass. People Ops owns the final decision and must verify active employment, actual start date, broader manager-chain exclusions, prior-candidate-history exclusions, and all other policy exclusions; Payroll must verify its cutoff and owns conversion to the referring employee's local currency.</p>",
    `<p><strong>Counts:</strong> ${input.counts.currentCohortCount} current cohort; ${input.counts.deprecatedReviewCount} Deprecated review; ${input.counts.ungovernedSourceReviewCount} ungoverned-source review; ${input.counts.amountMappedCount} amount mapped; ${input.counts.mappingReviewCount} mapping review; ${input.counts.totalRowCount} total.</p>`,
    "<h2>Current accepted Employee Referral cohort</h2>",
    current.length ? renderHtmlTable(current) : "<p>Zero current accepted employee referrals for this period.</p>",
    "<h2>Review appendix - acceptance or source mapping not proven</h2>",
    review.length ? renderHtmlTable(review) : "<p>Zero review rows for this period.</p>",
    "</body></html>",
  ].join("\n")
}

export function evaluateEmployeeReferralEligibility(input: {
  recordType: EmployeeReferralRecordType
  referringEmployeeName: string | null
  referringEmployeeDeactivated?: boolean | null
  referringEmployeeIsExecutiveOrElt?: boolean
  hiringManagerNames: readonly string[]
  offerJobTitle: string | null
  currentApplicationJob: string | null
  offerTenureType?: string | null
  offerAnticipatedEndDate?: string | null
  offerWorkStatus?: string | null
  offerWorkerType?: string | null
  offerEmploymentType?: string | null
  greenhousePlannedStartDate: string | null
  assessmentDateLocal: string
}): {
  status: EmployeeReferralPreliminaryEligibility
  reason: string
  estimatedNinetyDayDate: string | null
} {
  assertDateOnly(input.assessmentDateLocal, "eligibility assessment date")
  const estimatedNinetyDayDate = input.greenhousePlannedStartDate
    ? addDays(input.greenhousePlannedStartDate, 90)
    : null
  if (input.recordType !== "CURRENT_ACCEPTED_COHORT") {
    return {
      status: "NEEDS REVIEW",
      reason: "Offer or referral-source status requires review",
      estimatedNinetyDayDate,
    }
  }

  const likelyIneligibleReasons: string[] = []
  const referrer = normalizePersonName(input.referringEmployeeName)
  if (
    referrer &&
    input.hiringManagerNames.some(
      (manager) => normalizePersonName(manager) === referrer
    )
  ) {
    likelyIneligibleReasons.push("Referring employee is a listed hiring manager")
  }
  if (input.referringEmployeeDeactivated === true) {
    likelyIneligibleReasons.push("Referring employee is no longer active")
  }
  if (input.referringEmployeeIsExecutiveOrElt === true) {
    likelyIneligibleReasons.push("Referring employee is an executive or ELT member")
  }

  const jobText = [
    input.offerJobTitle,
    input.currentApplicationJob,
    input.offerWorkerType,
  ]
    .filter(Boolean)
    .join(" ")
  if (/\bintern(?:ship)?\b/i.test(jobText)) {
    likelyIneligibleReasons.push("Position is an internship")
  }
  if (/\bpart[\s-]*time\b/i.test(input.offerWorkStatus ?? "")) {
    likelyIneligibleReasons.push("Offer is part-time")
  }
  if (
    /\bcontract(?:or)?\b/i.test(
      [input.offerTenureType, input.offerWorkerType, input.offerEmploymentType]
        .filter(Boolean)
        .join(" ")
    )
  ) {
    likelyIneligibleReasons.push("Offer is for a contractor")
  }
  if (likelyIneligibleReasons.length > 0) {
    return {
      status: "LIKELY INELIGIBLE",
      reason: likelyIneligibleReasons.join("; "),
      estimatedNinetyDayDate,
    }
  }

  const reviewReasons: string[] = []
  if (trimmed(input.offerAnticipatedEndDate)) {
    reviewReasons.push(
      `Offer has an anticipated end date (${trimmed(input.offerAnticipatedEndDate)})`
    )
  }
  if (/\bfixed[\s-]*term\b|\btemporary\b/i.test(input.offerTenureType ?? "")) {
    reviewReasons.push(`Offer tenure is ${trimmed(input.offerTenureType)}`)
  }

  if (input.hiringManagerNames.length === 0) {
    reviewReasons.push("Hiring manager is unavailable")
  }
  if (reviewReasons.length > 0) {
    return {
      status: "NEEDS REVIEW",
      reason: reviewReasons.join("; "),
      estimatedNinetyDayDate,
    }
  }
  if (!estimatedNinetyDayDate) {
    return {
      status: "NEEDS REVIEW",
      reason: "Planned start date is unavailable",
      estimatedNinetyDayDate: null,
    }
  }
  if (input.assessmentDateLocal < estimatedNinetyDayDate) {
    return {
      status: "PENDING - 90 DAYS NOT COMPLETED",
      reason: `Estimated 90-day date is ${estimatedNinetyDayDate}`,
      estimatedNinetyDayDate,
    }
  }
  return {
    status: "PRELIMINARILY ELIGIBLE",
    reason:
      "No automated exclusion found; confirm active employment and manager chain before payout",
    estimatedNinetyDayDate,
  }
}

function buildRow(input: {
  recordType: EmployeeReferralRecordType
  offer: EmployeeReferralRawOffer
  application: EmployeeReferralRawApplication
  governedSourceIdSet: ReadonlySet<string>
  candidatesById: ReadonlyMap<string, EmployeeReferralRawCandidate>
  jobsById: ReadonlyMap<string, EmployeeReferralRawJob>
  departmentsById: ReadonlyMap<string, EmployeeReferralRawDepartment>
  referrersById: ReadonlyMap<string, EmployeeReferralRawReferrer>
  usersById: ReadonlyMap<string, EmployeeReferralRawUser>
  jobOwnersByJobId: ReadonlyMap<string, readonly EmployeeReferralRawJobOwner[]>
  duplicateCurrentCandidateIds: ReadonlySet<string>
  assessmentDateLocal: string
}): EmployeeReferralReportRow {
  const { offer, application, recordType } = input
  const offerId = requiredId(offer.id, "offer")
  const applicationId = requiredId(application.id, "application")
  const version = requiredId(offer.version, "offer version")
  const reasons: string[] = []

  const offerCandidateId = idString(offer.candidate_id)
  const applicationCandidateId = idString(application.candidate_id)
  if (offerCandidateId && applicationCandidateId && offerCandidateId !== applicationCandidateId) {
    throw new Error(
      `Incomplete Greenhouse extraction: offer/application candidate mismatch for application ${applicationId}`
    )
  }
  const offerCandidate = resolveReferenced(
    offerCandidateId,
    input.candidatesById,
    "offer candidate",
    offerCandidateId !== null
  )
  const applicationCandidate = resolveReferenced(
    applicationCandidateId,
    input.candidatesById,
    "application candidate",
    applicationCandidateId !== null
  )
  const candidateId = offerCandidateId ?? applicationCandidateId
  const candidate = offerCandidate ?? applicationCandidate
  if (
    recordType !== "DEPRECATED_SIGNING_REVIEW" &&
    candidateId &&
    input.duplicateCurrentCandidateIds.has(candidateId)
  ) {
    reasons.push("MULTIPLE_CURRENT_ACCEPTED_OFFERS_OR_APPLICATIONS_FOR_CANDIDATE")
  }
  const candidateName = joinName(candidate?.first_name, candidate?.last_name)
  if (!candidateName) reasons.push("CANDIDATE_NAME_MISSING")

  const offerJobId = idString(offer.job_id)
  const offerJob = resolveReferenced(offerJobId, input.jobsById, "offer job", offerJobId !== null)
  const applicationJobId = idString(application.job_id)
  const applicationJob = resolveReferenced(
    applicationJobId,
    input.jobsById,
    "application job",
    applicationJobId !== null
  )
  if (offerJobId && applicationJobId && offerJobId !== applicationJobId) {
    reasons.push(`CURRENT_APPLICATION_JOB_MISMATCH:${applicationJobId}`)
  }
  if (!offerJobId) reasons.push("OFFER_JOB_MISSING")
  const offerJobTitle =
    readCustomFieldText(offer.custom_fields, "job_title") ??
    trimmed(offerJob?.name)
  if (!offerJobTitle) reasons.push("OFFER_JOB_TITLE_MISSING")

  const departmentId = idString(offerJob?.department_id)
  const department = resolveReferenced(
    departmentId,
    input.departmentsById,
    "department",
    departmentId !== null
  )
  if (departmentId && !trimmed(department?.name)) reasons.push("OFFER_JOB_DEPARTMENT_NAME_MISSING")

  const referrerId = idString(application.referrer_id)
  const referrer = resolveReferenced(
    referrerId,
    input.referrersById,
    "referrer",
    referrerId !== null
  )
  if (!referrerId) reasons.push("REFERRER_MISSING")
  if (referrerId && !trimmed(referrer?.name)) reasons.push("REFERRER_NAME_MISSING")
  const referrerUserId = idString(referrer?.user_id)
  if (referrer && referrerUserId === null) reasons.push("REFERRER_USER_ID_NULL")
  const referrerUser = referrerUserId
    ? input.usersById.get(referrerUserId) ?? null
    : null
  if (referrerUser?.deactivated === true) reasons.push("REFERRER_DEACTIVATED")
  if (
    referrerUserId &&
    EMPLOYEE_REFERRAL_POLICY.ineligibleExecutiveOrEltReferrerUserIds.some(
      (userId) => userId === referrerUserId
    )
  ) {
    reasons.push("REFERRER_EXECUTIVE_OR_ELT")
  }

  const hiringManagerNames = resolveHiringManagerNames({
    jobId: offerJobId,
    job: offerJob,
    offerCustomFields: offer.custom_fields,
    jobOwnersByJobId: input.jobOwnersByJobId,
    usersById: input.usersById,
  })
  if (hiringManagerNames.length === 0) reasons.push("HIRING_MANAGER_MISSING")

  const employment = readOfferEmploymentFields(offer.custom_fields)
  if (employment.anticipatedEndDate) {
    reasons.push(`OFFER_ANTICIPATED_END_DATE:${employment.anticipatedEndDate}`)
  }
  const location = readHiringLocation(offer.custom_fields)
  reasons.push(...location.reviewReasons)
  const policy = resolveEmployeeReferralPolicy({
    acceptedDate: offer.resolved_at ?? null,
    hiringLocation: location.value,
    departmentId,
  })
  reasons.push(...policy.reviewReasons)
  if (!trimmed(offer.starts_on)) reasons.push("GREENHOUSE_PLANNED_START_DATE_MISSING")

  const sourceId = idString(application.source_id)
  if (recordType === "DEPRECATED_SIGNING_REVIEW") {
    reasons.push("DEPRECATED_OFFER_ACCEPTANCE_UNKNOWN")
    if (sourceId && !input.governedSourceIdSet.has(sourceId)) {
      reasons.push(`UNGOVERNED_REFERRAL_SOURCE:${sourceId}`)
    }
  } else if (recordType === "UNGOVERNED_REFERRAL_SOURCE_REVIEW") {
    reasons.push(`UNGOVERNED_REFERRAL_SOURCE:${sourceId ?? "missing"}`)
  }

  const amountAllowed = recordType === "CURRENT_ACCEPTED_COHORT"
  const eligibility = evaluateEmployeeReferralEligibility({
    recordType,
    referringEmployeeName: trimmed(referrer?.name),
    referringEmployeeDeactivated: referrerUser?.deactivated ?? null,
    referringEmployeeIsExecutiveOrElt:
      referrerUserId !== null &&
      EMPLOYEE_REFERRAL_POLICY.ineligibleExecutiveOrEltReferrerUserIds.some(
        (userId) => userId === referrerUserId
      ),
    hiringManagerNames,
    offerJobTitle,
    currentApplicationJob: trimmed(applicationJob?.name),
    offerTenureType: employment.tenureType,
    offerAnticipatedEndDate: employment.anticipatedEndDate,
    offerWorkStatus: employment.workStatus,
    offerWorkerType: employment.workerType,
    offerEmploymentType: employment.employmentType,
    greenhousePlannedStartDate: trimmed(offer.starts_on),
    assessmentDateLocal: input.assessmentDateLocal,
  })
  const uniqueReasons = [...new Set(reasons)]
  return {
    recordType,
    rowKey: `${recordType}:${offerId}:${version}:${applicationId}`,
    candidateName,
    offerResolvedAt: trimmed(offer.resolved_at),
    greenhousePlannedStartDate: trimmed(offer.starts_on),
    currentApplicationStatus: trimmed(application.status),
    currentOfferStatus: trimmed(offer.status),
    referringEmployeeName: trimmed(referrer?.name),
    hiringManagerNames,
    offerJobTitle,
    offerJobFunction: trimmed(department?.name),
    currentApplicationJob: trimmed(applicationJob?.name),
    policyFunctionBand: policy.functionBandLabel,
    greenhouseHiringLocation: location.value,
    policyCountry: policy.country,
    policyReferenceBonusAmount: amountAllowed ? policy.amount : null,
    policyReferenceCurrency: amountAllowed ? policy.currency : null,
    bonusResolutionStatus: amountAllowed
      ? policy.bonusResolutionStatus
      : "POLICY_MAPPING_REQUIRED - Policy DRI/People Ops",
    preliminaryEligibility: eligibility.status,
    eligibilityReason: eligibility.reason,
    estimatedNinetyDayDate: eligibility.estimatedNinetyDayDate,
    mappingReviewStatusReason: uniqueReasons.length ? uniqueReasons.join(" | ") : "NONE",
    greenhouseApplicationId: applicationId,
    greenhouseOfferIdAndVersion: `${offerId} v${version}`,
  }
}

function resolveOfferApplication(
  offer: EmployeeReferralRawOffer,
  applicationsById: ReadonlyMap<string, EmployeeReferralRawApplication>
): EmployeeReferralRawApplication {
  const applicationId = requiredOfferApplicationId(offer)
  const application = applicationsById.get(applicationId)
  if (!application) {
    throw new Error(`Incomplete Greenhouse extraction: unresolved application ${applicationId}`)
  }
  return application
}

function referencedSourceId(
  application: EmployeeReferralRawApplication,
  sourcesById: ReadonlyMap<string, EmployeeReferralRawSource>
): string | null {
  const sourceId = idString(application.source_id)
  if (sourceId && !sourcesById.has(sourceId)) {
    throw new Error(`Incomplete Greenhouse extraction: unresolved application source ${sourceId}`)
  }
  return sourceId
}

function validateGovernedSources(
  sourcesById: ReadonlyMap<string, EmployeeReferralRawSource>
): void {
  for (const sourceId of EMPLOYEE_REFERRAL_POLICY.governedSourceIds) {
    const source = sourcesById.get(sourceId)
    if (!source) throw new Error(`Governed Employee Referral source ${sourceId} is missing`)
    const sourceType = sourceTypeTuple(source)
    if (
      sourceId !== EMPLOYEE_REFERRAL_POLICY.governedSource.id ||
      source.name !== EMPLOYEE_REFERRAL_POLICY.governedSource.name ||
      sourceType.id !== EMPLOYEE_REFERRAL_POLICY.governedSource.typeId ||
      sourceType.name !== EMPLOYEE_REFERRAL_POLICY.governedSource.typeName
    ) {
      throw new Error(`Governed Employee Referral source tuple drifted for ${sourceId}`)
    }
  }
}

function isReferralSource(source: EmployeeReferralRawSource): boolean {
  const type = sourceTypeTuple(source)
  return (
    type.id === EMPLOYEE_REFERRAL_POLICY.governedSource.typeId &&
    type.name === EMPLOYEE_REFERRAL_POLICY.governedSource.typeName
  )
}

function findDuplicateCurrentCandidateIds(
  selected: readonly {
    recordType: EmployeeReferralRecordType
    offer: EmployeeReferralRawOffer
    application: EmployeeReferralRawApplication
  }[]
): Set<string> {
  const counts = new Map<string, number>()
  for (const row of selected) {
    if (row.recordType === "DEPRECATED_SIGNING_REVIEW") continue
    const offerCandidateId = idString(row.offer.candidate_id)
    const applicationCandidateId = idString(row.application.candidate_id)
    if (offerCandidateId && applicationCandidateId && offerCandidateId !== applicationCandidateId) {
      continue
    }
    const candidateId = offerCandidateId ?? applicationCandidateId
    if (candidateId) counts.set(candidateId, (counts.get(candidateId) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([candidateId]) => candidateId))
}

function validateOfferResolvedAt(
  offer: EmployeeReferralRawOffer,
  period: EmployeeReferralReportPeriod
): void {
  const offerId = idString(offer.id) ?? "unknown"
  if (!offer.resolved_at) {
    throw new Error(`Incomplete Greenhouse extraction: offer ${offerId} has no resolved_at`)
  }
  const resolvedAt = Date.parse(offer.resolved_at)
  if (!Number.isFinite(resolvedAt)) {
    throw new Error(`Incomplete Greenhouse extraction: offer ${offerId} has invalid resolved_at`)
  }
  if (
    resolvedAt < Date.parse(period.windowStartUtc) ||
    resolvedAt >= Date.parse(period.windowEndUtc)
  ) {
    throw new Error(`Incomplete Greenhouse extraction: offer ${offerId} is outside report period`)
  }
}

function sourceTypeTuple(source: EmployeeReferralRawSource): { id: string | null; name: string | null } {
  if (source.type && typeof source.type === "object") {
    return { id: idString(source.type.id), name: trimmed(source.type.name) }
  }
  return { id: null, name: trimmed(source.type) }
}

function validateStableHiringLocationField(fields: readonly EmployeeReferralRawCustomField[]): void {
  const matches = fields.filter((field) => {
    const fieldType =
      typeof field.field_type === "string" ? field.field_type : field.field_type?.name ?? field.entity
    return (
      field.active === true &&
      field.name_key === EMPLOYEE_REFERRAL_POLICY.hiringLocationNameKey &&
      fieldType?.toLocaleLowerCase("en-US") === "offer"
    )
  })
  if (matches.length !== 1) {
    throw new Error(
      `Stable active offer custom field ${EMPLOYEE_REFERRAL_POLICY.hiringLocationNameKey} expected exactly once, found ${matches.length}`
    )
  }
}

function readHiringLocation(
  customFields: EmployeeReferralRawOffer["custom_fields"]
): { value: string | null; reviewReasons: string[] } {
  if (!customFields || Array.isArray(customFields)) {
    return { value: null, reviewReasons: [] }
  }
  const raw = (customFields as Readonly<Record<string, unknown>>)[
    EMPLOYEE_REFERRAL_POLICY.hiringLocationNameKey
  ]
  const fieldValue =
    raw && typeof raw === "object" && !Array.isArray(raw) && "value" in raw
      ? (raw as { value?: unknown }).value
      : raw
  const values = (Array.isArray(fieldValue) ? fieldValue : [fieldValue])
    .map((value) => (typeof value === "string" || typeof value === "number" ? String(value).trim() : ""))
    .filter(Boolean)
  if (values.length > 1) {
    return {
      value: values.join(" | "),
      reviewReasons: ["HIRING_LOCATION_MULTIPLE_VALUES"],
    }
  }
  return { value: values[0] ?? null, reviewReasons: [] }
}

function groupJobOwnersByJobId(
  owners: readonly EmployeeReferralRawJobOwner[]
): Map<string, EmployeeReferralRawJobOwner[]> {
  const result = new Map<string, EmployeeReferralRawJobOwner[]>()
  for (const owner of owners) {
    const jobId = idString(owner.job_id)
    if (!jobId) continue
    const rows = result.get(jobId) ?? []
    rows.push(owner)
    result.set(jobId, rows)
  }
  return result
}

function resolveHiringManagerNames(input: {
  jobId: string | null
  job: EmployeeReferralRawJob | null
  offerCustomFields: EmployeeReferralRawOffer["custom_fields"]
  jobOwnersByJobId: ReadonlyMap<string, readonly EmployeeReferralRawJobOwner[]>
  usersById: ReadonlyMap<string, EmployeeReferralRawUser>
}): string[] {
  const ownerNames = (input.jobId ? input.jobOwnersByJobId.get(input.jobId) : [])
    ?.filter((owner) => normalizeOwnerType(owner.type) === "hiring_manager")
    .map((owner) => {
      const userId = idString(owner.user_id)
      const user = userId ? input.usersById.get(userId) : null
      return joinName(user?.first_name, user?.last_name) ?? trimmed(user?.name)
    })
    .filter((name): name is string => Boolean(name)) ?? []
  return uniqueSortedNames([
    ...ownerNames,
    ...readHiringManagerNamesFromCustomFields(input.job?.custom_fields),
    ...readHiringManagerNamesFromCustomFields(input.offerCustomFields),
  ])
}

function readHiringManagerNamesFromCustomFields(customFields: unknown): string[] {
  if (!customFields) return []
  const rawValues: unknown[] = []
  if (Array.isArray(customFields)) {
    for (const field of customFields) {
      if (!field || typeof field !== "object") continue
      const record = field as Record<string, unknown>
      const key = `${record.name ?? ""} ${record.name_key ?? ""}`
      if (/hiring[\s_-]*manager|supervisor/i.test(key)) rawValues.push(record.value)
    }
  } else if (typeof customFields === "object") {
    for (const [key, value] of Object.entries(customFields)) {
      if (/hiring[\s_-]*manager|supervisor/i.test(key)) rawValues.push(value)
    }
  }
  return uniqueSortedNames(rawValues.flatMap(personNamesFromValue))
}

function readOfferEmploymentFields(
  customFields: EmployeeReferralRawOffer["custom_fields"]
): {
  tenureType: string | null
  anticipatedEndDate: string | null
  workStatus: string | null
  workerType: string | null
  employmentType: string | null
} {
  return {
    tenureType: readCustomFieldText(customFields, "tenure_type"),
    anticipatedEndDate: readCustomFieldText(customFields, "anticipated_end_date"),
    workStatus: readCustomFieldText(customFields, "work_status"),
    workerType: readCustomFieldText(customFields, "worker_type"),
    employmentType: readCustomFieldText(customFields, "employment_type"),
  }
}

function readCustomFieldText(customFields: unknown, nameKey: string): string | null {
  if (!customFields) return null
  if (Array.isArray(customFields)) {
    for (const field of customFields) {
      if (!field || typeof field !== "object") continue
      const record = field as Record<string, unknown>
      if (record.name_key === nameKey || record.name === nameKey) {
        return scalarText(record.value)
      }
    }
    return null
  }
  if (typeof customFields !== "object") return null
  return scalarText((customFields as Record<string, unknown>)[nameKey])
}

function scalarText(value: unknown): string | null {
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return scalarText((value as { value?: unknown }).value)
  }
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim() || null
    : null
}

function personNamesFromValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(personNamesFromValue)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if ("value" in record) return personNamesFromValue(record.value)
    const name =
      trimmed(record.name) ??
      joinName(trimmed(record.first_name), trimmed(record.last_name))
    return name ? [name] : []
  }
  const text = trimmed(value)
  return text ? text.split(/\s*[|;]\s*/).filter(Boolean) : []
}

function normalizeOwnerType(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
}

function uniqueSortedNames(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right, "en", { sensitivity: "base" })
  )
}

function normalizePersonName(value: string | null): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function addDays(value: string, days: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return null
  }
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

async function loadIdBatches<T>(
  getAll: EmployeeReferralGreenhouseGetAll,
  path: string,
  ids: readonly string[],
  fields: string,
  requestOptions: GreenhouseRequestOptions
): Promise<T[]> {
  const unique = uniqueIds(ids)
  const rows: T[] = []
  for (let index = 0; index < unique.length; index += 50) {
    const batch = unique.slice(index, index + 50)
    rows.push(
      ...(await getAll<T>(path, {
        ids: batch.join(","),
        per_page: 500,
        fields,
      }, requestOptions))
    )
  }
  return rows
}

function indexRows<T extends { id?: GreenhouseId | null }>(
  rows: readonly T[],
  label: string
): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    const id = requiredId(row.id, label)
    if (result.has(id)) throw new Error(`Incomplete Greenhouse extraction: duplicate ${label} ${id}`)
    result.set(id, row)
  }
  return result
}

function resolveReferenced<T>(
  id: string | null,
  rows: ReadonlyMap<string, T>,
  label: string,
  requiredWhenReferenced: boolean
): T | null {
  if (!id) return null
  const value = rows.get(id) ?? null
  if (!value && requiredWhenReferenced) {
    throw new Error(`Incomplete Greenhouse extraction: unresolved ${label} ${id}`)
  }
  return value
}

function requiredOfferApplicationId(offer: EmployeeReferralRawOffer): string {
  const offerId = idString(offer.id) ?? "unknown"
  const applicationId = idString(offer.application_id)
  if (!applicationId) {
    throw new Error(`Incomplete Greenhouse extraction: offer ${offerId} has no application_id`)
  }
  return applicationId
}

function requiredId(value: GreenhouseId | null | undefined, label: string): string {
  const id = idString(value)
  if (!id) throw new Error(`Incomplete Greenhouse extraction: ${label} is missing id`)
  return id
}

function idString(value: GreenhouseId | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const result = String(value).trim()
  return result || null
}

function uniqueIds(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort(compareIds)
}

function compareIds(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true })
}

function compareRows(left: EmployeeReferralReportRow, right: EmployeeReferralReportRow): number {
  const typeOrder: Record<EmployeeReferralRecordType, number> = {
    CURRENT_ACCEPTED_COHORT: 0,
    DEPRECATED_SIGNING_REVIEW: 1,
    UNGOVERNED_REFERRAL_SOURCE_REVIEW: 2,
  }
  return (
    typeOrder[left.recordType] - typeOrder[right.recordType] ||
    (left.offerResolvedAt ?? "").localeCompare(right.offerResolvedAt ?? "") ||
    left.greenhouseOfferIdAndVersion.localeCompare(right.greenhouseOfferIdAndVersion, "en", {
      numeric: true,
    }) ||
    left.greenhouseApplicationId.localeCompare(right.greenhouseApplicationId, "en", {
      numeric: true,
    })
  )
}

function assertUniqueRows(rows: readonly EmployeeReferralReportRow[]): void {
  const keys = new Set<string>()
  for (const row of rows) {
    if (keys.has(row.rowKey)) throw new Error(`Duplicate report row key ${row.rowKey}`)
    keys.add(row.rowKey)
  }
}

function subjectFor(
  period: EmployeeReferralReportPeriod,
  counts: EmployeeReferralReportCounts,
  options: { revision?: number; supersedesRevision?: number | null }
): string {
  const revision = options.revision ?? 1
  if (options.supersedesRevision) {
    return `CORRECTION - Employee Referral Cohort - ${period.label} - revision ${revision} - supersedes revision ${options.supersedesRevision}`
  }
  return `Employee Referral Cohort - ${period.label} - ${counts.currentCohortCount} current - ${counts.deprecatedReviewCount + counts.ungovernedSourceReviewCount} review`
}

function renderHtmlTable(rows: readonly EmployeeReferralReportRow[]): string {
  const headers = CSV_COLUMNS.map((column) => `<th>${htmlEscape(column.header)}</th>`).join("")
  const body = rows
    .map(
      (row) =>
        `<tr>${CSV_COLUMNS.map((column) => `<td>${htmlEscape(column.value(row) ?? "")}</td>`).join("")}</tr>`
    )
    .join("\n")
  return `<table border="1" cellspacing="0" cellpadding="5"><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table>`
}

function csvCell(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${neutralized.replace(/"/g, '""')}"`
}

function htmlEscape(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function joinName(firstName: string | null | undefined, lastName: string | null | undefined) {
  const result = [trimmed(firstName), trimmed(lastName)].filter(Boolean).join(" ")
  return result || null
}

function trimmed(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null
  const result = String(value).trim()
  return result || null
}

function validatePeriod(period: EmployeeReferralReportPeriod): void {
  const expected = createEmployeeReferralReportPeriod(
    period.periodStartLocal,
    period.periodEndLocalExclusive
  )
  if (
    period.timeZone !== expected.timeZone ||
    period.windowStartUtc !== expected.windowStartUtc ||
    period.windowEndUtc !== expected.windowEndUtc
  ) {
    throw new Error("Employee referral report period boundaries are invalid")
  }
}

function assertDateOnly(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Employee referral ${label} must use YYYY-MM-DD`)
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Employee referral ${label} is not a real date`)
  }
}

function assertMonthBoundary(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-01$/.test(value)) {
    throw new Error(`Employee referral report ${label} must be a YYYY-MM-01 boundary`)
  }
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Employee referral report ${label} is not a real date`)
  }
}

function localMidnightToUtc(localDate: string): string {
  return employeeReferralLocalDateTimeToUtc(localDate, 0)
}

function datePartsInZone(date: Date): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EMPLOYEE_REFERRAL_REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  }
}

function periodLabel(start: string, endExclusive: string): string {
  const startDate = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${endExclusive}T00:00:00Z`)
  endDate.setUTCMonth(endDate.getUTCMonth() - 1)
  const month = (date: Date) =>
    new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date)
  if (
    startDate.getUTCFullYear() === endDate.getUTCFullYear() &&
    startDate.getUTCMonth() === endDate.getUTCMonth()
  ) {
    return `${month(startDate)} ${startDate.getUTCFullYear()}`
  }
  if (startDate.getUTCFullYear() === endDate.getUTCFullYear()) {
    return `${month(startDate)}-${month(endDate)} ${startDate.getUTCFullYear()}`
  }
  return `${month(startDate)} ${startDate.getUTCFullYear()}-${month(endDate)} ${endDate.getUTCFullYear()}`
}

function two(value: number): string {
  return String(value).padStart(2, "0")
}
