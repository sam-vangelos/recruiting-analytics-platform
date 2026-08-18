import { supabase } from "./supabase"
import type { ResolutionStatus } from "./resolution-types"
import type {
  AgencyActionBucket,
  TerminalOutcome,
  YtdApplicationFact,
  YtdApplicationsPage,
  YtdAgencySort,
} from "./ytd-types"

const PAGE_SIZE = 1000

// W4-1 referral read-side. Mirrors the agency loaders in ytd-dashboard.ts, scoped to
// channel='referral'. The pure helpers below are re-implemented locally (not imported)
// because ytd-dashboard.ts does NOT export them and is outside this file's edit boundary
// (greenfield rule — do not touch ytd-dashboard to add exports). Return shapes stay
// parallel to the agency loaders so the YTD surface can reuse the same components.

// Read-side intersection for the 005 ownership writeback columns. Same rationale as
// ytd-dashboard.ts:27 — select("*") returns ownership_resolution_status at runtime once
// 005 lands, but the canonical YtdApplicationFact does not model it yet (cross-file type
// reconciliation is the Verify stage's job, ytd-types.ts is out of boundary). Both fields
// are optional + nullable so rows persisted before 005 read back cleanly without a sentinel.
type YtdApplicationFactRead = YtdApplicationFact & {
  ownership_confidence?: ResolutionConfidenceRead
  ownership_resolution_status?: ResolutionStatus | null
}

type ResolutionConfidenceRead = "confirmed" | "high" | "inferred" | "unresolved"

// Referral filters. YtdAgencyFilters models the agency axes (agency_source_id /
// duplicate_confidence / fee_risk_state); the referral surface filters on referrer_id +
// terminal_outcome instead. Declared locally rather than added to ytd-types.ts (out of
// boundary). recruiter_id is membership-filtered (.contains recruiter_ids) per the C1 lesson.
export interface YtdReferralFilters {
  year: number
  department_id?: number
  recruiter_id?: number
  referrer_id?: number
  action_bucket?: AgencyActionBucket
  current_stage_name?: string
  terminal_outcome?: TerminalOutcome
}

// ---------------------------------------------------------------------------
// Pure helpers (local re-implementations of ytd-dashboard's privates)
// ---------------------------------------------------------------------------

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

// Membership-fan-out grouping on recruiter_ids — the SAME axis fetchReferralFacts filters
// on (.contains recruiter_ids). Each row fans into one group per recruiter owner so a
// recruiter's row count equals the set returned when its row is clicked. A row with an
// EMPTY recruiter_ids belongs to no recruiter (an ownership defect surfaced via
// data_quality / the W4b defect view), so it is dropped here rather than masquerading as a
// recruiter named "Unknown" (the sentinel ban). Mirrors ytd-dashboard:groupByRecruiterMembership.
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

