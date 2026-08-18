import type { Metadata } from "next";
import Link from "next/link";
import {
  getRecruitingOpsConsoleData,
  type ConsoleAutomationLaneRow,
  type ConsoleMetric,
} from "@/lib/recruiting-ops/console-data";
import { loadDurableRunHistory, type DurableRunHistory } from "@/lib/recruiting-ops/durable-run-history";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recruiting Ops Automation Control Plane",
};

const statusStyles = {
  durable: "border-success-rule bg-success-bg text-success-fg",
  transitional: "border-warning-rule bg-warning-bg text-warning-fg",
  schema_ready: "border-success-rule bg-success-bg text-success-fg",
  adapter_disabled: "border-border bg-secondary text-ink-secondary",
  neutral: "border-border bg-secondary text-ink-secondary",
  shadowed: "border-success-rule bg-success-bg text-success-fg",
  authorized_for_review: "border-success-rule bg-success-bg text-success-fg",
  authorized_for_auto_delivery: "border-success-rule bg-success-bg text-success-fg",
  delivery_attempted: "border-warning-rule bg-warning-bg text-warning-fg",
  delivered: "border-success-rule bg-success-bg text-success-fg",
  withheld: "border-warning-rule bg-warning-bg text-warning-fg",
  succeeded: "border-success-rule bg-success-bg text-success-fg",
  blocked: "border-danger-rule bg-danger-bg text-danger-fg",
  paused: "border-warning-rule bg-warning-bg text-warning-fg",
  failed: "border-danger-rule bg-danger-bg text-danger-fg",
  superseded: "border-border bg-secondary text-ink-secondary",
  correction_recorded: "border-border bg-secondary text-ink-secondary",
  local_jsonl: "border-border bg-secondary text-ink-secondary",
  off: "border-success-rule bg-success-bg text-success-fg",
} as const;

function MetricTile({ metric }: { metric: ConsoleMetric }) {
  const tone = {
    neutral: "border-border bg-card text-ink",
    success: "border-success-rule bg-success-bg text-success-fg",
    warning: "border-warning-rule bg-warning-bg text-warning-fg",
  }[metric.tone];

  return (
    <section className={`flex min-h-[132px] flex-col justify-between rounded border p-5 ${tone}`}>
      <span className="font-mono text-[10px] font-semibold tracking-[1.5px]">{metric.label}</span>
      <span className="font-mono text-[40px] font-semibold leading-none">{metric.value}</span>
      <span className="text-xs font-normal">{metric.detail}</span>
    </section>
  );
}

