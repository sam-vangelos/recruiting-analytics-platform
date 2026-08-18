"use client";

import { useMemo, useState } from "react";
import type { ReferralSweepItem, ReferralTrackerData, UrgencyTier } from "@/lib/sweep-types";
import type { ResolutionConfidence, ResolutionStatus } from "@/lib/resolution-types";
import { ownershipDefectLabel, resolvedOrNull } from "@/lib/resolution-display";
import { referralTierLabel } from "@/lib/tracker-format";
import { SweepHealthBanner } from "@/app/_components/SweepHealthBanner";

type Filter = "all" | "unactioned" | "escalated" | "actioned";

const filters: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "ALL" },
  { key: "unactioned", label: "UNACTIONED" },
  { key: "escalated", label: "ESCALATED" },
  { key: "actioned", label: "ACTIONED" },
];

const rowAccent: Record<UrgencyTier, string> = {
  breach: "border-l-[3px] border-l-danger-rule",
  sla_risk: "border-l-[3px] border-l-danger-rule",
  alerted: "border-l-[3px] border-l-warning-rule",
  new: "border-l-[3px] border-l-info",
  actioned: "border-l-[3px] border-l-success-rule",
};

const badgeColor: Record<UrgencyTier, string> = {
  breach: "text-danger",
  sla_risk: "text-danger",
  alerted: "text-warning",
  new: "text-info",
  actioned: "text-success",
};

const hourColor: Record<UrgencyTier, string> = {
  breach: "text-danger",
  sla_risk: "text-danger",
  alerted: "text-warning",
  new: "text-ink",
  actioned: "text-ink-tertiary",
};

function matchesFilter(item: ReferralSweepItem, filter: Filter) {
  if (filter === "all") return true;
  if (filter === "unactioned") return item.urgency_tier !== "actioned";
  if (filter === "escalated") return item.urgency_tier === "breach";
  return item.urgency_tier === "actioned";
}

function formatHours(item: ReferralSweepItem) {
  if (item.urgency_tier === "actioned") return "--";
  return `${Math.round(item.hours_in_current_stage)}h`;
}

function StatusBadge({ tier }: { tier: UrgencyTier }) {
  return (
    <span className={`font-mono text-[11px] font-medium tracking-[1.5px] ${badgeColor[tier]}`}>
      ▪ {referralTierLabel(tier)}
    </span>
  );
}

// Tri-state recruiter owner, per the W0 canon "Unknown is a defect, never a label". The sweep
// already resolved this; we only gate display: a resolved name (with a muted dot when the ownership
// was only inferred), a genuine "no owner on the job" when resolution succeeded but found none, or a
// clearable defect chip for an unresolved/ambiguous/blocked resolution. The old bare "UNASSIGNED"
// conflated the last two and lied about the first.
function RecruiterCell({
  name,
  status,
  confidence,
}: {
  name: string | null;
  status: ResolutionStatus | null;
  confidence: ResolutionConfidence | null;
}) {
  const resolvedName = resolvedOrNull(name, status);
  if (resolvedName) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="truncate text-[13px] font-normal text-ink-secondary">{resolvedName}</span>
        {confidence === "inferred" ? (
          <span
            aria-hidden
            title="Inferred owner"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-tertiary"
          />
        ) : null}
      </span>
    );
  }
  if (status === "resolved") {
    return (
      <span className="text-[13px] font-normal italic text-ink-tertiary">No owner on job</span>
    );
  }
  return (
    <span
      title={status ? `Resolution: ${status}` : undefined}
      className="inline-flex items-center rounded border border-warning-rule bg-warning-bg px-2 py-0.5 font-mono text-[10px] font-semibold text-warning-fg"
    >
      {ownershipDefectLabel(status)}
    </span>
  );
}

// Render-layer gate for the stage column. The upstream sweep falls back to the literal "Unknown"
// when no stage name resolves (lib/sweep-types.ts ghStageName), and a blank string is also possible.
// Per the W0 canon, "Unknown" is a defect carried by absence — never a sentinel string on a live
// surface — so a missing stage reads as a muted "No stage", not the word "Unknown".
function StageCell({ stage }: { stage: string }) {
  const trimmed = stage.trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") {
    return <span className="text-[13px] font-normal italic text-ink-tertiary">No stage</span>;
  }
  return <span className="text-[13px] font-normal text-ink-secondary">{trimmed}</span>;
}

