import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  getRecruitingOpsLaneConsoleData,
  type ConsoleAutomationDeliverableRow,
} from "@/lib/recruiting-ops/console-data";
import type { DeliverableLane } from "@/lib/recruiting-ops/autonomy";

const lanes = ["auto_delivery", "review_assisted", "action_proposal"] as const satisfies readonly DeliverableLane[];

const statusStyles = {
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
  off: "border-success-rule bg-success-bg text-success-fg",
  warning: "border-warning-rule bg-warning-bg text-warning-fg",
} as const;

export function generateStaticParams() {
  return lanes.map((lane) => ({ lane }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lane: string }>;
}): Promise<Metadata> {
  const { lane } = await params;
  const parsed = parseLane(lane);
  if (!parsed) return { title: "Automation Lane · Recruiting Ops" };
  const data = getRecruitingOpsLaneConsoleData(parsed);
  return { title: `${data.lane.label} · Recruiting Ops Automation` };
}

function StatusPill({ value, tone }: { value: string; tone: keyof typeof statusStyles }) {
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${statusStyles[tone]}`}>
      {value}
    </span>
  );
}

function Measure({ label, value }: { label: string; value: number }) {
  return (
    <section className="flex min-h-[118px] flex-col justify-between rounded border border-border bg-card p-4">
      <span className="font-mono text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">{label}</span>
      <span className="font-mono text-[34px] font-semibold leading-none text-ink">{value}</span>
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[78px] border-b border-hairline-soft px-4 py-4 text-xs leading-5 text-ink-tertiary last:border-b-0">
      {children}
    </div>
  );
}

function DeliverableRow({ deliverable }: { deliverable: ConsoleAutomationDeliverableRow }) {
  const warningTone = deliverable.autoEligibility === "never_auto" ? "warning" : "neutral";
  return (
    <div className="grid min-h-[64px] min-w-[680px] grid-cols-[1.2fr_1fr_120px_112px_96px] items-center border-b border-hairline-soft px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-1 pr-3">
        <span className="truncate font-mono text-[12px] font-semibold text-ink">{deliverable.deliverableId}</span>
        <span className="truncate text-[12px] text-ink-tertiary">{deliverable.capabilityId}</span>
      </div>
      <span className="truncate pr-3 text-[12px] text-ink-secondary">{deliverable.recipientScopeRuleIds.join(", ")}</span>
      <StatusPill value={deliverable.initialAutonomyState.toUpperCase()} tone="neutral" />
      <StatusPill value={formatAutoEligibility(deliverable.autoEligibility)} tone={warningTone} />
      <span className="font-mono text-[12px] text-ink-secondary">{deliverable.shadowRunRequirement}</span>
    </div>
  );
}

export default async function RecruitingOpsLanePage({
  params,
}: {
  params: Promise<{ lane: string }>;
}) {
  const { lane: laneParam } = await params;
  const lane = parseLane(laneParam);
  if (!lane) notFound();
  const data = getRecruitingOpsLaneConsoleData(lane);

  return (
    <div className="flex w-full flex-col gap-8 bg-background px-5 py-6 md:px-12 md:py-8">
      <section className="flex flex-col justify-between gap-6 lg:flex-row lg:items-start">
        <div className="flex max-w-[780px] flex-col gap-3.5">
          <div className="flex items-center gap-3">
            <span className="h-px w-6 bg-ink-tertiary" />
            <Link
              href="/recruiting-ops"
              className="font-mono text-[11px] font-medium tracking-[2px] text-ink-tertiary underline-offset-2 hover:underline"
            >
              ← CONTROL PLANE
            </Link>
          </div>
          <h1 className="text-[34px] font-medium leading-tight text-ink">{data.lane.label}</h1>
          <p className="text-sm leading-6 text-ink-secondary">
            {data.lane.deliverableCount} deliverables · {data.deliveryLogs.length} local delivery logs · {data.gateFailures.length} failed gates · {data.actionProposals.length} action proposals
          </p>
        </div>
        <div className="flex min-w-[232px] flex-col items-start gap-2 text-left lg:items-end lg:text-right">
          <StatusPill value="FIXTURE DATA — NO REAL RUNS" tone="off" />
          <StatusPill value="READ-ONLY UI" tone="off" />
          <StatusPill value={data.lane.externalAdapterApproved ? "STATIC ADAPTER ON" : "STATIC ADAPTER OFF"} tone="off" />
          <StatusPill value={data.boundaries.productionWritesEnabled ? "PROD WRITES STATIC ON" : "PROD WRITES STATIC OFF"} tone="off" />
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Measure label="DELIVERABLES" value={data.lane.deliverableCount} />
        <Measure label="AUTO-ELIGIBLE DELIVERABLES" value={data.lane.autoEligibleDeliverableCount} />
        <Measure label="BLOCKED OR PAUSED" value={data.lane.blockedOrPausedDeliveryLogCount} />
        <Measure label="FAILED GATES" value={data.lane.failedGateCount} />
      </section>

      <section className="overflow-hidden rounded border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">DELIVERABLE CONTRACTS</h2>
        </div>
        <div className="overflow-x-auto">
          <div className="grid min-w-[680px] grid-cols-[1.2fr_1fr_120px_112px_96px] border-b border-border px-4 py-3 font-mono text-[10px] font-semibold tracking-[1.5px] text-ink-tertiary">
            <span>DELIVERABLE</span>
            <span>RECIPIENT SCOPE</span>
            <span>STATE</span>
            <span>ELIGIBILITY</span>
            <span>SHADOWS</span>
          </div>
          {data.deliverables.map((deliverable) => (
            <DeliverableRow key={deliverable.deliverableId} deliverable={deliverable} />
          ))}
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">LOCAL RUNS</h2>
          </div>
          <div className="flex flex-col">
            {data.runs.length === 0 ? (
              <EmptyState>No local runs are attached to this lane yet.</EmptyState>
            ) : (
              data.runs.map((run) => (
                <div key={run.runId} className="grid min-h-[62px] grid-cols-[1fr_116px_96px] items-center border-b border-hairline-soft px-4 py-3 last:border-b-0">
                  <div className="flex min-w-0 flex-col gap-1 pr-3">
                    <span className="truncate font-mono text-[12px] font-semibold text-ink">{run.runId}</span>
                    <span className="truncate text-[12px] text-ink-tertiary">{run.moduleId}</span>
                  </div>
                  <StatusPill value={run.mode.toUpperCase()} tone="neutral" />
                  <StatusPill value={run.status.toUpperCase()} tone={run.status === "succeeded" ? "succeeded" : "blocked"} />
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">DELIVERY LOGS</h2>
          </div>
          <div className="flex flex-col">
            {data.deliveryLogs.length === 0 ? (
              <EmptyState>No local delivery logs are attached to this lane yet.</EmptyState>
            ) : (
              data.deliveryLogs.map((entry) => (
                <div key={entry.deliveryLogId} className="flex flex-col gap-2 border-b border-hairline-soft px-4 py-4 last:border-b-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium text-ink">{entry.deliverableId}</span>
                    <StatusPill value={entry.status.toUpperCase()} tone={entry.status} />
                  </div>
                  <span className="font-mono text-[11px] text-ink-tertiary">{entry.eventType} · {entry.deliveryMechanism}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </section>

      <section className="grid gap-5 xl:grid-cols-[1fr_1fr]">
        <section className="rounded border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">FAILED GATES</h2>
          </div>
          <div className="flex flex-col">
            {data.gateFailures.length === 0 ? (
              <EmptyState>No failed gate results are attached to this lane.</EmptyState>
            ) : (
              data.gateFailures.map((gate) => (
                <div key={gate.gateResultId} className="flex flex-col gap-2 border-b border-hairline-soft px-4 py-4 last:border-b-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[11px] font-semibold text-ink">{gate.gateId}</span>
                    <StatusPill value={gate.deliverableId} tone="neutral" />
                  </div>
                  <p className="text-xs leading-5 text-ink-secondary">{gate.reason}</p>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink">ACTION PROPOSALS</h2>
          </div>
          <div className="flex flex-col">
            {data.actionProposals.length === 0 ? (
              <EmptyState>No dry-run action proposals are attached to this lane.</EmptyState>
            ) : (
              data.actionProposals.map((proposal) => (
                <div key={proposal.proposalId} className="flex flex-col gap-2 border-b border-hairline-soft px-4 py-4 last:border-b-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium text-ink">{proposal.actionType}</span>
                    <StatusPill value={proposal.approvalState.toUpperCase()} tone="neutral" />
                  </div>
                  <span className="font-mono text-[11px] text-ink-tertiary">{proposal.targetSystem} · {proposal.riskTier}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </section>
    </div>
  );
}

function parseLane(value: string): DeliverableLane | null {
  return lanes.includes(value as DeliverableLane) ? (value as DeliverableLane) : null;
}

function formatAutoEligibility(value: ConsoleAutomationDeliverableRow["autoEligibility"]): string {
  if (value === "candidate") return "AUTO-ELIGIBLE";
  return value.toUpperCase().replaceAll("_", "-");
}
