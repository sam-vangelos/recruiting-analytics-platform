/**
 * Turns a hydration run into the message a human reads on Thursday morning.
 *
 * Success and failure used to look identical from outside the system: the run
 * wrote its evidence to Supabase and exited, and the only way to learn that
 * four reports were stale was for someone to open one. This module renders
 * what happened; lib/notification-delivery.postSlackDm delivers it, the same
 * transport lib/ytd-extract.ts already uses for pipeline failures.
 *
 * Pure by construction — no I/O, no clock, no env — so every shape below is
 * asserted directly rather than through a mocked Slack.
 *
 * Nothing here may carry a candidate, recruiter, or requisition identifier. The
 * vocabulary is artifact keys and the ledger's own failure codes.
 */
import { getStagingArtifact, type StagingArtifactKey } from "./staging-artifact-registry"
import type { HydrationArtifactReport } from "./staging-hydration-orchestrator"

/** Operator-facing names. An artifact key is a database word, not a report. */
const ARTIFACT_LABELS: Record<StagingArtifactKey, string> = {
  elt_doc: "ELT Recruiting Doc",
  weekly_recruitment: "Weekly Recruitment",
  weekly_progress: "Weekly Progress",
  all_hires: "All Hires",
  pipeline_890: "Pipeline 890",
  pipeline_907: "Pipeline 907",
  pipeline_1026_1027: "Pipeline 1026/1027",
  pipeline_1118_1119: "Pipeline 1118/1119",
  final_offer: "Final Offer",
  rps_tracking: "RPS Tracking",
  delivery_roles_rps: "Delivery Roles RPS",
}

/** Why a report did not update, in words, for the codes a run actually emits. */
const FAILURE_EXPLANATIONS: Record<string, string> = {
  blocked: "write blocked before it mutated anything",
  artifact_execution_failed: "the artifact run raised",
  recurring_sheet_lifecycle_blocked: "the dated tab could not be prepared",
  weekly_rollover_blocked: "the weekly rollover was blocked",
  weekly_row_lifecycle_blocked: "the row lifecycle was blocked",
  value_plan_deferred_pending_structure: "waiting on a structural change that has not run",
  hydration_attempt_timed_out: "the attempt was still running when the process ended",
  hydration_run_lease_expired: "a dead run's lease was retired mid-attempt",
  source_payload_retention_expired: "the source snapshot aged out before the retry",
}

export interface HydrationRunAlert {
  /** First line, and the only thing a phone notification shows. */
  headline: string
  /** The whole message, headline included. */
  text: string
}

export interface HydrationRunAlertInput {
  status: string
  runId: string
  businessDate: string
  artifactOutcomes: readonly HydrationArtifactReport[]
  reason?: string
  /** Present for a scheduled cycle; a manual run has none. */
  scheduledAt?: string
  lane?: string
}

export function renderHydrationRunAlert(input: HydrationRunAlertInput): HydrationRunAlert {
  const landed = input.artifactOutcomes.filter((report) => report.certified)
  const missed = input.artifactOutcomes.filter((report) => !report.certified)
  const total = input.artifactOutcomes.length

  const headline = renderHeadline({
    landedCount: landed.length,
    total,
    reason: input.reason,
  })

  const lines = [headline, "", ...runIdentityLines(input)]
  if (missed.length > 0) {
    lines.push("", "*Did not update*")
    for (const report of missed) {
      lines.push(`• ${artifactLabel(report.artifactKey)} — ${explainMiss(report)}`)
    }
  }
  if (landed.length > 0) {
    lines.push("", `*Updated* — ${landed.map((report) => artifactLabel(report.artifactKey)).join(", ")}`)
  }
  if (missed.length > 0) {
    lines.push("", "Re-running: docs/recruiting-ops/WEEKLY_AUTOMATION_RUNBOOK.md")
  }

  return { headline, text: lines.join("\n") }
}

function renderHeadline(input: {
  landedCount: number
  total: number
  reason?: string
}): string {
  if (input.reason === "overlap_in_progress") {
    return ":hourglass: Recruiting reports skipped a cycle — another run still held the lease"
  }
  if (input.total === 0) {
    return ":rotating_light: Recruiting reports did not update — the run ended before any report was attempted"
  }
  if (input.landedCount === input.total) {
    return `:white_check_mark: Recruiting reports updated — all ${input.total} landed`
  }
  if (input.landedCount === 0) {
    return `:rotating_light: Recruiting reports did not update — 0 of ${input.total} landed`
  }
  return `:warning: Recruiting reports partly updated — ${input.landedCount} of ${input.total} landed, ${input.total - input.landedCount} did not`
}

function runIdentityLines(input: HydrationRunAlertInput): string[] {
  const lines = [`Business date ${input.businessDate} · run \`${input.runId}\` · ended ${input.status}`]
  if (input.scheduledAt) {
    lines.push(`Scheduled slot ${input.scheduledAt}${input.lane ? ` (${input.lane})` : ""}`)
  }
  return lines
}

function explainMiss(report: HydrationArtifactReport): string {
  if (report.outcome === null) return "never attempted"
  const explanation = report.failureCode ? FAILURE_EXPLANATIONS[report.failureCode] : undefined
  const stage = report.failureStage ? ` at ${report.failureStage}` : ""
  if (explanation) return `${explanation}${stage} (\`${report.failureCode}\`)`
  if (report.failureCode) return `\`${report.failureCode}\`${stage}`
  return `ended ${report.outcome}${stage}`
}

function artifactLabel(artifactKey: StagingArtifactKey): string {
  // getStagingArtifact throws on an unregistered key, which keeps a label from
  // silently drifting away from the registry the run actually wrote against.
  getStagingArtifact(artifactKey)
  return ARTIFACT_LABELS[artifactKey]
}

export interface HydrationSlotAlertInput {
  /** Scheduled slots that are past due with no run row at all. */
  missingSlots: readonly { scheduledAt: string; lane: string; dueArtifactCount: number }[]
}

export function renderHydrationSlotAlert(input: HydrationSlotAlertInput): HydrationRunAlert {
  const headline = input.missingSlots.length === 1
    ? ":rotating_light: A recruiting reports run never started"
    : `:rotating_light: ${input.missingSlots.length} recruiting reports runs never started`
  const lines = [
    headline,
    "",
    "No run was ever claimed for these scheduled slots, so nothing was attempted:",
  ]
  for (const slot of input.missingSlots) {
    lines.push(`• ${slot.scheduledAt} (${slot.lane}) — ${slot.dueArtifactCount} report(s) due`)
  }
  lines.push(
    "",
    "The scheduler, the launch call, or the job itself did not fire.",
    "Re-running: docs/recruiting-ops/WEEKLY_AUTOMATION_RUNBOOK.md"
  )
  return { headline, text: lines.join("\n") }
}
