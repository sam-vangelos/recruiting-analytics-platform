# P1 ELT copied-document dry-run and held hydration evidence

Prepared 2026-07-23. This document describes the held ELT fact-table
implementation on `codex/elt-fact-table-cadence-20260722`. It replaces the
earlier offline-only description: the branch now connects the planner to the
private durable orchestration and contains one guarded copied-Doc mutation
path. It does not constitute activation, a live copy canary, or a qualifying
shadow.

## Current result

- Fixture and integration verification: **PASS**.
- Live scheduled dry proof: **NOT RUN by this branch**.
- Live copied-artifact mutation: **NOT RUN by this branch**.
- Migration `028`: **held and not applied**. The linked remote migration ledger
  ends at `027`, and a read-only live `public` schema dump contains neither
  `recruiting_ops_elt_evidence_valid` nor
  `recruiting_ops_elt_evidence_valid_check`.
- Deployment and activation: **held**. Migration `028` must be applied and
  validated before any image capable of emitting `elt_fact_table_v1` evidence
  is deployed. The Job must remain `dry_run`, both the global and ELT write
  flags must remain false, the durable stop must remain engaged, and every
  governed Scheduler must remain paused outside a separately approved real
  gate.

Dry proofs, fixture runs, canaries, and this code review count as zero ELT
artifact shadows.

## Exact mutation surface

- Copied document:
  `1ExampleDriveId00000000000000000000000000007`
- Required title: `Copy of ELT Recruiting Updates`
- Required and only tab: `t.0`, with no child tabs
- Range contract: `elt_doc_top_week_facts`
- Upsert key: `elt_facts.weekShort`
- PII policy: `internal_review_identifiers`
- ACL policy: `exact_owner_and_service_writer`
- Exact ACL: owner `jordan.rivera@example.com` and writer
  `recops-sheets-writer@example-project.iam.gserviceaccount.com`, with no
  third permission
- Explicit denied canonical:
  `1ExampleDriveId00000000000000000000000000021`

The mutation compiler can replace or insert only the newest complete
Friday-through-Thursday date heading, five-column hire table (`Role`,
`Dept.`, `Priority`, `Candidate Name`, `Start Date`), and its Role Progress
narrative tail (per-section QTD offer line, numbered stage lines, offer-accepted
line — the A9 expansion, RECOPS-ELT-FACT-TABLE-BOUNDARY-v2). Every older
archive block stays outside the mutation range and is covered by the all-tab
outside-content HMAC. The canonical ID and every caller-supplied or unknown ID
are rejected before Google I/O.

The planner discovers live indices from exact reporting-week anchors. Historical
values such as the previously observed next boundary at `1562` are evidence,
not hard-coded write coordinates.

## Private cadence and durable path

The existing private Cloud Scheduler route launches the fixed private Cloud Run
Job. The Job accepts an explicit copied-artifact allowlist and resolves ELT only
at the 06:30 Pacific morning lane:

- Thursday: the weekly combined cycle;
- Friday: the ELT refresh alongside All Hires.

Both paths use the same normalized scheduled identity, deduplicated durable run,
immutable source cut, and artifact-specific attempt. Greenhouse access remains
read-only. A failed ELT attempt is isolated from sibling artifacts. An
interrupted or uncertified ELT attempt that may have crossed the Docs mutation
boundary is non-retryable.

Migration `028` adds no columns, data rewrite, index, or replacement RPC. It
adds one immutable validator and one `NOT VALID` then `VALIDATE` check
constraint. A terminal `written` or `no_change` ELT attempt using
`elt_fact_table_v1` is accepted only with the exact period, source, plan,
revision, Drive version, ACL, mutation-count, outside-content, and certification
evidence required for that outcome. Existing unlabelled evidence remains
backward compatible.

## Dry-run preflight

The planner blocks before a document read unless all source checks pass:

1. Non-empty run ID, workflow `E01`, and an explicitly allowed mode (live
   orchestration requires `shadow`).
2. Snapshot age at or below 120 minutes. Exactly 120 minutes passes; 120 minutes
   plus one millisecond blocks.
3. `truncation_suspected_pulls === 0` and a structurally valid `elt_facts`.
4. The state-of-play Friday and ELT last-complete Friday-through-Thursday labels
   each match their governed clock.
5. Fixture fingerprints are used only with `mode === "fixture"` and explicit
   fixture opt-in.
6. The target is the exact registered copied document.

