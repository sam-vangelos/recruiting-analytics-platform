// Headline regression for the YTD writer's "ON CONFLICT DO UPDATE command cannot affect row a
// second time" failure (18 consecutive daily incremental failures). runYtdSync runs
// buildFactsForChannel once per channel, and the job-scoped rows (stage definitions/events,
// owner snapshots) are derived from each channel's jobIds — so a job with both a referral and an
// agency application in-year emits IDENTICAL rows from both passes, and the concatenated batch
// handed to a blind upsert carries a duplicated conflict target. persist() must dedupe each
// batch on its conflict key before the upsert.
//
// This test drives the REAL persist() (exported for exactly this proof, mirroring
// projectFactsForWriteback) against a mocked Supabase client that records every upsert payload,
// and asserts each of the four batches has unique conflict keys. Written to FAIL against the
// pre-fix code (the stage-definition payload carries the dup) and pass after.
//
// Mock seam: persist imports `supabase` (the Proxy) by RELATIVE path; the repo ships no vitest
// path-alias resolution, so vi.mock("../lib/supabase") is what intercepts (the "@/" alias would
// not — see notification-delivery.test.ts:16-19). Installed via vi.hoisted so the factory can
// close over the recorder despite vi.mock hoisting. The YTD_OWNERSHIP_WRITEBACK gate is left
// unset, matching production today, so appendOwnershipSnapshots is skipped and the only DB calls
// are the four upserts plus the owner-stale update.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type {
  YtdApplicationFact,
  YtdJobOwnerSnapshot,
  YtdStageDefinition,
  YtdStageEvent,
} from "../lib/ytd-types"
import type { YtdApplicationFactWithOwnership } from "../lib/ytd-normalize"

interface UpsertCall {
  table: string
  payload: Array<Record<string, unknown>>
  options: { onConflict?: string } | undefined
}

const sb = vi.hoisted(() => {
  const upserts: UpsertCall[] = []

  function from(_table: string) {
    const table = _table
    return {
      // upsertRows: `await supabase.from(t).upsert(rows, { onConflict })` — awaited directly,
      // no trailing .select(). The returned object is therefore a thenable resolving to
      // { error: null }.
      upsert(rows: Array<Record<string, unknown>>, options: { onConflict?: string } | undefined) {
        upserts.push({ table, payload: rows, options })
        return Promise.resolve({ data: null, error: null })
      },
      // Owner-stale guard: `.update(patch).in(col, vals).lt(col, val)` — awaited at .lt().
      update() {
        const chain = {
          in() {
            return chain
          },
          lt() {
            return Promise.resolve({ error: null })
          },
        }
        return chain
      },
    }
  }

  return {
    client: { from },
    upserts,
    reset() {
      upserts.length = 0
    },
  }
})

vi.mock("../lib/supabase", () => ({
  supabase: sb.client,
  getSupabase: () => sb.client,
}))

// Import AFTER the mock is registered (vi.mock is hoisted, so this already sees the fake).
import { persist } from "../lib/ytd-extract"

const NOW = "2026-06-15T00:00:00Z"

function stageDef(overrides: Partial<YtdStageDefinition> = {}): YtdStageDefinition {
  return {
    job_interview_stage_id: 500,
    job_id: 20,
    stage_name: "Application Review",
    stage_rank: 1,
    active: true,
    last_synced_at: NOW,
    ...overrides,
  }
}

function stageEvent(overrides: Partial<YtdStageEvent> = {}): YtdStageEvent {
  return {
    id: 900,
    application_id: 1,
    job_interview_stage_id: 500,
    stage_name: "Application Review",
    stage_rank: 1,
    entered_at: NOW,
    exited_at: null,
    days_in_stage: null,
    current: true,
    sync_run_id: "run-1",
    ...overrides,
  }
}

function ownerSnap(overrides: Partial<YtdJobOwnerSnapshot> = {}): YtdJobOwnerSnapshot {
  return {
    job_id: 20,
    user_id: 77,
    owner_type: "recruiter",
    user_name: "Recruiter",
    user_email: "recruiter@example.com",
    active: true,
    last_seen_run_id: "run-1",
    last_seen_at: NOW,
    ...overrides,
  }
}

