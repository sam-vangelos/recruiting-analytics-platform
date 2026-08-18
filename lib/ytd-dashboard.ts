import { supabase } from "./supabase"
import type { ResolutionStatus } from "./resolution-types"
import type {
  AgencyActionBucket,
  DuplicateConfidence,
  FeeRiskState,
  TerminalOutcome,
  YtdApplicationFact,
  YtdApplicationsPage,
  YtdAgencyFilters,
  YtdAgencySort,
  YtdChannel,
  YtdDataQualityFlag,
} from "./ytd-types"

const PAGE_SIZE = 1000

// W2 contract #1 / #5 read-side type. The 005 writeback columns
// (ownership_confidence/ownership_resolution_status) land on the fact in the DB but are
// NOT yet on the canonical YtdApplicationFact (that cross-file type reconciliation is the
// Verify stage's job — ytd-types.ts is outside this file's edit boundary). select("*")
// already returns the columns at runtime; this local intersection types them so the read
// loaders can pass ownership_resolution_status through to a later defect UI (W4b) while
// staying assignable to YtdApplicationFact everywhere the public loader shapes still
// expect the base type. Both fields are optional + nullable: rows persisted before 005,
// and the column's own NULL default, must read back cleanly without a sentinel.
type YtdApplicationFactRead = YtdApplicationFact & {
  ownership_confidence?: ResolutionConfidenceRead
  ownership_resolution_status?: ResolutionStatus | null
}

type ResolutionConfidenceRead = "confirmed" | "high" | "inferred" | "unresolved"

