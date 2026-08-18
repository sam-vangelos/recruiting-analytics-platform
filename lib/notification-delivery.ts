/**
 * Notification delivery — the outbox enqueue + drain worker (W3).
 *
 * Pairs with supabase/migrations/006_notification_delivery.sql (the SCHEMA: the
 * notification_outbox + notification_delivery_attempts tables, the
 * claim_notification_outbox + reap_stale_notification_leases RPCs) and
 * lib/notification-render.ts (buildNotification, the PURE intent -> Slack-message
 * shaper). This module owns the I/O the render module deliberately does not: it
 * reads the ledger, writes the outbox, claims work, talks to Slack, and records
 * what physically happened.
 *
 * Three concerns, three storage shapes, one worker (006 header):
 *   - URGENCY stays where it is. sweep_items.urgency_tier / referralTierLabel are
 *     UNTOUCHED here. `ALERTED` is a sweep urgency label; this system owns only
 *     whether a Slack DM was sent / failed / suppressed. A row can read
 *     'Urgency: ALERTED' and 'Delivery: Suppressed (dashboard only)' at once.
 *   - INTENT lives in notification_outbox, one row per (channel, application_id,
 *     reason), idempotent on a deterministic dedupe_key.
 *   - ATTEMPT lives in append-only notification_delivery_attempts, carrying the
 *     Slack `ts` as provider_message_id (the value slack-notify.ts currently
 *     returns and discards — 006:11,68).
 *
 * Why a separate drain rather than sending inside the sweep: failure-domain
 * isolation. The sweep already runs Greenhouse extraction + enrichment + ledger
 * writes under maxDuration=60/120; a Slack 429 or token-revoke mid-sweep is exactly
 * the class the repo just hardened against (commits a7029c9 "Retry revoked
 * Greenhouse tokens", 8f105e7). The outbox captures intent; the drain owns send +
 * retry; Slack latency never touches the sweep's critical path.
 *
 * SEND GATE (the W3 fork as data): per-channel env gates NOTIFY_REFERRAL_SEND /
 * NOTIFY_AGENCY_SEND, read via readEnv, DEFAULT FALSE. An unset or blank gate means
 * SUPPRESS, never send — deploy is behavior-neutral (today's dashboard-only
 * behavior). A suppressed-by-policy intent still writes a full would-send audit row
 * so flipping the gate has retroactive visibility.
 *
 * RECIPIENT: the head-of-TA (SWEEP_CONFIG.slack.headOfTaUserId), today's behavior.
 * buildNotification defaults the recipient to that constant; a NULL recipient is a
 * DEFECT (recipient_unresolved), never a fabricated id and never a label.
 *
 * DELIVERY GUARANTEE: idempotent enqueue + at-least-once send. The claim RPC leases
 * under FOR UPDATE SKIP LOCKED so two concurrent drains never claim the same intent.
 * The one duplicate window: if a drain crashes AFTER Slack accepts the message but
 * BEFORE recordAttempt commits, the lease leaks, reap() returns the intent to
 * 'pending', and the next drain re-sends — one duplicate DM. True exactly-once is
 * not achievable (chat.postMessage exposes no idempotency key the bot can set), so
 * this is accepted: provider_message_id is recorded in the SAME write that stamps
 * the intent terminal, and the lease TTL is kept well above a Slack round-trip to
 * shrink the window. See drainOne() for the ordered writes.
 */

import { supabase } from "./supabase"
import { readEnv } from "./env"
import { resolvedOrNull } from "./resolution-display"
import { SWEEP_CONFIG } from "./sweep-config"
import {
  buildEscalationEmail,
  buildNotification,
  dedupeKey,
  type NotificationIntent,
  type NotificationPriorApplication,
} from "./notification-render"
import { isEmailSendEnabled, sendEmail } from "./email-notify"
import { loadSlackIdsForRecruiters } from "./recruiter-slack-directory"
// Enum unions are imported from the canonical home (notification-types.ts) rather than
// re-declared here. The render module re-declares structurally-identical literals for
// dependency-lightness; this I/O module — which writes the DB columns those CHECK
// constraints guard — binds to the single source of truth so a vocabulary edit lands
// in exactly one place (notification-types.ts header).
import type {
  NotificationChannel,
  NotificationType,
  NotificationReason,
  RecipientResolutionStatus,
  OutboxStatus,
  SuppressionReason,
} from "./notification-types"

const SLACK_API = "https://slack.com/api"

// ---------------------------------------------------------------------------
// Drain tuning. Defaults chosen to keep the lease comfortably longer than a Slack
// round-trip (shrinks the at-least-once duplicate window) and bounded per tick so a
// single drain invocation stays well inside the cron's maxDuration.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  /** Max intents claimed per drain tick. */
  batchLimit: 50,
  /** Lease TTL handed to claim_notification_outbox. Must exceed worst-case
   *  send+record latency so a live drain's lease never expires under it. */
  leaseSeconds: 120,
  /** Outbox.max_attempts is the DB authority; this is the local fallback cap. */
  maxAttempts: 5,
  /** Exponential backoff base for a transient failure: base * 2^(attempt-1). */
  backoffBaseSeconds: 60,
  /** Backoff ceiling so a long-failing intent still retries on a sane cadence. */
  backoffCapSeconds: 3600,
} as const

// ---------------------------------------------------------------------------
// Send gate. readEnv DEFAULTS to false: unset / blank / anything-not-"true" =>
// SUPPRESS. This is the safety contract — the gate must be EXPLICITLY "true" to
// send. Case-insensitive on "true"; everything else (including "1", "yes", "") is
// off, because the spec says an unset/blank gate suppresses and conservative is the
// correct failure mode for a money/trust-sensitive alert.
// ---------------------------------------------------------------------------

const SEND_GATE_ENV: Record<NotificationChannel, string> = {
  referral: "NOTIFY_REFERRAL_SEND",
  agency: "NOTIFY_AGENCY_SEND",
}

export function isChannelSendEnabled(channel: NotificationChannel): boolean {
  const raw = readEnv(SEND_GATE_ENV[channel])
  return raw?.toLowerCase() === "true"
}

// ---------------------------------------------------------------------------
// Backfill suppression cutover (Q2). Every alert_ledger row that predates the moment
// this delivery system went live alerted (or didn't) under the old dashboard-only
// regime; enqueuing them now and letting them send would be a retroactive blast. The
// cutover is the deploy boundary: NOTIFY_DELIVERY_CUTOVER_AT (an ISO instant). Any ledger
// row first alerted at-or-before that instant is enqueued already-terminal —
// status='suppressed', suppression_reason='backfill_predates_log' — so it can never be
// claimed and never sends. This is a HARD gate that fires regardless of the channel
// send-gate; only post-cutover alerts ever reach a 'pending' intent.
//
// When the cutover is UNSET/blank, no backfill boundary is declared, so we do NOT
// retroactively suppress — rows enqueue 'pending'. Zero-retroactive-send is still
// honored, because the channel send-gate defaults OFF: an undeclared-cutover deploy
// sends nothing until BOTH a cutover is stamped (drawing the pre/post line) AND the gate
// is flipped "true". Setting the cutover at deploy time is the operational contract; the
// unset default stays behavior-neutral rather than reclassifying live rows from one read.
// ---------------------------------------------------------------------------

const CUTOVER_ENV = "NOTIFY_DELIVERY_CUTOVER_AT"

/** The deploy cutover instant in epoch-ms, or null when none is configured (blank or
 *  unparseable => null => no backfill boundary, rows enqueue 'pending'). */
