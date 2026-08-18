/**
 * Seed the governed recruiter roster (migration 018) from the compiled v1
 * config — idempotent upserts on (recruiter_name, team_id). The compiled
 * config remains the test fixture; after this seed, live runs read the TABLE
 * and TA-ops edits rows instead of shipping code.
 *
 * Usage: set -a; source ../ta-ops-analytics/.env.local; set +a
 *        npx tsx scripts/recruiting-ops-seed-roster.ts
 */
import { recruiterTeamHodConfigV1 } from "../lib/recruiting-ops/dimensions/config/recruiter-team-hod.v1"
import { findAmbiguousRosterNames, loadGovernedRoster } from "../lib/recruiting-ops/governed-dimensions-client"
import { getSupabase } from "../lib/supabase"

async function main() {
  const supabase = getSupabase()
  const rows = recruiterTeamHodConfigV1.map((entry) => ({
    recruiter_name: entry.recruiterName,
    team_id: entry.teamId,
    team_name: entry.teamName,
    hod_name: entry.hodName,
    active: true,
  }))
  const { error } = await supabase
    .from("recruiting_ops_recruiter_roster")
    .upsert(rows, { onConflict: "recruiter_name,team_id" })
  if (error) {
    throw new Error(`roster seed failed: ${error.message}`)
  }
  const { count, error: countError } = await supabase
    .from("recruiting_ops_recruiter_roster")
    .select("*", { count: "exact", head: true })
  if (countError) {
    throw new Error(`roster count failed: ${countError.message}`)
  }
  console.log(`[recruiting-ops seed-roster] upserted ${rows.length} compiled entries; table now holds ${count} row(s)`)

  // RECONCILE, not just add (lens finding): the upsert key is
  // (recruiter_name, team_id), so a team change in config would ADD a second
  // active row and silently flip that person to AMBIGUOUS (null attribution).
  // For names the CONFIG owns, deactivate any active row whose team is no
  // longer the configured one. Rows for names absent from config are TA-ops
  // governance edits and are never touched here.
  const configuredPairs = new Set(rows.map((row) => `${row.recruiter_name.toLowerCase()}|${row.team_id}`))
  const configuredNames = new Set(rows.map((row) => row.recruiter_name.toLowerCase()))
  const active = await loadGovernedRoster()
  const stale = active.filter(
    (entry) =>
      configuredNames.has(entry.recruiterName.toLowerCase()) &&
      !configuredPairs.has(`${entry.recruiterName.toLowerCase()}|${entry.teamId}`)
  )
  for (const entry of stale) {
    const { error: deactivateError } = await supabase
      .from("recruiting_ops_recruiter_roster")
      .update({ active: false })
      .eq("recruiter_name", entry.recruiterName)
      .eq("team_id", entry.teamId)
    if (deactivateError) {
      throw new Error(`roster reconciliation failed for a stale team row: ${deactivateError.message}`)
    }
  }
  if (stale.length > 0) {
    console.log(`[recruiting-ops seed-roster] reconciled ${stale.length} stale team assignment(s) to inactive`)
  }

  // Post-reconciliation invariant: no active name may map to multiple teams.
  const ambiguous = findAmbiguousRosterNames(await loadGovernedRoster())
  if (ambiguous.length > 0) {
    throw new Error(
      `[recruiting-ops seed-roster] ${ambiguous.length} name(s) still map to multiple active teams (${ambiguous.join(", ")}) — attribution for them would resolve as AMBIGUOUS; deactivate the stale rows.`
    )
  }
}

main().catch((error) => {
  console.error(`[recruiting-ops seed-roster] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