// id -> display name built across the whole result so a recruiter id that resolves to a
// name on ANY row carries it (recruiter_names drops unresolvable names and is NOT
// index-aligned to recruiter_ids). A recruiter with no resolvable name anywhere maps to
// null, NOT a sentinel. Mirrors ytd-dashboard:buildRecruiterNameIndex.
function buildRecruiterNameIndex(rows: YtdApplicationFactRead[]): Map<number, string | null> {
  const names = new Map<number, string | null>()
  for (const row of rows) {
    const ids = row.recruiter_ids ?? []
    const labels = row.recruiter_names ?? []
    if (ids.length === labels.length) {
      ids.forEach((id, index) => {
        if (!names.get(id)) names.set(id, labels[index] ?? null)
      })
    }
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

// Worst (least-resolved) ownership status across a recruiter group, so the W4b defect UI
// can render a single honest status per recruiter. Mirrors ytd-dashboard:worstOwnershipStatus.
const READ_STATUS_RANK: Record<ResolutionStatus, number> = {
  resolved: 0,
  ambiguous: 1,
  unresolved: 2,
  permission_blocked: 3,
}

function worstOwnershipStatus(rows: YtdApplicationFactRead[]): ResolutionStatus | null {
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

// Generic single-key grouping (referrer / role / stage / outcome). An empty/null key lands
// in the "unknown" bucket so the loader can map it back to a null id + defect treatment
// rather than a sentinel name. Mirrors ytd-dashboard:groupRows.
function groupRows<T extends string | number | null | undefined>(
  rows: YtdApplicationFactRead[],
  key: (row: YtdApplicationFactRead) => T
): Map<string, YtdApplicationFactRead[]> {
  const groups = new Map<string, YtdApplicationFactRead[]>()
  for (const row of rows) {
    const raw = key(row)
    const nextKey = raw == null || raw === "" ? "unknown" : String(raw)
    const list = groups.get(nextKey) ?? []
    list.push(row)
    groups.set(nextKey, list)
  }
  return groups
}

function aggregateHandling(rows: YtdApplicationFactRead[]) {
  const action = actionStats(rows)
  return {
    submissions: rows.length,
    median_action_hours: action.median_hours,
    p75_action_hours: action.p75_hours,
    actioned: rows.filter((row) => row.first_action_at).length,
    never_actioned: rows.filter((row) => row.never_actioned).length,
    over_7d_count: rows.filter(isOver7d).length,
    actioned_within_7d_count: rows.filter(
      (row) =>
        typeof row.first_action_time_hours === "number" && row.first_action_time_hours <= 168
    ).length,
  }
}

const REFERRAL_NUMBER_SORTS = new Set([
  "submissions",
  "median_action_hours",
  "p75_action_hours",
  "actioned",
  "never_actioned",
  "over_7d_count",
])

// ---------------------------------------------------------------------------
// Paginated fact scans — NEVER the 1000-row PostgREST default (C5/year-scoped lesson).
// Every scan loops .range() until a short page; select("*") so unapplied 005 columns
// don't break the read.
// ---------------------------------------------------------------------------

async function fetchReferralFacts(filters: YtdReferralFilters): Promise<YtdApplicationFactRead[]> {
  const rows: YtdApplicationFactRead[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1
    let query = supabase
      .from("ytd_application_facts")
      .select("*")
      .eq("scan_year", filters.year)
      .eq("channel", "referral")

    if (filters.department_id) query = query.eq("department_id", filters.department_id)
    if (filters.referrer_id) query = query.eq("referrer_id", filters.referrer_id)
    if (filters.recruiter_id) query = query.contains("recruiter_ids", [filters.recruiter_id])
    if (filters.action_bucket) query = query.eq("action_bucket", filters.action_bucket)
    if (filters.current_stage_name) query = query.eq("current_stage_name", filters.current_stage_name)
    if (filters.terminal_outcome) query = query.eq("terminal_outcome", filters.terminal_outcome)

    const { data, error } = await query.range(from, to)
    if (error) throw new Error(`Failed to fetch referral YTD facts: ${error.message}`)
    rows.push(...((data ?? []) as unknown as YtdApplicationFactRead[]))
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export async function getYtdReferralSummary(filters: YtdReferralFilters) {
  const rows = await fetchReferralFacts(filters)
  const action = actionStats(rows)

  return {
    year: filters.year,
    filters,
    submissions: rows.length,
    actioned: rows.filter((row) => row.first_action_at).length,
    never_actioned: rows.filter((row) => row.never_actioned).length,
    median_action_hours: action.median_hours,
    p75_action_hours: action.p75_hours,
    over_7d_or_unactioned: rows.filter(isOver7d).length,
    actioned_within_7d: rows.filter(
      (row) => typeof row.first_action_time_hours === "number" && row.first_action_time_hours <= 168
    ).length,
    by_referrer: countBy(rows, (row) => row.referrer_name),
    by_recruiter: countBy(rows, (row) => row.primary_recruiter_name),
    by_role: countBy(rows, (row) => row.job_title),
    by_stage_depth: countBy(rows, (row) => row.max_stage_name),
    by_terminal_outcome: countBy(rows, (row) => row.terminal_outcome),
  }
}

export async function getYtdReferralRecruiters(filters: YtdReferralFilters, sort?: YtdAgencySort) {
  const rows = await fetchReferralFacts(filters)
  // C1: group on recruiter_ids membership — the SAME key fetchReferralFacts filters on
  // (.contains recruiter_ids). A recruiter's row count equals the set returned when its row
  // is clicked (which re-runs fetchReferralFacts with recruiter_id set).
  const groups = groupByRecruiterMembership(rows)
  const nameIndex = buildRecruiterNameIndex(rows)
  const direction = sortDirection(sort)
  const sortBy = sort?.sort_by ?? "submissions"

  const items = [...groups.entries()].map(([recruiterId, group]) => ({
    recruiter_id: recruiterId,
    // null (never "Unknown") when no name resolved — the defect is name===null +
    // ownership_resolution_status, not a sentinel string.
    recruiter_name: nameIndex.get(recruiterId) ?? null,
    ownership_resolution_status: worstOwnershipStatus(group),
    ...aggregateHandling(group),
  }))

  return items.sort((a, b) => {
    if (REFERRAL_NUMBER_SORTS.has(sortBy)) {
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

export async function getYtdReferralReferrers(filters: YtdReferralFilters, sort?: YtdAgencySort) {
  const rows = await fetchReferralFacts(filters)
  const groups = groupRows(rows, (row) => row.referrer_id)
  const direction = sortDirection(sort)
  const sortBy = sort?.sort_by ?? "submissions"

  const items = [...groups.entries()].map(([key, group]) => ({
    // null (never a sentinel id) for the no-referrer-resolved bucket — the defect is a
    // null referrer_id + null name carried as missing_referrer, not "Unknown".
    referrer_id: key === "unknown" ? null : Number(key),
    referrer_name: group.find((row) => row.referrer_name)?.referrer_name ?? null,
    deepest_stage: group
      .filter((row) => typeof row.max_stage_rank === "number")
      .sort((a, b) => (b.max_stage_rank ?? 0) - (a.max_stage_rank ?? 0))[0]?.max_stage_name ?? null,
    ...aggregateHandling(group),
  }))

  return items.sort((a, b) => {
    if (REFERRAL_NUMBER_SORTS.has(sortBy)) {
      return (
        compareNullableNumber(
          a[sortBy as keyof typeof a] as number | null,
          b[sortBy as keyof typeof b] as number | null,
          direction
        ) || compareString(a.referrer_name, b.referrer_name, 1)
      )
    }
    return compareString(a.referrer_name, b.referrer_name, direction)
  })
}

function applyReferralApplicationSort(
  rows: YtdApplicationFactRead[],
  sort?: YtdAgencySort
): YtdApplicationFactRead[] {
  const direction = sortDirection(sort)
  const sortBy = sort?.sort_by ?? "submitted_at"
  return [...rows].sort((a, b) => {
    if (sortBy === "first_action_time_hours") {
      return compareNullableNumber(a.first_action_time_hours, b.first_action_time_hours, direction)
    }
    if (sortBy === "primary_recruiter_name") {
      return compareString(a.primary_recruiter_name, b.primary_recruiter_name, direction)
    }
    if (sortBy === "referrer_name") return compareString(a.referrer_name, b.referrer_name, direction)
    if (sortBy === "action_bucket") return compareString(a.action_bucket, b.action_bucket, direction)
    if (sortBy === "current_stage_name") {
      return compareString(a.current_stage_name, b.current_stage_name, direction)
    }
    if (sortBy === "terminal_outcome") {
      return compareString(a.terminal_outcome, b.terminal_outcome, direction)
    }
    const aTime = a.submitted_at ? new Date(a.submitted_at).getTime() : null
    const bTime = b.submitted_at ? new Date(b.submitted_at).getTime() : null
    return compareNullableNumber(aTime, bTime, direction)
  })
}

export async function getYtdReferralApplications(
  filters: YtdReferralFilters & { page?: number; page_size?: number },
  sort?: YtdAgencySort
): Promise<YtdApplicationsPage> {
  const resolvedPage = Math.max(1, filters.page ?? 1)
  const pageSize = Math.min(250, Math.max(1, filters.page_size ?? 50))
  const rows = applyReferralApplicationSort(await fetchReferralFacts(filters), sort)
  const from = (resolvedPage - 1) * pageSize
  return {
    // Canon: never ship raw candidate contact PII in the payload (w0-frozen-spec — evidence
    // labels only). Drop candidate_email from each returned row; name + IDs are enough.
    items: rows.slice(from, from + pageSize).map((r) => {
      const row = { ...(r as unknown as Record<string, unknown>) }
      delete row.candidate_email
      return row
    }) as unknown as YtdApplicationFact[],
    page: resolvedPage,
    page_size: pageSize,
    total: rows.length,
  }
}

export async function getYtdReferralFilterOptions(filters: number | YtdReferralFilters) {
  const resolvedFilters = typeof filters === "number" ? { year: filters } : filters
  // C5: derive the option universe from the YEAR-SCOPED referral set, NOT the filtered set.
  // Fetching on year alone keeps each control's universe stable as siblings change; the
  // filtered subset still governs the tables/cards.
  const rows = await fetchReferralFacts({ year: resolvedFilters.year })

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

  // C1 consistency: the recruiter option list keys on recruiter_ids membership (the axis the
  // table groups on and the server filters with .contains). A recruiter with no resolvable
  // name anywhere is omitted rather than rendered as an "Unknown" sentinel (its rows still
  // surface in the unfiltered table + W4b).
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
    referrers: option((row) => row.referrer_id, (row) => row.referrer_name),
    action_buckets: [...new Set(rows.map((row) => row.action_bucket).filter(Boolean))].sort() as AgencyActionBucket[],
    current_stages: [...new Set(rows.map((row) => row.current_stage_name).filter(Boolean))].sort() as string[],
    terminal_outcomes: [...new Set(rows.map((row) => row.terminal_outcome).filter(Boolean))].sort() as TerminalOutcome[],
  }
}