function countBy<T extends string | number | null | undefined>(
  rows: YtdApplicationFact[],
  key: (row: YtdApplicationFact) => T
): Array<{ key: string; count: number }> {
  const map = new Map<string, number>()
  for (const row of rows) {
    const value = key(row)
    const label = value == null || value === "" ? "Unknown" : String(value)
    map.set(label, (map.get(label) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([keyValue, count]) => ({ key: keyValue, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil((pct / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]
}

function actionStats(rows: YtdApplicationFact[]) {
  const values = rows
    .map((row) => row.action_time_hours)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  return {
    measured: values.length,
    median_hours: percentile(values, 50),
    p75_hours: percentile(values, 75),
  }
}

function isDuplicate(row: YtdApplicationFact): boolean {
  return row.duplicate_confidence === "confirmed" || row.duplicate_confidence === "high"
}

function isOver7d(row: YtdApplicationFact): boolean {
  return row.action_bucket === "gt_7d" || row.action_bucket === "unactioned_gt_7d"
}

function sortDirection(sort?: YtdAgencySort): 1 | -1 {
  return sort?.sort_dir === "asc" ? 1 : -1
}

function compareNullableNumber(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return (a - b) * direction
}

function compareString(a: string | null | undefined, b: string | null | undefined, direction: 1 | -1): number {
  return String(a ?? "").localeCompare(String(b ?? "")) * direction
}

function qualitySummary(rows: YtdApplicationFact[]) {
  const counts: Record<YtdDataQualityFlag, number> = {
    missing_candidate_email: 0,
    missing_referrer: 0,
    missing_recruiter_owner: 0,
    missing_stage_history: 0,
    missing_stage_definition: 0,
    approximate_action_time: 0,
    cannot_check_conflict_missing_email: 0,
  }
  for (const row of rows) {
    for (const flag of row.data_quality_flags ?? []) counts[flag]++
  }
  return counts
}

async function fetchAllFacts(year: number): Promise<YtdApplicationFactRead[]> {
  const rows: YtdApplicationFactRead[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase
      .from("ytd_application_facts")
      .select("*")
      .eq("scan_year", year)
      .range(from, to)
    if (error) throw new Error(`Failed to fetch YTD facts: ${error.message}`)
    rows.push(...((data ?? []) as unknown as YtdApplicationFactRead[]))
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}

async function fetchAgencyFacts(filters: YtdAgencyFilters): Promise<YtdApplicationFactRead[]> {
  const rows: YtdApplicationFactRead[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1
    let query = supabase
      .from("ytd_application_facts")
      .select("*")
      .eq("scan_year", filters.year)
      .eq("channel", "agency")

    if (filters.department_id) query = query.eq("department_id", filters.department_id)
    if (filters.agency_source_id) query = query.eq("agency_source_id", filters.agency_source_id)
    if (filters.recruiter_id) query = query.contains("recruiter_ids", [filters.recruiter_id])
    if (filters.action_bucket) query = query.eq("action_bucket", filters.action_bucket)
    if (filters.duplicate_confidence) query = query.eq("duplicate_confidence", filters.duplicate_confidence)
    if (filters.fee_risk_state) query = query.eq("fee_risk_state", filters.fee_risk_state)
    if (filters.current_stage_name) query = query.eq("current_stage_name", filters.current_stage_name)
    if (filters.terminal_outcome) query = query.eq("terminal_outcome", filters.terminal_outcome)

    const { data, error } = await query.range(from, to)
    if (error) throw new Error(`Failed to fetch agency YTD facts: ${error.message}`)
    rows.push(...((data ?? []) as unknown as YtdApplicationFactRead[]))
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}

export async function getYtdSummary(year: number) {
  const rows = await fetchAllFacts(year)
  const referrals = rows.filter((row) => row.channel === "referral")
  const agency = rows.filter((row) => row.channel === "agency")
  const agencyConflicts = agency.filter((row) => row.conflict_detected)

  return {
    year,
    totals: {
      all: rows.length,
      referrals: referrals.length,
      agency: agency.length,
    },
    referral: {
      total: referrals.length,
      actioned: referrals.filter((row) => row.actioned_at).length,
      never_actioned: referrals.filter((row) => row.never_actioned).length,
      action_time: actionStats(referrals),
      by_role: countBy(referrals, (row) => row.job_title),
      by_referrer: countBy(referrals, (row) => row.referrer_name),
      by_recruiter: countBy(referrals, (row) => row.primary_recruiter_name),
      by_stage_depth: countBy(referrals, (row) => row.max_stage_name),
      by_terminal_outcome: countBy(referrals, (row) => row.terminal_outcome),
    },
    agency: {
      total: agency.length,
      actioned: agency.filter((row) => row.actioned_at).length,
      action_time: actionStats(agency),
      over_7d_or_unactioned: agency.filter(isOver7d).length,
      confirmed_high_duplicates: agency.filter(isDuplicate).length,
      fee_exposure: agency.filter((row) => row.fee_risk_state === "exposed").length,
      conflicts_detected: agencyConflicts.length,
      prior_history_conflicts: agency.filter((row) =>
        row.conflict_types.includes("prior_history")
      ).length,
      dual_agency_conflicts: agency.filter((row) =>
        row.conflict_types.includes("dual_agency")
      ).length,
      by_agency: countBy(agency, (row) => row.agency_source_name),
      by_role: countBy(agency, (row) => row.job_title),
      by_stage_depth: countBy(agency, (row) => row.max_stage_name),
      by_terminal_outcome: countBy(agency, (row) => row.terminal_outcome),
    },
    data_quality: qualitySummary(rows),
  }
}

export async function getYtdAgencySummary(filters: YtdAgencyFilters) {
  const rows = await fetchAgencyFacts(filters)
  const action = actionStats(rows)
  const duplicateRows = rows.filter(isDuplicate)
  const over7d = rows.filter(isOver7d)
  const exposed = rows.filter((row) => row.fee_risk_state === "exposed")

  return {
    year: filters.year,
    filters,
    submissions: rows.length,
    actioned: rows.filter((row) => row.first_action_at).length,
    median_action_hours: action.median_hours,
    p75_action_hours: action.p75_hours,
    over_7d_or_unactioned: over7d.length,
    confirmed_high_duplicates: duplicateRows.length,
    possible_duplicates: rows.filter((row) => row.duplicate_confidence === "possible").length,
    fee_exposure: exposed.length,
    at_risk: rows.filter((row) => row.fee_risk_state === "at_risk").length,
    insufficient_data: rows.filter((row) => row.fee_risk_state === "insufficient_data").length,
  }
}

function groupRows<T extends string | number | null | undefined>(
  rows: YtdApplicationFact[],
  key: (row: YtdApplicationFact) => T
): Map<string, YtdApplicationFact[]> {
  const groups = new Map<string, YtdApplicationFact[]>()
  for (const row of rows) {
    const raw = key(row)
    const nextKey = raw == null || raw === "" ? "unknown" : String(raw)
    const list = groups.get(nextKey) ?? []
    list.push(row)
    groups.set(nextKey, list)
  }
  return groups
}

// C1 ownership model: ONE key for grouping AND filtering — `recruiter_ids` membership.
//
// The bug (ytd-dashboard.ts:241 group on primary_recruiter_id vs :117 filter on
// .contains recruiter_ids): the two keys diverge under the resolver canon. After W2,
// primary_recruiter_id is NULL on every unresolved/ambiguous/permission_blocked row while
// recruiter_ids still carries the contended owner set as provenance. Grouping on
// primary_recruiter_id therefore drops every defect row into a single "unknown" bucket and
// hides a recruiter who is an owner-of-record on ambiguous rows; but the server filter
// (.contains recruiter_ids) WOULD return those rows. Clicking a recruiter row returned a
// different set than the row's own count claimed.
//
// Both sides now key on recruiter_ids membership: a row fans out into one group per id in
// its recruiter_ids, and the filter (fetchAgencyFacts:.contains) selects rows whose
// recruiter_ids contains that id. This is the only model under which "row count == set
// returned by clicking the row" holds, because a single application can have N recruiter
// owners and the server filter is membership-based. primary_recruiter_id stays the
// derived single-winner for display ordering only, never the grouping/filtering axis.
//
// A row with an EMPTY recruiter_ids (no recruiter owner resolved at all) belongs to no
// recruiter — it is an ownership defect surfaced elsewhere (data_quality / the W4b defect
// view), not a phantom recruiter row. It is intentionally dropped from this fan-out so a
// "no owner" bucket can't masquerade as a recruiter named "Unknown" (the sentinel ban).
function groupByRecruiterMembership(
  rows: YtdApplicationFactRead[]
): Map<number, YtdApplicationFactRead[]> {
  const groups = new Map<number, YtdApplicationFactRead[]>()
  for (const row of rows) {
    for (const recruiterId of new Set(row.recruiter_ids ?? [])) {
      const list = groups.get(recruiterId) ?? []
      list.push(row)
      groups.set(recruiterId, list)
    }
  }
  return groups
}

// id -> display name, built across the whole result so a recruiter id that resolves to a
// name on ANY row carries it (recruiter_names drops unresolvable names and is NOT
// index-aligned to recruiter_ids, so per-row zipping is unsafe — identity-resolver.namesOf).
// A recruiter with no resolvable name anywhere maps to null, NOT a sentinel: the defect is
// the null name + the row's ownership_resolution_status, never the literal "Unknown".
function buildRecruiterNameIndex(rows: YtdApplicationFactRead[]): Map<number, string | null> {
  const names = new Map<number, string | null>()
  for (const row of rows) {
    const ids = row.recruiter_ids ?? []
    const labels = row.recruiter_names ?? []
    // recruiter_names is the resolver's name list for recruiter_ids with the unresolvable
    // names dropped; when the two are the same length it is a clean positional mapping, so
    // adopt it. When they differ (a name was dropped), fall back to primary_* below.
    if (ids.length === labels.length) {
      ids.forEach((id, index) => {
        // Fill on first sight; a later non-null label still overwrites an earlier null
        // (names.get returns null/undefined -> falsy -> we re-enter and can upgrade).
        if (!names.get(id)) names.set(id, labels[index] ?? null)
      })
    }
    // primary_recruiter_id/name is an authoritative single (id,name) pair on resolved rows —
    // use it to backfill any id still missing a name.
    if (
      typeof row.primary_recruiter_id === "number" &&
      row.primary_recruiter_name &&
      !names.get(row.primary_recruiter_id)
    ) {
      names.set(row.primary_recruiter_id, row.primary_recruiter_name)
    }
  }
  return names
}

// W2 contract #1: surface a single ownership_resolution_status per recruiter group so the
// W4b defect UI can render it. The grouping is by recruiter_ids membership, so every row in
// a group named that recruiter as an owner; the worst (least-resolved) status across the
// group is the honest summary — if ANY of the recruiter's rows is an unresolved defect, the
// recruiter's ownership over its set is not fully clean. Rank: resolved is best.
const READ_STATUS_RANK: Record<ResolutionStatus, number> = {
  resolved: 0,
  ambiguous: 1,
  unresolved: 2,
  permission_blocked: 3,
}

function worstOwnershipStatus(
  rows: YtdApplicationFactRead[]
): ResolutionStatus | null {
  let worst: ResolutionStatus | null = null
  for (const row of rows) {
    const status = row.ownership_resolution_status
    if (!status) continue
    if (worst === null || READ_STATUS_RANK[status] > READ_STATUS_RANK[worst]) {
      worst = status
    }
  }
  return worst
}

function aggregateHandling(rows: YtdApplicationFactRead[]) {
  const action = actionStats(rows)
  return {
    submissions: rows.length,
    median_action_hours: action.median_hours,
    p75_action_hours: action.p75_hours,
    over_7d_count: rows.filter(isOver7d).length,
    actioned_within_7d_count: rows.filter(
      (row) =>
        typeof row.first_action_time_hours === "number" &&
        row.first_action_time_hours <= 168
    ).length,
    duplicate_count: rows.filter(isDuplicate).length,
    possible_duplicate_count: rows.filter((row) => row.duplicate_confidence === "possible").length,
    fee_exposure_count: rows.filter((row) => row.fee_risk_state === "exposed").length,
    at_risk_count: rows.filter((row) => row.fee_risk_state === "at_risk").length,
  }
}

export async function getYtdAgencyRecruiters(
  filters: YtdAgencyFilters,
  sort?: YtdAgencySort
) {
  const rows = await fetchAgencyFacts(filters)
  // C1: group on recruiter_ids membership — the SAME key fetchAgencyFacts filters on
  // (.contains recruiter_ids). Each row fans into one group per recruiter owner, so a
  // recruiter's row count equals the set returned when its row is clicked (which re-runs
  // fetchAgencyFacts with recruiter_id set).
  const groups = groupByRecruiterMembership(rows)
  const nameIndex = buildRecruiterNameIndex(rows)
  const direction = sortDirection(sort)
  const sortBy = sort?.sort_by ?? "p75_action_hours"

  const items = [...groups.entries()].map(([recruiterId, group]) => ({
    recruiter_id: recruiterId,
    // null (never "Unknown") when no name resolved — the defect is name===null +
    // ownership_resolution_status, not a sentinel string.
    recruiter_name: nameIndex.get(recruiterId) ?? null,
    // W2 contract #1: pass the (worst) resolution status through for the W4b defect UI.
    ownership_resolution_status: worstOwnershipStatus(group),
    ...aggregateHandling(group),
  }))

  return items.sort((a, b) => {
    const numberSorts = new Set([
      "submissions",
      "median_action_hours",
      "p75_action_hours",
      "over_7d_count",
      "duplicate_count",
      "fee_exposure_count",
    ])
    if (numberSorts.has(sortBy)) {
      return (
        compareNullableNumber(
          a[sortBy as keyof typeof a] as number | null,
          b[sortBy as keyof typeof b] as number | null,
          direction
        ) || compareString(a.recruiter_name, b.recruiter_name, 1)
      )
    }
    return compareString(a.recruiter_name, b.recruiter_name, direction)
  })
}

export async function getYtdAgencyAgencies(
  filters: YtdAgencyFilters,
  sort?: YtdAgencySort
) {
  const rows = await fetchAgencyFacts(filters)
  const groups = groupRows(rows, (row) => row.agency_source_id)
  const direction = sortDirection(sort)
  const sortBy = sort?.sort_by ?? "submissions"

  const items = [...groups.entries()].map(([key, group]) => ({
    agency_source_id: key === "unknown" ? null : Number(key),
    // null (never "Unknown") when no agency source resolved — unresolved agency identity
    // is a defect signal, not a displayable source name.
    agency_source_name: group.find((row) => row.agency_source_name)?.agency_source_name ?? null,
    deepest_stage: group
      .filter((row) => typeof row.max_stage_rank === "number")
      .sort((a, b) => (b.max_stage_rank ?? 0) - (a.max_stage_rank ?? 0))[0]?.max_stage_name ?? null,
    ...aggregateHandling(group),
  }))

  return items.sort((a, b) => {
    const numberSorts = new Set([
      "submissions",
      "median_action_hours",
      "p75_action_hours",
      "over_7d_count",
      "duplicate_count",
      "fee_exposure_count",
    ])
    if (numberSorts.has(sortBy)) {
      return (
        compareNullableNumber(
          a[sortBy as keyof typeof a] as number | null,
          b[sortBy as keyof typeof b] as number | null,
          direction
        ) || compareString(a.agency_source_name, b.agency_source_name, 1)
      )
    }
    return compareString(a.agency_source_name, b.agency_source_name, direction)
  })
}

function applyAgencyApplicationSort(
  rows: YtdApplicationFact[],
  sort?: YtdAgencySort
): YtdApplicationFact[] {
  const direction = sortDirection(sort)
  const sortBy = sort?.sort_by ?? "submitted_at"
  return [...rows].sort((a, b) => {
    if (sortBy === "first_action_time_hours") {
      return compareNullableNumber(a.first_action_time_hours, b.first_action_time_hours, direction)
    }
    if (sortBy === "primary_recruiter_name") {
      return compareString(a.primary_recruiter_name, b.primary_recruiter_name, direction)
    }
    if (sortBy === "agency_source_name") {
      return compareString(a.agency_source_name, b.agency_source_name, direction)
    }
    if (sortBy === "action_bucket") return compareString(a.action_bucket, b.action_bucket, direction)
    if (sortBy === "duplicate_confidence") {
      return compareString(a.duplicate_confidence, b.duplicate_confidence, direction)
    }
    if (sortBy === "fee_risk_state") return compareString(a.fee_risk_state, b.fee_risk_state, direction)
    const aTime = a.submitted_at ? new Date(a.submitted_at).getTime() : null
    const bTime = b.submitted_at ? new Date(b.submitted_at).getTime() : null
    return compareNullableNumber(aTime, bTime, direction)
  })
}

export async function getYtdAgencyApplications(
  filters: YtdAgencyFilters & { page?: number; page_size?: number },
  sort?: YtdAgencySort
): Promise<YtdApplicationsPage> {
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = Math.min(250, Math.max(1, filters.page_size ?? 50))
  const rows = applyAgencyApplicationSort(await fetchAgencyFacts(filters), sort)
  const from = (page - 1) * pageSize
  return {
    // PII: never ship raw candidate_email to the client (w0-frozen-spec; parity with
    // ytd-referral-dashboard.ts:368-372). Strip it from every returned row.
    items: rows.slice(from, from + pageSize).map((r) => {
      const row = { ...(r as unknown as Record<string, unknown>) }
      delete row.candidate_email
      return row
    }) as unknown as YtdApplicationFact[],
    page,
    page_size: pageSize,
    total: rows.length,
  }
}

export async function getYtdAgencyFilterOptions(filters: number | YtdAgencyFilters) {
  const resolvedFilters = typeof filters === "number" ? { year: filters } : filters
  // C5: derive the option universe from the YEAR-SCOPED agency set, NOT the already-filtered
  // set. The old code fetched with the full active filter set (ytd-dashboard.ts:358), so
  // narrowing one filter shrank every OTHER filter's choices — selecting agency A erased the
  // recruiters/stages that only appear under agency B, and the operator could no longer pivot
  // to them without clearing first. Fetching on year alone keeps each control's universe
  // stable as siblings change; the filtered subset still governs the tables/cards.
  const rows = await fetchAgencyFacts({ year: resolvedFilters.year })
  const option = <T extends string | number | null | undefined>(
    key: (row: YtdApplicationFactRead) => T,
    label: (row: YtdApplicationFactRead) => string | null | undefined
  ) => {
    const map = new Map<string, string>()
    for (const row of rows) {
      const raw = key(row)
      if (raw == null || raw === "") continue
      map.set(String(raw), label(row) ?? String(raw))
    }
    return [...map.entries()]
      .map(([value, nextLabel]) => ({ value, label: nextLabel }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  // C1 consistency: the recruiter option list keys on recruiter_ids membership (the same axis
  // the table groups on and the server filters with .contains), so a recruiter who only owns
  // ambiguous rows — primary_recruiter_id NULL there — still appears as a selectable filter.
  // Names come from the same id->name index the table uses; a recruiter with no resolvable
  // name anywhere is omitted from the dropdown rather than rendered as a "Unknown" sentinel
  // (it has no clean label to offer; its rows still surface in the unfiltered table + W4b).
  const recruiterNames = buildRecruiterNameIndex(rows)
  const recruiterIds = new Set<number>()
  for (const row of rows) for (const id of row.recruiter_ids ?? []) recruiterIds.add(id)
  const recruiters = [...recruiterIds]
    .map((id) => ({ value: String(id), label: recruiterNames.get(id) ?? null }))
    .filter((entry): entry is { value: string; label: string } => entry.label !== null)
    .sort((a, b) => a.label.localeCompare(b.label))

  return {
    year: resolvedFilters.year,
    departments: option((row) => row.department_id, (row) => row.department_name),
    recruiters,
    agencies: option((row) => row.agency_source_id, (row) => row.agency_source_name),
    action_buckets: [...new Set(rows.map((row) => row.action_bucket).filter(Boolean))].sort() as AgencyActionBucket[],
    duplicate_confidences: [...new Set(rows.map((row) => row.duplicate_confidence).filter(Boolean))].sort() as DuplicateConfidence[],
    fee_risk_states: [...new Set(rows.map((row) => row.fee_risk_state).filter(Boolean))].sort() as FeeRiskState[],
    current_stages: [...new Set(rows.map((row) => row.current_stage_name).filter(Boolean))].sort() as string[],
    terminal_outcomes: [...new Set(rows.map((row) => row.terminal_outcome).filter(Boolean))].sort() as TerminalOutcome[],
  }
}

export interface YtdApplicationFilters {
  year: number
  channel?: YtdChannel
  job_id?: number
  agency_source_id?: number
  recruiter_id?: number
  current_stage_name?: string
  never_actioned?: boolean
  conflict_detected?: boolean
  page?: number
  page_size?: number
}

export async function getYtdApplications(filters: YtdApplicationFilters): Promise<YtdApplicationsPage> {
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = Math.min(250, Math.max(1, filters.page_size ?? 50))
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  let query = supabase
    .from("ytd_application_facts")
    .select("*", { count: "exact" })
    .eq("scan_year", filters.year)

  if (filters.channel) query = query.eq("channel", filters.channel)
  if (filters.job_id) query = query.eq("job_id", filters.job_id)
  if (filters.agency_source_id) query = query.eq("agency_source_id", filters.agency_source_id)
  if (filters.current_stage_name) query = query.eq("current_stage_name", filters.current_stage_name)
  if (typeof filters.never_actioned === "boolean") query = query.eq("never_actioned", filters.never_actioned)
  if (typeof filters.conflict_detected === "boolean") query = query.eq("conflict_detected", filters.conflict_detected)
  if (filters.recruiter_id) query = query.contains("recruiter_ids", [filters.recruiter_id])

  const { data, error, count } = await query
    .order("applied_at", { ascending: false, nullsFirst: false })
    .range(from, to)

  if (error) throw new Error(`Failed to fetch YTD applications: ${error.message}`)
  return {
    // PII: strip raw candidate_email before it leaves the loader (parity with the agency +
    // referral application loaders; w0-frozen-spec).
    items: (data ?? []).map((r) => {
      const row = { ...(r as unknown as Record<string, unknown>) }
      delete row.candidate_email
      return row
    }) as unknown as YtdApplicationFact[],
    page,
    page_size: pageSize,
    total: count ?? 0,
  }
}

export async function getYtdDataQuality(year: number) {
  const rows = await fetchAllFacts(year)
  const flags = qualitySummary(rows)
  const affected: Record<YtdDataQualityFlag, number[]> = {
    missing_candidate_email: [],
    missing_referrer: [],
    missing_recruiter_owner: [],
    missing_stage_history: [],
    missing_stage_definition: [],
    approximate_action_time: [],
    cannot_check_conflict_missing_email: [],
  }

  for (const row of rows) {
    for (const flag of row.data_quality_flags ?? []) {
      affected[flag].push(row.application_id)
    }
  }

  return {
    year,
    flags,
    affected_application_ids: affected,
  }
}
