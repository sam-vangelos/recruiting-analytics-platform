// SWEEP 005 WRITEBACK GATE — the operational-plane sibling of the YTD gate
// (ytd-extract.ts projectFactsForWriteback). Both sweeps persist migration-005 columns to
// sweep_items / agency_submissions. Against a PRE-005 DB an insert that references those columns is
// rejected by PostgREST and the WHOLE sweep batch fails. Unlike the YTD writeback, the sweeps run
// on the cron schedule (vercel.json: sweep-referral hourly, sweep-agency every 4h), so an ungated
// writeback is a live-on-deploy hazard, not a dormant one. Default OFF strips the 005 columns so the
// insert is legal pre-005; flip SWEEP_OWNERSHIP_WRITEBACK=true only AFTER 005 is applied. Mirrors the
// YTD_OWNERSHIP_WRITEBACK / NOTIFY_*_SEND dormant-by-default idiom.

import { readEnv } from "./env"

// The 005-only columns per operational table (migration 005:120-132). NOTE: sweep_items.recruiter_name
// and referrer_name are 002 columns (002:27-29), NOT 005, so they are never stripped — but on
// agency_submissions, recruiter_name IS a 005 column (005:130), hence the two distinct lists.
export const SWEEP_ITEMS_005_COLUMNS = [
  "recruiter_id",
  "referrer_id",
  "ownership_confidence",
  "ownership_resolution_status",
] as const

export const AGENCY_SUBMISSIONS_005_COLUMNS = [
  "source_resolution_status",
  "recruiter_id",
  "recruiter_name",
  "ownership_resolution_status",
] as const

export function isSweepOwnershipWritebackEnabled(): boolean {
  return readEnv("SWEEP_OWNERSHIP_WRITEBACK")?.toLowerCase() === "true"
}

// Strip the listed 005 columns from a row when the writeback is OFF; pass the row through unchanged
// when ON. Pure and returns a fresh object — never mutates the input. Unit-tested in
// test/sweep-writeback-gate.test.ts. (The agency_submissions NOT-NULL legacy fallback for
// agency_source_id/name lives inline at the sweep-agency push, because it needs the raw GH source.)
export function gateSweepRow(
  row: Record<string, unknown>,
  ownership005Columns: readonly string[],
  ownershipWriteback: boolean
): Record<string, unknown> {
  if (ownershipWriteback) return row
  const out = { ...row }
  for (const col of ownership005Columns) delete out[col]
  return out
}
