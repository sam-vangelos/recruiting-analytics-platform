/**
 * Pure payload / Slack-block builder for a single notification intent (W3).
 *
 * This is the SHAPING layer of the outbox + drain-worker design (frozen W0 spec,
 * Notification domain; schema in supabase/migrations/006_notification_delivery.sql).
 * The sweep captures an INTENT; the drain claims it and calls buildNotification to
 * turn that intent into a recipient + Slack message just before posting. No I/O —
 * the drain owns the network, this module only shapes.
 *
 * Three properties this file holds:
 *   1. PURITY — no fetch, no Supabase, no env mutation, no Date.now() in the body
 *      text (timestamps arrive pre-formatted on the intent). buildNotification is a
 *      deterministic function of its argument plus the head-of-TA recipient constant.
 *   2. FORMAT FIDELITY — the `text` output mirrors lib/slack-notify.ts mrkdwn exactly
 *      (*bold*, :emoji:, bullet/dash lists, `---` separators) so a per-intent DM reads
 *      the same as today's batched alert. `blocks` carry the same content as Block Kit
 *      section blocks; `text` doubles as the notification-fallback string.
 *   3. PII DISCIPLINE — the body shows names and role only. The intent input shape
 *      carries NO email/phone field, and a defensive scrub strips any address-shaped
 *      token that leaks into a display string before it reaches the message.
 *
 * Delivery state is SEPARATE from urgency. `ALERTED` stays a sweep urgency label
 * (sweep-types.ts urgencyTier / tracker-format.ts referralTierLabel — untouched here);
 * this module owns only what a sent Slack DM says. A row can read 'Urgency: ALERTED'
 * and 'Delivery: Suppressed' at once — that divergence lives in the outbox, not here.
 *
 * Enum literals are NOT inlined here — they import from the canonical
 * lib/notification-types.ts (the single source of truth whose `as const` tuples
 * the 006 CHECK-constraint contract tests assert against) and are re-exported so
 * existing consumers importing these unions (and NotificationIntent) from this
 * module stay compatible. A CHECK-constraint edit now lands in exactly one place.
 */

import { SWEEP_CONFIG } from "./sweep-config"
import type {
  NotificationChannel,
  NotificationType,
  NotificationReason,
  RecipientResolutionStatus,
} from "./notification-types"

// Re-export the canonical unions so existing importers of these names (and of
// NotificationIntent) from notification-render keep resolving unchanged.
//   - NotificationChannel        => notification_outbox.channel CHECK
//   - NotificationType           => notification_outbox.notification_type CHECK (006:29)
//   - NotificationReason         => notification_outbox.reason vocab (006:30)
//       referral channel: 'sla_alerted' | 'sla_risk' | 'breach'
//       agency channel:   'prior_history' | 'dual_agency'
//   - RecipientResolutionStatus  => notification_outbox.recipient_resolution_status CHECK
//       'resolved' | 'unresolved' | 'ambiguous'; a NULL recipient is a DEFECT
//       surfaced via this status, never the literal "Unknown"/"UNASSIGNED".
export type {
  NotificationChannel,
  NotificationType,
  NotificationReason,
  RecipientResolutionStatus,
}

// ---------------------------------------------------------------------------
// Intent contract (input) — mirrors notification_outbox columns + the W0 spec's
// named intent fields. Display-only strings; NO raw email/phone by construction.
// ---------------------------------------------------------------------------

/** One prior Greenhouse application, for agency-conflict context. Display fields
 *  only — no candidate contact info. Mirrors PriorApplication (sweep-types.ts:97). */
export interface NotificationPriorApplication {
  application_id: number
  job_title: string
  source_name: string
  status: string
  current_stage: string | null
  applied_at: string | null
}

/**
 * The render-time intent. A denormalized snapshot the drain already holds (the
 * outbox.payload), so buildNotification never re-hits Greenhouse.
 *
 * PII rule, enforced by SHAPE: there is no email or phone field. The recruiter
 * owner and candidate are passed as display names only; the recipient is the
 * head-of-TA, addressed by Slack user id, not by email.
 */
export interface NotificationIntent {
  channel: NotificationChannel
  notification_type: NotificationType
  reason: NotificationReason
  application_id: number

