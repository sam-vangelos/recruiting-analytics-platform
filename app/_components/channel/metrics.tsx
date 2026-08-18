// app/_components/channel/metrics.tsx (GREENFIELD)
//
// U0 metric primitives (W0 frozen spec, "Key interfaces" :204-207). Unifies the three
// divergent hand-rolled metric components — LargeMetric (referrals client.tsx:60-118),
// CompactMetric (agency client.tsx:95-141), and Metric (ytd/agency client.tsx:132-158) —
// onto one MetricCard, and the three ad-hoc grid wrappers onto one MetricGrid.
//
// Kills the 10px-label drift at the source: every prior component set its eyebrow label at
// text-[10px] (referrals :108/:237-254, agency :132, ytd :151). MetricCard pins the label at
// text-[11px], the smallest size the design system uses for an uppercase mono eyebrow (it is
// the same size the app-header nav and "LAST SWEEP" caption use, app-header.tsx:46/52/65).
//
// All color comes from the globals.css design tokens (--color-*-bg / -fg / -rule); no raw hex.

import type { ReactNode } from "react";

/** Metric emphasis tones. Matches the frozen-spec union exactly (no `info` — that accent is a
 *  table row-rule concern, not a metric card). */
export type MetricTone = "neutral" | "warning" | "danger" | "success";

/** `lg` = the referrals hero rectangle (56px value, hairline divider). `sm` = the dense agency /
 *  ytd workbench card (32px value, no divider). */
export type MetricSize = "lg" | "sm";

interface ToneStyle {
  /** Card surface. */
  bg: string;
  /** Eyebrow label color. */
  label: string;
  /** Value color. */
  value: string;
  /** Detail/sub-label color. */
  detail: string;
  /** Divider hairline (lg only). */
  hairline: string;
  /** Border / accent rule. Neutral gets a full border; risk tones get a left accent rule. */
  border: string;
}

const TONE_STYLES: Record<MetricTone, ToneStyle> = {
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
};

interface SizeStyle {
  /** Outer section layout: min-height, padding, gap. */
  section: string;
  /** Value type scale. */
  value: string;
  /** Whether the lg hairline divider renders. */
  divider: boolean;
}

const SIZE_STYLES: Record<MetricSize, SizeStyle> = {
  // The referrals hero treatment (was LargeMetric): tall card, 56px value, hairline divider.
  lg: {
    section: "min-h-[187px] gap-3 p-6",
    value: "text-[56px] leading-none",
    divider: true,
  },
  // The dense workbench treatment (was CompactMetric / Metric): short card, 32px value, no divider.
  sm: {
    section: "min-h-[119px] gap-1 p-5",
    value: "text-[32px] leading-tight",
    divider: false,
  },
};

/**
 * One metric rectangle. Lead with the label, then the answer, then the supporting detail —
 * editorial hierarchy, not a database readout.
 *
 * Canon: `tone` carries risk semantics via a LEFT accent rule + tinted surface; neutral is a
 * full hairline border. Never a full risk-colored fill on a neutral card.
 */
export function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
  size = "sm",
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: MetricTone;
  size?: MetricSize;
}) {
  const t = TONE_STYLES[tone];
  const s = SIZE_STYLES[size];

  return (
    <section className={`flex flex-col rounded ${t.bg} ${t.border} ${s.section}`}>
      <span className={`font-mono text-[11px] font-semibold tracking-[1.5px] ${t.label}`}>
        {label}
      </span>
      {s.divider ? <span className={`h-px w-full ${t.hairline}`} /> : null}
      <span className={`font-mono font-semibold ${s.value} ${t.value}`}>{value}</span>
      <span className={`text-xs font-normal ${t.detail}`}>{detail}</span>
    </section>
  );
}

/**
 * Responsive grid of MetricCards. `columns` is the desktop target; the grid steps down on
 * narrower viewports so cards never crush below a readable width (replaces the three ad-hoc
 * `grid-cols-N` wrappers across the clients).
 */
export function MetricGrid({
  children,
  columns,
}: {
  children: ReactNode;
  columns: 4 | 5;
}) {
  const desktop = columns === 5 ? "xl:grid-cols-5" : "xl:grid-cols-4";
  return (
    <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 ${desktop}`}>
      {children}
    </div>
  );
}
