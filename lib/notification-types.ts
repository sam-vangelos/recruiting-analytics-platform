/**
 * Canonical notification-domain vocabularies (W3 / H2 contract target).
 *
 * Single source of truth for the string-literal enums that the
 * supabase/migrations/006_notification_delivery.sql CHECK constraints enforce.
 * notification-render.ts and notification-delivery.ts both inlined these unions
 * before this module existed; the W3 review flagged the missing canonical home.
 * They now import from here so a CHECK-constraint edit lands in exactly one place.
 *
 * EACH export is a frozen `as const` tuple PLUS a derived string-literal type:
 *   - the tuple is the runtime artifact (contract tests assert it equals the DB
 *     CHECK vocabulary, exhaustiveness loops, Zod-style membership checks);
 *   - the type is the compile-time artifact the rest of the codebase consumes.
 *
 * Mirrored VERBATIM against 006. Source columns:
 *   - NotificationChannel        => notification_outbox.channel CHECK
 *   - NotificationType           => notification_outbox.notification_type CHECK
 *   - NotificationReason         => notification_outbox.reason (documented vocab)
 *   - OutboxStatus               => notification_outbox.status CHECK
 *   - SuppressionReason          => notification_outbox.suppression_reason CHECK
 *   - RecipientResolutionStatus  => notification_outbox.recipient_resolution_status CHECK
 *
 * Canon: a NULL recipient_user_id is a data-quality DEFECT surfaced via
 * recipient_resolution_status ('unresolved' / 'ambiguous'), never the literal
 * "Unknown"/"UNASSIGNED".
 */

/** notification_outbox.channel CHECK (channel in ('referral','agency')). */
export const NOTIFICATION_CHANNELS = ["referral", "agency"] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

/**
 * notification_outbox.notification_type CHECK
 *   (notification_type in ('referral_alert','agency_conflict','agency_dual_agency','escalation')).
 */
export const NOTIFICATION_TYPES = [
  "referral_alert",
  "agency_conflict",
  "agency_dual_agency",
  "escalation",
] as const
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

/**
 * notification_outbox.reason vocabulary (006:30). Drives the dedupe_key suffix
 * and the message framing.
 *   referral channel: 'sla_alerted' | 'sla_risk' | 'breach'
 *   agency channel:   'prior_history' | 'dual_agency'
 */
export const NOTIFICATION_REASONS = [
  "sla_alerted",
  "sla_risk",
  "breach",
  "prior_history",
  "dual_agency",
  // P5: email escalation. Added to the reason CHECK by migration 008 (006 is immutable). Gives
  // the escalation intent a distinct dedupe_key suffix ({channel}:{app}:escalation) so it never
  // collides with the original alert intent.
  "escalation",
] as const
export type NotificationReason = (typeof NOTIFICATION_REASONS)[number]

/**
 * notification_outbox.status CHECK
 *   (status in ('pending','sending','sent','failed','suppressed')).
 */
export const OUTBOX_STATUSES = [
  "pending",
  "sending",
  "sent",
  "failed",
  "suppressed",
] as const
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number]

/**
 * notification_outbox.suppression_reason CHECK
 *   (suppression_reason in
 *     ('policy_disabled','recipient_unresolved','resolved_before_send',
 *      'duplicate_window','backfill_predates_log')).
 */
export const SUPPRESSION_REASONS = [
  "policy_disabled",
  "recipient_unresolved",
  "resolved_before_send",
  "duplicate_window",
  "backfill_predates_log",
] as const
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

/**
 * notification_outbox.recipient_resolution_status CHECK
 *   (recipient_resolution_status in ('resolved','unresolved','ambiguous')).
 * NULL recipient_user_id => 'unresolved'/'ambiguous' defect, never a label.
 */
export const RECIPIENT_RESOLUTION_STATUSES = [
  "resolved",
  "unresolved",
  "ambiguous",
] as const
export type RecipientResolutionStatus =
  (typeof RECIPIENT_RESOLUTION_STATUSES)[number]