  /** Candidate display name (e.g. "Jane Doe"). NEVER an email/phone. */
  candidate_name: string
  /** Role / job the candidate is in process for (e.g. "Staff Engineer"). */
  job_title: string

  /** The recruiter who owns the application — DISPLAY ONLY (this is not the
   *  recipient; the recipient is the head-of-TA). Null when ownership is a
   *  data-quality defect; rendered as an honest defect note, never "Unknown". */
  recruiter_owner_name?: string | null

  /** Referral channel: who referred the candidate (display name). */
  referrer_name?: string | null
  /** Agency channel: the submitting agency's name. Null => unresolved defect,
   *  surfaced honestly, NEVER the literal "Unknown Agency". */
  agency_name?: string | null

  /** Current pipeline stage (referral SLA framing). */
  current_stage?: string | null
  /** Pre-formatted relative time the urgency clock is measured from
   *  (e.g. "26 hours ago"). Pre-formatted because this module is pure. */
  urgency_since?: string | null
  /** Hours in the current stage, for the SLA line. */
  hours_in_stage?: number | null

  /** Agency channel: prior Greenhouse history feeding the conflict. */
  prior_applications?: NotificationPriorApplication[]
  /** Agency channel: 'high' | 'medium' | 'low' risk, when classified. */
  risk_level?: "high" | "medium" | "low" | null

  /** Optional recipient override. Defaults to the head-of-TA (today's behavior). */
  recipient_user_id?: string | null
  /** Defaults to 'resolved' (head-of-TA is always known). */
  recipient_resolution_status?: RecipientResolutionStatus

  /** Routing metadata frozen into the payload at enqueue (P2) so the drain-time recipient
   *  resolution (P4) can route to the owning recruiter without re-querying. NOT rendered, NOT
   *  part of the dedupe_key. The owning recruiter's Greenhouse user id (primary_recruiter_id),
   *  null when ownership is unresolved/ambiguous. */
  recruiter_id?: number | null
  /** Count of distinct recruiter owners on the application. >1 means shared ownership — P4
   *  routes those to head-of-TA (status 'ambiguous') rather than DMing an arbitrary owner. */
  recruiter_count?: number | null

  /** P5 escalation: hours since first_alerted_at when the escalation was enqueued, for the
   *  "no action in N hours" email framing. */
  escalation_age_hours?: number | null
  /** P5 escalation: the GH candidate id, so the email can hyperlink the candidate name to their
   *  Greenhouse profile. Null => the name renders unlinked. */
  candidate_id?: number | null
}

// ---------------------------------------------------------------------------
// Output contract — what the drain hands to postSlackDm.
// ---------------------------------------------------------------------------

/** A Block Kit section block carrying mrkdwn. The narrow subset the message uses. */
export interface SlackSectionBlock {
  type: "section"
  text: { type: "mrkdwn"; text: string }
}

/** A Block Kit divider (the Block Kit form of the `---` mrkdwn separator). */
export interface SlackDividerBlock {
  type: "divider"
}

export type SlackBlock = SlackSectionBlock | SlackDividerBlock

export interface BuiltNotification {
  /** Slack user id to DM. The head-of-TA today; NEVER an email. May be null only
   *  if a caller explicitly passes an unresolved recipient — that is a defect the
   *  drain suppresses (recipient_unresolved), it is not addressed by this module. */
  recipient_user_id: string | null
  /** Whether the recipient is a real resolved id. Mirrors the outbox column. */
  recipient_resolution_status: RecipientResolutionStatus
  /** mrkdwn message text — mirrors lib/slack-notify.ts exactly. Doubles as the
   *  notification-fallback string for the Block Kit `blocks`. */
  text: string
  /** Block Kit blocks carrying the same content as `text`. */
  blocks: SlackBlock[]
  /** Idempotency key: '{channel}:{application_id}:{reason}' (006:26 / spec). */
  dedupe_key: string
}

// ---------------------------------------------------------------------------
// PII scrub — defensive belt-and-suspenders. The intent shape already excludes
// email/phone; this guarantees that even a mis-populated display string cannot
// leak an address into the message body.
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// Phone: 7+ run of digits allowing spaces, dashes, dots, parens, leading +.
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g

/** Strip email/phone-shaped tokens from a display string. Names and roles never
 *  match these patterns; the scrub only fires on leaked contact info. */