function fact(overrides: Partial<YtdApplicationFactWithOwnership> = {}): YtdApplicationFactWithOwnership {
  const base: YtdApplicationFact = {
    application_id: 1,
    scan_year: 2026,
    channel: "agency",
    candidate_id: 10,
    candidate_name: "Candidate",
    candidate_email: "candidate@example.com",
    job_id: 20,
    job_title: "Role",
    source_id: 100,
    source_name: "Agency",
    department_id: 30,
    department_name: "Engineering",
    application_status: "active",
    applied_at: "2026-05-10T00:00:00Z",
    submitted_at: "2026-05-10T00:00:00Z",
    last_activity_at: "2026-05-10T00:00:00Z",
    referrer_id: null,
    referrer_name: null,
    agency_source_id: 100,
    agency_source_name: "Agency",
    primary_recruiter_id: null,
    primary_recruiter_name: null,
    recruiter_ids: [],
    recruiter_names: [],
    current_stage_id: 1,
    current_stage_name: "Application Review",
    current_stage_entered_at: "2026-05-10T00:00:00Z",
    application_review_entered_at: "2026-05-10T00:00:00Z",
    application_review_exited_at: null,
    actioned_at: null,
    first_action_at: null,
    action_time_hours: null,
    first_action_time_hours: null,
    never_actioned: true,
    action_time_quality: "unknown",
    action_bucket: "unactioned_lt_7d",
    max_stage_id: 1,
    max_stage_name: "Application Review",
    max_stage_rank: 1,
    terminal_outcome: "active",
    conflict_detected: false,
    conflict_types: [],
    dual_agency_group_key: null,
    prior_internal_application_ids: [],
    duplicate_confidence: "none",
    duplicate_evidence_types: [],
    duplicate_candidate_ids: [],
    fee_risk_state: "not_duplicate",
    fee_risk_reason: null,
    conflict_detail: null,
    data_quality_flags: [],
    last_synced_at: NOW,
    sync_run_id: "run-1",
  }
  return {
    ...base,
    ownership_confidence: "unresolved",
    ownership_resolution_status: "unresolved",
    source_resolution_status: "resolved",
    ...overrides,
  }
}

function findUpsert(table: string): UpsertCall {
  const call = sb.upserts.find((u) => u.table === table)
  if (!call) throw new Error(`expected an upsert into ${table}`)
  return call
}

function keysFor(call: UpsertCall, keyFn: (row: Record<string, unknown>) => string): string[] {
  return call.payload.map(keyFn)
}

describe("persist dedupes every upsert batch on its conflict key", () => {
  beforeEach(() => {
    sb.reset()
    // Match production: writeback gate OFF, so appendOwnershipSnapshots is skipped and the
    // 005 ownership columns are stripped from the fact rows.
    vi.stubEnv("YTD_OWNERSHIP_WRITEBACK", "")
    vi.stubEnv("YTD_SYNC_ALERT_SEND", "")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test("double-emitted job-scoped + fact batches collapse to unique conflict keys", async () => {
    // Two structurally-identical copies of every row — exactly what the cross-channel loop
    // produces for a job present in both channels.
    await persist({
      stageDefinitions: [stageDef(), stageDef()],
      stageEvents: [stageEvent(), stageEvent()],
      ownerSnapshots: [ownerSnap(), ownerSnap()],
      facts: [fact(), fact()],
      scanJobIds: [20],
      syncRunId: "run-1",
      nowIso: NOW,
    })

    const stageDefs = keysFor(findUpsert("ytd_job_stage_definitions"), (r) =>
      String(r.job_interview_stage_id)
    )
    expect(new Set(stageDefs).size, "stage definitions deduped").toBe(stageDefs.length)

    const owners = keysFor(
      findUpsert("ytd_job_owner_snapshots"),
      (r) => `${r.job_id}|${r.user_id}|${r.owner_type}`
    )
    expect(new Set(owners).size, "owner snapshots deduped").toBe(owners.length)

    const events = keysFor(findUpsert("ytd_application_stage_events"), (r) => String(r.id))
    expect(new Set(events).size, "stage events deduped").toBe(events.length)

    const facts = keysFor(findUpsert("ytd_application_facts"), (r) => String(r.application_id))
    expect(new Set(facts).size, "facts deduped").toBe(facts.length)
  })

  test("last-write-wins survives mutation — the later duplicate's value is kept", async () => {
    // Two facts sharing application_id but differing on a mutated column; the survivor must be
    // the SECOND (the fully-mutated copy at the persist boundary).
    await persist({
      stageDefinitions: [],
      stageEvents: [],
      ownerSnapshots: [],
      facts: [
        fact({ fee_risk_state: "not_duplicate" }),
        fact({ fee_risk_state: "exposed" }),
      ],
      scanJobIds: [],
      syncRunId: "run-1",
      nowIso: NOW,
    })

    const factCall = findUpsert("ytd_application_facts")
    expect(factCall.payload).toHaveLength(1)
    expect(factCall.payload[0].fee_risk_state).toBe("exposed")
  })
})