After the read, planning also requires the exact ID, title, single-tab topology,
revision ID, non-empty body, top sentinel at index `1`, deterministic current
fact-table shape, and an unambiguous next archive boundary. Duplicate weeks, a
requested week below the top block, unexpected leading content, crossing
structural elements, a skipped week, or a non-reconstructible rollback preimage
all block. An absent week is eligible only when it is exactly one week newer
than the current top week. An exact current top fact table produces `no_op`.

The standalone CLI remains read-only and treats
`RECOPS_HYDRATE_ELT_DOC=true` as a configuration stop. Only the registered
private adapter may set the planner's internal permit-boundary marker; that
marker is not a write permit.

## Guarded write path

A write requires all of the following at the network chokepoint:

1. Job mode `write`, `RECOPS_STAGING_HYDRATION_ENABLED=true`, and
   `RECOPS_HYDRATE_ELT_DOC=true`.
2. A fresh, short-lived permit bound to the exact copy, run, source, payload,
   outside-content HMAC, and `elt_doc_top_week_facts`.
3. A reachable durable safety store with an explicit staging-hydration
   `DISENGAGED` state and no applicable global, capability, or deliverable
   blocker. The state is read before permit issuance and again immediately
   before mutation.
4. Application Default Credentials impersonating only the fixed writer service
   account. No key file is accepted.
5. Google scopes limited to Docs, Sheets, and
   `drive.metadata.readonly`. Drive is used only for metadata and permission
   reads; no permission mutation exists.
6. Two identical all-tab Docs reads bracketed by one unchanged decimal Drive
   version and one unchanged exact-ACL HMAC.
7. An atomic Docs `batchUpdate` using the planned
   `writeControl.requiredRevisionId`.

After mutation, the writer waits for an advanced Drive version and exact
committed revision, re-proves the ACL, certifies the date chips and hire table,
and requires the all-tab outside-content HMAC to remain unchanged. A safely
fenced rejected postimage is rolled back under its exclusive revision and
independently re-read. An ambiguous mutation that is neither the exact preimage
nor the exact certified postimage is never retried or blindly rolled back.

## Human approval gate

The branch intentionally adds no programmatic “approval received” latch. Human
approval is an operational release gate: operators must not apply the write
configuration, add ELT to an active Job allowlist, disengage the durable stop,
or run a copy canary until the operator explicitly approves the exact
recipient/PII boundary recorded in `PREREQUISITES.md`. The canonical remains
read-only and requires a later, separate artifact-specific promotion approval.

## Offline CLI

The CLI consumes secure local JSON exports and emits only a public-safe summary:

```text
npx tsx scripts/recruiting-ops/elt-doc-dry-run.ts \
  --snapshot=/secure/path/e01-snapshot.json \
  --document=/secure/path/elt-doc-read.json \
  --now=2026-07-23T13:30:00.000Z \
  --out=/secure/path/public-summary.json
```

Live-derived fingerprints require `RECOPS_PII_FINGERPRINT_SALT`; candidate
names and raw document content stay in the private in-memory plan. Synthetic
fixture mode additionally requires `--allow-fixture` and a snapshot whose mode
is exactly `fixture`.

## Verification commands

```text
npm test -- \
  test/recruiting-ops-elt-doc-plan.test.ts \
  test/recruiting-ops-elt-doc-dry-run.test.ts \
  test/recruiting-ops-elt-evidence-migration.test.ts \
  test/recruiting-ops-google-workspace-elt-doc-writer.test.ts \
  test/recruiting-ops-staging-elt-doc-hydration-runner.test.ts \
  test/recruiting-ops-hydration-orchestration-store.test.ts \
  test/recruiting-ops-staging-hydration-orchestrator.test.ts \
  test/recruiting-ops-staging-maintenance-cadence.test.ts
npm run typecheck
npm run check:recruiting-ops-architecture
npm run lint -- <changed files>
git diff --check
```

The full test suite, mutation corpus, and production build are separate required
release checks. Before this documentation correction, the same held runtime
diff passed 1,445 tests, typecheck, architecture checks, an 8/8 mutation
corpus, changed-file lint, and a production build. The documentation-coherence
run then passed 10 focused files / 199 tests, typecheck, architecture checks,
and `git diff --check`; changed-file lint exited zero with no errors and one
existing unused-parameter warning in the architecture checker. Passing any
local check does not authorize a live fire.
