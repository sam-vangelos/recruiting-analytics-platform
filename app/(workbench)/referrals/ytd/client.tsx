"use client";

import { useRouter } from "next/navigation";
import type { YtdApplicationFact, YtdAgencySort } from "@/lib/ytd-types";
import type { YtdNotice } from "@/lib/ytd-page-load";

interface Option {
  value: string;
  label: string;
}

interface Summary {
  submissions: number;
  actioned: number;
  never_actioned: number;
  median_action_hours: number | null;
  p75_action_hours: number | null;
  over_7d_or_unactioned: number;
  actioned_within_7d: number;
}

interface RecruiterRow {
  recruiter_id: number | null;
  recruiter_name: string | null;
  ownership_resolution_status: string | null;
  submissions: number;
  median_action_hours: number | null;
  p75_action_hours: number | null;
  over_7d_count: number;
  never_actioned: number;
  actioned_within_7d_count: number;
}

interface ReferrerRow {
  referrer_id: number | null;
  referrer_name: string | null;
  deepest_stage: string | null;
  submissions: number;
  actioned: number;
  never_actioned: number;
  median_action_hours: number | null;
  over_7d_count: number;
}

interface FilterOptions {
  departments: Option[];
  recruiters: Option[];
  referrers: Option[];
  action_buckets: string[];
  current_stages: string[];
  terminal_outcomes: string[];
}

interface Data {
  summary: Summary;
  recruiters: RecruiterRow[];
  referrers: ReferrerRow[];
  applications: {
    items: YtdApplicationFact[];
    page: number;
    page_size: number;
    total: number;
  };
  filterOptions: FilterOptions;
  filters: {
    year: number;
    department_id?: number;
    recruiter_id?: number;
    referrer_id?: number;
    action_bucket?: string;
    terminal_outcome?: string;
  };
  recruiterSort: YtdAgencySort;
  referrerSort: YtdAgencySort;
}

const actionBucketLabels: Record<string, string> = {
  lt_24h: "<24h",
  h24_48: "24-48h",
  d2_7: "2-7d",
  gt_7d: ">7d",
  unactioned_lt_7d: "Unactioned <7d",
  unactioned_gt_7d: "Unactioned >7d",
  unknown: "Unknown",
};

const outcomeLabels: Record<string, string> = {
  active: "Active",
  rejected: "Rejected",
  hired: "Hired",
  converted: "Converted",
  unknown: "Unknown",
};

const visibleFilterKeys = [
  "department_id",
  "recruiter_id",
  "referrer_id",
  "action_bucket",
  "terminal_outcome",
] as const;

const allFilterKeys = [
  ...visibleFilterKeys,
  "current_stage_name",
] as const;

const recruiterGridClass =
  "grid-cols-[minmax(200px,1.4fr)_repeat(6,minmax(80px,0.6fr))]";
const referrerGridClass =
  "grid-cols-[minmax(200px,1.4fr)_repeat(6,minmax(80px,0.6fr))]";
const evidenceGridClass =
  "grid-cols-[minmax(280px,1.4fr)_minmax(130px,0.7fr)_minmax(130px,0.7fr)_90px_90px_90px_minmax(120px,0.6fr)_minmax(120px,0.6fr)_100px]";