function StatusPill({ value, tone }: { value: string; tone: keyof typeof statusStyles }) {
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${statusStyles[tone]}`}>
      {value}
    </span>
  );
}

function LanePanel({ lane }: { lane: ConsoleAutomationLaneRow }) {
  const hasNoLocalActivity =
    lane.shadowDeliveryLogCount === 0 &&
    lane.blockedOrPausedDeliveryLogCount === 0 &&
    lane.failedGateCount === 0;

  return (
    <Link
      href={lane.href}
      className="flex min-h-[216px] flex-col justify-between rounded border border-border bg-card p-4 transition hover:border-ink-tertiary"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-mono text-[12px] font-semibold tracking-[1.5px] text-ink">{lane.label.toUpperCase()}</h2>
          <p className="mt-2 text-xs leading-5 text-ink-secondary">
            {lane.deliverableCount} deliverables · {lane.autoEligibleDeliverableCount} auto-eligible deliverables · {lane.neverAutoCount} never-auto
          </p>
        </div>
        <StatusPill value={lane.externalAdapterApproved ? "STATIC ADAPTER ON" : "STATIC ADAPTER OFF"} tone="off" />
      </div>
      {hasNoLocalActivity ? (
        <p className="text-xs leading-5 text-ink-tertiary">No local runs or delivery logs are attached to this lane yet.</p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <SmallMeasure label="SHADOW LOGS" value={lane.shadowDeliveryLogCount} />
        <SmallMeasure label="BLOCKED" value={lane.blockedOrPausedDeliveryLogCount} />
        <SmallMeasure label="FAILED GATES" value={lane.failedGateCount} />
        <SmallMeasure label="PROPOSALS" value={lane.actionProposalCount} />
      </div>
      <span className="font-mono text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">OPEN LANE →</span>
    </Link>
  );
}

function SmallMeasure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-hairline-soft bg-background px-3 py-2">
      <div className="font-mono text-[18px] font-semibold leading-none text-ink">{value}</div>
      <div className="mt-1 font-mono text-[9px] font-semibold tracking-[1px] text-ink-tertiary">{label}</div>
    </div>
  );
}

function DurableRunHistoryPanel({ durable }: { durable: DurableRunHistory }) {
  return (
    <section className="overflow-hidden rounded border border-border bg-card">
      <div className="flex min-h-[48px] items-center justify-between gap-4 border-b border-border px-4 py-3">
        <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">
          DURABLE RUN HISTORY — SUPABASE
        </h2>
        {durable.status === "loaded" ? (
          <span className="font-mono text-[10px] font-medium tracking-[1.5px] text-ink-tertiary">
            {durable.runs.length} RUN{durable.runs.length === 1 ? "" : "S"} · READ{" "}
            {new Date(durable.loadedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        ) : (
          <StatusPill value="STORE UNAVAILABLE" tone="blocked" />
        )}
      </div>
      {durable.status === "unavailable" ? (
        <p className="px-4 py-4 text-xs leading-5 text-ink-secondary">
          Run history could not be read: {durable.reason}. The catalog below remains fixture data.
        </p>
      ) : durable.runs.length === 0 ? (
        <p className="px-4 py-4 text-xs leading-5 text-ink-secondary">
          No persisted runs yet — the first live run writes history here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[760px] grid-cols-[1.2fr_1fr_88px_96px_72px_72px_96px] border-b border-border px-4 py-3 font-mono text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
            <span>RUN</span>
            <span>CAPABILITY</span>
            <span>MODE</span>
            <span>STATUS</span>
            <span>ROWS</span>
            <span>GAPS</span>
            <span>STARTED</span>
          </div>
          <div className="min-w-[760px]">
            {durable.runs.map((run) => (
              <div
                key={run.runId}
                className="grid grid-cols-[1.2fr_1fr_88px_96px_72px_72px_96px] items-center border-b border-hairline-soft px-4 py-2.5 last:border-b-0"
              >
                <span className="truncate font-mono text-[11px] text-ink" title={run.runId}>
                  {run.runId}
                </span>
                <span className="truncate text-xs text-ink-secondary" title={run.capabilityId}>
                  {run.capabilityId.replaceAll("_", " ")}
                </span>
                <span className="font-mono text-[10px] uppercase text-ink-secondary">{run.mode}</span>
                <StatusPill
                  value={run.status.toUpperCase()}
                  tone={run.status in statusStyles ? (run.status as keyof typeof statusStyles) : "neutral"}
                />
                <span className="font-mono text-[11px] text-ink">{run.normalizedRowCount}</span>
                <span className="font-mono text-[11px] text-ink">{run.sourceGapCount}</span>
                <span className="font-mono text-[10px] text-ink-tertiary">
                  {new Date(run.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function formatBoundaryLabel(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

export default async function RecruitingOpsConsolePage() {
  const data = getRecruitingOpsConsoleData();
  const catalog = data.automation;
  const durable = await loadDurableRunHistory();
  const durableLive = durable.status === "loaded" && durable.runs.length > 0;

  return (
    <div className="flex w-full flex-col gap-8 bg-background px-5 py-6 md:px-12 md:py-8">
      <section className="flex w-full flex-col justify-between gap-6 lg:flex-row lg:items-start">
        <div className="flex max-w-[820px] flex-col gap-3.5">
          <div className="flex items-center gap-3">
            <span className="h-px w-6 bg-ink-tertiary" />
            <span className="font-mono text-[11px] font-medium tracking-[2px] text-ink-tertiary">
              RECRUITING OPERATIONS
            </span>
          </div>
          <h1 className="text-[34px] font-medium leading-tight text-ink">
            Automation Control Plane
          </h1>
          <p className="text-sm font-normal leading-6 text-ink-secondary">
            Local catalog snapshot over shadow runs, delivery logs, gate results, and dry-run action proposals.
          </p>
        </div>
        <div className="flex min-w-[232px] flex-col items-start gap-2 text-left lg:items-end lg:text-right">
          <StatusPill value="CAPABILITY-FIRST" tone="durable" />
          {durableLive ? (
            <StatusPill value="DURABLE RUN HISTORY — LIVE" tone="durable" />
          ) : (
            <StatusPill value="FIXTURE DATA — NO REAL RUNS" tone="off" />
          )}
          <StatusPill value="READ-ONLY UI" tone="off" />
          <StatusPill value="EXTERNAL DELIVERY STATIC OFF" tone="off" />
          <span className="font-mono text-[10px] font-medium tracking-[1.5px] text-ink-tertiary">
            GENERATED {new Date(data.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.metrics.map((metric) => (
          <MetricTile key={metric.label} metric={metric} />
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {catalog.laneRows.map((lane) => (
          <LanePanel key={lane.lane} lane={lane} />
        ))}
      </section>

      <DurableRunHistoryPanel durable={durable} />

      <section className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="overflow-hidden rounded border border-border bg-card">
          <div className="flex min-h-[48px] items-center justify-between gap-4 border-b border-border px-4 py-3">
            <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">
              LOCAL RUN CATALOG — FIXTURE
            </h2>
            <span
              className="font-mono text-[10px] font-medium tracking-[1.5px] text-ink-tertiary"
              title={catalog.catalogProvenance.detail}
            >
              {catalog.catalogProvenance.mode.toUpperCase()} · {catalog.catalogId}
            </span>
          </div>
          <div className="overflow-x-auto">
            <div className="grid min-w-[680px] grid-cols-[1.1fr_0.9fr_96px_96px_96px] border-b border-border px-4 py-3 font-mono text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
              <span>RUN</span>
              <span>CAPABILITY</span>
              <span>MODE</span>
              <span>STATUS</span>
              <span>LOGS</span>
            </div>
            <div className="min-w-[680px]">
              {catalog.recentRuns.map((run) => (
                <div
                  key={run.runId}
                  className="grid min-h-[64px] grid-cols-[1.1fr_0.9fr_96px_96px_96px] items-center border-b border-hairline-soft px-4 py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col gap-1 pr-3">
                    <span className="truncate font-mono text-[12px] font-semibold text-ink">{run.runId}</span>
                    <span className="truncate text-[12px] text-ink-tertiary">{run.moduleId}</span>
                  </div>
                  <span className="truncate pr-3 text-[12px] text-ink-secondary">{run.capabilityId}</span>
                  <StatusPill value={run.mode.toUpperCase()} tone="neutral" />
                  <StatusPill value={run.status.toUpperCase()} tone={run.status === "succeeded" ? "succeeded" : "blocked"} />
                  <span className="font-mono text-[12px] text-ink-secondary">{run.deliveryLogIds.length}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <aside className="grid gap-5">
          <section className="rounded border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">
                DELIVERY LOGS
              </h2>
            </div>
            <div className="flex flex-col">
              {catalog.deliveryLogs.map((entry) => (
                <div key={entry.deliveryLogId} className="flex flex-col gap-2 border-b border-hairline-soft px-4 py-4 last:border-b-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium text-ink">{entry.deliverableId}</span>
                    <StatusPill value={entry.status.toUpperCase()} tone={entry.status} />
                  </div>
                  <span className="font-mono text-[11px] text-ink-tertiary">{entry.eventType} · {entry.deliveryMechanism}</span>
                  <span className="text-xs text-ink-secondary">{entry.gateResultIds.length} gate results · {entry.artifactIds.length} artifacts</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">
                FAILED GATES
              </h2>
            </div>
            <div className="flex flex-col">
              {catalog.gateFailures.map((gate) => (
                <div key={gate.gateResultId} className="flex flex-col gap-2 border-b border-hairline-soft px-4 py-4 last:border-b-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[11px] font-semibold text-ink">{gate.gateId}</span>
                    <StatusPill value={gate.deliverableId} tone="neutral" />
                  </div>
                  <p className="text-xs leading-5 text-ink-secondary">{gate.reason}</p>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>

      <section className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
        <section className="rounded border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">
              ACTION PROPOSALS
            </h2>
          </div>
          <div className="flex flex-col">
            {catalog.actionProposals.map((proposal) => (
              <div key={proposal.proposalId} className="flex flex-col gap-2 border-b border-hairline-soft px-4 py-4 last:border-b-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium text-ink">{proposal.actionType}</span>
                  <StatusPill value={proposal.approvalState.toUpperCase()} tone="neutral" />
                </div>
                <span className="font-mono text-[11px] text-ink-tertiary">{proposal.targetSystem} · {proposal.riskTier}</span>
                <span className="text-xs text-ink-secondary">{proposal.evidenceRunIds.length} evidence run · live execution false</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded border border-border bg-card">
          <div className="flex h-[48px] items-center justify-between border-b border-border px-4">
            <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">
              STATIC CONTROL BOUNDARIES
            </h2>
            <Link
              href="/recruiting-ops/legacy-coverage"
              className="font-mono text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary underline-offset-2 hover:underline"
            >
              LEGACY COVERAGE →
            </Link>
          </div>
          <div className="grid gap-3 px-4 py-4 md:grid-cols-2">
            {Object.entries(data.boundaries).map(([key, enabled]) => (
              <div key={key} className="flex min-h-[42px] items-center justify-between gap-4 border-b border-hairline-soft pb-3 last:border-b-0 md:last:border-b">
                <span className="text-[13px] text-ink-secondary">{formatBoundaryLabel(key)}</span>
                <StatusPill value={enabled ? "STATIC ON" : "STATIC OFF"} tone={enabled ? "paused" : "off"} />
              </div>
            ))}
          </div>
        </section>
      </section>

      <section className="overflow-hidden rounded border border-border bg-card">
        <div className="flex h-[48px] items-center justify-between border-b border-border px-4">
          <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">
            CAPABILITIES
          </h2>
          <span className="text-xs text-ink-tertiary">{data.counts.capabilityCount} capability rows</span>
        </div>
        <div className="overflow-x-auto">
          <div className="grid min-w-[680px] grid-cols-[1.4fr_1fr_104px_88px] border-b border-border px-4 py-3 font-mono text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
            <span>CAPABILITY</span>
            <span>PRIMARY AUDIENCE</span>
            <span>DURABILITY</span>
            <span>COVERAGE</span>
          </div>
          <div className="max-h-[420px] min-w-[680px] overflow-y-auto">
            {data.capabilityRows.map((row) => (
              <div
                key={row.capabilityId}
                className="grid min-h-[64px] grid-cols-[1.4fr_1fr_104px_88px] items-center border-b border-hairline-soft px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-1 pr-3">
                  <span className="truncate font-mono text-[12px] font-semibold text-ink">{row.capabilityId}</span>
                  <span className="truncate text-[12px] text-ink-tertiary">{row.outcome}</span>
                </div>
                <div className="flex min-w-0 flex-col gap-1 pr-3">
                  <span className="truncate text-[13px] text-ink-secondary">{row.primaryAudience}</span>
                  <span className="truncate text-[11px] text-ink-tertiary">{row.consumptionPurpose}</span>
                </div>
                <StatusPill
                  value={row.durability === "durable" ? "DURABLE" : "TRANSITIONAL"}
                  tone={row.durability}
                />
                <span className="font-mono text-[11px] text-ink-secondary">
                  {row.workflowCount}w · {row.moduleCount}m
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
