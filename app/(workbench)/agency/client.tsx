"use client";

import { useMemo, useState } from "react";
import type { AgencySubmission, AgencyTrackerData } from "@/lib/sweep-types";
import { resolvedOrNull } from "@/lib/resolution-display";
import { SweepHealthBanner } from "@/app/_components/SweepHealthBanner";

// Gated agency name for narrative prose: the resolved source name, or an honest substitute when the
// source is unresolved (the defect contract — never interpolate a raw/null name into copy).
function agencyDisplayName(submission: AgencySubmission): string {
  return (
    resolvedOrNull(submission.agency_source_name, submission.source_resolution_status) ??
    "an unresolved agency"
  );
}

type SortKey = "conflicts" | "volume" | "active";

const sortOptions: Array<{ key: SortKey; label: string }> = [
  { key: "conflicts", label: "Conflicts" },
  { key: "volume", label: "Volume" },
  { key: "active", label: "Active" },
];

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getPriorApplications(submission: AgencySubmission) {
  const prior = submission.conflict_detail?.prior_applications;
  return Array.isArray(prior) ? prior : [];
}

function getPriorSubmissions(submission: AgencySubmission) {
  const prior = submission.conflict_detail?.prior_submissions;
  return Array.isArray(prior) ? prior : [];
}

function getAgencyName(value: unknown) {
  if (value && typeof value === "object" && "agency" in value) {
    const agency = (value as { agency?: unknown }).agency;
    return typeof agency === "string" && agency.length > 0 ? agency : null;
  }

  return null;
}

function describePriorApplication(value: unknown) {
  if (!value || typeof value !== "object") return "prior internal contact found";

  const record = value as { status?: unknown };
  const status = typeof record.status === "string" ? record.status : "prior internal contact found";

  return status;
}

