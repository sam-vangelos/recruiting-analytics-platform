import { parseYear } from "../route-utils"
import type { YtdReferralFilters } from "@/lib/ytd-referral-dashboard"
import type { AgencyActionBucket, TerminalOutcome, YtdAgencySort } from "@/lib/ytd-types"

function numberParam(value: string | null): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function enumParam<T extends string>(
  value: string | null,
  allowed: readonly T[]
): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined
}

// Mirrors parseAgencyFilters (../agency/route-helpers.ts) but on the referral axes:
// referrer_id replaces agency_source_id, and duplicate_confidence/fee_risk_state are
// dropped (those are agency fee-protection axes, not referral). recruiter_id is the same
// membership-filtered axis the loader applies with .contains recruiter_ids (C1 lesson).
export function parseReferralFilters(url: URL): YtdReferralFilters {
  return {
    year: parseYear(url.searchParams.get("year")),
    department_id: numberParam(url.searchParams.get("department_id")),
    recruiter_id: numberParam(url.searchParams.get("recruiter_id")),
    referrer_id: numberParam(url.searchParams.get("referrer_id")),
    action_bucket: enumParam<AgencyActionBucket>(url.searchParams.get("action_bucket"), [
      "lt_24h",
      "h24_48",
      "d2_7",
      "gt_7d",
      "unactioned_lt_7d",
      "unactioned_gt_7d",
      "unknown",
    ]),
    current_stage_name: url.searchParams.get("current_stage_name") ?? undefined,
    terminal_outcome: enumParam<TerminalOutcome>(url.searchParams.get("terminal_outcome"), [
      "active",
      "rejected",
      "hired",
      "converted",
      "unknown",
    ]),
  }
}

export function parseReferralSort(url: URL, defaultSortBy: string): YtdAgencySort {
  const sortDir = url.searchParams.get("sort_dir") === "asc" ? "asc" : "desc"
  return {
    sort_by: url.searchParams.get("sort_by") ?? defaultSortBy,
    sort_dir: sortDir,
  }
}

export function parsePaging(url: URL): { page?: number; page_size?: number } {
  return {
    page: numberParam(url.searchParams.get("page")),
    page_size: numberParam(url.searchParams.get("page_size")),
  }
}