function backfillCutoverMs(): number | null {
  const raw = readEnv(CUTOVER_ENV)
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

/** True when a cutover IS configured and this ledger row first alerted at-or-before it —
 *  i.e. a pre-deploy backfill row that must be suppressed, never sent. Returns false when
 *  no cutover is set (no boundary => enqueue normally; the send-gate is the safety net). */
function ledgerPredatesCutover(firstAlertedAt: string | null): boolean {
  const cutoff = backfillCutoverMs()
  if (cutoff === null) return false
  if (!firstAlertedAt) return false
  const alertedMs = Date.parse(firstAlertedAt)
  if (!Number.isFinite(alertedMs)) return false
  return alertedMs <= cutoff
}

// ---------------------------------------------------------------------------
// Outbox row shape (subset of 006 columns this module reads/writes). Mirrors the
// notification_outbox CHECK constraints; the payload is the denormalized
// NotificationIntent the drain rebuilds without re-hitting Greenhouse (006:39).
// ---------------------------------------------------------------------------

// OutboxStatus + SuppressionReason are imported from lib/notification-types.ts (the
// canonical vocabulary) and re-exported here so existing importers of these names from
// this module keep compiling.
export type { OutboxStatus, SuppressionReason }

export type DeliveryTarget = "slack_dm" | "email" | "dashboard_only"

/** The persisted render snapshot. Carries every field buildNotification reads so the
 *  drain never reaches past the outbox row. It is a NotificationIntent minus the
 *  fields promoted to their own columns (channel/type/reason/application_id). */
export type OutboxPayload = Omit<
  NotificationIntent,
  "channel" | "notification_type" | "reason" | "application_id"
>

export interface OutboxRow {
  id: string
  dedupe_key: string
  channel: NotificationChannel
  notification_type: NotificationType
  reason: NotificationReason
  application_id: number
  candidate_id: number | null
  job_id: number | null
  recipient_user_id: string | null
  recipient_resolution_status: RecipientResolutionStatus
  delivery_target: DeliveryTarget
  payload: OutboxPayload
  status: OutboxStatus
  attempt_count: number
  max_attempts: number
  next_attempt_at: string
  leased_until: string | null
  last_delivery_attempt_id: string | null
  suppression_reason: SuppressionReason | null
  created_at: string
  updated_at: string
  sent_at: string | null
}

// ---------------------------------------------------------------------------
// Results.
// ---------------------------------------------------------------------------

export interface EnqueueResult {
  /** Ledger rows scanned that had no outbox row yet. */
  candidates: number
  /** Intents actually inserted (idempotent: a re-run inserts 0). */
  inserted: number
  /** Per-channel breakdown of inserts. */
  byChannel: Record<NotificationChannel, number>
  /** Ledger rows skipped because the joined sweep_items/agency row was missing or
   *  carried a non-alerting tier (data we could not render an honest intent from). */
  skipped: number
}

export interface DrainResult {
  /** Stale leases reaped back to 'pending' before claiming. */
  reaped: number
  /** Intents leased by claim_notification_outbox this tick. */
  claimed: number
  sent: number
  failed: number
  suppressed: number
}

// ---------------------------------------------------------------------------
// (1) enqueuePending — scan alert_ledger for rows lacking a notification_outbox row,
// join the canonical display fields, build a per-application intent, and upsert
// idempotently on dedupe_key.
//
// Why a ledger SCAN rather than the sweeps pushing intents directly: this task may
// NOT edit the sweep libs (lib/sweep-referral.ts, lib/sweep-agency.ts). A scan over
// alert_ledger (the dedup spine the sweeps already maintain — 001:43, unique
// (application_id, sweep_type)) lets enqueue run entirely from this module with zero
// sweep contention. Each unresolved-or-resolved ledger row is one application that
// alerted; we materialize its current intent from sweep_items / agency_submissions.
// ---------------------------------------------------------------------------

interface LedgerRow {
  application_id: number
  sweep_type: NotificationChannel
  greenhouse_stage_at_alert: string | null
  first_alerted_at: string
  last_alerted_at: string
  resolved_at: string | null
}

interface SweepItemRow {
  application_id: number
  candidate_id: number | null
  job_id: number | null
  candidate_name: string | null
  job_title: string | null
  source_name: string | null
  current_stage: string | null
  urgency_tier: string | null
  hours_in_current_stage: number | null
  last_activity_at: string | null
  application_created_at: string | null
  referrer_name: string | null
  /** 015 — every recruiter on the requisition, recorded by the HOURLY sweep. Preferred over
   *  ytd_application_facts.recruiter_ids, which is written once a day. */
  recruiter_ids: number[] | null
  recruiter_name: string | null
  ownership_resolution_status: string | null
  conflict_detail: AgencyConflictDetail | null
}

/** The local-state shape sweep-agency.ts writes when a cross-agency conflict is
 *  detected from agency_submissions rather than Greenhouse history
 *  (sweep-agency.ts:531-540): { application_id, agency, job_title, submitted_at }.
 *  Distinct from NotificationPriorApplication — Q4 maps it into that shape so the
 *  dual_agency renderer's Agency 1 / Agency 2 lines render. */
interface PriorAgencySubmission {
  application_id?: number | null
  agency?: string | null
  job_title?: string | null
  submitted_at?: string | null
}

interface AgencyConflictDetail {
  conflict_type?: "prior_history" | "dual_agency"
  risk_level?: "high" | "medium" | "low"
  prior_applications?: NotificationPriorApplication[]
  prior_submissions?: PriorAgencySubmission[]
  candidate_email?: string | null
}

interface AgencySubmissionRow {
  application_id: number
  candidate_name?: string | null
  agency_source_name: string | null
  job_title: string | null
  recruiter_name: string | null
  conflict_type: "prior_history" | "dual_agency" | null
  conflict_detail: AgencyConflictDetail | null
  source_resolution_status: string | null
}

const EMPTY_BY_CHANNEL: Record<NotificationChannel, number> = {
  referral: 0,
  agency: 0,
}

// ---------------------------------------------------------------------------
// PostgREST caps an unbounded select at 1000 rows (the project's default
// db-max-rows). enqueuePending's two unfiltered scans — notification_outbox (the
// idempotency pre-filter) and alert_ledger (the alert spine) — both grow without
// bound, so an un-paginated scan silently truncates and a row past the 1000th would
// never enqueue (Q5). Page with .range() until a short page signals the end.
// ---------------------------------------------------------------------------

const SCAN_PAGE_SIZE = 1000

/** A select chain that accepts .range() and resolves to { data, error }. The mocked
 *  PostgREST builder returns the same thenable from .range(), so a short first page
 *  ends the loop after one fetch in tests; in prod each call narrows the window. */
type RangeableSelect<T> = PromiseLike<{ data: T[] | null; error: unknown }> & {
  range: (from: number, to: number) => RangeableSelect<T>
}

/** Run a paginated SELECT to exhaustion. `build` is invoked per page with the row
 *  window; pages accumulate until one returns fewer than SCAN_PAGE_SIZE rows. */
async function scanAll<T>(
  build: () => RangeableSelect<T>
): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await build().range(from, from + SCAN_PAGE_SIZE - 1)
    if (error) throw error
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < SCAN_PAGE_SIZE) break
    from += SCAN_PAGE_SIZE
  }
  return out
}

function relativeTime(isoDate: string | null): string | null {
  if (!isoDate) return null
  const diffMs = Date.now() - new Date(isoDate).getTime()
  if (!Number.isFinite(diffMs)) return null
  const hours = Math.round(diffMs / (1000 * 60 * 60))
  if (hours < 1) return "just now"
  if (hours === 1) return "1 hour ago"
  if (hours < 24) return `${hours} hours ago`
  const days = Math.round(hours / 24)
  return days === 1 ? "1 day ago" : `${days} days ago`
}

/** Map a sweep urgency_tier to an outbox reason. Returns null for non-alerting
 *  tiers ('new'/'actioned') — those never get a notification intent. Urgency itself
 *  is NOT reclassified here; this only names why a ledgered alert is being sent. */
function referralReasonFromTier(tier: string | null): NotificationReason | null {
  switch (tier) {
    // 'new' is an ACTIVE referral sitting in Application Review under 24h (sweep-types.ts:79-83)
    // — a fresh referral awaiting first touch, not a non-event. It maps to the SAME reason as
    // 'alerted' deliberately: dedupe_key is {channel}:{application_id}:{reason}, so the 24h
    // 'alerted' tick collapses onto the hour-1 row instead of sending a second DM. Net effect is
    // the first alert moving from ~24h to ~1h with per-candidate volume unchanged. Mapping 'new'
    // to a DISTINCT reason would double every referral's DM count — do not split these.
    case "new":
    case "alerted":
      return "sla_alerted"
    case "sla_risk":
      return "sla_risk"
    case "breach":
      return "breach"
    default:
      return null
  }
}

/** Paginated scan of the full alert_ledger (the alert spine). Extracted (P0) so P5's escalation
 *  enqueue pass reuses the exact same scan instead of re-shaping enqueuePending's body. */
async function scanAlertLedger(): Promise<LedgerRow[]> {
  return scanAll<LedgerRow>(
    () =>
      supabase
        .from("alert_ledger")
        .select(
          "application_id, sweep_type, greenhouse_stage_at_alert, first_alerted_at, last_alerted_at, resolved_at"
        ) as unknown as RangeableSelect<LedgerRow>
  )
}

