import { parseYear } from "../route-utils"
import type {
  AgencyActionBucket,
  DuplicateConfidence,
  FeeRiskState,
  TerminalOutcome,
  YtdAgencyFilters,
  YtdAgencySort,
} from "@/lib/ytd-types"

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

export function parseAgencyFilters(url: URL): YtdAgencyFilters {
  return {
    year: parseYear(url.searchParams.get("year")),
    department_id: numberParam(url.searchParams.get("department_id")),
    recruiter_id: numberParam(url.searchParams.get("recruiter_id")),
    agency_source_id: numberParam(url.searchParams.get("agency_source_id")),
    action_bucket: enumParam<AgencyActionBucket>(url.searchParams.get("action_bucket"), [
      "lt_24h",
      "h24_48",
      "d2_7",
      "gt_7d",
      "unactioned_lt_7d",
      "unactioned_gt_7d",
      "unknown",
    ]),
    duplicate_confidence: enumParam<DuplicateConfidence>(
      url.searchParams.get("duplicate_confidence"),
      ["confirmed", "high", "possible", "none", "insufficient_data"]
    ),
    fee_risk_state: enumParam<FeeRiskState>(url.searchParams.get("fee_risk_state"), [
      "not_duplicate",
      "cleared_in_window",
      "pending_in_window",
      "at_risk",
      "exposed",
      "insufficient_data",
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

export function parseAgencySort(url: URL, defaultSortBy: string): YtdAgencySort {
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