function scrubPii(value: string): string {
  return value.replace(EMAIL_RE, "[redacted]").replace(PHONE_RE, "[redacted]")
}

/** Coerce a display value to a safe, scrubbed string, or null when absent. */
function display(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return scrubPii(trimmed)
}

// ---------------------------------------------------------------------------
// Risk-level rendering — mirrors slack-notify.ts:199-204 emoji vocabulary.
// ---------------------------------------------------------------------------

function riskLabel(risk: "high" | "medium" | "low"): string {
  switch (risk) {
    case "high":
      return ":red_circle: HIGH"
    case "medium":
      return ":large_orange_circle: MEDIUM"
    case "low":
      return ":large_green_circle: LOW"
  }
}

// ---------------------------------------------------------------------------
// Body builders — one per channel. Each returns the ordered mrkdwn lines that
// both the `text` join and the section-block split consume, so the two outputs
// can never drift.
// ---------------------------------------------------------------------------

function referralLines(intent: NotificationIntent): string[] {
  const candidate = display(intent.candidate_name) ?? "(name unavailable)"
  const role = display(intent.job_title) ?? "(role unavailable)"
  const lines: string[] = []

  const heading =
    intent.reason === "breach"
      ? ":rotating_light: *Referral SLA Breach*"
      : intent.reason === "sla_risk"
        ? ":warning: *Referral Approaching SLA*"
        : "*Employee Referral — please action within 48h*"
  lines.push(heading)

  // Candidate and requisition are separate labelled lines (the operator's spec). The old form packed
  // them into one "Candidate: name → role" line, which reads as a single fact rather than the
  // two the recruiter acts on.
  lines.push(`*Candidate:* ${candidate}`)
  lines.push(`*Requisition:* ${role}`)

  // Referrer null => the /referrers join found no name for this application's referrer_id. Carry
  // the defect honestly rather than dropping the line, so an empty referrer is visible as a data
  // gap instead of silently looking like a referral nobody made. (Before the v3 /referrers join
  // landed this was null on every row — see sweep-referral.deriveReferrerName.)
  const referrer = display(intent.referrer_name)
  lines.push(referrer ? `*Referrer:* ${referrer}` : "*Referrer:* _not resolved_")

  const since = display(intent.urgency_since)
  if (since) lines.push(`*Submitted:* ${since}`)

  // STAGE and RECRUITER lines removed per the 2026-08-06 decision. Stage is invariably "Application
  // Review" (urgencyTier only classifies in-review items as alertable — sweep-types.ts:79), and
  // the recruiter is the DM's recipient once NOTIFY_RECIPIENT_MODE=recruiter, so naming them in
  // the body told them something they already knew. Both fields still ride the intent payload
  // for the dashboard and the recipient-audit route; only the Slack body drops them.

  if (intent.reason === "breach" || intent.reason === "sla_risk") {
    lines.push(
      intent.reason === "breach"
        ? "*Action required:* Past the 48h referral SLA — review now."
        : "*Action required:* Approaching the 48h referral SLA."
    )
  }

  return lines
}