function priorTiming(submission: AgencySubmission) {
  const value = submission.conflict_detail?.days_since_prior;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${value} days earlier`;
  }

  return "earlier";
}

function conflictNarrative(submission: AgencySubmission) {
  if (submission.conflict_type === "dual_agency") {
    const priorAgency =
      getPriorSubmissions(submission).map(getAgencyName).find(Boolean) ?? "another agency";

    const agency = agencyDisplayName(submission);
    return {
      title: "Dual Agency Submission",
      badge: "Under review",
      variant: "warning" as const,
      body: `${agency} and ${priorAgency} both submitted candidates to ${submission.job_title ?? "the same role"}. Cross-referencing for overlap.`,
      metadata: `Agencies: ${agency} + ${priorAgency} · Role: ${submission.job_title ?? "unknown"} · Detected: ${formatDate(submission.checked_at)}`,
    };
  }

  const prior = getPriorApplications(submission).map(describePriorApplication);
  const priorText = prior.length > 0 ? prior.join("; ") : "prior internal contact found";

  const agency = agencyDisplayName(submission);
  return {
    title: "Prior Contact Conflict",
    badge: "Unresolved",
    variant: "danger" as const,
    body: `Candidate submitted by ${agency} to ${submission.job_title ?? "unknown role"} on ${formatDate(submission.submitted_at)}. Internal recruiter contacted this candidate ${priorTiming(submission)} — ${priorText}. Agency fee obligation may apply.`,
    metadata: `Agency: ${agency} · Submitted: ${formatDate(submission.submitted_at)} · Candidate: ${submission.candidate_id ?? "unknown"}`,
  };
}

function dualAgencyDetail(data: AgencyTrackerData) {
  const dual = data.conflict_alerts.find((alert) => alert.conflict_type === "dual_agency");
  if (!dual) return "Multiple agencies, same candidate";

  const priorAgency =
    getPriorSubmissions(dual).map(getAgencyName).find(Boolean) ?? "another agency";

  return `${agencyDisplayName(dual)} + ${priorAgency} → same role`;
}

function CompactMetric({
  label,
  value,
  detail,
  variant = "neutral",
}: {
  label: string;
  value: number;
  detail: string;
  variant?: "neutral" | "danger" | "warning";
}) {
  const styles = {
    neutral: {
      bg: "bg-card",
      border: "border-border",
      label: "text-ink-tertiary",
      value: "text-ink",
      detail: "text-ink-secondary",
    },
    danger: {
      bg: "bg-danger-bg",
      border: "border-danger-rule",
      label: "text-danger-fg",
      value: "text-danger-fg",
      detail: "text-danger-fg",
    },
    warning: {
      bg: "bg-warning-bg",
      border: "border-warning-rule",
      label: "text-warning-fg",
      value: "text-warning-fg",
      detail: "text-warning-fg",
    },
  }[variant];

  return (
    <section className={`flex min-h-[119px] flex-col gap-1 rounded-lg border ${styles.border} ${styles.bg} p-5`}>
      <span className={`text-[10px] font-semibold tracking-[1.5px] ${styles.label}`}>
        {label}
      </span>
      <span className={`font-mono text-[32px] font-semibold leading-tight ${styles.value}`}>
        {value}
      </span>
      <span className={`text-xs font-normal ${styles.detail}`}>{detail}</span>
    </section>
  );
}

function ConflictCard({ submission }: { submission: AgencySubmission }) {
  const narrative = conflictNarrative(submission);
  const styles = {
    danger: {
      bg: "bg-danger-bg",
      border: "border-l-danger-rule",
      badgeBorder: "border-danger-rule",
      text: "text-danger-fg",
    },
    warning: {
      bg: "bg-warning-bg",
      border: "border-l-warning-rule",
      badgeBorder: "border-warning-rule",
      text: "text-warning-fg",
    },
  }[narrative.variant];

  return (
    <article
      className={`flex w-full flex-col gap-3 overflow-hidden rounded-lg border-l-[3px] ${styles.border} ${styles.bg} p-5`}
    >
      <div className="flex items-center gap-2">
        <h3 className={`text-sm font-semibold ${styles.text}`}>{narrative.title}</h3>
        <span className={`rounded border ${styles.badgeBorder} px-2 py-0.5 text-[10px] font-semibold ${styles.text}`}>
          {narrative.badge}
        </span>
      </div>
      <p className={`text-[13px] font-normal leading-normal ${styles.text}`}>
        {narrative.body}
      </p>
      <span className={`font-mono text-[11px] font-normal ${styles.text}`}>
        {narrative.metadata}
      </span>
    </article>
  );
}

export function AgencyTrackerClient({ data }: { data: AgencyTrackerData | null }) {
  const [sortKey, setSortKey] = useState<SortKey>("conflicts");
  const sortedAgencies = useMemo(() => {
    if (!data) return [];

    return [...data.by_agency].sort((a, b) => {
      if (sortKey === "volume") return b.submissions - a.submissions;
      if (sortKey === "active") return Number(b.has_dual_agency) - Number(a.has_dual_agency);
      return b.conflicts - a.conflicts;
    });
  }, [data, sortKey]);

  if (!data) {
    return (
      <div className="flex w-full flex-col gap-8 bg-background px-12 py-8">
        <section className="flex w-full items-center justify-between">
          <div className="flex flex-col gap-3.5">
            <h1 className="text-[34px] font-medium leading-tight tracking-[-0.5px] text-ink">
              Agency Duplicate Detection
            </h1>
            <p className="text-sm font-normal text-ink-secondary">
              Checks agency-submitted candidates against the existing Greenhouse pool. Flags prior contact, prior rejection, and dual-agency submissions.
            </p>
          </div>
        </section>
        <section className="rounded-lg border border-border bg-card px-6 py-10 text-sm text-ink-secondary">
          Agency tracker data is unavailable. Check Supabase environment variables and the latest agency sweep run.
        </section>
      </div>
    );
  }

  const agenciesWithConflicts = data.by_agency.filter((agency) => agency.conflicts > 0).length;
  const conflictMetricVariant = data.conflicts_detected > 0 ? "danger" : "neutral";
  const dualAgencyMetricVariant = data.dual_agency_count > 0 ? "warning" : "neutral";
  const agencySummaryColor =
    agenciesWithConflicts > 0 ? "text-danger-fg" : "text-ink-tertiary";

  return (
    <div className="flex w-full flex-col gap-8 bg-background px-12 py-8">
      <section className="flex w-full items-center justify-between">
        <div className="flex flex-col gap-3.5">
          <h1 className="text-[34px] font-medium leading-tight tracking-[-0.5px] text-ink">
            Agency Duplicate Detection
          </h1>
          <p className="text-sm font-normal text-ink-secondary">
            Checks agency-submitted candidates against the existing Greenhouse pool. Flags prior contact, prior rejection, and dual-agency submissions.
          </p>
        </div>
      </section>

      <SweepHealthBanner health={data.health} />

      <section className="grid grid-cols-4 gap-4">
        <CompactMetric
          label="AGENCY SUBMISSIONS (YTD)"
          value={data.submissions_ytd}
          detail={`${data.by_agency.length} active agencies`}
        />
        <CompactMetric
          label="CONFLICTS DETECTED"
          value={data.conflicts_detected}
          detail="Prior internal contact found"
          variant={conflictMetricVariant}
        />
        <CompactMetric
          label="DUAL AGENCY"
          value={data.dual_agency_count}
          detail={dualAgencyDetail(data)}
          variant={dualAgencyMetricVariant}
        />
        <CompactMetric
          label="CLEARED"
          value={data.cleared}
          detail="No prior history found"
        />
      </section>

      {data.conflict_alerts.length > 0 ? (
        <section className="flex w-full flex-col gap-3">
          <h2 className="text-lg font-semibold text-ink">Conflicts &amp; Alerts</h2>
          {data.conflict_alerts.map((submission) => (
            <ConflictCard key={submission.id} submission={submission} />
          ))}
        </section>
      ) : null}

      <section className="flex w-full flex-col gap-3">
        <div className="flex w-full justify-between">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-ink">Submissions by Agency</h2>
            <p className="text-[13px] font-normal text-ink-secondary">
              All active agency submissions, ordered by open conflict count.
            </p>
          </div>
          <span className={`font-mono text-[11px] font-medium tracking-[1.5px] ${agencySummaryColor}`}>
            {data.by_agency.length} AGENCIES · — THIS WEEK · {agenciesWithConflicts} WITH CONFLICTS
          </span>
        </div>

        <div className="flex h-[37px] w-full items-center gap-3">
          <span className="text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
            SORT
          </span>
          <div className="flex rounded-lg border border-border bg-secondary p-1">
            {sortOptions.map((option) => {
              const active = option.key === sortKey;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setSortKey(option.key)}
                  className={`rounded-md px-3 py-1.5 text-[13px] ${
                    active
                      ? "bg-background font-semibold text-ink shadow-[0_1px_2px_#00000010]"
                      : "font-normal text-ink-tertiary"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <span className="font-mono text-[11px] font-normal tracking-[1.5px] text-ink-tertiary">
            ↓ highest first
          </span>
        </div>

        <div className="w-full overflow-hidden rounded-lg border border-border">
          <div className="flex w-full items-center border-b border-border bg-secondary px-4 py-2.5">
            <div className="flex-1 text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
              AGENCY
            </div>
            <div className="w-[80px] text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
              CONFLICTS
            </div>
            <div className="w-[120px] text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
              LAST SUBMITTED
            </div>
            <div className="w-[80px] text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
              APPS
            </div>
            <div className="w-[80px] text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
              ACTIVE
            </div>
            <div className="w-[80px] text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
              REJECTED
            </div>
          </div>

          {sortedAgencies.length > 0 ? (
            sortedAgencies.map((agency) => {
              const hasConflict = agency.conflicts > 0;
              const accent = hasConflict
                ? agency.has_dual_agency
                  ? "border-l-[3px] border-l-warning-rule pl-[13px]"
                  : "border-l-[3px] border-l-danger-rule pl-[13px]"
                : "pl-4";
              const conflictColor = hasConflict
                ? agency.has_dual_agency
                  ? "text-warning"
                  : "text-danger"
                : "text-ink-tertiary";

              return (
                <div
                  key={agency.source_id ?? "unresolved-source"}
                  className={`flex min-h-[42px] w-full items-center border-b border-hairline-soft py-3 pr-4 last:border-b-0 ${accent}`}
                >
                  <div className="flex-1 text-[13px] font-medium text-ink">
                    {agency.resolved ? (
                      agency.agency_name
                    ) : (
                      <span
                        title="Agency source not resolved — see the resolution defect queue"
                        className="inline-flex items-center rounded border border-warning-rule bg-warning-bg px-2 py-0.5 font-mono text-[10px] font-semibold text-warning-fg"
                      >
                        {agency.agency_name}
                      </span>
                    )}
                  </div>
                  <div className={`w-[80px] font-mono text-sm font-medium ${conflictColor}`}>
                    {agency.conflicts}
                  </div>
                  <div className="w-[120px] font-mono text-[13px] font-normal text-ink-tertiary">
                    —
                  </div>
                  <div className="w-[80px] font-mono text-[13px] font-normal text-ink">
                    {agency.submissions}
                  </div>
                  <div className="w-[80px] font-mono text-[13px] font-normal text-ink-tertiary">
                    —
                  </div>
                  <div className="w-[80px] font-mono text-[13px] font-normal text-ink-tertiary">
                    —
                  </div>
                </div>
              );
            })
          ) : (
            <div className="px-4 py-8 text-center text-sm text-ink-tertiary">
              No agency submissions detected yet.
            </div>
          )}
        </div>
      </section>

      {data.all_submissions.length > 0 && (
        <section className="flex w-full flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-ink">All Submissions</h2>
            <p className="text-[13px] font-normal text-ink-secondary">
              Every agency-submitted candidate YTD, regardless of conflict status.
            </p>
          </div>

          <div className="w-full overflow-hidden rounded-lg border border-border">
            <div className="flex w-full items-center border-b border-border bg-secondary px-4 py-2.5">
              <div className="w-[120px] text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
                CANDIDATE
              </div>
              <div className="flex-1 text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
                ROLE
              </div>
              <div className="w-[180px] text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
                AGENCY
              </div>
              <div className="w-[160px] text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
                RECRUITER
              </div>
              <div className="w-[100px] text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
                SUBMITTED
              </div>
              <div className="w-[100px] text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
                STATUS
              </div>
            </div>

            {data.all_submissions.map((sub) => {
              const resolvedAgency = resolvedOrNull(
                sub.agency_source_name,
                sub.source_resolution_status
              );
              const accent = sub.conflict_detected
                ? sub.conflict_type === "dual_agency"
                  ? "border-l-[3px] border-l-warning-rule pl-[13px]"
                  : "border-l-[3px] border-l-danger-rule pl-[13px]"
                : "pl-4";

              return (
                <div
                  key={sub.application_id}
                  className={`flex min-h-[42px] w-full items-center border-b border-hairline-soft py-3 pr-4 last:border-b-0 ${accent}`}
                >
                  <div className="w-[120px] font-mono text-[11px] font-normal text-ink-secondary">
                    C-{sub.candidate_id}
                  </div>
                  <div className="flex-1 text-[13px] font-normal text-ink-secondary truncate pr-2">
                    {sub.job_title ?? "—"}
                  </div>
                  <div className="w-[180px] text-[13px] font-medium text-ink truncate pr-2">
                    {resolvedAgency ?? (
                      <span
                        title="Agency source not resolved"
                        className="inline-flex items-center rounded border border-warning-rule bg-warning-bg px-2 py-0.5 font-mono text-[10px] font-semibold text-warning-fg"
                      >
                        Unresolved
                      </span>
                    )}
                  </div>
                  <div className="w-[160px] text-[13px] font-normal text-ink-secondary truncate pr-2">
                    {sub.ownership_resolution_status === "resolved" && sub.recruiter_name ? (
                      sub.recruiter_name
                    ) : sub.ownership_resolution_status === "resolved" ? (
                      <span className="italic text-ink-tertiary">No owner on job</span>
                    ) : (
                      <span
                        title="Recruiter owner not resolved"
                        className="inline-flex items-center rounded border border-warning-rule bg-warning-bg px-2 py-0.5 font-mono text-[10px] font-semibold text-warning-fg"
                      >
                        Unresolved
                      </span>
                    )}
                  </div>
                  <div className="w-[100px] font-mono text-[13px] font-normal text-ink-tertiary">
                    {formatDate(sub.submitted_at)}
                  </div>
                  <div className="w-[100px]">
                    {sub.conflict_detected ? (
                      <span
                        className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                          sub.conflict_type === "dual_agency"
                            ? "border-warning-rule bg-warning-bg text-warning-fg"
                            : "border-danger-rule bg-danger-bg text-danger-fg"
                        }`}
                      >
                        {sub.conflict_type === "dual_agency" ? "Dual agency" : "Prior contact"}
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded border border-success-rule bg-success-bg px-2 py-0.5 font-mono text-[10px] font-semibold text-success-fg">
                        Cleared
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
