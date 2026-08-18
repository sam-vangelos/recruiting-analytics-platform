import {
  getYtdAgencyAgencies,
  getYtdAgencyApplications,
  getYtdAgencyFilterOptions,
  getYtdAgencyRecruiters,
  getYtdAgencySummary,
} from "@/lib/ytd-dashboard";
import { hasEnv } from "@/lib/env";
import {
  buildSyncNotice,
  classifyLoaderError,
  getLatestSyncStatus,
  type YtdNotice,
} from "@/lib/ytd-page-load";
import type {
  AgencyActionBucket,
  DuplicateConfidence,
  FeeRiskState,
  TerminalOutcome,
  YtdAgencyFilters,
  YtdAgencySort,
} from "@/lib/ytd-types";
import { AgencyYtdClient } from "./client";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function numberParam(value: string | string[] | undefined): number | undefined {
  const parsed = Number(one(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function enumParam<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[]
): T | undefined {
  const next = one(value);
  return allowed.includes(next as T) ? (next as T) : undefined;
}

function filtersFromParams(params: Record<string, string | string[] | undefined>): YtdAgencyFilters {
  const parsedYear = Number(one(params.year));
  return {
    year:
      Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
        ? parsedYear
        : new Date().getUTCFullYear(),
    department_id: numberParam(params.department_id),
    recruiter_id: numberParam(params.recruiter_id),
    agency_source_id: numberParam(params.agency_source_id),
    action_bucket: enumParam<AgencyActionBucket>(params.action_bucket, [
      "lt_24h",
      "h24_48",
      "d2_7",
      "gt_7d",
      "unactioned_lt_7d",
      "unactioned_gt_7d",
      "unknown",
    ]),
    duplicate_confidence: enumParam<DuplicateConfidence>(params.duplicate_confidence, [
      "confirmed",
      "high",
      "possible",
      "none",
      "insufficient_data",
    ]),
    fee_risk_state: enumParam<FeeRiskState>(params.fee_risk_state, [
      "not_duplicate",
      "cleared_in_window",
      "pending_in_window",
      "at_risk",
      "exposed",
      "insufficient_data",
    ]),
    current_stage_name: one(params.current_stage_name),
    terminal_outcome: enumParam<TerminalOutcome>(params.terminal_outcome, [
      "active",
      "rejected",
      "hired",
      "converted",
      "unknown",
    ]),
  };
}

function sortFromParams(
  params: Record<string, string | string[] | undefined>,
  fallback = "p75_action_hours"
): YtdAgencySort {
  return {
    sort_by: one(params.sort_by) ?? fallback,
    sort_dir: one(params.sort_dir) === "asc" ? "asc" : "desc",
  };
}

function serializedParams(params: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const next = one(value);
    if (next) out[key] = next;
  }
  return out;
}

export default async function AgencyYtdPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const filters = filtersFromParams(params);
  const sort = sortFromParams(params);

  if (!hasEnv("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) {
    return (
      <AgencyYtdClient
        data={null}
        error="Agency YTD data is unavailable because Supabase environment variables are missing."
        params={serializedParams(params)}
      />
    );
  }

  let data: Parameters<typeof AgencyYtdClient>[0]["data"] = null;
  let error: string | null = null;
  let notice: YtdNotice | null = null;

  try {
    const [summary, recruiters, agencies, applications, filterOptions, sync] = await Promise.all([
      getYtdAgencySummary(filters),
      getYtdAgencyRecruiters(filters, sort),
      getYtdAgencyAgencies(filters, { sort_by: "submissions", sort_dir: "desc" }),
      getYtdAgencyApplications(
        { ...filters, page: numberParam(params.page), page_size: numberParam(params.page_size) ?? 25 },
        { sort_by: one(params.app_sort_by) ?? "submitted_at", sort_dir: one(params.app_sort_dir) === "asc" ? "asc" : "desc" }
      ),
      getYtdAgencyFilterOptions(filters),
      getLatestSyncStatus(filters.year, "agency"),
    ]);

    data = { summary, recruiters, agencies, applications, filterOptions, filters, sort };
    notice = buildSyncNotice(summary.submissions, sync);
  } catch (caught) {
    console.error("[ytd/agency] Failed to load workbench:", caught);
    const message = caught instanceof Error ? caught.message : String(caught);
    error =
      classifyLoaderError(caught) === "auth"
        ? `Agency YTD could not authenticate to the data store — this is likely a credentials/key misconfiguration, not an empty dataset. (${message})`
        : message;
  }

  return (
    <AgencyYtdClient data={data} error={error} notice={notice} params={serializedParams(params)} />
  );
}