export async function enqueuePending(): Promise<EnqueueResult> {
  // Step 1: which intents already exist? The pre-filter keys on the FULL dedupe_key
  // (channel:application_id:reason), NOT channel:application_id (Q1). Keying on the
  // app alone meant an app already enqueued at one tier (e.g. sla_alerted) could
  // never enqueue at a worse tier (sla_risk / breach) — escalation silently dropped.
  // Per distinct reason/tier we now enqueue exactly once; the dedupe_key unique
  // constraint (006:53) is still the backstop, but the pre-filter no longer collapses
  // the tier axis. Selecting `reason` is required to build the key.
  const existingOutbox = await scanAll<{
    application_id: number
    channel: NotificationChannel
    reason: NotificationReason
  }>(
    () =>
      supabase
        .from("notification_outbox")
        .select("application_id, channel, reason") as unknown as RangeableSelect<{
        application_id: number
        channel: NotificationChannel
        reason: NotificationReason
      }>
  )

  const haveOutbox = new Set(
    existingOutbox.map((r) =>
      dedupeKey({
        channel: r.channel,
        application_id: r.application_id,
        reason: r.reason,
      })
    )
  )

  // Step 2: ledger rows are the alerts. One row per (application_id, sweep_type).
  // Paginated (Q5) so a backlog past the 1000-row PostgREST cap still enqueues.
  // resolved_at is read so a row resolved before its first drain can be enqueued
  // already-suppressed downstream (the live resolve-time check is Q3 in drainOne).
  const ledgerRows = await scanAlertLedger()

  const result: EnqueueResult = {
    candidates: 0,
    inserted: 0,
    byChannel: { ...EMPTY_BY_CHANNEL },
    skipped: 0,
  }
  if (ledgerRows.length === 0) return result

  // Step 3: join the canonical display fields for EVERY ledger row. We can't pre-drop
  // by app id anymore (the reason — hence the dedupe_key — is only known after we
  // hydrate the live tier / conflict_type), so hydrate first, build the intent, then
  // dedupe on the full key. sweep_items is the most-recent detection row per
  // application; agency_submissions carries the resolved agency name + conflict
  // detail. The drain renders from the payload we freeze here, so these reads are the
  // ONLY Greenhouse-derived data the notification will ever show (006:39).
  const referralAppIds = ledgerRows
    .filter((r) => r.sweep_type === "referral")
    .map((r) => r.application_id)
  const agencyAppIds = ledgerRows
    .filter((r) => r.sweep_type === "agency")
    .map((r) => r.application_id)

  const sweepItemsById = await loadLatestSweepItems([
    ...referralAppIds,
    ...agencyAppIds,
  ])
  const agencySubsById = await loadAgencySubmissions(agencyAppIds)
  // P2: recruiter ownership per application (Supabase-only) so the owner line renders and the
  // routing metadata (recruiter_id / recruiter_count) rides into the frozen payload for P4.
  const ytdRecruiterById = await loadYtdRecruiter([...referralAppIds, ...agencyAppIds])

  // Step 4: build intents. After build, drop any whose dedupe_key already exists
  // (idempotency + escalation: a new tier yields a new key and survives). A row that
  // predates the deploy cutover is enqueued already-terminal suppressed
  // (backfill_predates_log, Q2) so the first live drain never sends the backlog.
  const intents: Array<ReturnType<typeof intentToRow>> = []
  const seenThisRun = new Set<string>()
  for (const row of ledgerRows) {
    const built =
      row.sweep_type === "referral"
        ? buildReferralIntentForLedger(
            row,
            sweepItemsById.get(row.application_id),
            ytdRecruiterById.get(row.application_id)
          )
        : buildAgencyIntentForLedger(
            row,
            sweepItemsById.get(row.application_id),
            agencySubsById.get(row.application_id),
            ytdRecruiterById.get(row.application_id)
          )
    if (!built) {
      result.skipped += 1
      continue
    }
    // Q2 backfill: a pre-cutover ledger row enqueues already-suppressed so it can
    // never be claimed and never sends. Post-cutover rows enqueue 'pending'.
    // Two independent boundaries, either of which makes this row terminal-suppressed:
    //   - the original W3 deploy cutover (NOTIFY_DELIVERY_CUTOVER_AT), and
    //   - the recruiter-routing start line, which guarantees no recruiter ever receives an alert
    //     raised before fan-out was switched on.
    const predatesCutover =
      ledgerPredatesCutover(row.first_alerted_at) ||
      predatesRecruiterRouting(row.first_alerted_at)
    const terminal = predatesCutover
      ? ({ status: "suppressed", suppression_reason: "backfill_predates_log" } as const)
      : undefined

    // FAN-OUT (operator decision 2026-08-06). In recruiter mode a referral/agency alert goes to EVERY recruiter
    // on the requisition's hiring team, each as their own DM — so one alert becomes one outbox row
    // per owner, each independently keyed, sent, retried and audited. In head_of_ta mode the list
    // is empty and this collapses to exactly one row on the 3-part key, unchanged.
    // An owner list that is empty or absent also yields the single unkeyed row, which routes to
    // head-of-TA as 'unresolved' — an application with no known owner must still surface.
    const fanoutIds =
      recipientMode() === "recruiter" && built.recruiter_ids && built.recruiter_ids.length > 0
        ? built.recruiter_ids
        : [undefined]

    for (const recruiterId of fanoutIds) {
      const key = dedupeKey({
        channel: built.intent.channel,
        application_id: built.intent.application_id,
        reason: built.intent.reason,
        recipient_recruiter_id: recruiterId ?? null,
      })
      // Already enqueued (any tier collapses to its own key) or already built this run.
      if (haveOutbox.has(key) || seenThisRun.has(key)) continue
      seenThisRun.add(key)
      // A genuinely-new intent (no matching-key outbox row yet) is a candidate.
      result.candidates += 1
      intents.push(intentToRow(built, terminal, "slack_dm", recruiterId))
    }
  }

  if (intents.length === 0) return result

  // Step 5: idempotent upsert on dedupe_key. ignoreDuplicates => a re-scan that sees
  // the same alert is a no-op insert; the unique constraint (006:53) is the backstop.
  const { data: upserted, error: upsertErr } = await supabase
    .from("notification_outbox")
    .upsert(intents, { onConflict: "dedupe_key", ignoreDuplicates: true })
    .select("id, channel")
  if (upsertErr) throw upsertErr

  for (const r of (upserted ?? []) as Array<{ channel: NotificationChannel }>) {
    result.inserted += 1
    result.byChannel[r.channel] += 1
  }
  return result
}

async function loadLatestSweepItems(
  applicationIds: number[]
): Promise<Map<number, SweepItemRow>> {
  const byId = new Map<number, SweepItemRow>()
  if (applicationIds.length === 0) return byId
  // created_at desc so the FIRST row seen per application_id is the most recent
  // detection — that's the urgency_tier / conflict_detail we render from.
  const { data, error } = await supabase
    .from("sweep_items")
    // SELECT * (not a named column list) so this loader cannot 500 against a pre-005
    // schema: the list named ownership_resolution_status (added by 005), which
    // PostgREST rejects when the migration is unapplied. `*` returns whatever columns
    // exist; the SweepItemRow fields are read defensively (every access is optional),
    // and created_at — needed for the most-recent-per-application ordering below — is
    // included by `*`. Activation is gated upstream (NOTIFY_DELIVERY_ENABLED); this is
    // the second layer of pre-005 safety.
    .select("*")
    .in("application_id", applicationIds)
    .order("created_at", { ascending: false })
  if (error) throw error
  for (const row of (data ?? []) as Array<SweepItemRow & { created_at: string }>) {
    if (!byId.has(row.application_id)) byId.set(row.application_id, row)
  }
  return byId
}

async function loadAgencySubmissions(
  applicationIds: number[]
): Promise<Map<number, AgencySubmissionRow>> {
  const byId = new Map<number, AgencySubmissionRow>()
  if (applicationIds.length === 0) return byId
  const { data, error } = await supabase
    .from("agency_submissions")
    // SELECT * (not a named column list) so this loader cannot 500 against a pre-005
    // schema: the list named source_resolution_status and recruiter_name (both added to
    // agency_submissions by 005), which PostgREST rejects when the migration is
    // unapplied. `*` returns whatever columns exist; AgencySubmissionRow fields are read
    // defensively downstream. Activation is gated upstream (NOTIFY_DELIVERY_ENABLED).
    .select("*")
    .in("application_id", applicationIds)
  if (error) throw error
  for (const row of (data ?? []) as AgencySubmissionRow[]) {
    byId.set(row.application_id, row)
  }
  return byId
}

interface YtdRecruiterRow {
  /** The resolved single-winner recruiter (a GH user id); null = unresolved/ambiguous. */
  primary_recruiter_id: number | null
  primary_recruiter_name: string | null
  /** All distinct recruiter owners; length > 1 = shared ownership. */
  recruiter_ids: number[] | null
  /** GH candidate id — covers old escalation alerts that have no fresh sweep_items row, so the
   *  escalation email can still hyperlink the candidate's Greenhouse profile. */
  candidate_id: number | null
}

/** P2: recruiter ownership for the alerted applications, from ytd_application_facts — which
 *  already carries a resolved primary_recruiter_id on 44/46 alerted apps (sweep_items.recruiter_id
 *  is dormant/0). Supabase-only (the enqueuer stays zero-external-IO). application_id is the facts
 *  PK so a single .in() suffices; a very-recently-alerted app with no fact yet simply misses the
 *  map and falls back to head-of-TA downstream (no throw). */
async function loadYtdRecruiter(
  applicationIds: number[]
): Promise<Map<number, YtdRecruiterRow>> {
  const byId = new Map<number, YtdRecruiterRow>()
  if (applicationIds.length === 0) return byId
  const { data, error } = await supabase
    .from("ytd_application_facts")
    .select(
      "application_id, primary_recruiter_id, primary_recruiter_name, recruiter_ids, candidate_id"
    )
    .in("application_id", applicationIds)
  if (error) throw error
  for (const row of (data ?? []) as Array<YtdRecruiterRow & { application_id: number }>) {
    byId.set(row.application_id, {
      primary_recruiter_id: row.primary_recruiter_id ?? null,
      primary_recruiter_name: row.primary_recruiter_name ?? null,
      recruiter_ids: row.recruiter_ids ?? null,
      candidate_id: row.candidate_id ?? null,
    })
  }
  return byId
}