function agencyLines(intent: NotificationIntent): string[] {
  const candidate = display(intent.candidate_name) ?? "(name unavailable)"
  const role = display(intent.job_title) ?? "(role unavailable)"
  const lines: string[] = []

  if (intent.notification_type === "agency_dual_agency") {
    lines.push("*Dual Agency Submission Detected*")
    lines.push(`*Candidate:* ${candidate}`)
    const priors = intent.prior_applications ?? []
    if (priors.length >= 2) {
      const [a1, a2] = priors
      lines.push(
        `*Agency 1:* ${display(a1.source_name) ?? "(agency unresolved)"} — submitted ${a1.applied_at ?? "unknown"}`
      )
      lines.push(
        `*Agency 2:* ${display(a2.source_name) ?? "(agency unresolved)"} — submitted ${a2.applied_at ?? "unknown"}`
      )
    }
    lines.push(
      "*Action required:* Determine which agency (if either) has claim priority."
    )
    return lines
  }

  // prior_history / agency_conflict
  lines.push("*Agency Submission Conflict Detected*")
  lines.push(`*Candidate:* ${candidate}`)

  // Agency name null => unresolved defect, surfaced honestly, never "Unknown Agency".
  const agency = display(intent.agency_name)
  lines.push(
    agency
      ? `*Submitted by:* ${agency} → ${role}`
      : `*Submitted by:* _agency unresolved_ → ${role}`
  )

  const owner = display(intent.recruiter_owner_name)
  if (owner) lines.push(`*Recruiter:* ${owner}`)

  const priors = intent.prior_applications ?? []
  if (priors.length > 0) {
    lines.push("")
    lines.push("*Prior history in Greenhouse:*")
    for (const prior of priors) {
      const status = prior.status === "rejected" ? "Rejected" : prior.status
      lines.push(
        `- Application #${prior.application_id} — ${prior.current_stage ?? "Unknown"} — ${status} ${prior.applied_at ?? ""}`.trimEnd()
      )
    }
  }

  if (intent.risk_level) {
    lines.push("")
    lines.push(`*Risk:* ${riskLabel(intent.risk_level)}`)
  }

  return lines
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** '{channel}:{application_id}:{reason}' — matches notification_outbox.dedupe_key
 *  (006:26) and the spec's build*Intents contract. Exported so the outbox writer
 *  and the renderer derive the same key from the same rule.
 *
 *  FAN-OUT (operator decision 2026-08-06): a referral landing on a requisition is news for EVERY recruiter on
 *  that req's hiring team, so recruiter mode emits one outbox row per recruiter. Those rows share
 *  (channel, application_id, reason) and would collide on a 3-part key, so the recipient's
 *  Greenhouse user id becomes a 4th segment. This is what makes each recipient's delivery
 *  INDEPENDENTLY idempotent: if 2 of 3 sends succeed and the third fails, only the third retries.
 *  A single shared row looping over recipients could not offer that — the retry would re-DM the
 *  two who already received it.
 *
 *  Keyed on the GREENHOUSE user id, not the Slack id: the Greenhouse id is known at enqueue and is
 *  stable, whereas the Slack id is resolved at drain (P4) and would change the key if a recruiter's
 *  Slack account were ever re-resolved. */
export function dedupeKey(intent: {
  channel: NotificationChannel
  application_id: number
  reason: NotificationReason
  /** Omitted in head_of_ta mode (one row, 3-part key, unchanged from before fan-out). */
  recipient_recruiter_id?: number | null
}): string {
  const base = `${intent.channel}:${intent.application_id}:${intent.reason}`
  return typeof intent.recipient_recruiter_id === "number"
    ? `${base}:${intent.recipient_recruiter_id}`
    : base
}

/**
 * Shape a notification intent into a recipient + Slack message. PURE — no I/O.
 *
 * Recipient defaults to the head-of-TA (today's behavior; SWEEP_CONFIG.slack
 * .headOfTaUserId). An explicit unresolved recipient is preserved with its
 * resolution status so the drain can suppress it (recipient_unresolved) rather
 * than this module fabricating one.
 *
 * The `text` output mirrors lib/slack-notify.ts mrkdwn; `blocks` carry the same
 * content as Block Kit sections (blank lines split sections; `---` becomes a
 * divider). Names and role only — no email/phone reaches the body.
 */
export function buildNotification(intent: NotificationIntent): BuiltNotification {
  const lines =
    intent.channel === "agency" ? agencyLines(intent) : referralLines(intent)

  const text = lines.join("\n")
  const blocks = linesToBlocks(lines)

  const recipientGiven =
    intent.recipient_user_id !== undefined
      ? display(intent.recipient_user_id)
      : SWEEP_CONFIG.slack.headOfTaUserId

  // Recipient is a Slack user id, addressed by id — never an email. If a caller
  // passes one explicitly, honor the status they assert; otherwise the head-of-TA
  // constant is, by definition, resolved.
  const recipient_user_id =
    recipientGiven === undefined ? null : recipientGiven
  const recipient_resolution_status: RecipientResolutionStatus =
    intent.recipient_resolution_status ??
    (recipient_user_id ? "resolved" : "unresolved")

  return {
    recipient_user_id,
    recipient_resolution_status,
    text,
    blocks,
    dedupe_key: dedupeKey(intent),
  }
}

/** HTML-escape a display string (already PII-scrubbed by display()). */
function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * P5: shape an escalation intent into a rec-ops email (subject + html). PURE, like
 * buildNotification — the drain owns the network. Names and role only; display() PII-scrub +
 * esc() HTML-escape on every field. The body states the candidate has had no action recorded in
 * N hours and names the owning recruiter (who was already alerted in Slack), so rec-ops has the
 * context to chase it.
 */
export function buildEscalationEmail(intent: NotificationIntent): {
  subject: string
  html: string
} {
  const candidate = display(intent.candidate_name) ?? "this candidate"
  const role = display(intent.job_title) ?? "(role unavailable)"
  const owner = display(intent.recruiter_owner_name)
  const referrer = display(intent.referrer_name)
  const agency = display(intent.agency_name)
  const stage = display(intent.current_stage)
  const isAgency = intent.channel === "agency"
  const channelWord = isAgency ? "agency" : "referral"
  const ageH = intent.escalation_age_hours
  const ageStr =
    typeof ageH === "number" && Number.isFinite(ageH) ? `${Math.round(ageH)} hours` : "48 hours"

  // Candidate name hyperlinked to their Greenhouse profile (app.greenhouse.io routes by login, so
  // no org subdomain is needed). Falls back to bold text when the candidate id is unknown.
  const candidateUrl =
    typeof intent.candidate_id === "number"
      ? `https://app.greenhouse.io/people/${intent.candidate_id}`
      : null
  const candidateLink = candidateUrl
    ? `<a href="${candidateUrl}" style="color:#2563eb;font-weight:600;text-decoration:none">${esc(candidate)}</a>`
    : `<strong>${esc(candidate)}</strong>`

  const subject = `[ACTION REQUIRED] New ${channelWord} candidate in need of review: ${candidate}`

  // How the candidate entered, and the per-channel ask.
  const sourceClause = isAgency
    ? agency
      ? `submitted by <strong>${esc(agency)}</strong>`
      : "submitted by an agency"
    : referrer
      ? `referred by <strong>${esc(referrer)}</strong>`
      : "referred by a colleague"
  const ask = isAgency
    ? "Please check whether this candidate already exists in Greenhouse before proceeding, to avoid undue agency spend."
    : "Please review promptly so we’re providing the best possible experience to both the referrer and the candidate."

  const td = `style="padding:4px 14px 4px 0;color:#71717a;white-space:nowrap"`
  const tdv = `style="padding:4px 0;color:#18181b"`
  const rows = [
    `<tr><td ${td}>Role</td><td ${tdv}>${esc(role)}</td></tr>`,
    stage ? `<tr><td ${td}>Stage</td><td ${tdv}>${esc(stage)}</td></tr>` : "",
    `<tr><td ${td}>Owning recruiter</td><td ${tdv}>${owner ? esc(owner) : "<em>not resolved</em>"}</td></tr>`,
    `<tr><td ${td}>Awaiting review</td><td ${tdv}>${esc(ageStr)}</td></tr>`,
  ]
    .filter(Boolean)
    .join("")

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;color:#18181b;line-height:1.55;max-width:560px">
  <p style="margin:0 0 16px">Hi there,</p>
  <p style="margin:0 0 16px">${candidateLink} was ${sourceClause}, and the ${channelWord} has been awaiting review for ${esc(ageStr)}.</p>
  <p style="margin:0 0 18px">${ask}</p>
  <table style="border-collapse:collapse;font-size:14px;margin:0 0 22px">${rows}</table>
  <p style="margin:0 0 2px">Thanks,</p>
  <p style="margin:0;color:#52525b;font-size:13px">TA Ops — automated escalation</p>
</div>`

  return { subject, html }
}

/**
 * Split ordered mrkdwn lines into Block Kit blocks. A blank line ends the current
 * section (so prior-history / risk read as their own block); a lone "---" line
 * becomes a divider (the Block Kit form of the mrkdwn separator slack-notify.ts
 * uses between agency conflicts). Mirrors the text layout 1:1 so the two outputs
 * never diverge.
 */
function linesToBlocks(lines: string[]): SlackBlock[] {
  const blocks: SlackBlock[] = []
  let buffer: string[] = []

  const flush = () => {
    if (buffer.length === 0) return
    const joined = buffer.join("\n").trim()
    if (joined) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: joined } })
    }
    buffer = []
  }

  for (const line of lines) {
    if (line.trim() === "---") {
      flush()
      blocks.push({ type: "divider" })
      continue
    }
    if (line.trim() === "") {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()

  return blocks
}
