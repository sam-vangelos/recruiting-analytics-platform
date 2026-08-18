import type { Metadata } from "next";
import Link from "next/link";
import { getRecruitingOpsConsoleData } from "@/lib/recruiting-ops/console-data";

export const metadata: Metadata = {
  title: "Legacy Coverage · Recruiting Ops Command Center",
};

const statusStyles = {
  local_ready: "border-success-rule bg-success-bg text-success-fg",
  registered_only: "border-warning-rule bg-warning-bg text-warning-fg",
  P0: "border-danger-rule bg-danger-bg text-danger-fg",
  P1: "border-warning-rule bg-warning-bg text-warning-fg",
  P2: "border-border bg-secondary text-ink-secondary",
  Stop: "border-border bg-secondary text-ink-secondary",
  Unknown: "border-border bg-secondary text-ink-secondary",
} as const;

function StatusPill({ value, tone }: { value: string; tone: keyof typeof statusStyles }) {
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${statusStyles[tone]}`}>
      {value}
    </span>
  );
}

export default function RecruitingOpsLegacyCoveragePage() {
  const data = getRecruitingOpsConsoleData();

  return (
    <div className="flex w-full flex-col gap-8 bg-background px-12 py-8">
      <section className="flex w-full items-start justify-between gap-8">
        <div className="flex max-w-[760px] flex-col gap-3.5">
          <div className="flex items-center gap-3">
            <span className="h-px w-6 bg-ink-tertiary" />
            <Link
              href="/recruiting-ops"
              className="font-mono text-[11px] font-medium tracking-[2px] text-ink-tertiary underline-offset-2 hover:underline"
            >
              ← COMMAND CENTER
            </Link>
          </div>
          <h1 className="text-[34px] font-medium leading-tight text-ink">
            Legacy Coverage
          </h1>
          <p className="text-sm font-normal leading-6 text-ink-secondary">
            Audit surface for the inherited handover. Every {data.counts.requiredWorkflowCount} workflow task is tracked
            here for provenance and coverage; the product itself is organized by capability. This view answers only:
            have we accounted for everything handed over?
          </p>
        </div>
        <div className="flex min-w-[210px] flex-col items-end gap-2 text-right">
          <span className="font-mono text-[10px] font-medium tracking-[1.5px] text-ink-tertiary">
            {data.counts.localReadyWorkflowCount}/{data.counts.requiredWorkflowCount} LOCAL-READY
          </span>
        </div>
      </section>

      <section className="overflow-hidden rounded border border-border bg-card">
        <div className="flex h-[48px] items-center justify-between border-b border-border px-4">
          <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">
            WORKFLOW COVERAGE
          </h2>
          <span className="text-xs text-ink-tertiary">
            {data.counts.localReadyWorkflowCount}/{data.counts.requiredWorkflowCount} local-ready
          </span>
        </div>
        <div className="grid grid-cols-[92px_1fr_116px_88px_88px] border-b border-border px-4 py-3 font-mono text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
          <span>ID</span>
          <span>WORKFLOW</span>
          <span>CATEGORY</span>
          <span>PRIORITY</span>
          <span>STATUS</span>
        </div>
        <div className="max-h-[720px] overflow-y-auto">
          {data.workflowRows.map((row) => (
            <div
              key={row.id}
              className="grid min-h-[58px] grid-cols-[92px_1fr_116px_88px_88px] items-center border-b border-hairline-soft px-4 py-3 last:border-b-0"
            >
              <span className="font-mono text-[12px] font-semibold text-ink">{row.id}</span>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-sm font-medium text-ink">{row.title}</span>
                <span className="truncate text-[12px] text-ink-tertiary">{row.nextGate}</span>
              </div>
              <span className="text-[12px] text-ink-secondary">{row.category}</span>
              <StatusPill value={row.priority} tone={row.priority} />
              <StatusPill
                value={row.implementationStatus === "local_ready" ? "LOCAL" : "SEED"}
                tone={row.implementationStatus}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