function LargeMetric({
  label,
  value,
  detail,
  variant = "neutral",
}: {
  label: string;
  value: number;
  detail: string;
  variant?: "neutral" | "warning" | "danger" | "success";
}) {
  const styles = {
    neutral: {
      bg: "bg-card",
      label: "text-ink-tertiary",
      value: "text-ink",
      detail: "text-ink-secondary",
      hairline: "bg-border",
      border: "border border-border",
    },
    warning: {
      bg: "bg-warning-bg",
      label: "text-warning-fg",
      value: "text-warning-fg",
      detail: "text-warning-fg",
      hairline: "bg-warning opacity-30",
      border: "border-l-2 border-l-warning-rule",
    },
    danger: {
      bg: "bg-danger-bg",
      label: "text-danger-fg",
      value: "text-danger-fg",
      detail: "text-danger-fg",
      hairline: "bg-danger opacity-30",
      border: "border-l-2 border-l-danger-rule",
    },
    success: {
      bg: "bg-success-bg",
      label: "text-success-fg",
      value: "text-success-fg",
      detail: "text-success-fg",
      hairline: "bg-success opacity-30",
      border: "border-l-2 border-l-success-rule",
    },
  }[variant];

  return (
    <section className={`flex min-h-[187px] flex-col gap-3 rounded ${styles.bg} p-6 ${styles.border}`}>
      <span className={`font-mono text-[10px] font-medium tracking-[2px] ${styles.label}`}>
        {label}
      </span>
      <span className={`h-px w-full ${styles.hairline}`} />
      <span className={`font-mono text-[56px] font-medium leading-none ${styles.value}`}>
        {value}
      </span>
      <span className={`text-xs font-normal ${styles.detail}`}>{detail}</span>
    </section>
  );
}

