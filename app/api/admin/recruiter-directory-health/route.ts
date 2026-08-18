import { supabase } from "@/lib/supabase"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireCronSecret,
} from "../../ytd/route-utils"

export const runtime = "nodejs"

// P3 directory coverage (CRON_SECRET-gated, read-only). Confirms the recruiter->slack directory is
// populated and surfaces whether the bot scope is blocking it — the gate to check before flipping
// NOTIFY_RECIPIENT_MODE=recruiter.
export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  const { data: dir, error } = await supabase
    .from("recruiter_slack_directory")
    .select("greenhouse_user_id, resolution_status")
    .range(0, 9999)
  if (error) return noStoreServerErrorJson("api/admin/recruiter-directory-health", error)

  // Distinct fact owners (the recipients we want covered).
  const owners = new Set<number>()
  for (let from = 0; ; from += 1000) {
    const { data, error: e2 } = await supabase
      .from("ytd_application_facts")
      .select("primary_recruiter_id")
      .not("primary_recruiter_id", "is", null)
      .range(from, from + 999)
    if (e2) return noStoreServerErrorJson("api/admin/recruiter-directory-health", e2)
    const rows = (data ?? []) as Array<{ primary_recruiter_id: number | null }>
    for (const r of rows) if (typeof r.primary_recruiter_id === "number") owners.add(r.primary_recruiter_id)
    if (rows.length < 1000) break
  }

  const rows = (dir ?? []) as Array<{ greenhouse_user_id: number; resolution_status: string }>
  const byStatus: Record<string, number> = {}
  const resolvedIds = new Set<number>()
  for (const r of rows) {
    byStatus[r.resolution_status] = (byStatus[r.resolution_status] ?? 0) + 1
    if (r.resolution_status === "resolved") resolvedIds.add(r.greenhouse_user_id)
  }
  const ownersResolved = [...owners].filter((id) => resolvedIds.has(id)).length

  return noStoreJson({
    directory_size: rows.length,
    by_status: byStatus,
    scope_blocked: (byStatus["scope_blocked"] ?? 0) > 0,
    fact_owners: owners.size,
    fact_owners_resolved: ownersResolved,
    fact_owners_unresolved: owners.size - ownersResolved,
  })
}
