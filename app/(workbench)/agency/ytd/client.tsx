"use client";

import { useRouter } from "next/navigation";
import type { YtdApplicationFact, YtdAgencyFilters, YtdAgencySort } from "@/lib/ytd-types";
import type { YtdNotice } from "@/lib/ytd-page-load";

interface Option {
  value: string;
  label: string;
}

interface Summary {
  submissions: number;
  median_action_hours: number | null;
  p75_action_hours: number | null;
  over_7d_or_unactioned: number;
  confirmed_high_duplicates: number;
  fee_exposure: number;
  at_risk: number;
}

interface HandlingRow {
  recruiter_id?: number | null;
  recruiter_name?: string | null;
  agency_source_id?: number | null;
  agency_source_name?: string | null;
  deepest_stage?: string | null;
  submissions: number;
  median_action_hours: number | null;
  p75_action_hours: number | null;
  over_7d_count: number;
  duplicate_count: number;
  possible_duplicate_count: number;
  fee_exposure_count: number;
  at_risk_count: number;
}

interface FilterOptions {
  departments: Option[];
  recruiters: Option[];
  agencies: Option[];
  action_buckets: string[];
  duplicate_confidences: string[];
  fee_risk_states: string[];
  current_stages: string[];
  terminal_outcomes: string[];
}

