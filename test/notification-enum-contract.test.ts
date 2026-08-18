// W3 — notification enum CONTRACT test.
//
// WHAT THIS TESTS, AND WHY IT IS SHAPED THIS WAY
// ----------------------------------------------
// lib/notification-types.ts is the single source of truth for the string-literal
// vocabularies the supabase/migrations/006_notification_delivery.sql CHECK constraints
// enforce (its header: "Mirrored VERBATIM against 006"). "Mirrored verbatim" is a claim
// no compiler checks — the TS tuple and the SQL CHECK live in two files with no shared
// artifact, so they can silently drift the moment someone edits one and not the other.
// A drift is not cosmetic: notification-delivery.ts writes these exact strings into the
// guarded columns, so a TS value the SQL CHECK rejects is a runtime insert failure on
// the drain's critical path, and a SQL value missing from the TS union is a vocabulary
// the type system will never let the code produce.
//
// This test makes the claim mechanical. It reads 006 as text, parses each column's
// vocabulary out of its CHECK (`column in ('a','b',...)`) — including `reason`, which
// now carries a real CHECK (a prior revision left it free text with the set in a `-- ...`
// comment; W3 hardening replaced the comment-only vocab with an enforced constraint so a
// rejected reason fails at write, not silently) — and asserts the matching
// notification-types.ts tuple is the SAME SET. Order-insensitive: the migration and the
// tuple are both unordered enumerations of a domain, so we compare as sorted sets, and a
// failure prints the missing/extra members on each side.
//
// Parsing the SQL (not hardcoding the expected set) is deliberate: a hardcoded copy here
// would itself be a third place to drift. The migration file IS the contract; this test
// binds the TS tuples to it directly.

import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, test } from "vitest"

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  NOTIFICATION_REASONS,
  OUTBOX_STATUSES,
  SUPPRESSION_REASONS,
  RECIPIENT_RESOLUTION_STATUSES,
} from "../lib/notification-types"

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, "..", "supabase", "migrations")
// Read the EFFECTIVE vocabulary, not just 006's. 006 is immutable (applied in prod); later
// migrations carry additive ALTERs (008 widens the reason CHECK to include 'escalation'). The
// effective constraint is the LAST one defined across migrations in order, so we concatenate
// 006 then any follow-on deltas and checkSet() takes the final `<column> in (...)` per column.
// This binds the TS tuples to what the DB actually enforces without editing the applied 006 text.
const MIGRATION_FILES = [
  "006_notification_delivery.sql",
  "008_escalation_reason.sql",
].filter((f) => existsSync(join(migrationsDir, f)))
const sql = MIGRATION_FILES.map((f) =>
  readFileSync(join(migrationsDir, f), "utf8")
).join("\n")

// ---------------------------------------------------------------------------
// Parsers. Each pulls a set of single-quoted literals out of the migration text.
// ---------------------------------------------------------------------------

/** Pull every 'single-quoted' literal out of a fragment (the body of an `in (...)`). */
function literals(fragment: string): string[] {
  return [...fragment.matchAll(/'([^']*)'/g)].map((m) => m[1])
}

/**
 * Extract a CHECK vocabulary for `notification_outbox.<column>` of the form
 *   <column> in ('a','b',...)
 * The migration writes some CHECKs inline with the column (`check (col in (...))`)
 * and one (notification_type) on its own continuation line; matching on the column
 * name + ` in (` and reading to the closing paren handles both. Whitespace/newlines
 * inside the parens are tolerated.
 */
function checkSet(column: string): string[] {
  // Match `<column> in (` then capture up to the first `)`. The leading (^|[^_a-z])
  // is a left word-boundary so `status` does NOT match the tail of
  // `recipient_resolution_status` (which appears earlier in the file).
  const re = new RegExp(`(?:^|[^_a-zA-Z])${column}\\s+in\\s*\\(([^)]*)\\)`, "gi")
  const matches = [...sql.matchAll(re)]
  if (matches.length === 0) throw new Error(`no CHECK 'in (...)' found for column ${column}`)
  // Default: the FIRST match — 006's notification_outbox inline CHECK (the same one the original
  // single-file test read; correct even when a column name recurs, e.g. `status` also appears on
  // notification_delivery_attempts later in 006). EXCEPTION: `reason` is widened by a later
  // migration's ALTER ... ADD CONSTRAINT (008), so its EFFECTIVE vocabulary is the LAST match.
  const chosen = column === "reason" ? matches[matches.length - 1] : matches[0]
  return literals(chosen[1])
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

// ---------------------------------------------------------------------------
// One assertion per guarded vocabulary: the TS tuple deep-equals the SQL set.
// ---------------------------------------------------------------------------

describe("notification-types.ts mirrors the 006 migration vocabularies", () => {
  test("NotificationChannel == notification_outbox.channel CHECK", () => {
    expect(sorted(NOTIFICATION_CHANNELS)).toEqual(sorted(checkSet("channel")))
  })

  test("NotificationType == notification_outbox.notification_type CHECK", () => {
    expect(sorted(NOTIFICATION_TYPES)).toEqual(
      sorted(checkSet("notification_type"))
    )
  })

  test("NotificationReason == notification_outbox.reason CHECK", () => {
    expect(sorted(NOTIFICATION_REASONS)).toEqual(sorted(checkSet("reason")))
  })

  test("OutboxStatus == notification_outbox.status CHECK", () => {
    expect(sorted(OUTBOX_STATUSES)).toEqual(sorted(checkSet("status")))
  })

  test("SuppressionReason == notification_outbox.suppression_reason CHECK", () => {
    expect(sorted(SUPPRESSION_REASONS)).toEqual(
      sorted(checkSet("suppression_reason"))
    )
  })

  test("RecipientResolutionStatus == notification_outbox.recipient_resolution_status CHECK", () => {
    expect(sorted(RECIPIENT_RESOLUTION_STATUSES)).toEqual(
      sorted(checkSet("recipient_resolution_status"))
    )
  })
})