export function ReferralTrackerClient({ data }: { data: ReferralTrackerData | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(
    () => (data ? data.items.filter((item) => matchesFilter(item, filter)) : []),
    [data, filter],
  );

  if (!data) {
    return (
      <div className="flex w-full flex-col gap-8 bg-background px-12 py-8">
        <section className="flex w-full items-center justify-between">
          <div className="flex flex-col gap-3.5">
            <div className="flex items-center gap-3">
              <span className="h-px w-6 bg-ink-tertiary" />
              <span className="font-mono text-[11px] font-medium tracking-[2px] text-ink-tertiary">
                RECRUITING OPERATIONS
              </span>
            </div>
            <h1 className="text-[34px] font-medium leading-tight tracking-[-0.5px] text-ink">
              Referral Tracker
            </h1>
            <p className="text-sm font-normal text-ink-secondary">
              Employee referrals surfaced, tracked, and escalated. Sweep runs hourly.
            </p>
          </div>
        </section>
        <section className="rounded border border-border bg-card px-6 py-10 text-sm text-ink-secondary">
          Referral tracker data is unavailable. Check Supabase environment variables and the latest referral sweep run.
        </section>
      </div>
    );
  }

  const filterCounts: Record<Filter, number> = {
    all: data.metrics.total,
    unactioned: data.metrics.unactioned,
    escalated: data.items.filter((item) => item.urgency_tier === "breach").length,
    actioned: data.metrics.actioned,
  };

  const jobCount = new Set(data.items.map((item) => item.job_id)).size;
  const unactionedVariant = data.metrics.unactioned > 0 ? "warning" : "neutral";
  const approachingVariant = data.metrics.approaching_sla > 0 ? "danger" : "neutral";
  const actionedVariant = data.metrics.actioned > 0 ? "success" : "neutral";

  return (
    <div className="flex w-full flex-col gap-8 bg-background px-12 py-8">
      <section className="flex w-full items-center justify-between">
        <div className="flex flex-col gap-3.5">
          <div className="flex items-center gap-3">
            <span className="h-px w-6 bg-ink-tertiary" />
            <span className="font-mono text-[11px] font-medium tracking-[2px] text-ink-tertiary">
              RECRUITING OPERATIONS
            </span>
          </div>
          <h1 className="text-[34px] font-medium leading-tight tracking-[-0.5px] text-ink">
            Referral Tracker
          </h1>
          <p className="text-sm font-normal text-ink-secondary">
            Employee referrals surfaced, tracked, and escalated. Sweep runs hourly.
          </p>
        </div>
      </section>

      <SweepHealthBanner health={data.health} />

      <section className="grid grid-cols-4 gap-4">
        <LargeMetric
          label="TOTAL REFERRALS (48H)"
          value={data.metrics.total}
          detail={`across ${jobCount} jobs`}
        />
        <LargeMetric
          label="UNACTIONED"
          value={data.metrics.unactioned}
          detail="still in Application Review"
          variant={unactionedVariant}
        />
        <LargeMetric
          label="APPROACHING SLA"
          value={data.metrics.approaching_sla}
          detail="over 36 hours, no action"
          variant={approachingVariant}
        />
        <LargeMetric
          label="ACTIONED"
          value={data.metrics.actioned}
          detail="moved past Application Review"
          variant={actionedVariant}
        />
      </section>

      <section className="w-full overflow-hidden rounded border border-border bg-card">
        <div className="flex h-[46px] w-full items-center border-b border-border px-4">
          {filters.map((item, index) => (
            <div key={item.key} className="flex h-full items-center">
              {index > 0 ? <span className="h-3.5 w-px bg-border" /> : null}
              <button
                type="button"
                onClick={() => setFilter(item.key)}
                className={`flex h-full items-center px-3 font-mono text-[11px] font-medium tracking-[1.5px] ${
                  filter === item.key
                    ? "border-b-2 border-ink text-ink"
                    : "text-ink-tertiary hover:text-ink-secondary"
                }`}
              >
                {item.label} ({filterCounts[item.key]})
              </button>
            </div>
          ))}
        </div>

        <div className="flex w-full items-center border-b border-border px-4 py-3">
          <div className="w-[180px] font-mono text-[10px] font-medium tracking-[2px] text-ink-tertiary">
            CANDIDATE
          </div>
          <div className="flex-1 font-mono text-[10px] font-medium tracking-[2px] text-ink-tertiary">
            JOB
          </div>
          <div className="w-[140px] font-mono text-[10px] font-medium tracking-[2px] text-ink-tertiary">
            REFERRER
          </div>
          <div className="w-[160px] font-mono text-[10px] font-medium tracking-[2px] text-ink-tertiary">
            STAGE
          </div>
          <div className="w-[80px] font-mono text-[10px] font-medium tracking-[2px] text-ink-tertiary">
            HOURS
          </div>
          <div className="w-[100px] font-mono text-[10px] font-medium tracking-[2px] text-ink-tertiary">
            STATUS
          </div>
          <div className="w-[120px] font-mono text-[10px] font-medium tracking-[2px] text-ink-tertiary">
            RECRUITER
          </div>
        </div>

        {rows.length > 0 ? (
          rows.map((item) => (
            <div
              key={item.application_id}
              className={`flex min-h-[54px] w-full items-center px-4 py-[18px] ${rowAccent[item.urgency_tier]}`}
            >
              <div className="w-[180px] text-sm font-normal text-ink">{item.candidate_name}</div>
              <div className="flex-1 text-[13px] font-normal text-ink-secondary">
                {item.job_title}
              </div>
              <div className="w-[140px]">
                {item.referrer_name ? (
                  <span className="truncate text-[13px] font-normal text-ink-secondary">
                    {item.referrer_name}
                  </span>
                ) : (
                  <span className="text-[13px] font-normal italic text-ink-tertiary">&mdash;</span>
                )}
              </div>
              <div className="w-[160px]">
                <StageCell stage={item.current_stage} />
              </div>
              <div className={`w-[80px] font-mono text-sm font-medium ${hourColor[item.urgency_tier]}`}>
                {formatHours(item)}
              </div>
              <div className="w-[100px]">
                <StatusBadge tier={item.urgency_tier} />
              </div>
              <div className="w-[120px]">
                <RecruiterCell
                  name={item.recruiter_name}
                  status={item.ownership_resolution_status}
                  confidence={item.ownership_confidence}
                />
              </div>
            </div>
          ))
        ) : (
          <div className="px-4 py-8 text-center text-sm text-ink-tertiary">
            No referrals match this filter.
          </div>
        )}
      </section>
    </div>
  );
}