function formatHours(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value < 24) return `${Math.round(value)}h`;
  return `${Math.round((value / 24) * 10) / 10}d`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "neutral" | "warning" | "danger";
}) {
  const styles = {
    neutral: "border-border bg-card text-ink",
    warning: "border-warning-rule bg-warning-bg text-warning-fg",
    danger: "border-danger-rule bg-danger-bg text-danger-fg",
  }[tone];

  return (
    <section className={`min-h-[86px] rounded border px-4 py-3 ${styles}`}>
      <div className="font-mono text-[10px] font-semibold tracking-[1.4px] opacity-75">
        {label}
      </div>
      <div className="mt-1 font-mono text-[26px] font-semibold leading-tight">{value}</div>
      <div className="mt-1 text-xs opacity-80">{detail}</div>
    </section>
  );
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-[155px] flex-col gap-1">
      <span className="font-mono text-[10px] font-semibold tracking-[1.4px] text-ink-tertiary">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded border border-border bg-card px-2 text-[13px] text-ink outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function OutcomePill({ outcome }: { outcome: string | null | undefined }) {
  const value = outcome ?? "unknown";
  const tone =
    value === "hired" || value === "converted"
      ? "border-success-rule bg-success-bg text-success-fg"
      : value === "rejected"
        ? "border-border bg-secondary text-ink-secondary"
        : "border-border bg-card text-ink-secondary";

  return (
    <span className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${tone}`}>
      {outcomeLabels[value] ?? value}
    </span>
  );
}

function findOptionLabel(options: Option[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}

function NoticeBanner({ notice }: { notice: YtdNotice }) {
  const tone =
    notice.tone === "danger"
      ? "border-danger-rule bg-danger-bg text-danger-fg"
      : "border-warning-rule bg-warning-bg text-warning-fg";
  return (
    <section className={`rounded border px-4 py-3 ${tone}`}>
      <div className="font-mono text-[10px] font-semibold tracking-[1.4px]">{notice.headline}</div>
      <div className="mt-1 text-[13px] leading-5 opacity-90">{notice.detail}</div>
    </section>
  );
}

export function ReferralYtdClient({
  data,
  error,
  notice,
  params,
}: {
  data: Data | null;
  error?: string | null;
  notice?: YtdNotice | null;
  params: Record<string, string>;
}) {
  const router = useRouter();

  function navigate(next: URLSearchParams) {
    const query = next.toString();
    router.push(query ? `/referrals/ytd?${query}` : "/referrals/ytd");
  }

  function pushParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    navigate(next);
  }

  function clearFilters() {
    const next = new URLSearchParams(params);
    allFilterKeys.forEach((key) => next.delete(key));
    next.delete("page");
    navigate(next);
  }

  function setPage(page: number) {
    const next = new URLSearchParams(params);
    if (page > 1) next.set("page", String(page));
    else next.delete("page");
    navigate(next);
  }

  function chooseRecruiter(id: number | null | undefined) {
    pushParam("recruiter_id", id ? String(id) : "");
  }

  function chooseReferrer(id: number | null | undefined) {
    pushParam("referrer_id", id ? String(id) : "");
  }

  if (!data) {
    return (
      <div className="flex w-full flex-col gap-8 bg-background px-12 py-8">
        <section className="flex flex-col gap-3">
          <h1 className="text-[34px] font-medium leading-tight text-ink">Referral YTD</h1>
          <p className="text-sm text-ink-secondary">
            Referral handling, recruiter accountability, and candidate outcomes year-to-date.
          </p>
        </section>
        <section className="rounded border border-border bg-card px-6 py-10 text-sm text-ink-secondary">
          {error ?? "Referral YTD data is unavailable."}
        </section>
      </div>
    );
  }

  const filterOptions = data.filterOptions;
  const summary = data.summary;
  const filteredRecruiter = data.filters.recruiter_id ? String(data.filters.recruiter_id) : "";
  const filteredReferrer = data.filters.referrer_id ? String(data.filters.referrer_id) : "";
  const slaRate =
    summary.submissions > 0
      ? Math.round((summary.actioned_within_7d / summary.submissions) * 100)
      : 0;

  const activeFilters = [
    data.filters.department_id
      ? {
          key: "department_id",
          label: "Department",
          value: findOptionLabel(filterOptions.departments, String(data.filters.department_id)),
        }
      : null,
    filteredRecruiter
      ? {
          key: "recruiter_id",
          label: "Recruiter",
          value: findOptionLabel(filterOptions.recruiters, filteredRecruiter),
        }
      : null,
    filteredReferrer
      ? {
          key: "referrer_id",
          label: "Referrer",
          value: findOptionLabel(filterOptions.referrers, filteredReferrer),
        }
      : null,
    data.filters.action_bucket
      ? {
          key: "action_bucket",
          label: "Action",
          value: actionBucketLabels[data.filters.action_bucket] ?? data.filters.action_bucket,
        }
      : null,
    data.filters.terminal_outcome
      ? {
          key: "terminal_outcome",
          label: "Outcome",
          value: outcomeLabels[data.filters.terminal_outcome] ?? data.filters.terminal_outcome,
        }
      : null,
  ].filter(
    (filter): filter is { key: string; label: string; value: string } => filter !== null,
  );

  const applicationStart =
    data.applications.total > 0
      ? (data.applications.page - 1) * data.applications.page_size + 1
      : 0;
  const applicationEnd = Math.min(
    data.applications.page * data.applications.page_size,
    data.applications.total,
  );
  const canPageBack = data.applications.page > 1;
  const canPageForward = applicationEnd < data.applications.total;

  return (
    <div className="flex w-full max-w-full flex-col gap-7 overflow-x-hidden bg-background px-12 py-8">
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="h-px w-12 bg-ink-tertiary" aria-hidden="true" />
          <span className="font-mono text-[11px] font-medium tracking-[2.5px] text-ink-tertiary">
            REFERRAL ANALYTICS
          </span>
        </div>
        <h1 className="text-[34px] font-medium leading-tight text-ink">Referral YTD</h1>
        <p className="max-w-[760px] text-sm leading-6 text-ink-secondary">
          Recruiter accountability, referral handling speed, and candidate outcomes year-to-date.
        </p>
      </section>

      {notice ? <NoticeBanner notice={notice} /> : null}

      <section className="flex flex-wrap gap-3 border-y border-border py-4">
        <SelectFilter
          label="YEAR"
          value={String(data.filters.year)}
          options={[{ value: String(data.filters.year), label: String(data.filters.year) }]}
          onChange={(value) => pushParam("year", value)}
        />
        <SelectFilter
          label="DEPARTMENT"
          value={data.filters.department_id ? String(data.filters.department_id) : ""}
          options={[{ value: "", label: "All departments" }, ...filterOptions.departments]}
          onChange={(value) => pushParam("department_id", value)}
        />
        <SelectFilter
          label="RECRUITER"
          value={filteredRecruiter}
          options={[{ value: "", label: "All recruiters" }, ...filterOptions.recruiters]}
          onChange={(value) => pushParam("recruiter_id", value)}
        />
        <SelectFilter
          label="REFERRER"
          value={filteredReferrer}
          options={[{ value: "", label: "All referrers" }, ...filterOptions.referrers]}
          onChange={(value) => pushParam("referrer_id", value)}
        />
        <SelectFilter
          label="ACTION"
          value={data.filters.action_bucket ?? ""}
          options={[
            { value: "", label: "All windows" },
            ...filterOptions.action_buckets.map((value) => ({
              value,
              label: actionBucketLabels[value] ?? value,
            })),
          ]}
          onChange={(value) => pushParam("action_bucket", value)}
        />
        <SelectFilter
          label="OUTCOME"
          value={data.filters.terminal_outcome ?? ""}
          options={[
            { value: "", label: "All outcomes" },
            ...filterOptions.terminal_outcomes.map((value) => ({
              value,
              label: outcomeLabels[value] ?? value,
            })),
          ]}
          onChange={(value) => pushParam("terminal_outcome", value)}
        />
      </section>

      {activeFilters.length > 0 ? (
        <section className="flex flex-wrap items-center gap-2">
          {activeFilters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => pushParam(filter.key, "")}
              className="rounded border border-border bg-card px-2.5 py-1.5 text-left text-[12px] text-ink-secondary hover:border-ink-tertiary hover:text-ink"
              title={`Clear ${filter.label}`}
            >
              <span className="font-mono text-[10px] font-semibold tracking-[1.2px] text-ink-tertiary">
                {filter.label}
              </span>{" "}
              <span>{filter.value}</span>
              <span className="ml-1 text-ink-tertiary" aria-hidden="true">
                x
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={clearFilters}
            className="px-2.5 py-1.5 font-mono text-[10px] font-semibold tracking-[1.2px] text-ink-tertiary hover:text-ink"
          >
            CLEAR FILTERS
          </button>
        </section>
      ) : null}

      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Metric label="REFERRALS YTD" value={summary.submissions} detail={`${summary.actioned} actioned`} />
        <Metric
          label="NEVER ACTIONED"
          value={summary.never_actioned}
          detail="no recruiter action recorded"
          tone={summary.never_actioned > 0 ? "warning" : "neutral"}
        />
        <Metric
          label="MEDIAN FIRST ACTION"
          value={formatHours(summary.median_action_hours)}
          detail={`P75 ${formatHours(summary.p75_action_hours)}`}
        />
        <Metric
          label="SLA COMPLIANCE"
          value={`${slaRate}%`}
          detail="actioned within 7 days"
          tone={slaRate < 80 ? "danger" : slaRate < 95 ? "warning" : "neutral"}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">Recruiter Handling</h2>
            <p className="text-[13px] text-ink-secondary">
              Req ownership, action speed, and referral accountability.
            </p>
          </div>
          <div className="flex gap-2">
            <SelectFilter
              label="SORT"
              value={params.sort_by ?? "never_actioned"}
              options={[
                { value: "never_actioned", label: "Never actioned" },
                { value: "submissions", label: "Referrals" },
                { value: "median_action_hours", label: "Median action" },
                { value: "p75_action_hours", label: "P75 action" },
                { value: "over_7d_count", label: ">7d" },
              ]}
              onChange={(value) => pushParam("sort_by", value)}
            />
            <SelectFilter
              label="DIR"
              value={params.sort_dir ?? "desc"}
              options={[
                { value: "desc", label: "High first" },
                { value: "asc", label: "Low first" },
              ]}
              onChange={(value) => pushParam("sort_dir", value)}
            />
          </div>
        </div>
        <div className="overflow-x-auto rounded border border-border">
          <div className={`grid w-full min-w-[820px] ${recruiterGridClass} bg-secondary px-4 py-2.5 font-mono text-[10px] font-semibold tracking-[1.3px] text-ink-tertiary`}>
            <div>RECRUITER</div>
            <div>REFERRALS</div>
            <div>MEDIAN</div>
            <div>P75</div>
            <div>&gt;7D</div>
            <div>NEVER ACTIONED</div>
            <div>SLA %</div>
          </div>
          {data.recruiters.length ? (
            data.recruiters.map((row) => {
              const rowSla =
                row.submissions > 0
                  ? Math.round((row.actioned_within_7d_count / row.submissions) * 100)
                  : 0;
              return (
                <button
                  key={row.recruiter_id ?? "unresolved"}
                  type="button"
                  onClick={() => chooseRecruiter(row.recruiter_id)}
                  className={`grid min-h-[44px] w-full min-w-[820px] ${recruiterGridClass} items-center border-t border-hairline-soft px-4 py-3 text-left text-[13px] hover:bg-card ${
                    filteredRecruiter && filteredRecruiter === String(row.recruiter_id ?? "")
                      ? "bg-card shadow-[inset_3px_0_0_var(--ink)]"
                      : ""
                  }`}
                >
                  <div className="font-medium text-ink">
                    {row.recruiter_name ?? (
                      <span className="italic text-ink-tertiary">No recruiter resolved</span>
                    )}
                  </div>
                  <div className="font-mono text-ink">{row.submissions}</div>
                  <div className="font-mono text-ink-secondary">{formatHours(row.median_action_hours)}</div>
                  <div className="font-mono text-ink-secondary">{formatHours(row.p75_action_hours)}</div>
                  <div className="font-mono text-warning">{row.over_7d_count}</div>
                  <div className={`font-mono ${row.never_actioned > 0 ? "text-danger" : "text-ink-secondary"}`}>
                    {row.never_actioned}
                  </div>
                  <div className={`font-mono ${rowSla < 80 ? "text-danger" : rowSla < 95 ? "text-warning" : "text-ink-secondary"}`}>
                    {rowSla}%
                  </div>
                </button>
              );
            })
          ) : (
            <div className="px-4 py-8 text-center text-sm text-ink-tertiary">No recruiter rows match the filters.</div>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">Referrer Breakdown</h2>
            <p className="text-[13px] text-ink-secondary">
              Who referred, volume, and handling outcomes.
            </p>
          </div>
          <div className="flex gap-2">
            <SelectFilter
              label="SORT"
              value={params.ref_sort_by ?? "submissions"}
              options={[
                { value: "submissions", label: "Referrals" },
                { value: "never_actioned", label: "Never actioned" },
                { value: "median_action_hours", label: "Median action" },
                { value: "over_7d_count", label: ">7d" },
              ]}
              onChange={(value) => pushParam("ref_sort_by", value)}
            />
            <SelectFilter
              label="DIR"
              value={params.ref_sort_dir ?? "desc"}
              options={[
                { value: "desc", label: "High first" },
                { value: "asc", label: "Low first" },
              ]}
              onChange={(value) => pushParam("ref_sort_dir", value)}
            />
          </div>
        </div>
        <div className="overflow-x-auto rounded border border-border">
          <div className={`grid w-full min-w-[820px] ${referrerGridClass} bg-secondary px-4 py-2.5 font-mono text-[10px] font-semibold tracking-[1.3px] text-ink-tertiary`}>
            <div>REFERRER</div>
            <div>REFERRALS</div>
            <div>ACTIONED</div>
            <div>NEVER ACTIONED</div>
            <div>MEDIAN</div>
            <div>&gt;7D</div>
            <div>DEEPEST STAGE</div>
          </div>
          {data.referrers.length ? (
            data.referrers.map((row) => (
              <button
                key={row.referrer_id ?? "unresolved"}
                type="button"
                onClick={() => chooseReferrer(row.referrer_id)}
                className={`grid min-h-[44px] w-full min-w-[820px] ${referrerGridClass} items-center border-t border-hairline-soft px-4 py-3 text-left text-[13px] hover:bg-card ${
                  filteredReferrer && filteredReferrer === String(row.referrer_id ?? "")
                    ? "bg-card shadow-[inset_3px_0_0_var(--ink)]"
                    : ""
                }`}
              >
                <div className="font-medium text-ink">
                  {row.referrer_name ?? (
                    <span className="italic text-ink-tertiary">No referrer resolved</span>
                  )}
                </div>
                <div className="font-mono text-ink">{row.submissions}</div>
                <div className="font-mono text-ink-secondary">{row.actioned}</div>
                <div className={`font-mono ${row.never_actioned > 0 ? "text-danger" : "text-ink-secondary"}`}>
                  {row.never_actioned}
                </div>
                <div className="font-mono text-ink-secondary">{formatHours(row.median_action_hours)}</div>
                <div className="font-mono text-warning">{row.over_7d_count}</div>
                <div className="truncate text-ink-secondary">{row.deepest_stage ?? "—"}</div>
              </button>
            ))
          ) : (
            <div className="px-4 py-8 text-center text-sm text-ink-tertiary">No referrer rows match the filters.</div>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">Candidate-Level Evidence</h2>
          <div className="flex gap-2">
            <SelectFilter
              label="SORT"
              value={params.app_sort_by ?? "submitted_at"}
              options={[
                { value: "submitted_at", label: "Submitted" },
                { value: "first_action_time_hours", label: "Action speed" },
                { value: "primary_recruiter_name", label: "Recruiter" },
                { value: "referrer_name", label: "Referrer" },
                { value: "terminal_outcome", label: "Outcome" },
              ]}
              onChange={(value) => pushParam("app_sort_by", value)}
            />
            <SelectFilter
              label="DIR"
              value={params.app_sort_dir ?? "desc"}
              options={[
                { value: "desc", label: "Desc" },
                { value: "asc", label: "Asc" },
              ]}
              onChange={(value) => pushParam("app_sort_dir", value)}
            />
          </div>
        </div>
        <div className="overflow-hidden rounded border border-border">
          <div className="overflow-x-auto">
            <div className={`grid w-full min-w-[1200px] ${evidenceGridClass} bg-secondary px-4 py-2.5 font-mono text-[10px] font-semibold tracking-[1.3px] text-ink-tertiary`}>
              <div>CANDIDATE / ROLE</div>
              <div>REFERRER</div>
              <div>RECRUITER</div>
              <div>SUBMITTED</div>
              <div>ACTION</div>
              <div>WINDOW</div>
              <div>DEEPEST STAGE</div>
              <div>CURRENT STAGE</div>
              <div>OUTCOME</div>
            </div>
            {data.applications.items.map((row) => (
              <div
                key={row.application_id}
                className={`grid min-h-[58px] w-full min-w-[1200px] ${evidenceGridClass} items-center border-t border-hairline-soft px-4 py-3 text-[13px]`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-ink">
                    {row.candidate_name ?? "Candidate unavailable"}
                  </div>
                  <div className="truncate text-ink-secondary">{row.job_title ?? "—"}</div>
                  <div className="mt-1 truncate font-mono text-[10px] text-ink-tertiary">
                    C-{row.candidate_id} / App {row.application_id}
                  </div>
                </div>
                <div className="truncate text-ink-secondary">{row.referrer_name ?? "—"}</div>
                <div className="truncate text-ink-secondary">{row.primary_recruiter_name ?? "—"}</div>
                <div className="font-mono text-ink-secondary">{formatDate(row.submitted_at)}</div>
                <div className="font-mono text-ink-secondary">{formatHours(row.first_action_time_hours)}</div>
                <div className="text-ink-secondary">
                  {row.action_bucket ? (
                    <span className="rounded border border-border bg-secondary px-2 py-0.5 font-mono text-[10px] font-semibold text-ink-secondary">
                      {actionBucketLabels[row.action_bucket] ?? row.action_bucket}
                    </span>
                  ) : (
                    "—"
                  )}
                </div>
                <div className="truncate text-ink-secondary">{row.max_stage_name ?? "—"}</div>
                <div className="truncate text-ink-secondary">{row.current_stage_name ?? "—"}</div>
                <div>
                  <OutcomePill outcome={row.terminal_outcome} />
                </div>
              </div>
            ))}
            {!data.applications.items.length ? (
              <div className="px-4 py-8 text-center text-sm text-ink-tertiary">
                No candidate rows match the filters.
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-4 py-3 text-[12px] text-ink-secondary">
            <span>
              Showing {applicationStart}-{applicationEnd} of {data.applications.total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!canPageBack}
                onClick={() => setPage(data.applications.page - 1)}
                className="rounded border border-border px-3 py-1.5 font-mono text-[10px] font-semibold tracking-[1.2px] text-ink-secondary disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:border-ink-tertiary enabled:hover:text-ink"
              >
                PREVIOUS
              </button>
              <button
                type="button"
                disabled={!canPageForward}
                onClick={() => setPage(data.applications.page + 1)}
                className="rounded border border-border px-3 py-1.5 font-mono text-[10px] font-semibold tracking-[1.2px] text-ink-secondary disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:border-ink-tertiary enabled:hover:text-ink"
              >
                NEXT
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
