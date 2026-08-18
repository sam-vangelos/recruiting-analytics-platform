import {
  getYtdReferralSummary,
  getYtdReferralRecruiters,
  getYtdReferralReferrers,
  getYtdReferralApplications,
  getYtdReferralFilterOptions,
} from "@/lib/ytd-referral-dashboard";
import { hasEnv } from "@/lib/env";
import {
  buildSyncNotice,
  classifyLoaderError,
  getLatestSyncStatus,
  type YtdNotice,
} from "@/lib/ytd-page-load";
import type {
  AgencyActionBucket,
  TerminalOutcome,
  YtdAgencySort,
} from "@/lib/ytd-types";
import { ReferralYtdClient } from "./client";

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

function filtersFromParams(params: Record<string, string | string[] | undefined>) {
  const parsedYear = Number(one(params.year));
  return {
    year:
      Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
        ? parsedYear
        : new Date().getUTCFullYear(),
    department_id: numberParam(params.department_id),
    recruiter_id: numberParam(params.recruiter_id),
    referrer_id: numberParam(params.referrer_id),
    action_bucket: enumParam<AgencyActionBucket>(params.action_bucket, [
      "lt_24h",
      "h24_48",
      "d2_7",
      "gt_7d",
      "unactioned_lt_7d",
      "unactioned_gt_7d",
      "unknown",
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
  prefix = "",
  fallback = "never_actioned"
): YtdAgencySort {
  return {
    sort_by: one(params[`${prefix}sort_by`]) ?? fallback,
    sort_dir: one(params[`${prefix}sort_dir`]) === "asc" ? "asc" : "desc",
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

export default async function ReferralYtdPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const filters = filtersFromParams(params);
  const recruiterSort = sortFromParams(params, "", "never_actioned");
  const referrerSort = sortFromParams(params, "ref_", "submissions");
  const appSort = sortFromParams(params, "app_", "submitted_at");

  if (!hasEnv("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) {
    return (
      <ReferralYtdClient
        data={null}
        error="Referral YTD data is unavailable because Supabase environment variables are missing."
        params={serializedParams(params)}
      />
    );
  }

  let data: Parameters<typeof ReferralYtdClient>[0]["data"] = null;
  let error: string | null = null;
  let notice: YtdNotice | null = null;

  try {
    const [summary, recruiters, referrers, applications, filterOptions, sync] = await Promise.all([
      getYtdReferralSummary(filters),
      getYtdReferralRecruiters(filters, recruiterSort),
      getYtdReferralReferrers(filters, referrerSort),
      getYtdReferralApplications(
        { ...filters, page: numberParam(params.page), page_size: numberParam(params.page_size) ?? 25 },
        appSort
      ),
      getYtdReferralFilterOptions(filters),
      getLatestSyncStatus(filters.year, "referral"),
    ]);

    data = { summary, recruiters, referrers, applications, filterOptions, filters, recruiterSort, referrerSort };
    // Distinguish "no completed sync yet" from a genuine zero so an empty-because-never-synced
    // page doesn't masquerade as a truthful zero (the referral failure mode).
    notice = buildSyncNotice(summary.submissions, sync);
  } catch (caught) {
    console.error("[ytd/referrals] Failed to load workbench:", caught);
    const message = caught instanceof Error ? caught.message : String(caught);
    error =
      classifyLoaderError(caught) === "auth"
        ? `Referral YTD could not authenticate to the data store — this is likely a credentials/key misconfiguration, not an empty dataset. (${message})`
        : message;
  }

  return (
    <ReferralYtdClient data={data} error={error} notice={notice} params={serializedParams(params)} />
  );
}
