import { supabase } from "@/lib/supabase"
import { SWEEP_CONFIG } from "@/lib/sweep-config"
import { loadSlackIdsForRecruiters } from "@/lib/recruiter-slack-directory"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireCronSecret,
} from "../../ytd/route-utils"

export const runtime = "nodejs"

// P4 dark-audit (CRON_SECRET-gated, read-only). Previews what recruiter-mode routing WOULD produce
// for the current slack_dm intents — WITHOUT sending and WITHOUT flipping NOTIFY_RECIPIENT_MODE.
// Review this mapping (candidate -> recruiter -> would-be Slack recipient) for accuracy before
// flipping the mode, since sends are already on to head-of-TA. Forces recruiter mode inline so it
// previews regardless of the live env.
export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  const headOfTa = SWEEP_CONFIG.slack.headOfTaUserId?.trim() || null

  const { data, error } = await supabase
    .from("notification_outbox")
    .select("application_id, channel, status, delivery_target, payload")
    .eq("delivery_target", "slack_dm")
    .range(0, 9999)
  if (error) return noStoreServerErrorJson("api/admin/recipient-audit", error)

  const rawRows = ((data ?? []) as Array<{
    application_id: number
    channel: string
    status: string
    payload: {
      candidate_name?: string | null
      recruiter_owner_name?: string | null
      recruiter_id?: number | null
      recruiter_count?: number | null
    } | null
  }>).filter((r) => r.status === "pending" || r.status === "sent")

  // The owner LIST, not the single resolved primary: fan-out emits one DM per recruiter on the
  // requisition, so the preview has to read the same source the enqueuer does
  // (ytd_application_facts.recruiter_ids). payload.recruiter_id is the pre-fan-out primary and
  // would under-report by more than half.
  const appIds = [...new Set(rawRows.map((r) => r.application_id))]
  const ownersByApp = new Map<number, number[]>()
  for (let i = 0; i < appIds.length; i += 500) {
    const { data: facts, error: factsErr } = await supabase
      .from("ytd_application_facts")
      .select("application_id, recruiter_ids")
      .in("application_id", appIds.slice(i, i + 500))
    if (factsErr) return noStoreServerErrorJson("api/admin/recipient-audit", factsErr)
    for (const f of (facts ?? []) as Array<{ application_id: number; recruiter_ids: number[] | null }>) {
      ownersByApp.set(f.application_id, f.recruiter_ids ?? [])
    }
  }

  const rows = rawRows.map((r) => ({ ...r, recruiter_ids: ownersByApp.get(r.application_id) ?? [] }))

  const recruiterIds = [...new Set(rows.flatMap((r) => r.recruiter_ids))]
  const slackById = await loadSlackIdsForRecruiters(recruiterIds)

  // Names for the owners we are about to preview. The outbox payload only names the single
  // primary, so a fan-out row for a non-primary owner would otherwise render nameless.
  const nameById = new Map<number, string>()
  if (recruiterIds.length > 0) {
    const { data: named } = await supabase
      .from("ytd_application_facts")
      .select("primary_recruiter_id, primary_recruiter_name")
      .in("primary_recruiter_id", recruiterIds)
    for (const n of (named ?? []) as Array<{ primary_recruiter_id: number | null; primary_recruiter_name: string | null }>) {
      if (typeof n.primary_recruiter_id === "number" && n.primary_recruiter_name) {
        nameById.set(n.primary_recruiter_id, n.primary_recruiter_name)
      }
    }
  }

  // FAN-OUT PREVIEW. This route previously carried its OWN copy of the recipient rule, including
  // the 'ambiguous' divert that resolveRecipient no longer has — so after fan-out shipped it
  // reported the old routing (75 to recruiters / 103 ambiguous) and actively misled the operator
  // it exists to inform. It now previews one DM per recruiter on the requisition, matching
  // enqueuePending. An audit that disagrees with the sender is worse than no audit.
  interface AuditEntry {
    application_id: number
    channel: string
    candidate: string | null
    recruiter_count: number
    recruiter: string | null
    recruiter_id: number | null
    would_recipient: string | null
    would_status: "resolved" | "unresolved"
  }

  const audit: AuditEntry[] = rows.flatMap((r): AuditEntry[] => {
    const p = r.payload ?? {}
    const ownerIds = (r.recruiter_ids ?? []).filter(
      (id): id is number => typeof id === "number"
    )
    const common = {
      application_id: r.application_id,
      channel: r.channel,
      candidate: p.candidate_name ?? null,
      recruiter_count: ownerIds.length,
    }
    // No owner on the req => the single head-of-TA row, as the enqueuer emits.
    if (ownerIds.length === 0) {
      return [{ ...common, recruiter: null, recruiter_id: null, would_recipient: headOfTa, would_status: "unresolved" }]
    }
    return ownerIds.map((recruiterId) => {
      const slackId = slackById.get(recruiterId) ?? null
      return {
        ...common,
        recruiter: nameById.get(recruiterId) ?? null,
        recruiter_id: recruiterId,
        would_recipient: slackId ?? headOfTa,
        // 'unresolved' here means a departed recruiter (directory status 'deactivated') whose
        // alert falls back to the head-of-TA and still sends.
        would_status: slackId ? "resolved" : "unresolved",
      }
    })
  })

  // COVERAGE MUST BE A LIKE-FOR-LIKE RATIO. An outbox row is (application x tier), so one candidate
  // contributes several rows — 202 rows over 106 applications here. Dividing distinct applications
  // reached by the ROW count reported 105/202 and read as 52% coverage when the true figure is
  // 105/106, or 99%. The two denominators are now named and never mixed: coverage is
  // applications-over-applications, volume is DMs.
  const applications = new Set(audit.map((a) => a.application_id))
  const applicationsReached = new Set(
    audit.filter((a) => a.would_status === "resolved").map((a) => a.application_id)
  )

  return noStoreJson({
    recipient_mode_preview: "recruiter_fanout",
    summary: {
      // Coverage — the decision number. Both sides count APPLICATIONS.
      applications: applications.size,
      applications_reaching_a_recruiter: applicationsReached.size,
      applications_reaching_nobody: applications.size - applicationsReached.size,
      coverage_pct:
        applications.size === 0
          ? null
          : Math.round((100 * applicationsReached.size) / applications.size),
      // Volume — a different denominator, deliberately named so it cannot be read as coverage.
      outbox_rows: rows.length,
      total_dms: audit.length,
      dms_to_recruiter: audit.filter((a) => a.would_status === "resolved").length,
      dms_to_head_of_ta_unresolved: audit.filter((a) => a.would_status === "unresolved").length,
      distinct_recruiters: new Set(
        audit.filter((a) => a.would_status === "resolved").map((a) => a.recruiter_id)
      ).size,
    },
    audit,
  })
}