/** A built intent: the full NotificationIntent the render module consumes, plus the
 *  recipient resolution we resolve at enqueue time (head-of-TA today). */
interface BuiltIntent {
  intent: NotificationIntent
  candidate_id: number | null
  job_id: number | null
  recipient_user_id: string | null
  recipient_resolution_status: RecipientResolutionStatus
  /** Every recruiter on the requisition's hiring team (ytd_application_facts.recruiter_ids).
   *  Fan-out emits one outbox row per entry in recruiter mode. Null/empty => one row to
   *  head-of-TA. NOT the same as intent.recruiter_id, which is the single resolved primary. */
  recruiter_ids: number[] | null
}

interface RecipientResolution {
  recipient_user_id: string | null
  recipient_resolution_status: RecipientResolutionStatus
}

interface RecipientCtx {
  recruiterId?: number | null
  recruiterSlackId?: string | null
  recruiterCount?: number | null
}

/** head_of_ta (default) routes every DM to the head-of-TA, as today. recruiter routes to the
 *  owning recruiter, falling back to head-of-TA. Decoupled from the send gates so routing can be
 *  flipped + audited without touching whether we send. */
/** The instant recruiter routing was switched on. REQUIRED for recruiter mode — see
 *  recipientMode. Returns null when unset or unparseable. */