interface Data {
  summary: Summary;
  recruiters: HandlingRow[];
  agencies: HandlingRow[];
  applications: {
    items: YtdApplicationFact[];
    page: number;
    page_size: number;
    total: number;
  };
  filterOptions: FilterOptions;
  filters: YtdAgencyFilters;
  sort: YtdAgencySort;
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

const confidenceLabels: Record<string, string> = {
  confirmed: "Confirmed",
  high: "High confidence",
  possible: "Possible",
  none: "No duplicate",
  insufficient_data: "Insufficient data",
};

const riskLabels: Record<string, string> = {
  not_duplicate: "Not duplicate",
  cleared_in_window: "Cleared in window",
  pending_in_window: "Pending in window",
  at_risk: "At risk",
  exposed: "Exposed",
  insufficient_data: "Insufficient data",
};

const evidenceLabels: Record<string, string> = {
  email_exact: "Email",
  phone_exact: "Phone",
  profile_url_exact: "Profile URL",
  candidate_id: "Same GH candidate",
  name_company_title: "Name + company + title",
};

const visibleFilterKeys = [
  "department_id",
  "recruiter_id",
  "agency_source_id",
  "action_bucket",
  "duplicate_confidence",
  "fee_risk_state",
] as const;

const allFilterKeys = [
  ...visibleFilterKeys,
  "current_stage_name",
  "terminal_outcome",
] as const;

const recruiterGridClass =
  "grid-cols-[minmax(220px,1.4fr)_repeat(6,minmax(92px,0.6fr))]";
const agencyGridClass = "grid-cols-[minmax(220px,1fr)_96px_96px_96px]";
const evidenceGridClass =
  "grid-cols-[minmax(320px,1.45fr)_minmax(160px,0.75fr)_minmax(160px,0.75fr)_96px_96px_minmax(260px,1fr)_150px]";

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

function ownerLabel(value: string | null | undefined) {
  return value?.trim() || "Unresolved owner";
}

function agencyLabel(value: string | null | undefined) {
  return value?.trim() || "Unresolved agency";
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

function RiskPill({ state }: { state: string | null | undefined }) {
  const value = state ?? "unknown";
  const tone =
    value === "exposed"
      ? "border-danger-rule bg-danger-bg text-danger-fg"
      : value === "at_risk" || value === "pending_in_window"
        ? "border-warning-rule bg-warning-bg text-warning-fg"
        : "border-border bg-secondary text-ink-secondary";

  return (
    <span className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${tone}`}>
      {riskLabels[value] ?? value}
    </span>
  );
}

function findOptionLabel(options: Option[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}

function evidencePills(row: YtdApplicationFact) {
  if (row.duplicate_confidence === "insufficient_data") return ["Insufficient identity data"];
  if (Array.isArray(row.duplicate_evidence_types) && row.duplicate_evidence_types.length > 0) {
    return row.duplicate_evidence_types.map((type) => evidenceLabels[type] ?? type);
  }
  if (row.duplicate_confidence === "none") return ["No matching signals"];
  return [confidenceLabels[row.duplicate_confidence] ?? row.duplicate_confidence];
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

export function AgencyYtdClient({
  data,
  error,
  notice,
  params,
}: {
  data: Data | null;
  error: string | null;
  notice?: YtdNotice | null;
  params: Record<string, string>;
}) {
  const router = useRouter();

  function navigate(next: URLSearchParams) {
    const query = next.toString();
    router.push(query ? `/agency/ytd?${query}` : "/agency/ytd");
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

  function chooseAgency(id: number | null | undefined) {
    pushParam("agency_source_id", id ? String(id) : "");
  }

  if (!data) {
    return (
      <div className="flex w-full flex-col gap-8 bg-background px-12 py-8">
        <section className="flex flex-col gap-3">
          <h1 className="text-[34px] font-medium leading-tight text-ink">Agency YTD</h1>
          <p className="text-sm text-ink-secondary">
            Agency handling and fee-risk analytics for the current year.
          </p>
        </section>
        <section className="rounded border border-border bg-card px-6 py-10 text-sm text-ink-secondary">
          {error ?? "Agency YTD data is unavailable."}
        </section>
      </div>
    );
  }

  const filterOptions = data.filterOptions;
  const summary = data.summary;
  const filteredRecruiter = data.filters.recruiter_id ? String(data.filters.recruiter_id) : "";
  const filteredAgency = data.filters.agency_source_id ? String(data.filters.agency_source_id) : "";
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
    filteredAgency
      ? {
          key: "agency_source_id",
          label: "Agency",
          value: findOptionLabel(filterOptions.agencies, filteredAgency),
        }
      : null,
    data.filters.action_bucket
      ? {
          key: "action_bucket",
          label: "Action",
          value: actionBucketLabels[data.filters.action_bucket] ?? data.filters.action_bucket,
        }
      : null,
    data.filters.duplicate_confidence
      ? {
          key: "duplicate_confidence",
          label: "Duplicate",
          value:
            confidenceLabels[data.filters.duplicate_confidence] ??
            data.filters.duplicate_confidence,
        }
      : null,
    data.filters.fee_risk_state
      ? {
          key: "fee_risk_state",
          label: "Risk",
          value: riskLabels[data.filters.fee_risk_state] ?? data.filters.fee_risk_state,
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
            AGENCY ANALYTICS
          </span>
        </div>
        <h1 className="text-[34px] font-medium leading-tight text-ink">Agency YTD</h1>
        <p className="max-w-[760px] text-sm leading-6 text-ink-secondary">
          Historical agency submissions, recruiter handling speed, duplicate signals, and fee-risk exposure.
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
          label="AGENCY"
          value={filteredAgency}
          options={[{ value: "", label: "All agencies" }, ...filterOptions.agencies]}
          onChange={(value) => pushParam("agency_source_id", value)}
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
          label="DUPLICATE"
          value={data.filters.duplicate_confidence ?? ""}
          options={[
            { value: "", label: "All duplicate states" },
            ...filterOptions.duplicate_confidences.map((value) => ({
              value,
              label: confidenceLabels[value] ?? value,
            })),
          ]}
          onChange={(value) => pushParam("duplicate_confidence", value)}
        />
        <SelectFilter
          label="RISK"
          value={data.filters.fee_risk_state ?? ""}
          options={[
            { value: "", label: "All risk states" },
            ...filterOptions.fee_risk_states.map((value) => ({
              value,
              label: riskLabels[value] ?? value,
            })),
          ]}
          onChange={(value) => pushParam("fee_risk_state", value)}
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

      <section className="grid grid-cols-1 gap-3 md:grid-cols-5">
        <Metric label="SUBMISSIONS" value={summary.submissions} detail="Agency candidates YTD" />
        <Metric
          label="MEDIAN FIRST ACTION"
          value={formatHours(summary.median_action_hours)}
          detail={`P75 ${formatHours(summary.p75_action_hours)}`}
        />
        <Metric
          label=">7D / UNACTIONED"
          value={summary.over_7d_or_unactioned}
          detail="handling risk"
          tone={summary.over_7d_or_unactioned > 0 ? "warning" : "neutral"}
        />
        <Metric
          label="CONFIRMED / HIGH DUPES"
          value={summary.confirmed_high_duplicates}
          detail="duplicate matches"
          tone={summary.confirmed_high_duplicates > 0 ? "warning" : "neutral"}
        />
        <Metric
          label="FEE EXPOSURE"
          value={summary.fee_exposure}
          detail="outside 7d / unactioned"
          tone={summary.fee_exposure > 0 ? "danger" : "neutral"}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">Recruiter Handling</h2>
            <p className="text-[13px] text-ink-secondary">
              Req ownership, action speed, duplicate volume, and fee exposure.
            </p>
          </div>
          <div className="flex gap-2">
            <SelectFilter
              label="SORT"
              value={params.sort_by ?? "p75_action_hours"}
              options={[
                { value: "p75_action_hours", label: "P75 action" },
                { value: "median_action_hours", label: "Median action" },
                { value: "submissions", label: "Submissions" },
                { value: "over_7d_count", label: ">7d" },
                { value: "duplicate_count", label: "Duplicates" },
                { value: "fee_exposure_count", label: "Exposure" },
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
          <div className={`grid w-full min-w-[920px] ${recruiterGridClass} bg-secondary px-4 py-2.5 font-mono text-[10px] font-semibold tracking-[1.3px] text-ink-tertiary`}>
            <div>RECRUITER</div>
            <div>SUBMISSIONS</div>
            <div>MEDIAN</div>
            <div>P75</div>
            <div>&gt;7D</div>
            <div>DUPES</div>
            <div>EXPOSURE</div>
          </div>
          {data.recruiters.length ? (
            data.recruiters.map((row) => (
              <button
                key={row.recruiter_id ?? "unknown"}
                type="button"
                onClick={() => chooseRecruiter(row.recruiter_id)}
                className={`grid min-h-[44px] w-full min-w-[920px] ${recruiterGridClass} items-center border-t border-hairline-soft px-4 py-3 text-left text-[13px] hover:bg-card ${
                  filteredRecruiter && filteredRecruiter === String(row.recruiter_id ?? "")
                    ? "bg-card shadow-[inset_3px_0_0_var(--ink)]"
                    : ""
                }`}
              >
                <div className="font-medium text-ink">{ownerLabel(row.recruiter_name)}</div>
                <div className="font-mono text-ink">{row.submissions}</div>
                <div className="font-mono text-ink-secondary">{formatHours(row.median_action_hours)}</div>
                <div className="font-mono text-ink-secondary">{formatHours(row.p75_action_hours)}</div>
                <div className="font-mono text-warning">{row.over_7d_count}</div>
                <div className="font-mono text-ink-secondary">{row.duplicate_count}</div>
                <div className="font-mono text-danger">{row.fee_exposure_count}</div>
              </button>
            ))
          ) : (
            <div className="px-4 py-8 text-center text-sm text-ink-tertiary">No recruiter rows match the filters.</div>
          )}
        </div>
      </section>

      <section className="flex max-w-[760px] flex-col gap-3">
        <h2 className="text-lg font-semibold text-ink">Agency Breakdown</h2>
        <div className="overflow-hidden rounded border border-border">
          <div className={`grid ${agencyGridClass} bg-secondary px-4 py-2.5 font-mono text-[10px] font-semibold tracking-[1.3px] text-ink-tertiary`}>
            <div>AGENCY</div>
            <div>APPS</div>
            <div>DUPES</div>
            <div>EXPOSURE</div>
          </div>
          {data.agencies.map((row) => (
            <button
              key={row.agency_source_id ?? "unknown"}
              type="button"
              onClick={() => chooseAgency(row.agency_source_id)}
              className={`grid min-h-[42px] w-full ${agencyGridClass} items-center border-t border-hairline-soft px-4 py-3 text-left text-[13px] hover:bg-card ${
                filteredAgency && filteredAgency === String(row.agency_source_id ?? "")
                  ? "bg-card shadow-[inset_3px_0_0_var(--ink)]"
                  : ""
              }`}
            >
              <div className="truncate font-medium text-ink">{agencyLabel(row.agency_source_name)}</div>
              <div className="font-mono text-ink">{row.submissions}</div>
              <div className="font-mono text-ink-secondary">{row.duplicate_count}</div>
              <div className="font-mono text-danger">{row.fee_exposure_count}</div>
            </button>
          ))}
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
                { value: "action_bucket", label: "Action bucket" },
                { value: "duplicate_confidence", label: "Duplicate" },
                { value: "fee_risk_state", label: "Risk" },
                { value: "primary_recruiter_name", label: "Recruiter" },
                { value: "agency_source_name", label: "Agency" },
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
            <div className={`grid w-full min-w-[1260px] ${evidenceGridClass} bg-secondary px-4 py-2.5 font-mono text-[10px] font-semibold tracking-[1.3px] text-ink-tertiary`}>
              <div>CANDIDATE / ROLE</div>
              <div>RECRUITER</div>
              <div>AGENCY</div>
              <div>SUBMITTED</div>
              <div>ACTION</div>
              <div>DUPLICATE EVIDENCE</div>
              <div>RISK</div>
            </div>
            {data.applications.items.map((row) => (
              <div
                key={row.application_id}
                className={`grid min-h-[58px] w-full min-w-[1260px] ${evidenceGridClass} items-center border-t border-hairline-soft px-4 py-3 text-[13px]`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-ink">
                    {row.candidate_name ?? "Candidate unavailable"}
                  </div>
                  <div className="truncate text-ink-secondary">{row.job_title ?? "Unknown role"}</div>
                  <div className="mt-1 truncate font-mono text-[10px] text-ink-tertiary">
                    C-{row.candidate_id} / App {row.application_id}
                  </div>
                </div>
                <div className="truncate text-ink-secondary">{ownerLabel(row.primary_recruiter_name)}</div>
                <div className="truncate text-ink-secondary">{agencyLabel(row.agency_source_name)}</div>
                <div className="font-mono text-ink-secondary">{formatDate(row.submitted_at)}</div>
                <div className="font-mono text-ink-secondary">{formatHours(row.first_action_time_hours)}</div>
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {evidencePills(row).map((label) => (
                    <span
                      key={label}
                      className="rounded border border-border bg-secondary px-2 py-0.5 font-mono text-[10px] font-semibold text-ink-secondary"
                    >
                      {label}
                    </span>
                  ))}
                </div>
                <div>
                  <RiskPill state={row.fee_risk_state} />
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
