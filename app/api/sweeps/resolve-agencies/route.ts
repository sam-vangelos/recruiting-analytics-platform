// app/api/sweeps/resolve-agencies/route.ts — W1 bootstrap route (GREENFIELD, frozen-spec:468/488).
//
// The dead-route throw both lib/sweep-agency.ts:96 and lib/ytd-extract.ts:91 already point an
// operator at ("No agency sources in registry. Run /api/sweeps/resolve-agencies first."). Until
// this exists, an empty registry is unrecoverable: the agency sweep and the YTD agency extract
// both hard-fail at their first read.
//
// POST drives lib/agency-resolver.bootstrapAgencySources (frozen-spec:448): list /sources, keep
// only the ones whose type.id === AGENCY_SOURCE_TYPE_ID (4000007004 = 'Agencies', live-verified),
// resolve each to an AgencySourceResolution, and seed BOTH durable tables —
//   * agency_source_resolution — the evidence companion (005:92-108): full status/confidence/
//     evidence_types, agency_name NULL (NEVER 'Unknown Agency') when status !== 'resolved'.
//   * agency_source_registry  — the thin id->name cache (001:60-65) that sweep-agency.ts:89-102
//     and ytd-extract.ts:79-94 read. Seeded ONLY from resolved rows: an unresolved source has a
//     NULL agency_name and source_name (text NOT NULL) can be NULL, so it cannot become a
//     registry row — the registry is the resolved-identity cache, the resolution table carries
//     the defects.
//
// Resolver I/O lives here (the resolver's deps seam, frozen-spec:448): the route owns the
// Greenhouse fetch and the Supabase writes; the resolver owns filtering + the per-source rung
// ladder. Forward-only by the locked W1 defaults — a re-run upserts on source_id (idempotent),
// it does not rewrite history. Guarded by requireCronSecret; the cron/identity-reconcile route
// re-runs the same bootstrap daily so new agencies self-heal (frozen-spec:469).

import { bootstrapAgencySources } from "@/lib/agency-resolver"
import { readEnv } from "@/lib/env"
import type { AgencySourceResolution } from "@/lib/resolution-types"
import { greenhouseGetAll } from "@/lib/greenhouse-client"
import { supabase } from "@/lib/supabase"
import type { GHSource } from "@/lib/sweep-types"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireCronSecret,
} from "../../ytd/route-utils"

// Node runtime: the resolver fans out Greenhouse REST calls (token refresh, cursor pagination,
// 429 retry) and writes Supabase via the service-role client — none of which run on the edge.
export const runtime = "nodejs"
// One full /sources page + the dual-table seed is well under a minute, but a token refresh +
// 429 backoff can stretch it; mirror cron/sweep-agency.ts:6 rather than the 300s sync routes.
export const maxDuration = 120

// Supabase upsert batch cap, mirroring lib/ytd-extract.ts:336. /sources returns ~tens of agency
// rows so this never chunks in practice; kept for parity with the rest of the persist layer.
const UPSERT_BATCH_SIZE = 500

function chunk<T>(rows: T[], size = UPSERT_BATCH_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/**
 * The resolver's `upsert` dependency (frozen-spec:448). Receives every resolved/unresolved
 * AgencySourceResolution the resolver produced and persists it to BOTH durable tables, then
 * returns the count of seeded registry rows so the route can report registry_rows truthfully.
 *
 * agency_source_resolution gets every row (resolved AND defect). agency_source_registry gets
 * only rows that resolved to a concrete (source_id, source_name) — the registry's source_name
 * is NOT NULL (001:62), so an unresolved source with a NULL name is intentionally excluded
 * rather than backfilled with a sentinel (canon: a defect is status+evidence, never 'Unknown').
 */
async function seedResolutionsAndRegistry(
  resolutions: AgencySourceResolution[]
): Promise<number> {
  const nowIso = new Date().toISOString()

  const resolutionRows = resolutions.map((r) => ({
    source_id: r.source_id,
    source_name: r.source_name,
    source_type_id: r.source_type_id,
    source_type_name: r.source_type_name,
    agency_name: r.agency_name,
    agency_account_id: r.agency_account_id,
    agency_user_ids: r.agency_user_ids,
    active: r.active,
    confidence: r.confidence,
    resolution_status: r.status,
    evidence_types: r.evidence_types,
    evidence_detail: r.evidence_detail,
    last_verified_at: nowIso,
  }))

  for (const batch of chunk(resolutionRows)) {
    if (batch.length === 0) continue
    const { error } = await supabase
      .from("agency_source_resolution")
      .upsert(batch, { onConflict: "source_id" })
    if (error) {
      throw new Error(`Failed to upsert agency_source_resolution: ${error.message}`)
    }
  }

  // Registry is the resolved-identity cache only: a row needs a concrete id + name. type-narrow
  // so the registry payload carries non-null source_id/source_name (registry columns are NOT NULL).
  const registryRows = resolutions
    .filter(
      (r): r is AgencySourceResolution & { source_id: number; source_name: string } =>
        r.status === "resolved" && r.source_id != null && r.source_name != null
    )
    .map((r) => ({
      source_id: r.source_id,
      source_name: r.source_name,
      source_type: r.source_type_name,
      last_verified_at: nowIso,
    }))

  let seeded = 0
  for (const batch of chunk(registryRows)) {
    if (batch.length === 0) continue
    const { error } = await supabase
      .from("agency_source_registry")
      .upsert(batch, { onConflict: "source_id" })
    if (error) {
      throw new Error(`Failed to seed agency_source_registry: ${error.message}`)
    }
    seeded += batch.length
  }
  return seeded
}

export async function POST(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  // Activation gate (default OFF). The whole handler writes the migration-005 table
  // agency_source_resolution (seedResolutionsAndRegistry:82-84) BEFORE it seeds the pre-005
  // agency_source_registry (:107-109), via the resolver's single upsert seam — the two tables
  // are seeded by one indivisible callback, so the cold-start registry seed cannot run without
  // the 005 write. Pre-005 that write errors; gate the entire handler until the identity
  // migrations are activated, returning an honest 200-skip rather than a 500. Mirrors the
  // repo's writeback-flag idiom (lib/sweep-writeback.ts:30, lib/ytd-extract.ts:814).
  if (readEnv("IDENTITY_RECONCILE_ENABLED")?.toLowerCase() !== "true") {
    return noStoreJson({ skipped: true, reason: "identity migrations not activated" })
  }

  try {
    let registryRows = 0

    // The resolver owns the type.id===AGENCY_SOURCE_TYPE_ID filter and the rung ladder; the route
    // supplies its two I/O seams (frozen-spec:448). `upsert` returns the registry-row count, which
    // bubbles out here for the response.
    const { agencies, sourceIds } = await bootstrapAgencySources({
      listSources: (params) => greenhouseGetAll<GHSource>("/sources", params),
      upsert: async (resolutions: AgencySourceResolution[]) => {
        registryRows = await seedResolutionsAndRegistry(resolutions)
        return registryRows
      },
    })

    return noStoreJson({
      sources_scanned: sourceIds.length,
      agencies_resolved: agencies,
      registry_rows: registryRows,
    })
  } catch (err) {
    return noStoreServerErrorJson("api/sweeps/resolve-agencies", err)
  }
}