export function recruiterRoutingFromMs(): number | null {
  const raw = readEnv("NOTIFY_RECRUITER_ROUTING_FROM")
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

/** head_of_ta (default) routes every DM to the head-of-TA. recruiter fans out to every recruiter
 *  on the requisition.
 *
 *  RECRUITER MODE FAILS CLOSED WITHOUT A START LINE (operator decision 2026-08-06: "They should ONLY receive
 *  messages that send at some point after the capability is switched on"). Turning on fan-out
 *  changes every referral dedupe_key, so every already-alerted application re-enqueues under new
 *  keys — 202 live alerts at the time of writing, 68 of them owned by one recruiter, all firing on
 *  the next drain tick. Suppressing that backlog must NOT depend on an operator remembering to set
 *  a second variable in the right order, so the two are welded together: NOTIFY_RECIPIENT_MODE
 *  alone does nothing. Without a parseable NOTIFY_RECRUITER_ROUTING_FROM this returns head_of_ta,
 *  which makes "routing on, backlog unguarded" an unrepresentable state rather than a race. */
function recipientMode(): "head_of_ta" | "recruiter" {
  if (readEnv("NOTIFY_RECIPIENT_MODE")?.toLowerCase() !== "recruiter") return "head_of_ta"
  return recruiterRoutingFromMs() === null ? "head_of_ta" : "recruiter"
}

/** True when this alert was first raised at-or-before recruiter routing was switched on, so no
 *  recruiter may ever receive it. Keyed on alert_ledger.first_alerted_at — the moment the alert
 *  came into existence — NOT last_alerted_at, which the hourly sweep bumps and would slide the
 *  boundary forward forever. A pre-existing application that later escalates to a new tier is
 *  still suppressed: its ledger row predates the switch-on, so it stays the head-of-TA's backlog.
 *  Independent of NOTIFY_DELIVERY_CUTOVER_AT, which is currently EMPTY in production and therefore
 *  suppresses nothing — this must not inherit that gap. */
function predatesRecruiterRouting(firstAlertedAt: string | null): boolean {
  const from = recruiterRoutingFromMs()
  if (from === null) return false
  if (!firstAlertedAt) return true // no known raise time => cannot prove it is new => do not send
  const alertedMs = Date.parse(firstAlertedAt)
  if (!Number.isFinite(alertedMs)) return true
  return alertedMs <= from
}

/** Resolve a slack_dm recipient. With no ctx (enqueue time) or in head_of_ta mode, the head-of-TA
 *  is the recipient. In recruiter mode: a shared job (>1 owner) goes to head-of-TA as 'ambiguous'
 *  (never DM an arbitrary owner); a resolved recruiter slack id is DM'd; a recruiter with no slack
 *  id — or no recruiter — falls back to head-of-TA as 'unresolved'. ALL three carry a non-null id
 *  so all three SEND; the status is an audit dimension, never a sentinel name. */
export function resolveRecipient(ctx?: RecipientCtx): RecipientResolution {
  const headOfTa = SWEEP_CONFIG.slack.headOfTaUserId?.trim() || null
  if (recipientMode() === "head_of_ta" || !ctx) {
    return { recipient_user_id: headOfTa, recipient_resolution_status: headOfTa ? "resolved" : "unresolved" }
  }
  // NO 'ambiguous' BRANCH ANY MORE. It used to divert any application whose req had >1 recruiter
  // owner back to the head-of-TA, on the reasoning that we must not DM an arbitrary owner. Fan-out
  // dissolves that problem rather than working around it: recruiter mode emits one row PER owner,
  // each carrying its own recruiter_id, so there is never an arbitrary choice left to make. Live
  // check on req 1206 (AI Engineering Lead, NY): Greenhouse's hiring team lists Ravi Pillai,
  // Victor Reyes and Margot Ellis all as Recruiters — the "(Recruiting tasks)" marker on one
  // of them is a default task-assignment flag, NOT a statement that the other two are uninvolved.
  // A referral arriving on that req is news for all three.
  if (ctx.recruiterSlackId) {
    return { recipient_user_id: ctx.recruiterSlackId, recipient_resolution_status: "resolved" }
  }
  // Owner known but not reachable on Slack (departed — the directory carries 'deactivated'), or no
  // owner at all. Falls back to head-of-TA and still SENDS; the status is the audit dimension.
  return { recipient_user_id: headOfTa, recipient_resolution_status: "unresolved" }
}

function buildReferralIntentForLedger(
  ledger: LedgerRow,
  item: SweepItemRow | undefined,
  ytd?: YtdRecruiterRow
): BuiltIntent | null {
  // Reason is derived from the live urgency_tier when we have the sweep_items row,
  // else from the stage stamped on the ledger at alert time. If neither yields an
  // alerting reason, there is nothing honest to send — skip.
  const tier = item?.urgency_tier ?? null
  const reason = referralReasonFromTier(tier)
  if (!reason) return null

  const recipient = resolveRecipient()
  const candidate_name =
    item?.candidate_name?.trim() || `Candidate #${ledger.application_id}`
  const job_title = item?.job_title?.trim() || `Job #${item?.job_id ?? "?"}`
  const owner = recruiterOwner(ytd, item)

  const intent: NotificationIntent = {
    channel: "referral",
    notification_type: "referral_alert",
    reason,
    application_id: ledger.application_id,
    candidate_name,
    job_title,
    recruiter_owner_name: owner.name,
    referrer_name: item?.referrer_name ?? null,
    current_stage: item?.current_stage ?? ledger.greenhouse_stage_at_alert ?? null,
    urgency_since: relativeTime(
      item?.last_activity_at ??
        item?.application_created_at ??
        ledger.first_alerted_at
    ),
    hours_in_stage: item?.hours_in_current_stage ?? null,
    recipient_user_id: recipient.recipient_user_id,
    recipient_resolution_status: recipient.recipient_resolution_status,
    recruiter_id: owner.recruiter_id,
    recruiter_count: owner.recruiter_count,
  }
  return {
    intent,
    recruiter_ids: owner.recruiter_ids,
    candidate_id: item?.candidate_id ?? null,
    job_id: item?.job_id ?? null,
    ...recipient,
  }
}

/** P2: resolve the owning recruiter for an alerted application. Prefers the ytd_application_facts
 *  resolution (a resolved single-winner primary_recruiter_id; populated on the bulk of alerted
 *  apps); falls back to the sweep_items recruiter_name gated on its ownership_resolution_status.
 *  Returns the display name (null = honest defect, never a sentinel), the routing recruiter_id,
 *  and the owner count (>1 = shared, which P4 routes to head-of-TA as 'ambiguous'). */
function recruiterOwner(
  ytd: YtdRecruiterRow | undefined,
  item: SweepItemRow | undefined
): {
  name: string | null
  recruiter_id: number | null
  recruiter_count: number | null
  recruiter_ids: number[] | null
} {
  // OWNER LIST SOURCE, in freshness order (015). The sweep runs hourly and records the req's
  // recruiters on the same tick that raises the alert; ytd_application_facts is written once a day
  // by ytd-incremental at 06:30 UTC. Reading only the daily table meant a referral arriving after
  // 06:30 had NO owners until the next morning, so its hour-1 alert fell back to the head-of-TA —
  // measured 2026-08-07 as five of six same-day alerts unroutable.
  //
  // An EMPTY sweep list falls through to the daily table rather than being treated as "no owners".
  // Empty is indistinguishable from a filtering bug in the sweep, and stale owners route better
  // than none; a genuinely unowned req yields nothing from either source and still reaches the
  // head-of-TA. NULL means the sweep predates 015 and never recorded a list.
  const sweepIds = item?.recruiter_ids
  const recruiterIds =
    sweepIds && sweepIds.length > 0 ? sweepIds : ytd?.recruiter_ids ?? null
  const recruiterCount = recruiterIds?.length ?? null
  if (ytd && typeof ytd.primary_recruiter_id === "number") {
    return {
      name: ytd.primary_recruiter_name ?? null,
      recruiter_id: ytd.primary_recruiter_id,
      recruiter_count: recruiterCount,
      recruiter_ids: recruiterIds,
    }
  }
  // No resolved YTD owner — fall back to the sweep_items name (gated on its own status), but carry
  // no routing recruiter_id (P4 falls back to head-of-TA).
  return {
    name: resolvedOrNull(item?.recruiter_name, item?.ownership_resolution_status),
    recruiter_id: null,
    recruiter_count: recruiterCount,
    recruiter_ids: recruiterIds,
  }
}

/** Q4: map the local-state prior_submissions shape (sweep-agency.ts:531-540) onto the
 *  canonical NotificationPriorApplication the dual_agency renderer reads. The renderer
 *  surfaces source_name (the agency) and applied_at (when submitted); status /
 *  current_stage aren't shown for dual_agency, so they carry honest placeholders rather
 *  than a fabricated stage. */
function priorSubmissionsToApplications(
  submissions: PriorAgencySubmission[]
): NotificationPriorApplication[] {
  return submissions.map((s) => ({
    application_id: s.application_id ?? 0,
    job_title: s.job_title?.trim() || "",
    source_name: s.agency?.trim() || "",
    status: "submitted",
    current_stage: null,
    applied_at: s.submitted_at ?? null,
  }))
}

function buildAgencyIntentForLedger(
  ledger: LedgerRow,
  item: SweepItemRow | undefined,
  sub: AgencySubmissionRow | undefined,
  ytd?: YtdRecruiterRow
): BuiltIntent | null {
  // conflict_type tells us prior_history vs dual_agency. Prefer the agency_submissions
  // row (canonical resolved agency name + conflict_detail), fall back to the
  // sweep_items.conflict_detail (sweep-agency.ts:692-697 stores the same shape).
  const detail = sub?.conflict_detail ?? item?.conflict_detail ?? null
  const conflictType: "prior_history" | "dual_agency" | null =
    sub?.conflict_type ?? detail?.conflict_type ?? null
  if (!conflictType) return null

  const reason: NotificationReason =
    conflictType === "dual_agency" ? "dual_agency" : "prior_history"
  const notification_type: NotificationType =
    conflictType === "dual_agency" ? "agency_dual_agency" : "agency_conflict"

  const recipient = resolveRecipient()
  const candidate_name =
    item?.candidate_name?.trim() || `Candidate #${ledger.application_id}`
  const job_title =
    sub?.job_title?.trim() || item?.job_title?.trim() || `Job #${item?.job_id ?? "?"}`

  // agency_source_name NULL => unresolved defect; the render module surfaces it honestly
  // ("_agency unresolved_"), never "Unknown Agency". BUGFIX: the old gate fell through to the raw
  // agency_source_name / item.source_name when NOT resolved, leaking an unverified label. The shared
  // resolvedOrNull gate returns null on any non-'resolved' status (lib/resolution-display.ts).
  const agency_name = resolvedOrNull(
    sub?.agency_source_name,
    sub?.source_resolution_status
  )

  // P2: prefer the resolved ytd_application_facts owner; fall back to the agency_submissions
  // name, then the sweep_items name (gated on its status).
  const owner = recruiterOwner(ytd, item)
  const recruiter_owner_name =
    owner.name ||
    sub?.recruiter_name?.trim() ||
    (item?.ownership_resolution_status === "resolved"
      ? item?.recruiter_name ?? null
      : null) ||
    null

  // prior_applications is the canonical render shape (Greenhouse-history conflicts
  // store it). A dual_agency conflict detected from LOCAL state instead carries
  // prior_submissions (sweep-agency.ts:531-540, shape { application_id, agency,
  // job_title, submitted_at }). Q4: when prior_applications is absent but
  // prior_submissions is present, map it into NotificationPriorApplication so the
  // dual_agency renderer's Agency 1 / Agency 2 lines (notification-render.ts:257-265,
  // reading source_name + applied_at) actually render instead of falling through.
  const prior_applications =
    detail?.prior_applications ??
    (conflictType === "dual_agency" && detail?.prior_submissions
      ? priorSubmissionsToApplications(detail.prior_submissions)
      : [])

  const intent: NotificationIntent = {
    channel: "agency",
    notification_type,
    reason,
    application_id: ledger.application_id,
    candidate_name,
    job_title,
    agency_name,
    recruiter_owner_name,
    prior_applications,
    risk_level: detail?.risk_level ?? null,
    recipient_user_id: recipient.recipient_user_id,
    recipient_resolution_status: recipient.recipient_resolution_status,
    recruiter_id: owner.recruiter_id,
    recruiter_count: owner.recruiter_count,
  }
  return {
    intent,
    recruiter_ids: owner.recruiter_ids,
    candidate_id: item?.candidate_id ?? null,
    job_id: item?.job_id ?? null,
    ...recipient,
  }
}

/** Project a built intent into a notification_outbox insert row. The payload stores
 *  the WHOLE NotificationIntent (channel/type/reason/application_id are also promoted
 *  to columns for indexing) so the drain rebuilds it verbatim for buildNotification.
 *  `terminal` lets the enqueuer write a row already-suppressed (Q2 backfill) instead
 *  of the default 'pending' — a backfill row is born terminal so it can never be
 *  claimed and never sends. */
function intentToRow(
  built: BuiltIntent,
  terminal?: { status: OutboxStatus; suppression_reason: SuppressionReason },
  // P0 seam: P5's escalation pass passes "email"; every existing caller keeps slack_dm.
  deliveryTarget: DeliveryTarget = "slack_dm",
  // Fan-out: the one recruiter THIS row is for. Undefined in head_of_ta mode, which keeps the
  // 3-part key and the pre-fan-out behaviour byte-for-byte.
  recipientRecruiterId?: number
) {
  const { intent } = built
  return {
    dedupe_key: dedupeKey({
      channel: intent.channel,
      application_id: intent.application_id,
      reason: intent.reason,
      recipient_recruiter_id: recipientRecruiterId ?? null,
    }),
    channel: intent.channel,
    notification_type: intent.notification_type,
    reason: intent.reason,
    application_id: intent.application_id,
    candidate_id: built.candidate_id,
    job_id: built.job_id,
    recipient_user_id: built.recipient_user_id,
    recipient_resolution_status: built.recipient_resolution_status,
    delivery_target: deliveryTarget,
    // Fan-out rows override payload.recruiter_id with THIS row's owner, so the drain's existing
    // per-row lookup (loadRecipientRefresh reads payload.recruiter_id) routes each copy to its own
    // recruiter with no drain-side change. recruiter_count stays the TRUE owner count for the audit.
    payload: (recipientRecruiterId === undefined
      ? intent
      : { ...intent, recruiter_id: recipientRecruiterId }) as unknown as OutboxPayload,
    status: (terminal?.status ?? "pending") as OutboxStatus,
    suppression_reason: terminal?.suppression_reason ?? null,
  }
}

// ---------------------------------------------------------------------------
// (2) drain — claim a bounded batch via the RPC and deliver each.
// ---------------------------------------------------------------------------

export interface DrainOptions {
  limit?: number
  leaseSeconds?: number
}

export async function drain(
  limit: number = DEFAULTS.batchLimit,
  opts: DrainOptions = {}
): Promise<DrainResult> {
  const leaseSeconds = opts.leaseSeconds ?? DEFAULTS.leaseSeconds

  // Self-heal first: return any leaked 'sending' leases to 'pending' so a crashed
  // prior drain's work is reclaimable this tick (006:108). Reaping before claiming
  // means a just-reaped intent is eligible for the very next claim.
  const reaped = await reap()

  const { data: claimedData, error: claimErr } = await supabase.rpc(
    "claim_notification_outbox",
    { p_limit: limit, p_lease_seconds: leaseSeconds }
  )
  if (claimErr) throw claimErr

  const claimed = (claimedData ?? []) as OutboxRow[]
  const result: DrainResult = {
    reaped,
    claimed: claimed.length,
    sent: 0,
    failed: 0,
    suppressed: 0,
  }

  // Q3: a claimed intent whose alert_ledger row has since been resolved must NOT send
  // — the alert it speaks for is already closed. Load the resolved (application_id,
  // sweep_type) keys for this batch once, then suppress any claimed intent that hits
  // one (resolved_before_send). One query per tick, not per intent.
  const resolvedKeys = await loadResolvedLedgerKeys(claimed)
  // P4: re-resolve the slack_dm recipient at DRAIN (not frozen at enqueue) so flipping
  // NOTIFY_RECIPIENT_MODE redirects already-pending intents with no dedupe_key churn, reading the
  // directory fresh. Empty/no-op in head_of_ta mode.
  const recipientRefresh = await loadRecipientRefresh(claimed)

  for (const row of claimed) {
    const outcome = await drainOne(row, resolvedKeys, recipientRefresh)
    if (outcome === "sent") result.sent += 1
    else if (outcome === "failed") result.failed += 1
    else result.suppressed += 1
  }

  return result
}

/** P4: per-claimed-row recipient override (keyed on outbox id), computed at drain time for
 *  slack_dm intents in recruiter mode. Reads each intent's frozen recruiter_id/recruiter_count
 *  from its payload and the live directory. Returns an EMPTY map in head_of_ta mode (drainOne then
 *  uses the frozen enqueue-time recipient). A directory-read error returns empty too — a refresh
 *  blip must never block the drain; the frozen head-of-TA recipient stands. */
async function loadRecipientRefresh(
  claimed: OutboxRow[]
): Promise<Map<string, RecipientResolution>> {
  const map = new Map<string, RecipientResolution>()
  if (recipientMode() !== "recruiter") return map
  // Only FAN-OUT rows may be redirected to a recruiter. A row enqueued before routing was switched
  // on carries the 3-segment key and was built for the head-of-TA; redirecting it here would hand a
  // recruiter a pre-switch-on alert through the back door — the exact thing the enqueue-side start
  // line exists to prevent. Enqueue suppression alone does not cover this: rows already sitting
  // 'pending' at the moment of the flip were written under the old key and are claimed afterwards.
  // A fan-out key is `{channel}:{application_id}:{reason}:{recruiter_id}`. Matching on segment
  // COUNT alone is not enough: production already holds two rows keyed `...:sla_risk:test_v2` and
  // `...:sla_risk:manual_test` from a manual test in May 2026. Both are 4-segment LEGACY rows, and
  // a count check would classify them as fan-out — backwards from the safety intent. Neither is
  // claimable today (one 'sent', one terminally 'failed'; the claim RPC selects only 'pending'),
  // so there is no live exposure, but the guard must mean what it says.
  //
  // A row is fan-out only if its 4th segment is the numeric recruiter id that its own payload
  // carries. That ties the key to the row's content rather than to its shape.
  const isFanoutRow = (r: OutboxRow): boolean => {
    const parts = r.dedupe_key.split(":")
    if (parts.length !== 4) return false
    const keyed = Number(parts[3])
    return Number.isInteger(keyed) && keyed === r.payload?.recruiter_id
  }
  const slackRows = claimed.filter(
    (r) => r.delivery_target === "slack_dm" && isFanoutRow(r)
  )
  if (slackRows.length === 0) return map

  const recruiterIds = slackRows
    .map((r) => r.payload?.recruiter_id)
    .filter((id): id is number => typeof id === "number")
  let slackById: Map<number, string | null>
  try {
    slackById = await loadSlackIdsForRecruiters(recruiterIds)
  } catch (err) {
    console.error("[drain] recipient refresh failed — falling back to frozen recipients:", err)
    return map
  }

  for (const row of slackRows) {
    const recruiterId = row.payload?.recruiter_id ?? null
    const recruiterCount = row.payload?.recruiter_count ?? null
    const recruiterSlackId =
      typeof recruiterId === "number" ? slackById.get(recruiterId) ?? null : null
    map.set(row.id, resolveRecipient({ recruiterId, recruiterSlackId, recruiterCount }))
  }
  return map
}

/** The (channel:application_id) keys, within this claimed batch, whose alert_ledger
 *  row is now resolved (resolved_at is not null). A pending intent for one of these
 *  is stale: the alert closed before the drain reached it (Q3). Empty batch => no
 *  query. */
async function loadResolvedLedgerKeys(
  claimed: OutboxRow[]
): Promise<Set<string>> {
  const keys = new Set<string>()
  if (claimed.length === 0) return keys
  const appIds = [...new Set(claimed.map((r) => r.application_id))]
  const { data, error } = await supabase
    .from("alert_ledger")
    .select("application_id, sweep_type, resolved_at")
    .in("application_id", appIds)
  if (error) throw error
  for (const row of (data ?? []) as Array<{
    application_id: number
    sweep_type: NotificationChannel
    resolved_at: string | null
  }>) {
    if (row.resolved_at) keys.add(`${row.sweep_type}:${row.application_id}`)
  }
  return keys
}

type DrainOutcome = "sent" | "failed" | "suppressed"

/**
 * Deliver ONE claimed intent. Ordered so the at-least-once guarantee holds:
 *
 *   1. Recompute the gate + recipient. Suppress (no Slack call) when the channel
 *      gate is off (policy_disabled) or the recipient is unresolved
 *      (recipient_unresolved) — record a suppressed attempt + stamp the intent.
 *   2. Otherwise POST to Slack. On success, the SAME recordSentAttempt write
 *      captures provider_message_id AND stamps the intent 'sent' — so an intent
 *      that reads 'sent' always has its ts persisted; a crash before this commit
 *      leaves it 'sending', the reaper requeues it, and the next drain re-sends
 *      (the one accepted duplicate window — see file header).
 *   3. On failure: append a failed attempt and either back off to 'pending'
 *      (attempt_count < max_attempts) or terminate at 'failed'. A failed send NEVER
 *      stamps 'sent'.
 *
 * The render is PER-INTENT: buildNotification consumes one application's intent and
 * returns one message. So each attempt row covers exactly this one outbox id
 * (outbox_ids=[row.id], intent_count=1). Batching one DM across many intents is a
 * future optimization the render module does not yet expose; the schema's
 * outbox_ids[] already accommodates it without a shape change.
 */
async function drainOne(
  row: OutboxRow,
  resolvedKeys: Set<string> = new Set(),
  recipientRefresh: Map<string, RecipientResolution> = new Map()
): Promise<DrainOutcome> {
  // Rebuild the intent from the frozen payload — NEVER re-hit Greenhouse (006:39).
  const intent = payloadToIntent(row)
  const built = buildNotification(intent)

  // Q3 resolve-time suppression: the alert this intent speaks for has been resolved
  // since it was enqueued. Sending now would alert on a closed conflict. Suppress
  // (resolved_before_send), no send call. Checked FIRST and TARGET-AGNOSTIC — a resolved
  // alert needs no recipient and no gate regardless of how it would have been delivered.
  if (resolvedKeys.has(`${row.channel}:${row.application_id}`)) {
    await recordSuppressed(row, "resolved_before_send")
    return "suppressed"
  }

  switch (row.delivery_target) {
    case "slack_dm": {
      // P4: the drain-time recruiter routing override (recruiter mode), else the frozen
      // enqueue-time recipient (head-of-TA).
      const recipient = recipientRefresh.get(row.id) ?? {
        recipient_user_id: built.recipient_user_id,
        recipient_resolution_status: built.recipient_resolution_status,
      }
      return drainSlackDm(row, built, recipient)
    }
    case "email":
      return drainEmail(row, intent)
    case "dashboard_only":
    default:
      await recordSuppressed(row, "policy_disabled")
      return "suppressed"
  }
}

/** Deliver an email-target intent (P5 escalation). Gate OFF (default) suppresses with a full
 *  would-send audit row. The destination is the rec-ops mailbox (RECOPS_ESCALATION_EMAIL, read at
 *  drain time — a constant, consistent with the frozen-payload contract); a missing address is a
 *  recipient defect. On send, the SAME recordSentAttempt write captures the Resend id (as
 *  provider_message_id) and stamps the intent 'sent'. */
async function drainEmail(row: OutboxRow, intent: NotificationIntent): Promise<DrainOutcome> {
  if (!isEmailSendEnabled()) {
    await recordSuppressed(row, "policy_disabled")
    return "suppressed"
  }
  const to = readEnv("RECOPS_ESCALATION_EMAIL")?.trim()
  if (!to) {
    await recordSuppressed(row, "recipient_unresolved")
    return "suppressed"
  }
  const { subject, html } = buildEscalationEmail(intent)
  try {
    const id = await sendEmail(to, subject, html)
    await recordSentAttempt(row, to, id, { provider: "resend", metadata: { email_to: to } })
    return "sent"
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordFailedAttempt(row, to, message, { provider: "resend", metadata: { email_to: to } })
    return "failed"
  }
}

/** Deliver a slack_dm-target intent to the resolved recipient (P4: head-of-TA in head_of_ta mode,
 *  the owning recruiter — or head-of-TA fallback — in recruiter mode). */
async function drainSlackDm(
  row: OutboxRow,
  built: ReturnType<typeof buildNotification>,
  recipient: RecipientResolution
): Promise<DrainOutcome> {
  // P4 RELAXED GATE: suppress ONLY when there is no recipient id at all. The status
  // ('resolved'/'ambiguous'/'unresolved') is now an AUDIT dimension, NOT the send gate — a
  // shared-job 'ambiguous' or a 'unresolved' cold-start still carries the head-of-TA fallback id
  // and MUST send (dropping it would silently lose those alerts). Only a missing head-of-TA
  // config (null id) is a true recipient defect.
  if (!recipient.recipient_user_id) {
    await recordSuppressed(row, "recipient_unresolved")
    return "suppressed"
  }

  // Policy gate OFF (default): suppress with a full would-send audit row, no Slack.
  if (!isChannelSendEnabled(row.channel)) {
    await recordSuppressed(row, "policy_disabled")
    return "suppressed"
  }

  // Gate ON: send to the resolved recipient.
  try {
    const ts = await postSlackDm(recipient.recipient_user_id, built.text)
    await recordSentAttempt(row, recipient.recipient_user_id, ts)
    return "sent"
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordFailedAttempt(row, recipient.recipient_user_id, message)
    return "failed"
  }
}

/** Reconstruct the NotificationIntent from a claimed row. The payload holds the
 *  whole intent; we re-stamp the promoted columns onto it so a hand-seeded payload
 *  (e.g. in a test) still produces a coherent intent. */
function payloadToIntent(row: OutboxRow): NotificationIntent {
  return {
    ...row.payload,
    channel: row.channel,
    notification_type: row.notification_type,
    reason: row.reason,
    application_id: row.application_id,
    recipient_user_id: row.recipient_user_id,
    recipient_resolution_status: row.recipient_resolution_status,
  }
}

// ---------------------------------------------------------------------------
// (3) reap — return leaked 'sending' leases to 'pending'. Thin RPC wrapper.
// ---------------------------------------------------------------------------

export async function reap(): Promise<number> {
  const { data, error } = await supabase.rpc("reap_stale_notification_leases")
  if (error) throw error
  // The function returns the integer row_count of reaped leases.
  return typeof data === "number" ? data : Number(data ?? 0)
}

// ---------------------------------------------------------------------------
// Attempt recording + outbox stamping. Each path writes one append-only
// notification_delivery_attempts row, then stamps the outbox intent. Attempt-first
// so the audit trail captures the physical outcome even if the intent stamp races;
// for the 'sent' path the provider_message_id lives on the attempt row that is
// written before the intent is marked terminal (the at-least-once contract).
// ---------------------------------------------------------------------------

interface AttemptInsert {
  channel: NotificationChannel
  notification_type: NotificationType
  recipient_user_id: string | null
  delivery_target: DeliveryTarget
  status: "sent" | "failed" | "suppressed"
  provider: "slack" | "resend"
  provider_message_id: string | null
  outbox_ids: string[]
  intent_count: number
  error_message: string | null
  suppression_reason: SuppressionReason | null
  attempted_at: string
  sent_at: string | null
  metadata: Record<string, unknown>
}

async function insertAttempt(attempt: AttemptInsert): Promise<string | null> {
  const { data, error } = await supabase
    .from("notification_delivery_attempts")
    .insert(attempt)
    .select("id")
    .single()
  if (error) throw error
  return (data as { id: string } | null)?.id ?? null
}

async function recordSentAttempt(
  row: OutboxRow,
  recipientUserId: string,
  ts: string | null,
  // P5: email sends pass provider 'resend' + an email_to metadata key (slack_channel_id would
  // mislabel an email recipient). Defaults preserve the slack_dm contract byte-for-byte.
  opts: { provider?: "slack" | "resend"; metadata?: Record<string, unknown> } = {}
): Promise<void> {
  const now = new Date().toISOString()
  const attemptId = await insertAttempt({
    channel: row.channel,
    notification_type: row.notification_type,
    recipient_user_id: recipientUserId,
    delivery_target: row.delivery_target,
    status: "sent",
    provider: opts.provider ?? "slack",
    provider_message_id: ts,
    outbox_ids: [row.id],
    intent_count: 1,
    error_message: null,
    suppression_reason: null,
    attempted_at: now,
    sent_at: now,
    metadata: opts.metadata ?? { slack_channel_id: recipientUserId, batch_render: "detail" },
  })
  await stampOutbox(row.id, {
    status: "sent",
    sent_at: now,
    leased_until: null,
    last_delivery_attempt_id: attemptId,
    suppression_reason: null,
  })
}

async function recordFailedAttempt(
  row: OutboxRow,
  recipientUserId: string,
  errorMessage: string,
  opts: { provider?: "slack" | "resend"; metadata?: Record<string, unknown> } = {}
): Promise<void> {
  const now = new Date().toISOString()
  const attemptId = await insertAttempt({
    channel: row.channel,
    notification_type: row.notification_type,
    recipient_user_id: recipientUserId,
    delivery_target: row.delivery_target,
    status: "failed",
    provider: opts.provider ?? "slack",
    provider_message_id: null,
    outbox_ids: [row.id],
    intent_count: 1,
    error_message: errorMessage.slice(0, 1000),
    suppression_reason: null,
    attempted_at: now,
    sent_at: null,
    metadata: opts.metadata ?? { slack_channel_id: recipientUserId },
  })

  // attempt_count was already incremented by claim_notification_outbox (006:96).
  // Exhausted => terminal 'failed'. Else back off to 'pending' for the next tick.
  const exhausted = row.attempt_count >= (row.max_attempts ?? DEFAULTS.maxAttempts)
  if (exhausted) {
    await stampOutbox(row.id, {
      status: "failed",
      leased_until: null,
      last_delivery_attempt_id: attemptId,
    })
  } else {
    await stampOutbox(row.id, {
      status: "pending",
      leased_until: null,
      last_delivery_attempt_id: attemptId,
      next_attempt_at: backoff(row.attempt_count).toISOString(),
    })
  }
}

async function recordSuppressed(
  row: OutboxRow,
  reason: SuppressionReason
): Promise<void> {
  const now = new Date().toISOString()
  const attemptId = await insertAttempt({
    channel: row.channel,
    notification_type: row.notification_type,
    recipient_user_id: row.recipient_user_id,
    delivery_target: row.delivery_target,
    status: "suppressed",
    provider: "slack",
    provider_message_id: null,
    outbox_ids: [row.id],
    intent_count: 1,
    error_message: null,
    suppression_reason: reason,
    attempted_at: now,
    sent_at: null,
    // Full would-send audit: the recipient we WOULD have DM'd, so flipping the gate
    // is visibly retroactive.
    metadata: {
      slack_channel_id: row.recipient_user_id,
      would_send_recipient: row.recipient_user_id,
    },
  })
  await stampOutbox(row.id, {
    status: "suppressed",
    suppression_reason: reason,
    leased_until: null,
    last_delivery_attempt_id: attemptId,
  })
}

interface OutboxStamp {
  status: OutboxStatus
  sent_at?: string | null
  leased_until?: string | null
  last_delivery_attempt_id?: string | null
  suppression_reason?: SuppressionReason | null
  next_attempt_at?: string
}

async function stampOutbox(id: string, patch: OutboxStamp): Promise<void> {
  const { error } = await supabase
    .from("notification_outbox")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
  if (error) throw error
}

/** Exponential backoff with a cap: base * 2^(attemptCount-1), ceilinged. attemptCount
 *  is the post-increment value from claim_notification_outbox, so the first failure
 *  (attemptCount=1) waits base, the second 2*base, etc. */
export function backoff(
  attemptCount: number,
  baseSeconds: number = DEFAULTS.backoffBaseSeconds,
  capSeconds: number = DEFAULTS.backoffCapSeconds
): Date {
  const exp = Math.max(0, attemptCount - 1)
  const seconds = Math.min(baseSeconds * 2 ** exp, capSeconds)
  return new Date(Date.now() + seconds * 1000)
}

// ---------------------------------------------------------------------------
// Slack POST. The minimal per-intent "DM this user this text" transport the drain needs:
// open the DM channel and post the pre-rendered mrkdwn (conversations.open ->
// chat.postMessage), returning the `ts` the schema records as provider_message_id. This is
// the live Slack sender; the old batch sender (lib/slack-notify.ts) was dead and removed in P6.
// ---------------------------------------------------------------------------

function slackToken(): string {
  const token = readEnv("SLACK_BOT_TOKEN")
  if (!token) throw new Error("SLACK_BOT_TOKEN must be set")
  return token
}

async function slackCall(
  method: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as Record<string, unknown>
  if (!data.ok) {
    throw new Error(`Slack API error: ${String(data.error ?? "unknown")}`)
  }
  return data
}

/** Open a DM with the user and post the message; return chat.postMessage `ts`. */
export async function postSlackDm(
  userId: string,
  text: string
): Promise<string | null> {
  const opened = await slackCall("conversations.open", { users: userId })
  const channel = opened.channel as { id: string } | undefined
  if (!channel?.id) throw new Error("Slack conversations.open returned no channel")
  const posted = await slackCall("chat.postMessage", {
    channel: channel.id,
    text,
    mrkdwn: true,
  })
  return (posted.ts as string) ?? null
}

// ---------------------------------------------------------------------------
// (4) enqueueEscalations — P5. Email rec-ops when an alert is unresolved past a per-channel
// window. A SECOND intent through the same outbox spine (notification_type='escalation',
// reason='escalation', delivery_target='email'), so it inherits idempotency (one email per app,
// ever, on a distinct dedupe_key) and resolved_before_send suppression for free.
// ---------------------------------------------------------------------------

/** Per-channel escalation window in hours. Default referral 48h (the SLA, per the operator), agency 168h
 *  (7d). Env-overridable: NOTIFY_ESCALATION_REFERRAL_HOURS / NOTIFY_ESCALATION_AGENCY_HOURS. */
function escalationWindowHours(channel: NotificationChannel): number {
  const envKey =
    channel === "agency"
      ? "NOTIFY_ESCALATION_AGENCY_HOURS"
      : "NOTIFY_ESCALATION_REFERRAL_HOURS"
  const raw = Number(readEnv(envKey))
  if (Number.isFinite(raw) && raw > 0) return raw
  return channel === "agency" ? 168 : 48
}

/** P1 health interlock. The resolver (sweep-action-tracker.checkResolutions) runs inside the
 *  hourly referral sweep; a recent COMPLETED referral sweep_run means Greenhouse is reachable and
 *  resolutions are firing, so an unresolved alert is genuinely unactioned — not a resolver
 *  outage. If the sweep pipeline is stalled (no completed run within 2× its hourly cadence), we
 *  SKIP the whole escalation pass: a keystone outage would otherwise make every alert look
 *  unresolved and blast rec-ops with emails about candidates that may already be handled. */
async function resolverLooksHealthy(nowMs: number): Promise<boolean> {
  const { data, error } = await supabase
    .from("sweep_runs")
    .select("completed_at")
    .eq("sweep_type", "referral")
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
  if (error) return false
  const last = (data?.[0] as { completed_at: string | null } | undefined)?.completed_at
  if (!last) return false
  const ageH = (nowMs - new Date(last).getTime()) / 3_600_000
  return Number.isFinite(ageH) && ageH <= 2
}

/** Build an escalation intent directly from the hydrated rows. Unlike the alert builders this is
 *  tier-independent (an old unresolved alert may have no fresh sweep_items row), so it never
 *  returns null — every due alert escalates. Recipient is the rec-ops mailbox resolved at drain
 *  from RECOPS_ESCALATION_EMAIL, so the outbox recipient fields are vestigial here (null +
 *  'resolved'); the email drain branch ignores them. */
function buildEscalationIntent(
  ledger: LedgerRow,
  item: SweepItemRow | undefined,
  sub: AgencySubmissionRow | undefined,
  ytd: YtdRecruiterRow | undefined,
  ageHours: number
): BuiltIntent {
  const owner = recruiterOwner(ytd, item)
  const isAgency = ledger.sweep_type === "agency"
  const intent: NotificationIntent = {
    channel: ledger.sweep_type,
    notification_type: "escalation",
    reason: "escalation",
    application_id: ledger.application_id,
    candidate_name: item?.candidate_name?.trim() || `Candidate #${ledger.application_id}`,
    job_title:
      sub?.job_title?.trim() || item?.job_title?.trim() || `Job #${item?.job_id ?? "?"}`,
    recruiter_owner_name: owner.name,
    referrer_name: isAgency ? null : item?.referrer_name ?? null,
    agency_name: isAgency
      ? resolvedOrNull(sub?.agency_source_name, sub?.source_resolution_status)
      : null,
    current_stage: item?.current_stage ?? ledger.greenhouse_stage_at_alert ?? null,
    recipient_user_id: null,
    recipient_resolution_status: "resolved",
    recruiter_id: owner.recruiter_id,
    recruiter_count: owner.recruiter_count,
    escalation_age_hours: ageHours,
    // GH candidate id for the email's profile hyperlink — prefer the YTD fact (covers old alerts
    // with no fresh sweep_items row), fall back to the sweep item.
    candidate_id: ytd?.candidate_id ?? item?.candidate_id ?? null,
  }
  return {
    intent,
    // Escalation is ONE email to the rec-ops mailbox, never a per-recruiter fan-out.
    recruiter_ids: null,
    candidate_id: ytd?.candidate_id ?? item?.candidate_id ?? null,
    job_id: item?.job_id ?? null,
    recipient_user_id: null,
    recipient_resolution_status: "resolved",
  }
}

export interface EscalationResult {
  candidates: number
  inserted: number
  /** True when the P1 health interlock suppressed the whole pass (resolver looks stalled). */
  skipped_resolver_unhealthy: boolean
}

export async function enqueueEscalations(): Promise<EscalationResult> {
  const nowMs = Date.now()

  // P1 interlock — suppress the entire pass on a resolver outage (see resolverLooksHealthy).
  if (!(await resolverLooksHealthy(nowMs))) {
    console.warn(
      "[escalation] referral resolver heartbeat is stale — skipping escalation enqueue this tick"
    )
    return { candidates: 0, inserted: 0, skipped_resolver_unhealthy: true }
  }

  const ledgerRows = await scanAlertLedger()
  // Unresolved AND past the per-channel window, measured off first_alerted_at (NOT
  // last_alerted_at — the sweep bumps that hourly, which would reset the escalation clock
  // forever and nothing would ever escalate).
  const due = ledgerRows.filter((r) => {
    if (r.resolved_at || !r.first_alerted_at) return false
    const ageH = (nowMs - new Date(r.first_alerted_at).getTime()) / 3_600_000
    return Number.isFinite(ageH) && ageH >= escalationWindowHours(r.sweep_type)
  })
  if (due.length === 0) {
    return { candidates: 0, inserted: 0, skipped_resolver_unhealthy: false }
  }

  // Idempotency: one escalation per app, ever. Pre-filter on the existing escalation dedupe_keys.
  const existing = await scanAll<{
    application_id: number
    channel: NotificationChannel
    reason: NotificationReason
  }>(
    () =>
      supabase
        .from("notification_outbox")
        .select("application_id, channel, reason") as unknown as RangeableSelect<{
        application_id: number
        channel: NotificationChannel
        reason: NotificationReason
      }>
  )
  const haveOutbox = new Set(
    existing.map((r) =>
      dedupeKey({ channel: r.channel, application_id: r.application_id, reason: r.reason })
    )
  )

  const referralAppIds = due.filter((r) => r.sweep_type === "referral").map((r) => r.application_id)
  const agencyAppIds = due.filter((r) => r.sweep_type === "agency").map((r) => r.application_id)
  const sweepItemsById = await loadLatestSweepItems([...referralAppIds, ...agencyAppIds])
  const agencySubsById = await loadAgencySubmissions(agencyAppIds)
  const ytdRecruiterById = await loadYtdRecruiter([...referralAppIds, ...agencyAppIds])

  const intents: Array<ReturnType<typeof intentToRow>> = []
  const seen = new Set<string>()
  let candidates = 0
  for (const row of due) {
    const ageHours = (nowMs - new Date(row.first_alerted_at).getTime()) / 3_600_000
    const built = buildEscalationIntent(
      row,
      sweepItemsById.get(row.application_id),
      agencySubsById.get(row.application_id),
      ytdRecruiterById.get(row.application_id),
      ageHours
    )
    const key = dedupeKey({
      channel: built.intent.channel,
      application_id: built.intent.application_id,
      reason: "escalation",
    })
    if (haveOutbox.has(key) || seen.has(key)) continue
    seen.add(key)
    candidates += 1
    // Cutover suppression: a pre-cutover ledger row enqueues already-suppressed so the first
    // escalation tick never blasts the historical backlog (~20 rows already past the window).
    const predates = ledgerPredatesCutover(row.first_alerted_at)
    intents.push(
      intentToRow(
        built,
        predates
          ? { status: "suppressed", suppression_reason: "backfill_predates_log" }
          : undefined,
        "email"
      )
    )
  }
  if (intents.length === 0) {
    return { candidates, inserted: 0, skipped_resolver_unhealthy: false }
  }

  const { data: upserted, error } = await supabase
    .from("notification_outbox")
    .upsert(intents, { onConflict: "dedupe_key", ignoreDuplicates: true })
    .select("id")
  if (error) throw error
  return {
    candidates,
    inserted: (upserted ?? []).length,
    skipped_resolver_unhealthy: false,
  }
}

// ---------------------------------------------------------------------------
// drainOutbox — the single entrypoint the cron route calls: enqueue, then drain.
// Reap happens inside drain(). Kept thin so the route mirrors ytd-incremental.
// ---------------------------------------------------------------------------

export interface DrainOutboxResult {
  enqueue: EnqueueResult
  escalation: EscalationResult
  drain: DrainResult
}

export async function drainOutbox(opts?: DrainOptions): Promise<DrainOutboxResult> {
  const enqueue = await enqueuePending()
  const escalation = await enqueueEscalations()
  const drainResult = await drain(opts?.limit ?? DEFAULTS.batchLimit, opts)
  return { enqueue, escalation, drain: drainResult }
}
