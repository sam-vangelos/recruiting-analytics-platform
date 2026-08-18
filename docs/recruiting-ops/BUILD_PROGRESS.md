# Recruiting Ops Command Center Build Progress

Status: Active
Owner: the operator
Worktree: `~/work/ta-ops-analytics-automation-control-plane-phase1-6`
Branch: `codex/recruiting-ops-automation-control-plane-phase1-6`

## Current Baseline

Date: 2026-06-26

Completed:

- P0 command-center docs seeded.
- P0 source/workflow/query/script/output registries implemented in `lib/recruiting-ops/registries.ts`.
- Registry validation tests added in `test/recruiting-ops-registries.test.ts`.
- Architecture guardrail checker added in `scripts/recruiting-ops-architecture-check.mjs`.
- Architecture checker fixture tests added in `test/recruiting-ops-architecture-check.test.ts`.
- Canonical spec and implementation plan rebuilt for goal-mode execution.
- Greenhouse read-adapter contracts and fake-client mapping tests implemented.
- Local workflow/action modules implemented for every registered handover surface.
- Local JSON/CSV artifact renderers implemented.
- Run/evidence ledger, discrepancy classes, source gaps, dry-run action proposals, and persistence shapes implemented.
- Read-only `/recruiting-ops` console implemented and sanity checked.
- Workflow-foundation spec and implementation plan archived as provenance.
- Capability-first source-of-truth docs added as the active implementation surface.

Verified commands:

- `npm run check:recruiting-ops-architecture`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

## Active Next Gate

The audit remediation campaign (plan: phases A–D) is executing. **Phases A, B, C1/C1b, C2, and C3's code side (C3-1 container, C3-2 trigger) are COMPLETE.** Next: C3-3 GCP substrate (Artifact Registry image, Cloud Run service, Scheduler jobs created PAUSED, Secret Manager) — built dark next to prod; the operator gates the cutover repoint and the G2 shadow flip. Then C4 delivery (T18 Slack first).

## 2026-07-07: C3-3 — GCP substrate LIVE (Cloud Run + Secret Manager + paused Scheduler)

the operator took ownership of `example-project`; the dark substrate is now deployed and verified:

- **Image:** Cloud Build from the working tree (explicit `.gcloudignore` — env files and `.recruiting-ops-artifacts` can never enter the source upload) → `us-central1-docker.pkg.dev/example-project/recruiting/ta-ops-analytics:7470e31` (2m51s, the C3-1 Dockerfile unchanged).
- **Service:** `ta-ops-analytics` in us-central1 (Supabase sits in AWS us-west-2 — same metro), dedicated runtime SA `ta-ops-analytics-run@` with per-secret accessor grants only, 1Gi/1cpu, min 0 / max 2, 300s timeout, env via Secret Manager (7 secrets), `SUPABASE_URL` as plain env. URL: https://ta-ops-analytics-000000000000.us-central1.run.app
- **Verified live:** / 307→referrals; Basic-auth wall holds (401 bare / 200 with the pair) on /referrals and /state-of-play; /state-of-play renders the E01 snapshot from Supabase (read path proven from Cloud Run); cron routes 401 without CRON_SECRET and answer 200-disabled with it (`RECOPS_EXEC_ENABLED` unset everywhere — the exec lane stays dormant by design).
- **Scheduler:** six HTTP jobs created and immediately PAUSED (sweep-referral hourly, sweep-agency 4h, ytd-incremental 06:30, reconcile-identity 06:00, notify-drain :15, recruiting-ops-exec :45 — all UTC, Bearer CRON_SECRET header, 320s deadline). Resuming them is the operator's cutover flip.
- **Cutover hazard (documented for the flip):** Vercel's crons still fire on the frozen deployment. `notify-drain` must never run from both substrates — strip vercel.json crons (one CLI prod deploy) BEFORE resuming the GCP jobs; the sweeps tolerate a small gap, double-drain risks double-sent Slack notifications.

## 2026-07-06: E01 exec state-of-play — module, snapshot, /state-of-play page, ELT facts (commits 1eb2504…fa4c220 + this one)

The exec workbook critique (verified falsehoods: COUNTBLANK-vs-em-dash owner narrative, catch-all stage counted as finalists, offers scoped to open jobs, idle-only health, TODAY() over a frozen extract) resolved into the medium verdict: the canonical exec surface is a hosted page fed by a platform module; the spreadsheet sidecar is retired.

Completed gate:

- **Definitions core (`lib/recruiting-ops/exec-definitions.ts`):** governed-first stage resolution with the unclassified bucket TERMINAL-UNORDERED (`order: null` — structurally excluded from every at-or-beyond comparison; the sidecar's top-of-scale catch-all promoted unknown stages into finalists/advances at three sites), reason-bearing health rules (no_pipeline / stalled_14d / ramping / stopped_this_week / thin_vs_seats / active_pipeline — green carries a data-bearing reason; idle-days demoted to diagnostics), momentum labels, req classification (is_template + pool/campaign patterns), Fri–Thu week + QTD-by-reporting-week + Thursday-deadline ELT week rules.
- **Exec read boundary:** separate `GreenhouseExecReadBoundary` (raw typed sources + per-pull diagnostics; a cap-sized pull flags truncationSuspected → the module raises a BLOCKING gap — silent truncation unrepresentable). Org-wide pulls with documented v3 filters: `prospect=false` at the source, offers org-wide by `resolved_at` (closed-job hires included; window widens to the ELT quarter start, the 12wk rollup stays true 84d), `/scorecards` KIT-SCOPED + windowed (the org-wide window pull dies of Greenhouse's own PG statement timeout — observed live), `/interviews?status=awaiting_feedback` as the pending-write-up signal, `/application_stages` by `updated_at` window. Union extended with `/candidates` + `/departments` (previously reached via casts). `customFieldValue` now unwraps multi_select arrays (Priority=["P0"]) and matches on the v3 field NAME.
- **E01 module (`modules/exec-state-of-play.ts`):** per-req rows (engaged depth vs application pile vs unclassified — never conflated; finalists governed-stage-≥-Assessment only; scorecard-truthed conducted split last7/prior7; pending write-ups; org-wide 12wk offers per req) + org rollup + enriched hires + ELT facts, all through `finalizeModuleResult`. Gaps: per-DISTINCT-normalized-label stage gaps (heuristic + unclassified), unowned roles, off-roster owners, req-class segregations, truncation (blocking). Registered across workflow/output/seed-matrix/capability registries (reuses `structured_hiring_status`); standalone live entrypoint `exec-live-workflow.ts` (the six-module runner stays untouched).
- **Migration 021 (applied + verified live):** `recruiting_ops_exec_snapshot` — the plane's FIRST row-content store, scoped to finalist names + GH profile URLs (no emails, no raw application ids), RLS deny-by-default; `funnel_stage` column on the stage taxonomy (governed 8-stage funnel mapping; 3-class rows fall through to the heuristic with a named gap). Snapshot writes ONLY on succeeded runs — a truncation-blocked run never becomes the page.
- **Route groups + `/state-of-play`:** `app/(workbench)/` keeps the operator chrome; `app/(exec)/state-of-play` is a second root layout with exec-only chrome. Server component over the latest snapshot; honest unavailable state; reason strings under every needs-attention/watch row; in-process split from the review pile; hires strip; segregated pools/campaigns; as-of stamp. Behind the existing Basic-auth proxy (`/state-of-play/:path*`). Walked in Chrome against live data.
- **ELT facts:** the module emits `build-elt-update.py`'s exact input shape. Same-week A/B vs the legacy doc (Jun 26–Jul 2): FDE+PE QTD 4 (PE 0, FDE 4) EXACT incl. names; Brazil 5 EXACT; Code+RL 3 (Code 2, RL 1) — preserving the undercount catch (legacy hand-wrote 2 while listing 3 names). Hires now org-wide + enriched (dept/priority/location); week bucketing is resolved_at-canonical (legacy bucketed by write time — logged as a definition class, not chased). Conducted is scorecard-truthed; the definition is stated on the artifact face.
- **Sidecar retirement:** `recruiting-ops-exec-sheet-data.ts` + `recruiting-ops-exec-preview.ts` DELETED; `build-exec-workbook.py` marked DORMANT (future C4 export candidate only). New dormant trigger `/api/cron/recruiting-ops-exec` (CRON_SECRET fail-closed; `RECOPS_EXEC_ENABLED` exactly "true" — the flip is the operator's; set nowhere).
- Live verification: two persisted E01 generations (66 reqs = 57 roles + 9 segregated pools/campaigns/templates; req 1108 red/dormant with its 4,754-application pile separated from 33 engaged; req 1026 at 6 finalists vs the workbook's 159; org-wide 12wk offers 73 vs the open-jobs-scoped 42; hires priority coverage 69/73); snapshot rows in Supabase read back by the page.

Commands run: typecheck clean; arch check 83 files (route-group paths + both cron prefixes); `npm test` 110 files / 742 tests green; live E01 runs end-to-end; page walked in Chrome; ELT A/B rendered and diffed against the legacy doc.

## 2026-07-03: Slices C3-1 + C3-2 + lens-fold (commits fd7424a, f5f1fe6, + run-integrity)

Completed gate:

- **C3-1 — container (fd7424a):** `output: "standalone"` (Vercel ignores it; the frozen deployment is unaffected) + multi-stage Dockerfile over node:24-alpine on the verified webpack build path; env-free build so no secrets enter layers; `.dockerignore` hard-excludes `.recruiting-ops-artifacts` (row-level data), env files, VCS. Standalone artifact verified directly: `server.js` served the console (200, durable panel live over Supabase) and cron auth 401s without the secret.
- **C3-2 — the trigger (f5f1fe6):** `/api/cron/recruiting-ops-shadow` — CRON_SECRET fail-closed; `RECOPS_SHADOW_ENABLED` must be exactly `"true"` (G2 = the operator's flip); the dormant path answers 200-disabled without touching Greenhouse or Supabase (locked, including the no-truthy-coercion case); failures are 500s, never silent 200s. The C0 runner extraction folded in where it pays: `lib/recruiting-ops/live-workflow.ts` is the ONE live entrypoint (scoping → governed dims → six modules → persist) shared by the operator CLI and the scheduled route. ARCH-META-5: the arch checker's prefixes now cover the route directory. vitest resolves `@/` so route files are testable directly.
- **C2 boundary-lens fold (migration 020 applied):** the resumed lens agent's full report reconciled — it confirmed the two already-fixed highs (torn-state freeze; compensation masking), validated both refutations (concurrent-PK race converges to the torn-state finding; 018's mode-check window had no exposed rows), and added findings now folded: `children_checksum` on runs (parent checksums never covered gaps/discrepancies — a same-runId re-persist with different child CONTENT now throws; nullable, so pre-020 rows verify by counts), `legacy_artifact_refs` persisted (audit lineage no longer dies at persistence), NaN-throwing timestamp guards + deterministic tie-breaks in the kill-switch/autonomy readers (an unparseable timestamp could otherwise pin a scope's derived state forever), and the roster seed became a RECONCILIATION (stale team rows for config-owned names deactivate; post-seed invariant: one active team per configured name, else the seed throws; TA-ops rows for names outside config are never touched). 020 wraps its DDL in an explicit transaction (the 018 drop+add lesson).
- Live verification: three persisted run generations in Supabase (18 runs); the 6 newest carry children_checksum and legacy lineage columns populated.

Commands run: typecheck clean; arch check (75 files, now including the route); `npm test` 106 files/683 tests green; mutation 8/8 (post-commit — the corpus refuses a dirty checker by design); red passes empty; live run through the shared helper verified end-to-end.

## 2026-07-02: Slice C2 — Durable State (G1 executed; migrations 015–019 applied; commits 9a195f1, ba0687a, 40edb13, + console read side)

Completed gate (G1 approved via the operator's "work through each remaining development phase" directive; every apply verified live by inspection; full local gate green per slice; data-corruption lens at the phase boundary):

- **C2-0 — G1 executed:** migrations 015–017 applied to the analytics Supabase (`exampleanalyticsref0`) via the linked CLI (`supabase db query --file`). Verified live: 10 command-center tables, RLS enabled on all 10, capability_id on 6 tables, contract-parity + proposal-lifecycle columns present, **zero** anon/authenticated grants, 6 discrepancy classes seeded. Remote `schema_migrations` bookkeeping records only 001–004 while 005–014 are live — this org applies out-of-band; 015–019 followed the same convention (all idempotent by construction). C3's deploy pipeline should pick ONE convention.
- **C2-1 — durable run history + honest modes (9a195f1):** `persistWorkflowRuns` writes runs/evidence/artifacts/gaps/discrepancies through a minimal client interface (supabase-js confined to one binding). P8 idempotency (identical checksums = no-op; same runId + different checksums = throw); compensating delete on child-insert failure (a partial persist would read as a clean zero-gap run); pre-insert unique-id guard. That guard caught a REAL grain bug live: T05/T07/T02/T01 module gap ids were keyed above their row grain (application where the row is interview/offer/movement/job-week) and collided within one run — all rekeyed. Run mode threads runner→modules; live runs stamp `local`, never `fixture`. First durable history verified in Supabase: 6 runs, 4233 gaps, 4233 discrepancies, 12 artifacts, mode=local.
- **C2-2 — governed dimensions (ba0687a; migration 018 applied + seeded):** recruiter→team/HOD moves to `recruiting_ops_recruiter_roster` (35 rows seeded from v1 config, idempotent upsert); T05 gains `recruiting_ops_interview_stage_taxonomy` (org-specific slot labels classify by policy; heuristics remain fallback; table starts empty deliberately — populating it is a policy act). Injection is exclusive, never merged; live runs fail loudly on an unseeded roster. 018 also realigned the runs mode check with the application vocabulary (`production_disabled`, not the unreachable `production`).
- **C2-3 — durable safety stores (40edb13; migration 019 applied):** append-only `recruiting_ops_delivery_ledger` (durable twin of the local JSONL ledger — same P8 content-aware idempotency and dangling-lineage refusal; `deriveShadowLedgerHistory` extracted so trust/idempotency evidence derives identically from either source), `recruiting_ops_kill_switch_events` (current state = latest per scope), `recruiting_ops_autonomy_state_events` (current state = latest approved; transition machine stays in code). The send-chokepoint `kill_switch` check now passes ONLY on affirmative durable evidence (reachable store + no applicable engaged switch, capability-resolved via the seed matrix, recipient-scope switches blocking conservatively); no evidence or unreachable store stays fail-closed — both paths locked by test.
- **C2-4 — console real run history:** `loadDurableRunHistory` projects `recruiting_ops_runs` (public-safe counts only) into a DURABLE RUN HISTORY panel; the status pill flips FIXTURE→"DURABLE RUN HISTORY — LIVE" only when real rows load; store-unreachable renders an honest STORE UNAVAILABLE state, never a silent fixture fallback. Render-verified on the served page: live pill present, both persisted T02 run ids rendering. The fixture catalog panel stays, still labeled fixture.

**Boundary lens (data-corruption) — ran INLINE with refutation discipline after the lens agent stalled twice at launch (custom-agent harness issue, not a review verdict); a resumed agent pass runs in parallel as a check. Four findings verified against code and folded, each locked by test:**
1. **Torn-state freeze (medium):** a persist that died between the run insert and its children (or whose compensating delete failed) left a run row whose checksums match — every re-persist then no-opped forever, freezing corruption. `already_persisted` now verifies child-row counts against expected and throws TORN with exact counts.
2. **Compensation error masking (low):** a failed compensating delete replaced the original insert error. Both failures now surface in one message naming the torn runId.
3. **Kill-switch same-instant tie (low):** the writer already refuses conflicting same-instant events (shared event id, P8), and the read side now resolves exact-timestamp ties to ENGAGED for rows arriving outside the writer — when order is unknowable, the safe reading is "the switch is on".
4. **Seed-created ambiguity (medium):** the roster upsert keys on (recruiter_name, team_id), so a team change in config ADDS a second active row and silently flips that person to AMBIGUOUS (null attribution). The seed now detects and warns loudly at creation time; `findAmbiguousRosterNames` + resolveTeam's refuse-to-guess are locked together.
Refuted as impossible with code evidence: a PK race between concurrent same-runId persists deleting the other writer's history (the run-row insert sits OUTSIDE the compensating try block, so its failure never triggers a delete), and the 018 mode-check drop+add window (the new check admits every value the old rows carried; verified applied).

Commands run per slice: typecheck clean; arch check (73 files); `npm test` 105 files/676 tests green; mutation 8/8; red passes empty; webpack build clean; live persistence verified by Supabase queries after each apply; console render-verified via `next start` + curl. One transient Supabase-API 504 during the 019 apply retried clean (idempotent migration).

## 2026-07-02: Slice C1b — Fail-Open Seam Closed + v3 Composite Joins (commits e8cdcc3, 39a9044)

Completed gate (read-only mapping work, no ceremony; full local gate green; two live re-runs verified):

- **Fail-open seam closed (ledger item 1):** `GreenhouseReadBoundary` fetchers return `{facts, sourceGaps}`; the harvest boundary maps exclusively through the `WithDiagnostics` variants (the facts-only mappers are deleted as a class); the runner threads adapter gaps into T07/T05/T02/T09 where they merge into run status/artifacts/discrepancies. Two regression locks, each red-tested against the reintroduced defect: every dropped source record must surface as a blocking gap, and adapter gaps must flip module runs to blocked.
- **v3 composite joins (ledger items 2–4):** v3 serves flat records; the boundary now composes per module — T02: /applications + /application_stages + /job_interview_stages + /jobs (requisition ids); T05: /interviews + /job_interviews (slot names) + /interview_kits (the scorecard→slot hinge) + /scorecards (status + interviewed_at fallback); T09: /jobs + /job_owners (typed) + /users (names) + /openings (open headcount). Id-array filters chunk at 50 ids; an EMPTY id list never issues an unfiltered join pull (locked — the silent-widening class).
- **Live findings (probe-verified):** `job_ids` filtering WORKS and the cursor encodes it (4 pages, 0 out-of-set; v3 422s on cursor+param mixing) — first light's "org-wide pull" suspicion was volume, not a bug: the six focus reqs really carry ≥5000 applications. v3 pre-creates an `application_stages` row per plan stage: rows with no entered_at/exited_at and current=false are never-entered scaffolding (360/415 sampled), and every OCCUPIED row at this org carries entered_at — skipping scaffolding took T02 from 36k cry-wolf gaps to zero. ~2/3 of interviews carry no starts_at/scheduled_at (the org schedules outside the Greenhouse calendar); matched scorecards' interviewed_at recovers some.
- **Live end state (public-safe counts):** T07 succeeded 36 rows (144 non-blocking roster gaps → C2 governed table); T02 SUCCEEDED 7701 rows / 0 gaps (was 5000 records → 0 facts + 0 gaps); T03 succeeded 584 rows; T01 succeeded 1105 rows; T05 blocked HONESTLY (2370 rows; 1223 adapter gaps = interviews with no timestamp anywhere in Greenhouse; remainder = module interview-stage taxonomy openness); T09 blocked HONESTLY (1105 facts; 153 jobs unowned in Greenhouse, 9 coordinator-only teams, plus module-level roster drift).

**C1b acceptance met:** all six modules produce rows from live data; every remaining block names exactly what Greenhouse does not provide.

**Discovery ledger (→ C2+):**
1. Runs still stamp `mode: "fixture"` even against live reads — run-mode honesty lands with C2 durable run history.
2. T05's residual module gaps are interview-stage TAXONOMY openness (the tenant's slot names need governed vocabulary, same class as T02's stage dimension) — a governance table question for C2, not a mapping defect.
3. T09/T07 roster drift (recruiter names absent from compiled team/HOD config) remains the C2 governed-roster fix, as designed.
4. Org-wide sub-pulls (/job_owners 2751 rows, /openings open-only, /users by owner ids ≈161) sit comfortably under the 5000/endpoint cap; revisit caps only if org scale doubles.
5. T05 interviewerName is not resolved (needs scorecard.interviewer_id → /users join); optional field, deferred until a deliverable needs it.

Commands run: typecheck clean; arch check 67 files; `npm test` 101 files/656 tests green; mutation corpus 8/8; `test:red` passes empty; three bounded live probes (filter integrity, stage-row semantics, owner-name resolution) with public-safe output only; two full live runs before/after the scaffolding fix.

## 2026-07-02: Slice C1 — Live Harvest Read Bridge + First Light

Completed gate (govern-by-reversibility posture: reads carry no activation ceremony; no lens pass — read-only risk; full local gate green):

- `createLiveGreenhouseHarvestReadClient` / `createLiveGreenhouseReadBoundary` (extractors/greenhouse-live-read-client.ts): the C1 bridge from the read adapter's `GreenhouseHarvestReadClient` interface to the app's OAuth2 client (token cache/refresh, cursor pagination, 429 retry, revoked-token recovery). Per-endpoint record cap (default 5000) with public-safe count logging. Delegation + cap locked by test.
- `scripts/recruiting-ops-live-run.ts`: bounded first-light runner — scopes by requisition ids (default = the six legacy focus reqs), pulls /jobs org-wide for T09, chunks job_ids into /offers (+`current_only=true`), /interviews, /applications; prints PUBLIC-SAFE summary only; artifacts under `.recruiting-ops-artifacts/live/<ts>`.
- v3 reality corrections found BY running (the audit's shape-assumption class, again): the plan's `/scheduled_interviews` endpoint does not exist in v3 → `/interviews` (supports job_ids, starts_at, embedded scorecards); v3 `custom_fields` is a MAP, not the assumed array → shape-tolerant accessor.

**FIRST LIGHT (2026-07-02T07:06Z, live org data):** 1105 jobs / 36 offers (6 legacy reqs) / 3583 interviews / 5000 applications (capped) → 12 artifacts. T07 succeeded (36 rows); T05 blocked (1859 rows, 1859 blocking gaps); T09 blocked (1106 rows, 2210 gaps); T02/T03 zero rows; T01 succeeded (1105 rows). Blocked = the gap machinery refusing unverifiable v3 shapes, exactly as designed.

**C1 discovery ledger (open, → C1b; all read-only mapping work):**
1. **Boundary drops adapter diagnostics (fail-open seam):** `createGreenhouseHarvestReadBoundary` uses the plain `mapHarvest*` variants, discarding the `WithDiagnostics` source gaps — T02 saw 5000 applications silently reduced to 0 facts with 0 gaps. The boundary must surface mapper gaps to modules.
2. **/applications sparsity + filter question:** live records lack the fields the mapper requires for pipeline facts (req_id/stage history — v3 sparsity class), and the job_ids scoping appears not to constrain the pull (~5000 org-wide records returned). Needs the v3 spec pass (expand params or per-job pulls).
3. **/jobs list sparsity:** ~all jobs miss `hiring_team` and `openings` in list responses (2 blocking gaps per job) — ownership needs an expand or a per-job/permissions endpoint.
4. **/interviews field mapping:** 1 blocking gap per row — the v3 interview record's stage/scorecard field names need mapping against the vendored spec (docs in ta-ops-analytics-job-scope-resolution-v2/docs/harvest-v3-api).
5. **Roster drift, live:** T07's 144 non-blocking gaps are live recruiter names absent from the committed team/HOD config — the governed-table migration (C2) is the fix, working as designed until then.

Commands run: typecheck clean; arch check passed (67 files — the bridge import is within boundary rules); `npm test` 101 files/651 tests green; three live runs (404 discovery → endpoint fix → clean run). Phase A (slices A1–A5) drained the red-spec backlog: all 12 audited populations fixed and promoted (`test/red/` empty — the goal state; CI and vitest.red.config handle it explicitly). Phase B merged origin/main into this branch (245 commits: the live analytics evolution, the MCP workstream, identity migration 014) and retired the parallel spec-starved modernization scaffold. The active gate is Phase C: wire the four organs (C0 runner extraction → C1 live Harvest read bridge → C2 durable state, gated on the operator approving migrations 015–017 → C3 cron trigger → C4 delivery).

## 2026-07-01: Phase B — Merge origin/main + Retire the Modernization Scaffold (commits 1871780, 2afdbdb)

Completed gate:

- Merged origin/main (245 commits) into the branch. Conflicts resolved as unions (package.json, .gitignore, app-header); our BUILD_PROGRESS kept canonical, main's preserved as `BUILD_PROGRESS_MODERNIZATION_SCAFFOLD.md`.
- Retired the spec-starved modernization scaffold after an import-graph census: 134 files deleted (dbt tree, validate-only dbt workflow, 21 control scripts, 43 scaffold-only libs, 50 scaffold-only tests, unapplied migrations 010–013) plus 21 `control:*` package scripts. Pre-verified against the live Supabase project (`report_run`/`recruiting_ops_fact_snapshot` 404 — never applied); zero non-scaffold importers (verified importer-by-importer).
- Kept deliberately: `mcp/**` (real workstream), migration 014 + its test (identity, live pilot), transition-control checklists (annotated: tooling references historical), main's app-hardening tests and libs.
- Architecture checker: branch isolation evolved from path-EXISTENCE (obsolete once main merged in by design) to the real boundary — command-center implementation files must never IMPORT scoped-MCP/agent/identity code. Behavioral lock inverted accordingly.
- Salvage (designs, not code): 012's `write_audit` DDL (database-level `live_execution = false` check + fingerprint-not-payload storage) → the plane's action proposals when a write surface lands; dbt grain-uniqueness/safe-mode assertions → Supabase constraints in C2; the credential scanner (locations/types/fingerprints, never values) → ci.yml candidate; the control-output-safety sentinel-injection test pattern → console/CLI surfaces.
- The one post-merge red (dbt-scaffold's spec-presence sentinel flipped by OUR `IMPLEMENTATION_SPEC_MODERNIZATION.md` — a pure filename collision) was retired with the scaffold.

Commands run: merge + union conflict resolution; retirement; arch check passed; `npm test` 100 files/647 tests green; typecheck clean; `next build --webpack` clean; `test:red` passes empty; mutation corpus 8/8 post-commit; retirement census by import-graph agent (T08 test confirmed false-positive and KEPT; greenhouse-write-boundary kept minus its scaffold-only third case).

## 2026-07-01: Remediation Slice A5 — Console Fixture Provenance

Completed gate:

- The synthetic run catalog is labeled as fixture data everywhere an operator sees it: a first-class `catalogProvenance` field on the console data (mode "fixture" + operator-facing detail), a "FIXTURE DATA — NO REAL RUNS" status pill on the control-plane and lane pages, and the run-catalog panel retitled "LOCAL RUN CATALOG — FIXTURE" with the provenance chip on the catalog id. An operator can no longer read the per-request synthetic runs as observed runtime state (P9-adjacent honesty fix; full replacement with durable run history lands in C2).
- Verified on the RENDERED surface, not just in code: built with webpack, served, and both pages' HTML checked for the labels.

Files changed: `lib/recruiting-ops/console-data.ts`, `app/recruiting-ops/page.tsx`, `app/recruiting-ops/lane/[lane]/page.tsx`, `test/recruiting-ops-console-data.test.ts` (provenance lock).

Commands run: typecheck clean; `npm test` 88 files/613 tests green; `./node_modules/.bin/next build --webpack` clean; `next start` + curl verification of both surfaces; mutation corpus post-commit.

## 2026-07-01: Remediation Slice A4 — Persistence Hardening + Migration Renumber (P6, RLS, ARCH-MIG-1)

Completed gate:

- Migrations renumbered 010/011/012 → **015/016/017** (git mv; origin/main's parallel modernization lineage occupies 010–014; these were never applied anywhere). Headers document the renumber; the 017 do-not-apply-until-the operator-approves gate is preserved.
- Deny-by-default RLS on all 10 command-center tables in 015: `enable row level security` with NO policies, plus anon/authenticated revokes wrapped in a role-guarded DO block (bare revokes on a non-Supabase Postgres error silently under psql's continue-on-error — the guard raises a loud warning instead of a silent partial apply; lens finding, folded). Locked by the strengthened persistence-rls spec: per-table RLS + revoke coverage and a create-policy prohibition.
- ARCH-MIG-1 emptiness guards: 016 raises loudly if any of the 5 ledger tables has rows before its NOT-NULL-no-default columns (gated on column absence, so re-apply is an idempotent no-op — lens finding, folded); 017 gets the identical class-level guard for `recruiting_ops_output_contracts` (previously protected only by a human comment — lens finding, folded).
- P6/CAPABILITY-SPINE-3: `Discrepancy.capabilityId` is REQUIRED and runtime-validated by name; all ~30 `buildDiscrepancy` call sites carry their module's capability (s-queue builders thread `cfg.definition.capabilityId`); the capability-binding suite already locks per-module correctness registry-wide.
- Red specs p6-nested-capability-provenance and persistence-rls moved to the green board; `test/red/` is now EMPTY. CI's red gate gains an explicit terminal state (empty backlog passes with a message); vitest.red.config sets passWithNoTests.

Files changed: `supabase/migrations/{015,016,017}_*.sql` (renamed + hardened); `lib/recruiting-ops/discrepancies.ts`; ~20 module files (capabilityId threading); `test/recruiting-ops-{p6-nested-capability-provenance,persistence-rls}.test.ts` (moved + strengthened); `test/recruiting-ops-{discrepancies,runs,persistence}.test.ts`; `.github/workflows/ci.yml`; `vitest.red.config.ts`.

Commands run: typecheck clean; arch check passed; `npm test` 88 files/612 tests green; `npm run test:red` passes empty; mutation corpus post-commit; data-corruption lens (with red-test mandate) — SQL validity verified, S03/S04 shared capability confirmed intentional (registry + binding suite), 3 findings folded (revoke atomicity, 016 re-apply idempotency, 017 unguarded sixth table).

## 2026-07-01: Remediation Slice A3 — Metric Truth (SHADOW-MODULES-1, SHADOW-MODULES-7)

Completed gate:

- T01 weekly offer count: a monthly-grain offer counts in exactly ONE week bucket, never in every week of its month (the legacy `slice(0,7)` filter replicated each offer into all 4–5 weekly rollups — a knowingly-wrong leadership number). Attribution: the offer's creation timestamp when present (`FinalOfferRow.offer_created_at`, new optional field populated from the Greenhouse fact's `createdAt` in t07 normalize), else the deterministic mid-month anchor; blank timestamps fall back to the anchor (`||`, not `??` — lens-found latent gap, folded with a lock).
- T05 match/mismatch: `computeMatchMismatch` requires full normalized-name equality; the legacy first-token substring fuzz that certified two different people sharing a first name as a "match" (false accountability signal) is gone. Genuine same-person guard stays green.
- Red specs t01-weekly-offer-count and t05-first-token-name-match moved to the green board (lens red-tested both against the pre-fix modules: clean AssertionErrors, no TypeErrors).

Files changed: `lib/recruiting-ops/modules/{t01-weekly-leadership,t05-rps,t07-final-offer}.ts`; `test/recruiting-ops-{t01-weekly-offer-count,t05-first-token-name-match}.test.ts` (moved + strengthened); `test/recruiting-ops-t07-final-offer.test.ts` (shape lock gains the new field).

Commands run: typecheck clean; arch check passed; `npm test` 86 files/608 tests green; `npm run test:red` 2 designed failures; mutation corpus post-commit; correctness lens (with red-test mandate) — exactly-once property verified boundary-exact on UTC math, one LOW folded.

- Keep all Phase 1-6 hard boundaries intact: no external delivery activation, unattended writes, live reads/writes, production persistence migration, scoped-MCP imports, or legacy retirement/cutover.
- Any slice must update this file, keep remaining red specs failing, and run the full required validation set before commit.

## 2026-07-01: Remediation Slice A2 — Gate/Autonomy Integration (P8, P3, AUTONOMY-4, P4×2, P2)

Completed gate:

- Delivery ledger append integrity (P8/SAFETY-GATES-7): the write path reads prior entries first — duplicate `deliveryLogId` with identical content is an idempotent no-op; the same id with DIFFERENT content throws (a same-`startedAt` retry over changed inputs must use a new runId, never silently drop a write — lens-found regression, folded); dangling `correctionOf`/`supersededBy` throw. New exports: `readLocalDeliveryLedgerEntries` (missing file → empty, corrupt line → throw) and `collectShadowLedgerHistory` (fail-loud on invalid windowMinutes and corrupt createdAt).
- Shadow-module trust/idempotency evidence (P3/SHADOW-MODULES-6) is ledger-derived in ALL THREE shadow modules: `priorPayloadFingerprintsInWindow` comes from the module's own ledger within the contract's freshness window (caller-supplied extras extend it), and shadow-run counters accumulate from recorded history instead of the hardcoded constant 1. Regression locks cover each module (a lens proved reverting the unlocked two left the suite green — now locked); the architecture checker requires the P3 pattern in all three.
- Trust window floor (AUTONOMY-4): `requiredCleanShadowRuns` is floored at the contract-derived minimum; caller overrides may only raise it.
- Promotion transition legality (P4/AUTONOMY-3): explicit `LEGAL_AUTONOMY_TRANSITIONS` table + `transition_legality` check — `auto_paused → auto_eligible` is blocked; paused deliverables re-enter via shadow re-promotion; `never_auto` has no exits.
- Kill switch at the send chokepoint (P4/AUTONOMY-1): `evaluateProductionDeliveryPreflight` emits a `kill_switch` check that fails closed (no durable store exists until C2; a pass would claim the switch is provably disengaged). Lock asserts status, not mere existence.
- Freshness NA closed in every mode (P2/ARCH-META-6): `not_applicable` freshness FAILS whenever the contract carries a freshness TTL — shadow and review exactly like auto-delivery; positive-path lock added (in-TTL review run still authorizes). Architecture-checker rule updated to the stronger invariant.
- Red specs p8, p3, autonomy4, p4-killswitch, p4-promotion, p2 moved from `test/red/` to the green board (each red-tested against the pre-fix implementation by the honesty lens: all fail by AssertionError on reverted code).

Files changed:

- `lib/recruiting-ops/delivery-ledger.ts`, `lib/recruiting-ops/delivery-gates.ts`
- `lib/recruiting-ops/autonomy-operator-controls.ts`, `lib/recruiting-ops/production-delivery-adapters.ts`
- `lib/recruiting-ops/modules/{recruiter-weekly-req-progress,ownership-capacity,scorecard-accountability}-shadow.ts`
- `scripts/recruiting-ops-architecture-check.mjs` (freshness rule strengthened; P3 pattern required in all three shadow modules)
- `test/recruiting-ops-{p8-ledger-idempotency-lineage,p3-shadow-idempotency,autonomy4-trust-window-floor,p4-killswitch-preflight,p4-promotion-transition,p2-freshness-na-review}.test.ts` (moved from test/red/ + strengthened)
- `test/recruiting-ops-{delivery-gates,recruiter-weekly-req-progress-shadow,autonomy-operator-controls,production-delivery-adapters,architecture-check}.test.ts` (old-contract locks inverted to the new contracts)

Commands run:

- `npm run typecheck` — clean; `npm run check:recruiting-ops-architecture` — passed (66 files)
- `npm test` — 84 files, 601 tests green; `npm run test:red` — 4 files still failing by AssertionError (p6, persistence-rls, t01, t05)
- `npm run test:mutation` — post-commit on the clean tree; result recorded in the A2 commit
- Adversarial lens review (sequential): correctness lens found the content-blind idempotent no-op regression (HIGH, folded: content-aware throw) + fail-open window validation (MED, folded); honesty lens red-tested all six moved specs against pre-fix code (all discriminate), found the p3 lock covered 1 of 3 modules (HIGH, folded: per-module locks + checker rules), the kill-switch lock asserting existence not status (MED, folded), and the missing review-mode positive path (LOW, folded)

## 2026-07-01: Remediation Slice A1 — PII/Redaction Class (P1 + render seam + SAFETY-GATES-4)

Completed gate:

- Person-name detection is value-driven and shared: every string leaf and array element is scanned for name-shaped capitalized runs (Unicode accents, apostrophes, initials, lowercase particles, hyphenated pairs, collapsed whitespace) in both `inspectPublicValue` and `redactForPublicValue`. Operational language survives via a governed vocabulary: exact canonical phrases assembled from the plane's own registries plus a versioned word list (`dimensions/operational-vocabulary.ts` + `dimensions/config/operational-vocabulary.v1.ts`), drift-locked in both directions (phrase wiring and word coverage) with declared person-word exceptions for canonical strings that legitimately embed names.
- Delivery-render seam: renderers resolve row PII posture from the deliverable's seed-matrix `piiPolicy` via `deliverableId` (fail-closed strict for absent/unknown ids), redact rows for `public_safe` deliverables, pass identifiers for `internal_review_identifiers` deliverables (t02/t05/t07/t08/t15/scorecard-shadow threaded), and re-certify the exact delivered rows against the same posture in both branches — the certified object IS the delivered object, and a belt test proves certification refuses leaking bytes even when redaction is defeated.
- CSV redaction keeps columns aligned with an explicit `[REDACTED]` marker only where the original row carried a value; null/undefined originals still render as empty cells.
- Discrepancy value summaries are redacted at composition (`buildDiscrepancy`); `validateDiscrepancy` still rejects hand-built unsafe records.
- `ownership-capacity-shadow` public summaries carry `teamId` (new `teamIdForTeamName` resolver) instead of the person-derived team label; an unmapped team scope emits a blocking source gap.
- SAFETY-GATES-4: `createPiiFingerprint` requires the env-injected `RECOPS_PII_FINGERPRINT_SALT` for live-provenance data and fails closed without it; the committed key is reachable only for fixture provenance.
- Red specs `p1-pii-name-shapes` and `render-payload-pii` moved from `test/red/` to the green board with assertions preserved (red-tested: both fail against the pre-slice implementation).

Known follow-ups logged (not silent): `public_safe` deliverables whose module rows carry person-name columns (`role_assignment_sheet` via t09/ownership-shadow, `weekly_recruitment_sheet` via t01) now render those columns redacted by contract — the modules should emit id-based columns instead (C0 runner extraction), and legacy parity for T01's recruiter column is a Phase-D shadow-discrepancy to adjudicate. Detector still exempts bare single capitalized names in prose and ALL-CAPS single tokens (documented limitation). `createPiiFingerprint` live provenance has no production caller yet — C1 threads boundary provenance.

Files changed:

- `lib/recruiting-ops/safe-public-output.ts`
- `lib/recruiting-ops/dimensions/operational-vocabulary.ts` (new)
- `lib/recruiting-ops/dimensions/config/operational-vocabulary.v1.ts` (new)
- `lib/recruiting-ops/dimensions/recruiter-team-hod.ts`
- `lib/recruiting-ops/renderers/csv.ts`, `lib/recruiting-ops/renderers/json.ts`
- `lib/recruiting-ops/local-artifacts.ts`
- `lib/recruiting-ops/discrepancies.ts`
- `lib/recruiting-ops/checksums.ts`
- `lib/recruiting-ops/modules/{t02-pipeline,t05-rps,t07-final-offer,t08-all-hires-tracker,t15-duplicate-candidate-review,scorecard-accountability-shadow,ownership-capacity-shadow}.ts`
- `test/recruiting-ops-{p1-pii-name-shapes,render-payload-pii,pii-fingerprint-salt,render-certify-belt}.test.ts` (new), `test/recruiting-ops-{public-output,local-artifacts,discrepancies,phase1-shadow-deliverables}.test.ts`
- Removed: `test/red/p1-pii-name-shapes.red.test.ts`, `test/red/render-payload-pii.red.test.ts`

Commands run:

- `npm run typecheck` — clean
- `npm run check:recruiting-ops-architecture` — passed (66 implementation files)
- `npm test` — 78 files, 589 tests, all green
- `npm run test:red` — 10 files, all still failing by AssertionError (remaining backlog)
- `npm run test:mutation` — run post-commit on the clean tree (corpus refuses dirty trees); result recorded in the A1 commit
- Adversarial lens review: correctness + test-honesty lenses on the working diff; all 8 findings folded (contract-driven render policy, certify-belt lock, null-vs-redacted CSV fix, detector grammar extensions, word-coverage drift-lock, salt literal lock)

## 2026-06-26: Pre-Integration Hardening Gate

Completed gate:

- Freshness is scoped to the exact payload rows for shadow deliverables; unrelated fresh source facts no longer rescue stale scoped output.
- Delivery-gate input validation now rejects contradictory adapter/mode/state/readiness combinations before verdict assembly, and auto-delivery freshness fails closed when timestamps are missing, invalid, future-dated, stale, or marked not applicable.
- Delivery logs now distinguish shadow authorization, review authorization, auto-delivery authorization, future delivery attempts/results, withheld, paused, blocked, and failed states while keeping all external delivery disabled.
- Public safety checks now cover common person-identifying key forms, bare owner/actor/recruiter values, and labeled person names in free-text summaries.
- PII-derived local fingerprints now use keyed HMAC-style pseudonyms; raw SHA-256 remains for non-PII checksums/templates and is treated as a supported checksum/fingerprint format only where appropriate.
- Greenhouse Harvest mapping now emits blocking source gaps for missing required live fields and drops records that would otherwise create `unknown` IDs/timestamps.
- Persistence parity is source-controlled in `supabase/migrations/012_recruiting_ops_pre_integration_contract_parity.sql`; no migration was applied.
- The read-only UI no longer displays `CANDIDATE` for auto-eligible deliverables and labels boundary state as static/local assertions, not observed runtime state.
- Architecture checker coverage now locks all external-adapter approval spellings and the auto-delivery freshness `not_applicable` guard.

Files changed:

- `app/app-header.tsx`
- `app/recruiting-ops/page.tsx`
- `app/recruiting-ops/lane/[lane]/page.tsx`
- `lib/recruiting-ops/action-proposals.ts`
- `lib/recruiting-ops/autonomy.ts`
- `lib/recruiting-ops/checksums.ts`
- `lib/recruiting-ops/console-data.ts`
- `lib/recruiting-ops/delivery-gates.ts`
- `lib/recruiting-ops/delivery-ledger.ts`
- `lib/recruiting-ops/extractors/greenhouse-harvest-read-adapter.ts`
- `lib/recruiting-ops/modules/*shadow.ts`
- `lib/recruiting-ops/modules/t02-pipeline.ts`
- `lib/recruiting-ops/modules/t05-rps.ts`
- `lib/recruiting-ops/modules/t07-final-offer.ts`
- `lib/recruiting-ops/modules/t09-ownership.ts`
- `lib/recruiting-ops/renderers/csv.ts`
- `lib/recruiting-ops/renderers/json.ts`
- `lib/recruiting-ops/run-catalog.ts`
- `lib/recruiting-ops/safe-public-output.ts`
- `lib/recruiting-ops/source-freshness.ts`
- `scripts/recruiting-ops-architecture-check.mjs`
- `supabase/migrations/012_recruiting_ops_pre_integration_contract_parity.sql`
- `test/recruiting-ops-*.test.ts` targeted RecOps coverage for the hardening gate
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-delivery-gates.test.ts test/recruiting-ops-delivery-ledger.test.ts test/recruiting-ops-public-output.test.ts test/recruiting-ops-greenhouse-harvest-read-adapter.test.ts`
- `npm test -- test/recruiting-ops-recruiter-weekly-req-progress-shadow.test.ts test/recruiting-ops-phase1-shadow-deliverables.test.ts test/recruiting-ops-run-catalog.test.ts test/recruiting-ops-console-data.test.ts`
- `npm test -- test/recruiting-ops-persistence.test.ts test/recruiting-ops-architecture-check.test.ts test/recruiting-ops-action-proposals.test.ts test/recruiting-ops-substrate.test.ts`
- `npm test -- test/recruiting-ops-t02-t03-pipeline.test.ts test/recruiting-ops-t05-rps.test.ts test/recruiting-ops-t07-final-offer.test.ts test/recruiting-ops-t09-ownership.test.ts`
- `npm run typecheck`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`
- `./node_modules/.bin/next build --webpack`
- Browser QA with local `next dev --webpack` on `/recruiting-ops`, `/recruiting-ops/lane/auto_delivery`, `/recruiting-ops/lane/review_assisted`, and `/recruiting-ops/lane/action_proposal` at desktop and mobile widths. No deployment was performed.

Test results:

- Targeted hardening tests passed after fixes: delivery gates/ledger/public safety/Harvest adapter, shadow deliverables/catalog/console, persistence/checker/action proposal/substrate, and T02/T05/T07/T09 required-field modules.
- `npm run typecheck` passed.
- `npm run check:recruiting-ops` passed: architecture checker scanned 64 implementation files and the registry/capability/binding/seed-matrix tests passed, 4 files and 27 tests.
- Full `npm test` passed: 71 files and 529 tests.
- `git diff --check` passed.
- `./node_modules/.bin/next build --webpack` passed on Next.js 16.2.6; `/recruiting-ops`, `/recruiting-ops/lane/auto_delivery`, `/recruiting-ops/lane/review_assisted`, and `/recruiting-ops/lane/action_proposal` prerendered successfully.
- Browser QA passed with no console errors, no document-wide horizontal overflow, no operator-visible `CANDIDATE` eligibility pill, no asserted/runtime label drift, and no action-proposal empty-state contradiction on the checked routes.

Residual blockers:

- No live/prod boundary has been crossed.
- Live Greenhouse credentials/reads/writes, external delivery, production writes, production persistence migration/backfill, broad PII persistence, scoped-MCP imports, UI mutation controls, and legacy retirement/cutover remain blocked until the operator explicitly approves a separate boundary.
- This gate improves local integration readiness but does not claim the system is ready to operate against live/prod services.

Next gate:

- First real integration boundary planning should start with live Greenhouse read approval, credential handling, source freshness contracts, and production persistence review; do not proceed without the operator approval.

## 2026-06-26: Phase 1-6 Post-Review Hardening Gate

Completed gate:

- H1 ownership shadow freshness now uses an honest source-observed ownership timestamp instead of reusing `generatedAt`; if no observed timestamp exists, the freshness gate is explicitly not applicable instead of fabricating a pass.
- H2 action proposals are laned by action-proposal semantics, not capability-to-deliverable seed joins; fixture proposals are visible in `action_proposal` and absent from `auto_delivery`.
- M6 auto-delivery interlock checking now covers `app/recruiting-ops/**` and command-center implementation prefixes, and catches both `externalDeliveryAdapterApproved` and `externalAdapterApproved` activation spellings.
- Operator-facing UI labels now distinguish auto-eligible deliverables from candidates, include empty states for lanes without local runs/logs/proposals, and label static boundary assertions honestly.
- Public proposal redaction now covers person-label fields such as `ownerLabel`; catalog discrepancy owner exposure now uses an owner fingerprint instead of a raw owner string.

Files changed:

- `app/recruiting-ops/page.tsx`
- `app/recruiting-ops/lane/[lane]/page.tsx`
- `lib/recruiting-ops/console-data.ts`
- `lib/recruiting-ops/delivery-gates.ts`
- `lib/recruiting-ops/extractors/greenhouse-harvest-read-adapter.ts`
- `lib/recruiting-ops/modules/ownership-capacity-shadow.ts`
- `lib/recruiting-ops/modules/t09-ownership.ts`
- `lib/recruiting-ops/run-catalog.ts`
- `lib/recruiting-ops/safe-public-output.ts`
- `scripts/recruiting-ops-architecture-check.mjs`
- `test/fixtures/recruiting-ops/greenhouse-ownership.json`
- `test/recruiting-ops-architecture-check.test.ts`
- `test/recruiting-ops-console-data.test.ts`
- `test/recruiting-ops-phase1-shadow-deliverables.test.ts`
- `test/recruiting-ops-public-output.test.ts`
- `test/recruiting-ops-run-catalog.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-phase1-shadow-deliverables.test.ts test/recruiting-ops-console-data.test.ts test/recruiting-ops-architecture-check.test.ts test/recruiting-ops-run-catalog.test.ts test/recruiting-ops-public-output.test.ts`
- `npm run check:recruiting-ops`
- `npm run typecheck`
- `npm test`
- `git diff --check`
- `./node_modules/.bin/next build --webpack`

Test results:

- Targeted hardening tests passed: 5 files, 68 tests.
- `npm run check:recruiting-ops` passed: architecture checker scanned 63 implementation files; registry/capability/binding/seed-matrix tests passed, 4 files, 27 tests.
- `npm run typecheck` passed with filesystem escalation for sandbox-blocked TypeScript build metadata.
- Full `npm test` passed: 71 files, 512 tests.
- `git diff --check` passed.
- `./node_modules/.bin/next build --webpack` passed; `/recruiting-ops`, `/recruiting-ops/lane/auto_delivery`, `/recruiting-ops/lane/review_assisted`, and `/recruiting-ops/lane/action_proposal` prerendered successfully.

Residual blockers:

- No hard approval boundary reached.
- External network calls, live Greenhouse reads/writes, external delivery, production writes, production persistence migration, broad PII persistence, scoped-MCP imports, UI controls that execute real mutations, and legacy retirement/cutover remain blocked.

Next gate:

- Continue post-hardening review of any remaining low-priority items; keep all follow-up work local-only unless Operator approves a hard-stop boundary.

## 2026-06-26: Phase 1-6 Phase 6 Autonomy Promotion and Operator Controls

Completed gate:

- Added local autonomy promotion records with a state-machine preflight, trust-window evaluation, kill-switch checks, and operator-control audit records.
- Added kill-switch operator events for global/capability/deliverable/recipient-scope controls.
- Preserved the boundary that Phase 6 can approve local autonomy-state movement but cannot change delivery authorization or activate external auto-delivery.
- Added tests for satisfied and blocked trust windows, local-only auto-eligible promotion, blocked `auto_delivering`, kill-switch blocking, and never-auto deliverable protection.

Files changed:

- `lib/recruiting-ops/autonomy-operator-controls.ts`
- `lib/recruiting-ops/index.ts`
- `test/recruiting-ops-autonomy-operator-controls.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-autonomy-operator-controls.test.ts test/recruiting-ops-autonomy.test.ts test/recruiting-ops-delivery-gates.test.ts`
- `npm run check:recruiting-ops`
- `npm run typecheck`
- `npm test`
- `git diff --check`

Test results:

- Targeted autonomy/operator-control tests passed: 3 files, 18 tests.
- `npm run check:recruiting-ops` passed, including architecture, registry, capability, capability-binding, and seed-matrix checks.
- `npm run typecheck` passed with filesystem escalation for the sandbox-blocked `tsconfig.tsbuildinfo` write.
- Full `npm test` passed: 71 files, 508 tests.
- `git diff --check` passed.

Residual blockers:

- No hard approval boundary reached.
- External auto-delivery activation, unattended writes, legacy retirement/cutover, live Greenhouse reads/writes, production writes, production persistence migration, broad PII persistence, and scoped-MCP imports remain blocked.

Next gate:

- Post-implementation review/hardening using `AUTOMATION_CONTROL_PLANE_PHASE_1_6_REVIEW_PROMPT.md`.

## 2026-06-26: Phase 1-6 Phase 5 Disabled Production Delivery Adapters

Completed gate:

- Added disabled production-delivery adapter contracts for Slack, Gmail, Google Sheets, Google Docs, Greenhouse, LinkedIn, Power BI, and n8n surfaces.
- Added disabled adapter objects whose `send` and `write` methods throw before external execution.
- Added production-delivery preflight checks that remain blocked even when a deliverable is structurally ready or an approval/UI mutation flag is accidentally enabled.
- Preserved the invariant that readiness, autonomy state, adapter approval, delivery gates, and actual delivery authorization remain distinct.

Files changed:

- `lib/recruiting-ops/production-delivery-adapters.ts`
- `lib/recruiting-ops/index.ts`
- `test/recruiting-ops-production-delivery-adapters.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-production-delivery-adapters.test.ts test/recruiting-ops-delivery-gates.test.ts test/recruiting-ops-delivery-ledger.test.ts`
- `npm run check:recruiting-ops`
- `npm run typecheck`
- `npm test`
- `git diff --check`

Test results:

- Targeted production-delivery adapter/gate/ledger tests passed: 3 files, 17 tests.
- `npm run check:recruiting-ops` passed, including architecture, registry, capability, capability-binding, and seed-matrix checks.
- `npm run typecheck` passed with filesystem escalation for the sandbox-blocked `tsconfig.tsbuildinfo` write.
- Full `npm test` passed: 70 files, 503 tests.
- `git diff --check` passed.

Residual blockers:

- No hard approval boundary reached.
- No Slack/Gmail/Sheets/Docs/Greenhouse/LinkedIn/Power BI/n8n sends or writes added.
- No external delivery, live Greenhouse writes, production writes, production persistence migration, broad PII persistence, or scoped-MCP imports added.

Next gate:

- Phase 1-6 Phase 6: add local autonomy promotion workflows, trust windows, kill switches, and operator controls without external auto-delivery activation.

## 2026-06-26: Phase 1-6 Phase 4 Disabled Mock Live-Read Scaffolds

Completed gate:

- Added a Phase 4 Greenhouse live-read scaffold with a disabled default boundary and explicit fixture-only mock mode.
- Added readiness diagnostics that remain fail-closed when live-read flags, real credential state, or network calls are marked enabled; the report still records `liveReadsEnabled: false`, `networkCallsAllowed: false`, and `liveAuthAllowed: false`.
- Added tests proving disabled boundaries throw before reads and do not call `fetch`, while mock mode reads only local fixtures.

Files changed:

- `lib/recruiting-ops/extractors/greenhouse-live-read-scaffold.ts`
- `lib/recruiting-ops/index.ts`
- `test/recruiting-ops-greenhouse-live-read-scaffold.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-greenhouse-live-read-scaffold.test.ts test/recruiting-ops-greenhouse-read-boundary.test.ts test/recruiting-ops-greenhouse-harvest-read-adapter.test.ts`
- `npm run check:recruiting-ops`
- `npm run typecheck`
- `npm test`
- `git diff --check`

Test results:

- Targeted live-read scaffold/boundary/adapter tests passed: 3 files, 10 tests.
- `npm run check:recruiting-ops` passed, including architecture, registry, capability, capability-binding, and seed-matrix checks.
- `npm run typecheck` passed with filesystem escalation for the sandbox-blocked `tsconfig.tsbuildinfo` write.
- Full `npm test` passed: 69 files, 498 tests.
- `git diff --check` passed.

Residual blockers:

- No hard approval boundary reached.
- No external network calls, real credentials, live Greenhouse reads/writes, production writes, or production persistence migration added.

Next gate:

- Phase 1-6 Phase 5: add disabled production-delivery adapter interfaces/design only.

## 2026-06-26: Phase 1-6 Phase 3 Read-Only Control-Plane UI

Completed gate:

- Updated `/recruiting-ops` into a read-only automation control-plane overview over static local catalog data, including lane posture, local runs, delivery logs, failed gates, action proposals, capability rows, and hard boundary states.
- Added static read-only lane detail routes at `/recruiting-ops/lane/auto_delivery`, `/recruiting-ops/lane/review_assisted`, and `/recruiting-ops/lane/action_proposal`.
- Extended console data with a contract-backed local catalog snapshot built from the deterministic gate evaluator and local run-catalog validators; no render-time writes, live reads, credentials, or external delivery controls were added.
- Preserved distinct readiness, autonomy state, delivery gates, recipient scope, delivery logs, and boundary approvals in the UI data.

Files changed:

- `lib/recruiting-ops/console-data.ts`
- `app/recruiting-ops/page.tsx`
- `app/recruiting-ops/lane/[lane]/page.tsx`
- `test/recruiting-ops-console-data.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-console-data.test.ts test/recruiting-ops-run-catalog.test.ts`
- `./node_modules/.bin/next build --webpack`
- `npm run check:recruiting-ops`
- `npm run typecheck`
- `npm test`
- `git diff --check`

Test results:

- Targeted console/catalog tests passed: 2 files, 10 tests.
- `./node_modules/.bin/next build --webpack` passed and prerendered `/recruiting-ops` plus the three lane routes.
- `npm run check:recruiting-ops` passed, including architecture, registry, capability, capability-binding, and seed-matrix checks.
- `npm run typecheck` passed with filesystem escalation for the sandbox-blocked `tsconfig.tsbuildinfo` write.
- Full `npm test` passed: 68 files, 493 tests.
- `git diff --check` passed.

Residual blockers:

- No hard approval boundary reached.
- No UI controls execute real mutations.
- No live Greenhouse reads/writes, external delivery, production writes, production persistence migration, broad PII persistence, or scoped-MCP imports added.

Next gate:

- Phase 1-6 Phase 4: add disabled/mock live-read adapter scaffolds and local readiness checks only.

## 2026-06-26: Phase 1-6 Phase 2 Local Run Catalog

Completed gate:

- Added a local run catalog contract/index over command-center runs, artifacts, local JSONL delivery logs, delivery-gate results, discrepancies, source gaps, and dry-run action proposals.
- Added lookup helpers for run filtering, gate-result filtering, action-proposal filtering, and run lineage.
- Added local JSON catalog read/write helpers that reject URL roots and unsafe filenames; this remains local-only and is not production persistence.
- Catalog entries store public summaries, fingerprints, redacted action proposal payload summaries, and local artifact/ledger provenance, not raw candidate payloads.

Files changed:

- `lib/recruiting-ops/run-catalog.ts`
- `lib/recruiting-ops/index.ts`
- `test/recruiting-ops-run-catalog.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-run-catalog.test.ts`
- `npm run check:recruiting-ops`
- `npm run typecheck`
- `npm test`
- `git diff --check`

Test results:

- Targeted run-catalog tests passed: 1 file, 6 tests.
- `npm run check:recruiting-ops` passed, including architecture, registry, capability, capability-binding, and seed-matrix checks.
- `npm run typecheck` passed with filesystem escalation for the sandbox-blocked `tsconfig.tsbuildinfo` write.
- Full `npm test` passed: 68 files, 491 tests.
- `git diff --check` passed.

Residual blockers:

- No hard approval boundary reached.
- No production persistence migration, live persistence, network calls, live reads, broad PII persistence, scoped-MCP imports, or UI mutation controls added.

Next gate:

- Phase 1-6 Phase 3: build the read-only `/recruiting-ops` control-plane UI over local/catalog data.

## 2026-06-26: Phase 1-6 Phase 1 Fixture Local Shadow Deliverables

Completed gate:

- Added fixture-backed, local-only shadow deliverables for scorecard accountability (`scorecard-accountability-shadow`) and ownership capacity management (`ownership-capacity-shadow`), expanding the existing weekly req progress shadow surface to three high-signal capabilities.
- Each new shadow module writes local JSON/CSV artifacts, evaluates deterministic delivery gates in `shadow` mode, and appends only to the local JSONL delivery ledger.
- Preserved the core invariant that structural readiness and shadow authorization do not imply production delivery authorization; tests assert an otherwise-ready scorecard output is paused at the boundary gate for `auto_delivery`.

Files changed:

- `lib/recruiting-ops/modules/scorecard-accountability-shadow.ts`
- `lib/recruiting-ops/modules/ownership-capacity-shadow.ts`
- `lib/recruiting-ops/capabilities.ts`
- `lib/recruiting-ops/index.ts`
- `test/recruiting-ops-phase1-shadow-deliverables.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-phase1-shadow-deliverables.test.ts test/recruiting-ops-recruiter-weekly-req-progress-shadow.test.ts test/recruiting-ops-delivery-gates.test.ts test/recruiting-ops-delivery-ledger.test.ts`
- `npm run check:recruiting-ops`
- `npm run typecheck`
- `npm test`
- `git diff --check`

Test results:

- Targeted Phase 1 shadow-deliverable/gate/ledger regression set passed: 4 files, 21 tests.
- `npm run check:recruiting-ops` passed, including architecture, registry, capability, capability-binding, and seed-matrix checks.
- `npm run typecheck` passed after rerunning with filesystem escalation for the sandbox-blocked `tsconfig.tsbuildinfo` write.
- Full `npm test` passed: 67 files, 485 tests.
- `git diff --check` passed.

Residual blockers:

- No hard approval boundary reached.
- No external network calls, live Greenhouse reads/writes, external delivery, production persistence, scoped-MCP imports, or UI routes added.

Next gate:

- Phase 1-6 Phase 2: build the local run catalog over artifacts, delivery logs, gate results, discrepancies, source gaps, and action proposals.

## 2026-06-26: Phase 1-6 Goal-Mode Launch Prework

Completed gate:

- Created the Phase 1-6 roadmap, phase manifest, goal prompt, and adversarial review prompt.
- Updated active source-of-truth, goal, guardrail, and build-progress docs to treat Phase 0 as complete and Phase 1-6 as the next long-form non-production expansion.
- Added `npm run typecheck` as a required validation command for the next loop.
- Updated architecture checks to require the Phase 1-6 launch artifacts, reject active docs that still point future agents at Phase 0 contract foundations as the next implementation target, and validate claimed Phase 1-6 phase-completion evidence.

Files changed:

- `docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_ROADMAP.md`
- `docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_PHASE_MANIFEST.md`
- `docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_GOAL_PROMPT.md`
- `docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_REVIEW_PROMPT.md`
- `docs/recruiting-ops/DOCS_SOURCE_OF_TRUTH.md`
- `docs/recruiting-ops/GOAL.md`
- `docs/recruiting-ops/ARCHITECTURE_GUARDRAILS.md`
- `docs/recruiting-ops/BUILD_PROGRESS.md`
- `scripts/recruiting-ops-architecture-check.mjs`
- `test/recruiting-ops-architecture-check.test.ts`
- `package.json`

Residual blockers:

- Phase 1-6 product implementation has not started yet.
- External-channel delivery, production adapters, live Greenhouse writes, broad PII persistence, production persistence migrations, legacy retirement, and cutover remain blocked until the operator explicitly scopes a future gate.

Next gate:

- Launch the Phase 1-6 long-form goal-mode implementation loop from `AUTOMATION_CONTROL_PLANE_PHASE_1_6_GOAL_PROMPT.md`.

## 2026-06-26: Phase 0 Gate 0 False-Green Guardrail

Completed gate:

- Added architecture-check enforcement for Phase 0 gates claimed complete in `BUILD_PROGRESS.md`.
- Scoped completion detection to dated `Phase 0 Gate N` progress headings so unfinished/future gate mentions do not force missing modules to exist.
- Required claimed-complete gates to have the matching implementation module, barrel export where applicable, and targeted tests.
- Covered the guardrail with fixture tests for unfinished gate text, the Gate 0 self-check, and missing implementation files for Gates 1 through 6.

Files changed:

- `scripts/recruiting-ops-architecture-check.mjs`
- `test/recruiting-ops-architecture-check.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-architecture-check.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Gate 0 targeted architecture-check tests passed.
- RecOps check passed.
- Full test suite passed.
- Diff whitespace check passed.

Residual blockers:

- Phase 0 TypeScript autonomy contracts are not implemented yet.
- Local autonomy/delivery/kill-switch ledgers are not implemented yet.
- External-channel delivery remains blocked until production adapters are approved.

Next gate:

- Implement Phase 0 Gate 1 TypeScript Autonomy Contracts.

## 2026-06-26: Phase 0 Gate 1 TypeScript Autonomy Contracts

Completed gate:

- Added `lib/recruiting-ops/autonomy.ts` with TypeScript contracts matching the Phase 0 automation-control-plane spec for lanes, autonomy states, readiness states, recipient-scope rules, kill switches, delivery-gate results, delivery-log entries, and authorization verdicts.
- Added local/static recipient-scope defaults for recruiter-scoped visibility, team visibility, leadership visibility, admin action review, and internal audit.
- Added validators for stable IDs, capability ownership of deliverables, lane/state compatibility, freshness TTL, stale behavior, PII posture, shadow-run requirement, recipient-scope references, blocked rationale, and never-auto rationale.
- Added a validated autonomy-contract lookup helper while keeping the actual seed matrix for Gate 3.
- Explicitly rejected `auto_delivering` unless an approved external delivery adapter posture is passed to the validator; Phase 0 still seeds no such posture.
- Exported the autonomy contracts from the recruiting-ops barrel.

Files changed:

- `lib/recruiting-ops/autonomy.ts`
- `lib/recruiting-ops/index.ts`
- `test/recruiting-ops-autonomy.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-autonomy.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Gate 1 autonomy tests passed.
- RecOps check passed.
- Full test suite passed.
- Diff whitespace check passed.

Residual blockers:

- Output and action contracts are not migrated to the autonomy model yet.
- The deliverable seed matrix is not implemented as TypeScript data yet.
- Local JSONL delivery ledger, gate evaluator, and the recruiter weekly req-progress shadow deliverable remain pending.
- External-channel delivery remains blocked until production adapters are approved.

Next gate:

- Gate 2: migrate output and action contracts to the automation autonomy model.

## 2026-06-26: Phase 0 Gate 2 Output And Action Contract Migration

Completed gate:

- Added automation metadata to every `ConcreteOutputContract`: capability ID, lane, initial autonomy state, freshness TTL, stale behavior, recipient-scope rule IDs, `deliveryLogRequired: true`, and `deliveryAuthorizationRequired: true`.
- Updated output-contract validation to check capability ownership, lane/state values, freshness policy, recipient-scope references, and the readiness/authorization split.
- Added `summarizeOutputReadinessAuthorization()` so structurally ready outputs still return `deliveryAuthorized: false` until a later gate evaluator authorizes delivery.
- Migrated action proposal states to `drafted`, `needs_review`, `approved_for_manual_execution`, `rejected`, `deferred`, `blocked`, and `executed_manually`.
- Added deferral metadata and manual-execution attestation metadata to action proposal contracts, admin queue rows, and pure persistence row mappings.
- Preserved `noLiveExecution: true`; manual execution is only attested metadata and never app execution.

Files changed:

- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/action-proposals.ts`
- `lib/recruiting-ops/modules/s-admin-action-queues.ts`
- `lib/recruiting-ops/persistence.ts`
- `test/recruiting-ops-substrate.test.ts`
- `test/recruiting-ops-action-proposals.test.ts`
- `test/recruiting-ops-s-admin-action-queues.test.ts`
- `test/recruiting-ops-persistence.test.ts`
- `test/recruiting-ops-capability-binding.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-substrate.test.ts test/recruiting-ops-action-proposals.test.ts test/recruiting-ops-s-admin-action-queues.test.ts test/recruiting-ops-persistence.test.ts test/recruiting-ops-capability-binding.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Gate 2 targeted tests passed.
- RecOps check passed.
- Full test suite passed.
- Diff whitespace check passed.

Residual blockers:

- The deliverable seed matrix is still embedded as output automation defaults and must be promoted to explicit source-controlled matrix data in Gate 3.
- Local JSONL delivery ledger, gate evaluator, and the recruiter weekly req-progress shadow deliverable remain pending.
- External-channel delivery remains blocked until production adapters are approved.

Next gate:

- Gate 3: implement the lane/default seed matrix and doc/code consistency tests.

## 2026-06-26: Phase 0 Gate 3 Lane Default Seed Matrix

Completed gate:

- Added `lib/recruiting-ops/automation-seed-matrix.ts` as the source-controlled TypeScript seed matrix for all current concrete deliverables.
- Promoted lane, initial autonomy state, auto-eligibility, shadow requirement, blocked reason, never-auto reason, freshness TTL, stale behavior, recipient scope, readiness states, and PII policy into matrix rows.
- Switched `ConcreteOutputContract` automation metadata to read from the seed matrix instead of embedded output-contract defaults.
- Exported deliverable autonomy contracts from the seed matrix for downstream Gate 4/5 usage.
- Added tests that enforce one-to-one coverage between the seed matrix, output registry, and concrete output contracts.
- Added doc/code consistency tests against `AUTOMATION_DELIVERABLE_SEED_MATRIX.md`.
- Added the seed-matrix consistency test to `npm run check:recruiting-ops` and updated the architecture checker fixture accordingly.

Files changed:

- `lib/recruiting-ops/automation-seed-matrix.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/index.ts`
- `test/recruiting-ops-automation-seed-matrix.test.ts`
- `test/recruiting-ops-architecture-check.test.ts`
- `package.json`
- `scripts/recruiting-ops-architecture-check.mjs`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-automation-seed-matrix.test.ts test/recruiting-ops-substrate.test.ts test/recruiting-ops-architecture-check.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Gate 3 targeted tests passed.
- RecOps check passed.
- Full test suite passed.
- Diff whitespace check passed.

Residual blockers:

- Local JSONL delivery ledger is not implemented yet.
- Gate evaluator and the recruiter weekly req-progress shadow deliverable remain pending.
- External-channel delivery remains blocked until production adapters are approved.

Next gate:

- Gate 4: add the local JSONL delivery ledger.

## 2026-06-26: Phase 0 Gate 4 Local JSONL Delivery Ledger

Completed gate:

- Added `lib/recruiting-ops/delivery-ledger.ts` for append-only local JSONL delivery-log entries.
- Kept ledger writes local-only under caller-provided artifact roots and rejected URL-style roots and unsafe file names.
- Added validation for delivery-log IDs, capability/deliverable ownership, lane matching the seed matrix, autonomy/readiness states, recipient fingerprints, payload fingerprints, gate snapshots, event type, local delivery mechanism, artifact IDs, timestamps, and public-summary safety.
- Added event typing for shadow runs, delivery attempts, gate failures, auto-pauses, corrections, manual-execution attestations, and kill-switch events.
- Added deterministic JSONL serialization and append helpers without production adapters or external-channel delivery.

Files changed:

- `lib/recruiting-ops/delivery-ledger.ts`
- `lib/recruiting-ops/index.ts`
- `test/recruiting-ops-delivery-ledger.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-delivery-ledger.test.ts test/recruiting-ops-autonomy.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Gate 4 targeted tests passed.
- RecOps check passed.
- Full test suite passed.
- Diff whitespace check passed.

Residual blockers:

- Gate evaluator is not implemented yet.
- The recruiter weekly req-progress shadow deliverable remains pending.
- External-channel delivery remains blocked until production adapters are approved.

Next gate:

- Gate 5: add the deterministic gate evaluator skeleton.

## 2026-06-26: Phase 0 Gate 5 Deterministic Gate Evaluator Skeleton

Completed gate:

- Added `lib/recruiting-ops/delivery-gates.ts` as a pure deterministic evaluator.
- Evaluated boundary, mode, freshness, discrepancy tolerance, source gap, template stability, recipient scope, PII posture, idempotency, trust period, and kill-switch gates.
- Returned verdicts of `authorized_for_shadow`, `authorized_for_review`, `authorized_for_auto_delivery`, `paused`, or `blocked`.
- Returned a local delivery-ledger entry draft with gate snapshots and status, without writing or calling adapters.
- Kept auto-delivery paused when no approved external delivery adapter is present.
- Added targeted tests for clean shadow authorization, kill-switch pause, stale warn/block behavior, recipient-scope blocking, trust-window blocking, and Phase 0 adapter boundary blocking.

Files changed:

- `lib/recruiting-ops/delivery-gates.ts`
- `lib/recruiting-ops/index.ts`
- `test/recruiting-ops-delivery-gates.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-delivery-gates.test.ts test/recruiting-ops-delivery-ledger.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Gate 5 targeted tests passed.
- RecOps check passed.
- Full test suite passed.
- Diff whitespace check passed.

Residual blockers:

- The recruiter weekly req-progress shadow deliverable remains pending.
- External-channel delivery remains blocked until production adapters are approved.

Next gate:

- Gate 6: add the first fixture-backed recruiter weekly req progress shadow deliverable.

## 2026-06-26: Phase 0 Gate 6 Recruiter Weekly Req Progress Shadow Deliverable

Completed gate:

- Added `lib/recruiting-ops/modules/recruiter-weekly-req-progress-shadow.ts`.
- Reused existing Greenhouse-style T02 fixture facts and T03 progress derivation to produce recruiter-scoped weekly req progress.
- Kept the recipient identity as a `sha256:` fingerprint and scoped rows to the requested req IDs without raw contact data.
- Wrote local JSON and CSV artifacts through the existing local renderer runtime.
- Evaluated delivery gates in `shadow` mode and appended a local JSONL delivery-log entry.
- Verified the gate evaluator authorizes local shadow but pauses production auto-delivery because no external delivery adapter is approved.
- Added the module to the `pipeline_movement_intelligence` capability binding and package barrel exports.
- Added tests for fixture artifact output, JSONL shadow log output, PII-safe summaries, and deterministic payload fingerprinting across reruns.

Files changed:

- `lib/recruiting-ops/modules/recruiter-weekly-req-progress-shadow.ts`
- `lib/recruiting-ops/capabilities.ts`
- `lib/recruiting-ops/index.ts`
- `test/recruiting-ops-recruiter-weekly-req-progress-shadow.test.ts`
- `docs/recruiting-ops/BUILD_PROGRESS.md`

Commands run:

- `npm test -- test/recruiting-ops-recruiter-weekly-req-progress-shadow.test.ts test/recruiting-ops-t02-t03-pipeline.test.ts test/recruiting-ops-delivery-gates.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Gate 6 targeted tests passed.
- RecOps check passed.
- Full test suite passed.
- Diff whitespace check passed.

Residual blockers:

- No external-channel delivery, production adapter, live Greenhouse write, broad PII persistence, production persistence migration, legacy retirement, or cutover is enabled.
- The first shadow deliverable uses fixtures only; live reads and production scheduling require future approval.

Next gate:

- Await the operator direction for the next post-Phase-0 workstream.

## 2026-06-26: Post-Phase-0 Guardrail Hardening (F1–F5)

Completed gate:

- Scope: the five low-severity hardening items from the approve-with-fixes Phase 0 review. No Phase 0 redesign; the contract foundation is unchanged.
- F1 — Central auto-delivery interlock. Added an always-on `auto-delivery-interlock` architecture-check rule that fails when `lib/recruiting-ops/**` implementation code opts into external auto-delivery before an adapter phase is approved: `externalDeliveryAdapterApproved: true`, `approvedExternalDeliveryAdapter: true`, `requestedDeliveryMode: "auto_delivery"`, or `autonomyState: "auto_delivering"` (comment-stripped; test files are excluded because they are not implementation files). The evaluator can still model auto-delivery in tests; shipped modules cannot opt in.
- F2 — Future-dated freshness guard. `evaluateFreshnessGate` no longer treats `sourceObservedAt > evaluatedAt` as fresh: a negative age now `warn`s on shadow/review paths and `fail`s on auto-delivery paths.
- F3 — Gate 0 symbol-missing regression test. Added a checker test where a claimed-complete gate file exists but omits a required export, asserting `[phase0-claimed-gate-implementation]` via the symbol-pattern branch (prior tests only exercised the missing-file branch).
- F4 — Ledger guarantees + lineage. Documented the local JSONL ledger's guarantees in code (local-only, append-only-in-practice, NOT tamper-evident) and added `validateDeliveryLedgerLineage` to enforce `correctionOf` / `supersededBy` referential integrity over an in-memory batch; cross-file/streaming enforcement is explicitly deferred until a durable store is approved.
- F5 — Seed matrix authority model. Added an "Authority Model" section to `AUTOMATION_DELIVERABLE_SEED_MATRIX.md` declaring the table authoritative for its columns and the code authoritative for `freshnessTtlMinutes`, `staleBehavior`, `recipientScopeRuleIds`, `readinessStatesAllowed`, and `piiPolicy`; a test locks the statement.
- Build hygiene (pre-existing, surfaced by `tsc`). Phase 0 had regressed `tsc --noEmit` while staying green on vitest + the architecture checker (neither type-checks): `output-contracts.ts` referenced `DeliverableAutonomyState` without importing it, and `autonomy.ts` typed `validateRecipientScopeRules`'s default param as the 5-tuple `as const`, so a `readonly RecipientScopeRule[]` argument was rejected. Fixed both (one type import, one param annotation) — no logic or contract change. `tsc --noEmit` is clean again. The type-check gap (the green path does not run `tsc`) is flagged for the operator as a future gate item.

Files changed:

- `scripts/recruiting-ops-architecture-check.mjs`
- `lib/recruiting-ops/delivery-gates.ts`
- `lib/recruiting-ops/delivery-ledger.ts`
- `lib/recruiting-ops/autonomy.ts` (pre-existing type-error fix)
- `lib/recruiting-ops/output-contracts.ts` (pre-existing type-error fix)
- `docs/recruiting-ops/AUTOMATION_DELIVERABLE_SEED_MATRIX.md`
- `docs/recruiting-ops/BUILD_PROGRESS.md`
- `test/recruiting-ops-architecture-check.test.ts`
- `test/recruiting-ops-delivery-gates.test.ts`
- `test/recruiting-ops-delivery-ledger.test.ts`
- `test/recruiting-ops-automation-seed-matrix.test.ts`

Commands run:

- `npm run check:recruiting-ops`
- `npm test`
- `./node_modules/.bin/tsc --noEmit`
- `git diff --check`

Residual blockers:

- Unchanged from Phase 0: no external-channel delivery, production adapter, live Greenhouse write, broad PII persistence, production persistence migration, scoped-MCP import, UI route, or legacy retirement/cutover. The interlock rule now makes a premature auto-delivery opt-in a build failure rather than a convention.

Next gate:

- Await the operator direction for the next post-Phase-0 workstream.

## 2026-06-25: Automation Control Plane Launch Artifacts

Completed gate:

- Added the Phase 0 automation-control-plane technical spec.
- Added the six-gate implementation plan for contract foundations.
- Added the deliverable seed matrix binding every concrete output contract to capability, lane, autonomy state, auto-eligibility, shadow requirement, and blocked/never-auto rationale.
- Added a paste-ready goal-mode prompt for the next implementation loop.
- Updated the docs source of truth so these launch artifacts are active and binding.
- Updated architecture checks to require the launch artifacts and their core contract language.

Files changed:

- `docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_TECHNICAL_SPEC.md`
- `docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_IMPLEMENTATION_PLAN.md`
- `docs/recruiting-ops/AUTOMATION_DELIVERABLE_SEED_MATRIX.md`
- `docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_GOAL_PROMPT.md`
- `docs/recruiting-ops/DOCS_SOURCE_OF_TRUTH.md`
- `docs/recruiting-ops/BUILD_PROGRESS.md`
- `scripts/recruiting-ops-architecture-check.mjs`
- `test/recruiting-ops-architecture-check.test.ts`

Residual blockers:

- TypeScript autonomy contracts are not implemented yet.
- Local autonomy/delivery/kill-switch ledgers are not implemented yet.
- External-channel delivery remains blocked until production adapters are approved.

Next gate:

- Implement Phase 0 TypeScript Autonomy Contracts.

## Prior Active Next Gate

Gate 1 (capability-first enforcement), Gate 2 (14-capability taxonomy, shared dimensions, report fidelity, credential-rotation gate), and the continuation fix pass are complete — see the dated closeout entries below. `lib/recruiting-ops/capabilities.ts` is the capability source of truth, the architecture checker enforces capability-first, capabilityId is required provenance through the run builders/validators/persistence/SQL, recruiter→team and stage attribution resolve through shared dimensions to a NULL defect, and zero `"unmapped"` attribution sentinels remain in the module layer.

At that historical point, the next gate was Contract Foundations for the Automation Control Plane:

- Add TypeScript contracts for deliverable autonomy, delivery logs, kill switches, and recipient scope rules.
- Split readiness from delivery authorization in code.
- Add freshness TTL and stale behavior to output contracts.
- Reconcile action proposal state names and add deferral/manual-execution attestation fields.
- Keep production writes, live Greenhouse writes, live persistence, broad PII persistence, and legacy retirement out of scope.

Explicitly-deferred follow-ups (each is a future goal, not a gap in the work done):

- Add the offer performance / target-vs-actual deliverable to `offer_and_hire_lifecycle_intelligence` once a targets input source is scoped (the only remaining report-fidelity item).
- Production adapters, live persistence, live Greenhouse writes, and legacy retirement remain out of scope until separately approved.

## 2026-06-25: Automation Control Plane Docs

Completed gate:

- Added active automation-control-plane docs for delivery autonomy, eligibility, quality gates, shadow/trust periods, and delivery logs.
- Updated the active source-of-truth docs so the command center is now framed as a capability-first automation control plane.
- Split the deliverable model conceptually: readiness is artifact safety/completeness; delivery authorization is the autonomy state.
- Added automation lane defaults for each capability in the audience/deliverable matrix.
- Reframed the action queue as action-proposal only; routine deterministic visibility deliverables should graduate toward auto-delivery when gates pass.
- Reframed the console IA around `/auto`, `/review`, `/actions`, `/deliveries`, `/capabilities`, `/deliverables`, `/evidence`, `/legacy-coverage`, and `/boundaries`.
- Updated architecture checks to require the new active docs and reject stale the operator-review-specific readiness terminology.

Files changed:

- `docs/recruiting-ops/AUTOMATION_CONTROL_PLANE.md`
- `docs/recruiting-ops/DELIVERY_AUTONOMY_MODEL.md`
- `docs/recruiting-ops/AUTOMATION_ELIGIBILITY_RUBRIC.md`
- `docs/recruiting-ops/AUTO_DELIVERY_QUALITY_GATES.md`
- `docs/recruiting-ops/SHADOW_MODE_AND_TRUST_PERIODS.md`
- `docs/recruiting-ops/DELIVERY_LOG_SPEC.md`
- active steering docs and architecture checker tests

Residual blockers:

- TypeScript autonomy contracts are not implemented yet.
- Local autonomy/delivery/kill-switch ledgers are not implemented yet.
- External-channel delivery remains blocked until production adapters are approved.

Next gate:

- Implement Contract Foundations for the Automation Control Plane in TypeScript.

## Residual Blockers

- No production Google Sheets/Docs write adapter is approved.
- No live Greenhouse write path is approved.
- Local artifacts must remain local and PII-safe.
- Live persistence adapters remain disabled unless the operator explicitly scopes them into a future goal.
- `npm run lint` remains outside the required green path until the unrelated existing lint baseline is fixed or explicitly scoped.
- Default `npm run build` may still fail in this worktree because Turbopack rejects the `node_modules` symlink as outside the filesystem root; use `./node_modules/.bin/next build --webpack` for application compile verification unless the worktree layout changes.

## Next Update Format

Each implementation gate should append:

- date,
- completed gate,
- files changed,
- commands run,
- test results,
- residual blockers,
- next gate.

## 2026-06-24: P1 Substrate Contracts

Completed gate:

- Implemented P1 command-center substrate contracts under `lib/recruiting-ops/**`.
- Added workflow runtime contracts over the P0 workflow registry.
- Added implementation-ready legacy artifact contracts and registry seeds for T07, T05, T02, T09, and T01.
- Added concrete local output contracts for first target workflows.
- Added run/evidence ledger contracts, source gap contracts, discrepancy classification helpers, and dry-run action proposal contracts.
- Added stable checksum/payload fingerprint helpers.
- Added public-output safety inspection/redaction helpers.

Files changed:

- `lib/recruiting-ops/action-proposals.ts`
- `lib/recruiting-ops/checksums.ts`
- `lib/recruiting-ops/discrepancies.ts`
- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `lib/recruiting-ops/legacy-artifacts.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/runs.ts`
- `lib/recruiting-ops/safe-public-output.ts`
- `lib/recruiting-ops/substrate.ts`
- `lib/recruiting-ops/workflow-contracts.ts`
- `test/recruiting-ops-action-proposals.test.ts`
- `test/recruiting-ops-discrepancies.test.ts`
- `test/recruiting-ops-public-output.test.ts`
- `test/recruiting-ops-runs.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-substrate.test.ts test/recruiting-ops-discrepancies.test.ts test/recruiting-ops-action-proposals.test.ts test/recruiting-ops-public-output.test.ts test/recruiting-ops-runs.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Targeted P1 tests passed: 5 files, 19 tests.
- RecOps check passed; architecture checker scanned 12 implementation files.
- Full test suite passed: 32 files, 251 tests.
- Diff whitespace check passed.

Residual blockers:

- No production Google Sheets/Docs write adapter is approved.
- No live Greenhouse write path is approved.
- Supabase migrations remain intentionally deferred until TypeScript contracts stabilize through module usage.
- P1B local artifact runtime and JSON/CSV renderers are still pending.
- Vertical modules are not started yet.

Next gate:

- Implement P1B local artifact runtime and local JSON/CSV renderers with temp-directory tests and public-output safety checks.
- Then start T07 Final Offer as the first Greenhouse-native vertical module.

## 2026-06-24: P1B Local Artifact Runtime

Completed gate:

- Added `.recruiting-ops-artifacts/` to `.gitignore`.
- Implemented local artifact path resolution and artifact writing in `lib/recruiting-ops/local-artifacts.ts`.
- Implemented local JSON renderer in `lib/recruiting-ops/renderers/json.ts`.
- Implemented local CSV renderer in `lib/recruiting-ops/renderers/csv.ts`.
- Exported local artifact helpers from `lib/recruiting-ops/index.ts`.
- Added temp-directory renderer tests with public-output safety coverage.

Files changed:

- `.gitignore`
- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/local-artifacts.ts`
- `lib/recruiting-ops/renderers/json.ts`
- `lib/recruiting-ops/renderers/csv.ts`
- `test/recruiting-ops-local-artifacts.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-local-artifacts.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Local artifact renderer tests passed: 1 file, 5 tests.
- RecOps check passed; architecture checker scanned 15 implementation files.
- Full test suite passed: 33 files, 256 tests.
- Diff whitespace check passed.

Residual blockers:

- No production Google Sheets/Docs write adapter is approved.
- No live Greenhouse write path is approved.
- XLSX renderer is not implemented yet; it remains deferred until a stakeholder-visible workbook shape requires it.
- Vertical modules are not started yet.

Next gate:

- Start T07 Final Offer as the first vertical module using Greenhouse-style fixture facts, Q12 legacy evidence registration, discrepancy classification, and local JSON/CSV artifact output.

## 2026-06-24: T07 Final Offer Vertical Module

Completed gate:

- Added shared vertical module result/definition types.
- Implemented `t07-final-offer` fixture runner.
- Normalized Greenhouse-style offer lifecycle facts into a final-offer local output shape.
- Registered Q12/`legacy_q12_final_offer` as evidence inside the runner.
- Classified source gaps and legacy Q12 differences as discrepancies instead of treating legacy output as canonical.
- Rendered local JSON and CSV artifacts through the P1B renderer runtime.
- Added `offer_id` to the concrete final-offer output contract after the T07 test exposed the missing column.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/types.ts`
- `lib/recruiting-ops/modules/t07-final-offer.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `test/recruiting-ops-t07-final-offer.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t07-final-offer.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T07 tests passed: 1 file, 5 tests.
- RecOps check passed; architecture checker scanned 17 implementation files.
- Full test suite passed: 34 files, 261 tests.
- Diff whitespace check passed.

Residual blockers:

- T07 currently uses fixture data, not live Greenhouse reads.
- Recruiter/sourcer/team/HOD mapping is represented as source-gap evidence when missing.
- XLSX output is still deferred.
- No production writes are enabled.

Next gate:

- Start T05 RPS / scorecard accountability as the next vertical module, using Greenhouse-style scorecard/interview fixture facts, Q11 as legacy evidence, discrepancy classification, and local JSON/CSV output.

## 2026-06-24: T05 RPS Vertical Module

Completed gate:

- Implemented `t05-rps` fixture runner.
- Normalized Greenhouse-style interview and scorecard facts into an RPS accountability output shape.
- Added explicit interview taxonomy and scorecard status normalization.
- Registered Q11/`legacy_q11_rps_tracking` as evidence inside the runner.
- Classified open taxonomy/status mappings and legacy Q11 differences as discrepancies.
- Rendered local JSON and CSV artifacts through the local renderer runtime.
- Added `interview_id` and `interviewer_name` to the concrete RPS output contract.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t05-rps.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `test/recruiting-ops-t05-rps.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t05-rps.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T05 tests passed: 1 file, 5 tests.
- RecOps check passed; architecture checker scanned 18 implementation files.
- Full test suite passed: 35 files, 266 tests.
- Diff whitespace check passed.

Residual blockers:

- T05 currently uses fixture data, not live Greenhouse reads.
- Scorecard/interview taxonomy still needs owner review against live Greenhouse stage names before cutover.
- XLSX/pivot workbook output remains deferred.
- No production writes are enabled.

Next gate:

- Start T02/T03 pipeline and progress using Greenhouse-style application stage fixture facts, Q04-Q09 as legacy evidence, stage taxonomy/source-gap classification, local JSON/CSV output, and T03 progress derived from T02 facts.

## 2026-06-24: T02/T03 Pipeline And Progress Modules

Completed gate:

- Implemented `t02-pipeline` fixture runner.
- Normalized Greenhouse-style application stage movement facts into reusable pipeline rows.
- Added explicit stage taxonomy, week bucket, and dedupe key generation.
- Registered Q04-Q09/`legacy_q04_q09_pipeline_family` as evidence inside the T02 runner.
- Classified open stage/date mappings and legacy pipeline differences as discrepancies.
- Implemented `t03-progress` as a derived module over T02 pipeline rows.
- Rendered local JSON and CSV artifacts for both T02 and T03.
- Added `week_bucket` and `dedupe_key` to the concrete role-pipeline output contract.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t02-pipeline.ts`
- `lib/recruiting-ops/modules/t03-progress.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `test/recruiting-ops-t02-t03-pipeline.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t02-t03-pipeline.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T02/T03 tests passed: 1 file, 6 tests.
- RecOps check passed; architecture checker scanned 20 implementation files.
- Full test suite passed: 36 files, 272 tests.
- Diff whitespace check passed.

Residual blockers:

- T02/T03 currently use fixture data, not live Greenhouse reads.
- Stage taxonomy still needs owner review against live Greenhouse stage names before cutover.
- T04 graph and T18 Slack draft remain downstream consumers, not implemented in this gate.
- No production writes are enabled.

Next gate:

- Start T09 Role Assignment / ownership workload using Greenhouse-style job/opening/hiring-team fixture facts, Q13/Q14 as legacy evidence, discrepancy classification, and local JSON/CSV output.

## 2026-06-24: T09 Ownership / Workload Module

Completed gate:

- Implemented `t09-ownership` fixture runner.
- Normalized Greenhouse-style ownership facts into job-level rows and recruiter workload rows.
- Registered Q13/Q14/`legacy_q13_q14_role_assignment` as evidence inside the runner.
- Classified missing ownership mappings and legacy role-assignment differences as discrepancies.
- Rendered local JSON and CSV artifacts through the local renderer runtime.
- Added `view_type` and `workload_count` to the concrete role-assignment output contract.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t09-ownership.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `test/recruiting-ops-t09-ownership.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t09-ownership.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T09 tests passed: 1 file, 5 tests.
- RecOps check passed; architecture checker scanned 21 implementation files.
- Full test suite passed: 37 files, 277 tests.
- Diff whitespace check passed.

Residual blockers:

- T09 currently uses fixture data, not live Greenhouse reads.
- Pod/team ownership mapping still needs owner review against live Greenhouse configuration before cutover.
- No production writes are enabled.

Next gate:

- Start T01 weekly leadership rollup by composing T07, T05, T02/T03, and T09 facts into a leadership-safe aggregate output with Q01-Q03 as legacy evidence.

## 2026-06-24: T01 Weekly Leadership Rollup

Completed gate:

- Implemented `t01-weekly-leadership` fixture runner.
- Composed leadership rows from T07 final-offer facts, T05 RPS facts, T02 pipeline facts, and T09 ownership facts.
- Registered Q01-Q03/`legacy_q01_q03_weekly_recruitment` as evidence inside the runner.
- Classified ownership gaps and legacy weekly-report differences as discrepancies.
- Rendered local JSON and CSV leadership-safe artifacts.
- Added `rps_missing_count`, `openings_count`, and `recruiter_name` to the concrete weekly recruitment output contract.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t01-weekly-leadership.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `test/recruiting-ops-t01-weekly-leadership.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t01-weekly-leadership.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T01 tests passed: 1 file, 5 tests.
- RecOps check passed; architecture checker scanned 22 implementation files.
- Full test suite passed: 38 files, 282 tests.
- Diff whitespace check passed.

Residual blockers:

- T01 currently composes fixture facts, not live Greenhouse reads.
- Manual leadership fields/carry-forward strategy is represented structurally but not connected to a live legacy Sheet.
- No production writes are enabled.

Next gate:

- Completion audit for the current goal: confirm P1 substrate, local renderers, T07, T05, T02/T03, T09, and T01 are implemented, tested, architecture-checked, and committed.

## 2026-06-24: Local Command Center Runner and Greenhouse Read Boundary

Completed gate:

- Implemented a read-only Greenhouse extraction boundary contract for T07, T05, T02/T03, and T09.
- Added a fixture-backed Greenhouse read boundary that exposes sanitized Greenhouse-shaped facts without network calls or write-capable clients.
- Added sanitized fixture files for final offers, RPS/scorecards, pipeline/stage movement, ownership/workload, and legacy evidence.
- Implemented `runLocalCommandCenterWorkflow`, which runs T07, T05, T02, T03, T09, and T01 in dependency order.
- Confirmed the runner writes only local JSON/CSV artifacts under caller-provided temp/local roots.
- Kept live Greenhouse calls, production writes, Supabase migrations, warehouse/dbt/Looker-default paths, and UI work out of scope.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/extractors/greenhouse-read-boundary.ts`
- `lib/recruiting-ops/workflow-runner.ts`
- `test/fixtures/recruiting-ops/greenhouse-final-offers.json`
- `test/fixtures/recruiting-ops/greenhouse-rps.json`
- `test/fixtures/recruiting-ops/greenhouse-pipeline.json`
- `test/fixtures/recruiting-ops/greenhouse-ownership.json`
- `test/fixtures/recruiting-ops/legacy-evidence.json`
- `test/recruiting-ops-greenhouse-read-boundary.test.ts`
- `test/recruiting-ops-local-workflow-runner.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-greenhouse-read-boundary.test.ts test/recruiting-ops-local-workflow-runner.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Greenhouse boundary and local workflow runner tests passed: 2 files, 3 tests.
- RecOps check passed; architecture checker scanned 24 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 40 files, 285 tests.
- Diff whitespace check passed.

Residual blockers:

- Greenhouse extraction is still fixture-backed; live read adapters remain intentionally unimplemented.
- The workflow runner currently executes local artifact renders only; no Google Sheets/Docs/Slack/Power BI writes are enabled.
- Fixture facts prove contract shape, not complete production coverage of all legacy task variants.

Next gate:

- Add an explicit live Greenhouse read-adapter plan and mapping tests for T07, T05, T02/T03, and T09 before enabling any authenticated network reads.

## 2026-06-24: Greenhouse Harvest Read Adapter Contracts

Completed gate:

- Added a command-center Harvest read-client interface that can later bind to the existing GET-only Greenhouse transport without coupling modules to auth, fetch, or credentials.
- Added explicit endpoint plans for T07 final offers, T05 RPS/scorecards, T02/T03 pipeline/stage movement, and T09 ownership/workload.
- Implemented Harvest-shaped payload mappers into the existing vertical module fact contracts.
- Added a client-backed `GreenhouseReadBoundary` builder that works with an in-memory fake client and performs no network calls.
- Added fake-client mapping tests for offers, scheduled interviews, applications/stage history, and jobs/ownership payloads.
- Kept live Greenhouse calls, production writes, Greenhouse writes, warehouse/dbt/Looker-default paths, and UI work out of scope.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/extractors/greenhouse-harvest-read-adapter.ts`
- `test/recruiting-ops-greenhouse-harvest-read-adapter.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-greenhouse-harvest-read-adapter.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Greenhouse Harvest read adapter tests passed: 1 file, 3 tests.
- RecOps check passed; architecture checker scanned 25 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 41 files, 288 tests.
- Diff whitespace check passed.

Residual blockers:

- The adapter remains fake-client only; no authenticated Greenhouse read binding is enabled.
- Endpoint field coverage is a tested contract shape, not live API validation.
- Date-window and req-bundle filtering are still caller-provided params, not production scheduling policy.

Next gate:

- Start the remaining local/dry-run workflow buildout with T04 FDL Pipeline Graph as a local chart-data module derived from T02 pipeline facts and Q10 as legacy evidence.

## 2026-06-24: T04 FDL Pipeline Graph Module

Completed gate:

- Implemented `t04-pipeline-graph` as a local chart-data module derived from T02 pipeline rows.
- Added a concrete local output contract for `pipeline_graph_sheet`.
- Registered `legacy_q10_pipeline_graph` as Q10 evidence, not canonical truth.
- Aggregated chart-safe graph points by req group, week, and stage with deterministic stage order and movement share.
- Classified unresolved upstream stage/week mappings as source gaps and Q10 movement-count differences as review discrepancies.
- Rendered local JSON and CSV artifacts through the existing local renderer runtime.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t04-pipeline-graph.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t04-pipeline-graph.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t04-pipeline-graph.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T04/substrate targeted tests passed: 2 files, 11 tests.
- RecOps check passed; architecture checker scanned 26 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 42 files, 293 tests.
- Diff whitespace check passed.

Residual blockers:

- T04 derives from local T02 rows only; no UI chart renderer or production Sheet write exists.
- Q10 legacy evidence has a typed artifact contract but no captured live workbook sample attached.
- Stage taxonomy remains inherited from T02 and still needs owner review against live Greenhouse stage names before cutover.

Next gate:

- Implement T06 ELT Recruiting Updates as a local doc-section/narrative draft module composed from command-center facts with human-review output and no Google Docs writes.

## 2026-06-24: T06 ELT Recruiting Updates Module

Completed gate:

- Implemented `t06-elt-recruiting-updates` as a deterministic local doc-section draft module.
- Added a concrete local output contract for `elt_recruiting_doc`.
- Registered `legacy_elt_recruiting_update_doc` as Google Docs evidence and compatibility target, not canonical truth.
- Derived human-review-required ELT sections from T01 weekly leadership rows and optional T04 graph rows.
- Classified missing upstream leadership facts as source gaps and legacy doc prose differences as intentional modernization.
- Rendered local JSON and CSV artifacts only; no Google Docs write adapter was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t06-elt-recruiting-updates.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t06-elt-recruiting-updates.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t06-elt-recruiting-updates.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T06/substrate targeted tests passed: 2 files, 11 tests.
- RecOps check passed; architecture checker scanned 27 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 43 files, 298 tests.
- Diff whitespace check passed.

Residual blockers:

- T06 produces local doc-section rows only; no Google Docs read/write integration exists.
- Legacy ELT doc section structure still needs owner capture before any production adapter.
- Narrative drafts are deterministic and human-review-required; model-authored leadership prose remains out of scope for this gate.

Next gate:

- Implement T08 All Hires Tracker as an external automation monitor/custody module with local health artifacts and no Apps Script or Sheet writes.

## 2026-06-24: T08 All Hires Tracker Monitor

Completed gate:

- Implemented `t08-all-hires-tracker` as a local monitor/custody module for the existing All Hires automation.
- Added a concrete local output contract for `all_hires_sheet`.
- Registered `legacy_all_hires_apps_script` as Apps Script custody evidence, with explicit source-export and credential-reissue blockers.
- Normalized Greenhouse-style hire facts and Apps Script automation health facts into local review rows.
- Classified missing or risky Apps Script trigger/custody evidence as source gaps.
- Rendered local JSON and CSV artifacts only; no Apps Script, Google Sheets, or credential handling path was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t08-all-hires-tracker.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t08-all-hires-tracker.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t08-all-hires-tracker.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T08/substrate targeted tests passed: 2 files, 11 tests.
- RecOps check passed; architecture checker scanned 28 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 44 files, 303 tests.
- Diff whitespace check passed.

Residual blockers:

- T08 is monitor/custody only; the existing Apps Script remains external.
- Sanitized Apps Script source, trigger owner, execution history, and reissued credential evidence still need capture.
- No production Google Sheets or Apps Script writes are enabled.

Next gate:

- Implement T10 Recruiter Daily Report as a dormant-template/resume-gate module that preserves Q15 evidence and blocks execution until explicitly resumed.

## 2026-06-24: T10 Recruiter Daily Report Dormant Resume Gate

Completed gate:

- Implemented `t10-recruiter-daily-report` as a dormant-template/resume-gate module.
- Added a concrete local output contract for `recruiter_daily_sheet`.
- Registered `legacy_q15_recruiter_daily_report` as Q15/template evidence with the dormant execution posture preserved.
- Kept the default T10 state blocked/dormant unless resume is explicitly requested and the template is preserved.
- Classified dormant blocking as intentional modernization and LAST_RUN_DATE mismatches as stale mapping.
- Rendered local JSON and CSV artifacts only; no SQL execution or Sheet write path was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t10-recruiter-daily-report.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t10-recruiter-daily-report.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t10-recruiter-daily-report.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T10/substrate targeted tests passed: 2 files, 12 tests.
- RecOps check passed; architecture checker scanned 29 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 45 files, 309 tests.
- Diff whitespace check passed.

Residual blockers:

- T10 remains dormant by design; execution requires explicit the operator approval and current-consumer validation.
- Q15/template evidence is represented structurally but no live workbook/template sample is attached.
- No SQL execution, Apps Script execution, or production Google Sheet writes are enabled.

Next gate:

- Implement T12 RC Tracker Monitoring as a local external-sheet monitor with exception flags and owner follow-up queue artifacts.

## 2026-06-24: T12 RC Tracker Monitoring Module

Completed gate:

- Implemented `t12-rc-tracker-monitoring` as a local external-sheet monitor module.
- Added a concrete local output contract for `rc_tracker_sheet`.
- Registered `legacy_rc_tracker_sheet` as external Sheet evidence and compatibility target.
- Normalized source rows into status, exception flag, exception reason, and owner follow-up fields.
- Classified missing source extracts, unknown status taxonomy, and unmapped owners as source gaps.
- Rendered local JSON and CSV artifacts only; no Google Sheets read/write adapter was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t12-rc-tracker-monitoring.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t12-rc-tracker-monitoring.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t12-rc-tracker-monitoring.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T12/substrate targeted tests passed: 2 files, 11 tests.
- RecOps check passed; architecture checker scanned 30 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 46 files, 314 tests.
- Diff whitespace check passed.

Residual blockers:

- T12 uses local source-row fixtures only; no Google Sheets adapter or production read/write is enabled.
- Exact RC Tracker sheet link, owner, and accepted status/exception semantics still need capture.
- Follow-up rows are local artifacts, not routed notifications.

Next gate:

- Implement T13 Power BI Dashboard Monitoring as a local dashboard registry/refresh-alert triage module with no Power BI API dependency.

## 2026-06-24: T13 Power BI Dashboard Monitoring Module

Completed gate:

- Implemented `t13-power-bi-dashboard-monitoring` as a local dashboard registry and refresh-alert triage module.
- Added a concrete local output contract for `power_bi_dashboard_alerts`.
- Registered `legacy_power_bi_dashboard_registry` as Power BI evidence and compatibility target.
- Normalized dashboard inventory rows into refresh status, alert severity, and triage-required fields.
- Classified missing dashboard inventory, unknown refresh status taxonomy, and unmapped dashboard owners as source gaps.
- Rendered local JSON and CSV artifacts only; no Power BI API dependency or credential path was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t13-power-bi-dashboard-monitoring.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t13-power-bi-dashboard-monitoring.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t13-power-bi-dashboard-monitoring.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T13/substrate targeted tests passed: 2 files, 11 tests.
- RecOps check passed; architecture checker scanned 31 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 47 files, 319 tests.
- Diff whitespace check passed.

Residual blockers:

- T13 uses local dashboard facts only; workspace access, alert routing, and dashboard inventory still need capture.
- No Power BI API integration, alert email ingestion, or production adapter is enabled.
- T13 triage rows are local artifacts, not routed notifications.

Next gate:

- Implement T14 Power BI RLS / the BI vendor Coordination as a local access-matrix and vendor-coordination evidence module.

## 2026-06-24: T14 Power BI RLS / the BI vendor Coordination Module

Completed gate:

- Implemented `t14-power-bi-rls-coordination` as a local access-matrix and vendor-coordination evidence module.
- Added a concrete local output contract for `power_bi_rls_matrix`.
- Registered `legacy_power_bi_rls_vendor_packet` as Power BI/the BI vendor evidence and compatibility target.
- Normalized RLS access facts and the BI vendor coordination facts into review-gated local rows.
- Classified missing RLS matrix, missing vendor context, open status taxonomy, and unmapped owners as source gaps.
- Rendered local JSON and CSV artifacts only; no Power BI, the BI vendor, payment, or Google Sheet adapter was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t14-power-bi-rls-coordination.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t14-power-bi-rls-coordination.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t14-power-bi-rls-coordination.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T14/substrate targeted tests passed: 2 files, 11 tests.
- RecOps check passed; architecture checker scanned 32 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 48 files, 324 tests.
- Diff whitespace check passed.

Residual blockers:

- T14 remains human/vendor coordination; no vendor, payment, Power BI, or Google Sheet write path exists.
- Actual RLS matrix, the BI vendor owner, payment status, and support context still need capture.
- Rows are local evidence artifacts, not routed approvals or vendor communications.

Next gate:

- Implement T15 Duplicate Candidate Check Agent as a local duplicate-review queue module using Greenhouse-shaped facts and n8n/Mailgun custody evidence only.

## 2026-06-24: T15 Duplicate Candidate Review Queue

Completed gate:

- Implemented `t15-duplicate-candidate-review` as a local duplicate-candidate review queue module.
- Added a concrete local output contract for `duplicate_candidate_review_queue`.
- Registered `legacy_duplicate_candidate_n8n_workflow` as n8n/Mailgun custody evidence and compatibility target.
- Normalized Greenhouse-shaped duplicate application-pair facts into review rows using application identifiers only.
- Classified missing duplicate evidence, missing n8n/Mailgun custody, and unmapped review owners as source gaps.
- Rendered local JSON and CSV artifacts only; no n8n execution, Mailgun call, candidate contact field, or live write path was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t15-duplicate-candidate-review.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t15-duplicate-candidate-review.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t15-duplicate-candidate-review.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T15/substrate targeted tests passed: 2 files, 11 tests.
- RecOps check passed; architecture checker scanned 33 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 49 files, 329 tests.
- Diff whitespace check passed.

Residual blockers:

- n8n workflow export, Mailgun credential ownership, business rules, and sample outputs still need capture.
- Duplicate queue rows use local facts only; no live Greenhouse read, n8n execution, or Mailgun integration is enabled.
- Review rows require human owner review before any action.

Next gate:

- Implement T16 n8n Workflow Setup as a custody packet and dry-run event-log module for n8n/Mailgun dependencies.

## 2026-06-24: T16 n8n Workflow Setup Module

Completed gate:

- Implemented `t16-n8n-workflow-setup` as a local custody packet and disabled-safe dry-run event-log module.
- Added a concrete local output contract for `n8n_custody_packet`.
- Registered `legacy_n8n_mailgun_custody_packet` as n8n/Mailgun custody evidence and compatibility target.
- Normalized workflow export facts, Mailgun custody facts, and dry-run event facts into review-gated local rows.
- Classified missing workflow export, missing Mailgun custody, missing dry-run evidence, and unmapped custody owners as source gaps.
- Rendered local JSON and CSV artifacts only; no n8n client, Mailgun client, network call, or production adapter was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t16-n8n-workflow-setup.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t16-n8n-workflow-setup.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t16-n8n-workflow-setup.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T16/substrate targeted tests passed: 2 files, 12 tests.
- RecOps check passed; architecture checker scanned 34 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 50 files, 335 tests.
- Diff whitespace check passed.

Residual blockers:

- n8n workflow export, Mailgun custody owner, disabled-safe dry-run sample evidence, and credential rotation decisions still need capture.
- T16 rows are local custody artifacts only; no n8n execution, Mailgun integration, or production adapter is enabled.
- Cutover/retirement remains blocked until Operator approves after witnessed evidence.

Next gate:

- Implement T17 Apps Script Development as a local script-asset registry and trigger/scope custody module with no Apps Script or Sheets write adapter.

## 2026-06-24: T17 Apps Script Development Module

Completed gate:

- Implemented `t17-apps-script-development` as a local Apps Script asset registry and custody module.
- Added a concrete local output contract for `apps_script_asset_registry`.
- Registered `legacy_apps_script_asset_registry` as Apps Script custody evidence and compatibility target.
- Used the P0 `scriptAssetRegistry` as the required Apps Script asset list so known scripts cannot be silently dropped.
- Normalized project export, trigger, scope, custody owner, and custody-posture facts into local review rows.
- Classified missing registered assets, incomplete exports, incomplete trigger ownership, scope review/rotation issues, unsafe ownership posture, and unmapped owners as source gaps.
- Rendered local JSON and CSV artifacts only; no Apps Script API, Google Sheets API, trigger execution, or production adapter was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t17-apps-script-development.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t17-apps-script-development.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t17-apps-script-development.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T17/substrate targeted tests passed: 2 files, 12 tests.
- RecOps check passed; architecture checker scanned 35 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 51 files, 341 tests.
- Diff whitespace check passed.

Residual blockers:

- Sanitized Apps Script source exports, trigger metadata, scope review, owner custody, and service-identity/rotation evidence still need capture.
- T17 rows are local custody artifacts only; no Apps Script execution, Sheets writes, or production adapter is enabled.
- Retiring or replacing scripts remains out of scope until Operator approves after witnessed evidence.

Next gate:

- Implement T18 Recruiter Lead Slack Updates as a local Slack-draft renderer over T02/T03-style facts with human-send gating and no Slack API calls.

## 2026-06-24: T18 Recruiter Lead Slack Updates Module

Completed gate:

- Implemented `t18-recruiter-lead-slack-updates` as a local Slack-draft renderer with human-send gating.
- Added a concrete local output contract for `recruiter_lead_slack_draft`.
- Registered `legacy_recruiter_lead_slack_update_pattern` as Slack-format evidence and compatibility target.
- Normalized T02/T03-style recruiter lead update facts into draft rows with source workflow lineage.
- Classified missing source lineage, unmapped lead names, missing input facts, and invalid metric evidence as source gaps.
- Rendered local JSON and CSV artifacts only; no Slack API route, Slack agent import, message send, or production adapter was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t18-recruiter-lead-slack-updates.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t18-recruiter-lead-slack-updates.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t18-recruiter-lead-slack-updates.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T18/substrate targeted tests passed: 2 files, 12 tests.
- RecOps check passed; architecture checker scanned 36 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 52 files, 347 tests.
- Diff whitespace check passed.

Residual blockers:

- Accepted Slack examples, recipient/channel rules, and reviewer ownership still need capture.
- T18 rows are local draft artifacts only; no Slack send path or agent integration is enabled.
- Drafts remain human-reviewed and human-sent until the operator explicitly approves a later adapter gate.

Next gate:

- Implement T19 Validation Coordination as a local signoff/evidence log that can reconcile module runs and owner attestations without posting to Slack or writing Sheets.

## 2026-06-24: T19 Validation Coordination Module

Completed gate:

- Implemented `t19-validation-coordination` as a local validation/signoff ledger over module runs, evidence counts, discrepancies, source gaps, and owner attestations.
- Added a concrete local output contract for `validation_signoff_log`.
- Registered `legacy_validation_coordination_log` as validation tracker/signoff evidence and compatibility target.
- Normalized validation target facts and owner attestations into accepted, needs-review, missing-evidence, and blocked states.
- Classified missing validation targets, missing evidence, missing accepted attestation, and unmapped owners as source gaps.
- Rendered local JSON and CSV artifacts only; no Slack notification, Sheets write, or production adapter was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t19-validation-coordination.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t19-validation-coordination.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t19-validation-coordination.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T19/substrate targeted tests passed: 2 files, 12 tests.
- RecOps check passed; architecture checker scanned 37 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 53 files, 353 tests.
- Diff whitespace check passed.

Residual blockers:

- Accepted evidence examples, owner attestation format, and review cadence still need capture.
- T19 rows are local validation artifacts only; no Slack posting, Sheets writes, or production adapter is enabled.
- Validation acceptance remains an explicit human gate before cutover/retirement.

Next gate:

- Implement T20/T21 the operator Handoff Preparation as a local readiness dashboard over workflow coverage, access custody, SOP closure, and acceptance gates.

## 2026-06-24: T20/T21 the operator Handoff Preparation Module

Completed gate:

- Implemented `t20-t21-handoff-preparation` as a local handoff-readiness dashboard over workflow coverage, access custody, SOP closure, evidence, and the operator acceptance gates.
- Added a concrete local output contract for `handoff_readiness_dashboard`.
- Registered `legacy_handoff_readiness_tracker` as transition tracker/readiness evidence and compatibility target.
- Preserved the combined `T20/T21` workflow ID from the P0 registry and source-doc numbering inconsistency.
- Normalized readiness facts and the operator signoff facts into accepted, ready, needs-evidence, blocked, not-started, and unknown states.
- Classified missing readiness facts, missing evidence, unresolved blockers, missing the operator signoff, and unmapped owners as source gaps.
- Rendered local JSON and CSV artifacts only; no Google Docs/Sheets write, cutover action, retirement action, or production adapter was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/t20-t21-handoff-preparation.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-t20-t21-handoff-preparation.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-t20-t21-handoff-preparation.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- T20/T21/substrate targeted tests passed: 2 files, 12 tests.
- RecOps check passed; architecture checker scanned 38 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 54 files, 359 tests.
- Diff whitespace check passed.

Residual blockers:

- Final readiness checklist, required evidence semantics, and the operator acceptance semantics still need capture.
- T20/T21 rows are local readiness artifacts only; no Docs/Sheets writes, retirement, or cutover is enabled.
- Closeout remains a human acceptance gate.

Next gate:

- Implement S01/S02/S05/S06/S07 local admin action queues and S03/S04 local support queues as dry-run/proposal capabilities only.

## 2026-06-24: S01/S02/S05/S06/S07 Admin Action Queues

Completed gate:

- Implemented `s-admin-action-queues` as dry-run proposal queue modules for S01, S02, S05, S06, and S07.
- Reused the existing `buildActionProposal` substrate so every row remains fingerprinted, redacted, and `noLiveExecution: true`.
- Added concrete local output contracts for `requisition_action_queue`, `offer_action_queue`, `greenhouse_user_action_queue`, `linkedin_manual_action_queue`, and `google_groups_action_queue`.
- Registered legacy admin runbook artifacts for requisitions, offers, Greenhouse users, LinkedIn users, and Google Groups.
- Scoped each runner to its requested workflow so S05 cannot render S01 proposals from a mixed input batch.
- Classified missing scoped requests, missing evidence, target-system mismatches, blocked/rejected proposals, and never-tier actions as source gaps.
- Rendered local JSON and CSV artifacts only; no Greenhouse, LinkedIn, Google Admin, or production write adapter was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/s-admin-action-queues.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-s-admin-action-queues.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-s-admin-action-queues.test.ts test/recruiting-ops-substrate.test.ts test/recruiting-ops-action-proposals.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- S-admin/substrate/action-proposal targeted tests passed: 3 files, 15 tests.
- RecOps check passed; architecture checker scanned 39 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 55 files, 364 tests.
- Diff whitespace check passed.

Residual blockers:

- S01/S02/S05/S06/S07 remain dry-run proposal queues only; no admin mutation, approval execution, provisioning, group update, or vendor action is enabled.
- Approver identity, allowed manual steps, forbidden actions, and witnessed walkthrough evidence still need capture.
- Never-tier actions remain blocked from approval in the proposal substrate.

Next gate:

- Implement S03/S04 local support queues for Greenhouse clarifications and recruiting inbox drafts with human-owner/human-send gating only.

## 2026-06-24: S03/S04 Support Queues

Completed gate:

- Implemented `s-support-queues` as local support queue modules for S03 Greenhouse clarifications and S04 recruiting inbox responses.
- Added concrete local output contracts for `greenhouse_clarification_log` and `recruiting_inbox_queue`.
- Registered legacy support runbook artifacts for S03 and S04.
- Normalized Greenhouse clarification facts into owner-reviewed case rows.
- Normalized recruiting inbox triage facts into local draft rows with `human_action_required`.
- Classified missing support rows, missing evidence, unmapped owners, blocked/unknown statuses, and missing inbox draft responses as source gaps.
- Rendered local JSON and CSV artifacts only; no Gmail send, Slack route, Greenhouse update, or production adapter was added.

Files changed:

- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/s-support-queues.ts`
- `lib/recruiting-ops/output-contracts.ts`
- `lib/recruiting-ops/legacy-artifact-registry.ts`
- `test/recruiting-ops-s-support-queues.test.ts`
- `test/recruiting-ops-substrate.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-s-support-queues.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- S03/S04/substrate targeted tests passed: 2 files, 12 tests.
- RecOps check passed; architecture checker scanned 40 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 56 files, 370 tests.
- Diff whitespace check passed.

Residual blockers:

- S03/S04 remain local support queues only; no Gmail send, Slack post, Greenhouse update, or production adapter is enabled.
- Accepted examples, triage categories, owner rules, and escalation paths still need capture.
- Human-owner review and human-send gating remain required.

Next gate:

- Evaluate persistence readiness now that TypeScript contracts, local renderers, vertical modules, and dry-run support/action queues are implemented.

## 2026-06-24: Command Center Persistence Substrate

Completed gate:

- Added Supabase migration `010_recruiting_ops_command_center.sql` for non-production command-center persistence.
- Created tables for workflow registry, legacy artifact registry, output contracts, runs, run evidence refs, run artifacts, source gaps, discrepancy classes, discrepancies, and dry-run action proposals.
- Seeded discrepancy classes in the migration.
- Added hard schema checks for `production_write_enabled = false` and `no_live_execution = true`.
- Added pure TypeScript persistence row-mapping helpers in `lib/recruiting-ops/persistence.ts`.
- Added tests that validate table coverage, non-production boundaries, registry row mappings, run/evidence/artifact/source-gap/discrepancy row mappings, and dry-run action proposal redaction.
- Did not add a Supabase writer, migration runner, network call, production adapter, live write path, or broad raw payload storage.

Files changed:

- `supabase/migrations/010_recruiting_ops_command_center.sql`
- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/persistence.ts`
- `test/recruiting-ops-persistence.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-persistence.test.ts test/recruiting-ops-substrate.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Persistence/substrate targeted tests passed: 2 files, 11 tests.
- RecOps check passed; architecture checker scanned 41 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 57 files, 375 tests.
- Diff whitespace check passed.

Residual blockers:

- Persistence is schema and pure row-shape mapping only; no Supabase write client or migration application was executed.
- Any live persistence adapter, backfill, hosted DB migration, or production data movement requires explicit the operator approval.
- Raw candidate/application payload storage remains out of scope.

Next gate:

- Build the read-only `/recruiting-ops` UI console over local registry/module status and optional persisted run shapes, without external network calls or production writes.

## 2026-06-24: Read-only `/recruiting-ops` Console

Completed gate:

- Added local console data assembly in `lib/recruiting-ops/console-data.ts`.
- Added a read-only App Router route at `app/recruiting-ops/page.tsx`.
- Added the `RECOPS` nav item to the shared app header.
- Rendered local workflow coverage, implementation readiness, persistence ledger schema readiness, dry-run action queue count, and active non-production boundaries.
- Kept the route static/local: no Supabase reads, API routes, browser fetches, external network calls, production writes, or live adapters.
- Added console data tests that assert every required workflow is local-ready and all non-production boundaries remain off.
- Fixed command-center TypeScript compile narrowing on validated registry lookups and tightened two negative-test casts so full project type checking passes.

Files changed:

- `app/app-header.tsx`
- `app/recruiting-ops/page.tsx`
- `lib/recruiting-ops/console-data.ts`
- `lib/recruiting-ops/index.ts`
- `lib/recruiting-ops/modules/*.ts`
- `test/recruiting-ops-console-data.test.ts`
- `test/recruiting-ops-action-proposals.test.ts`
- `test/recruiting-ops-discrepancies.test.ts`

Commands run:

- `npm test -- test/recruiting-ops-console-data.test.ts test/recruiting-ops-registries.test.ts`
- `npm run check:recruiting-ops`
- `npm test`
- `npm run build` (failed before app compilation on Turbopack symlink-root panic in this worktree)
- `./node_modules/.bin/next build --webpack`
- `./node_modules/.bin/tsc --noEmit --incremental false`
- `git diff --check`

Test results:

- Console/registry targeted tests passed: 2 files, 9 tests.
- RecOps check passed; architecture checker scanned 43 implementation files.
- Registry coverage test passed: 1 file, 7 tests.
- Full test suite passed: 58 files, 377 tests.
- `next build --webpack` passed and prerendered `/recruiting-ops` as a static route.
- Direct TypeScript check passed with incremental output disabled.
- Default `npm run build` still fails before compilation because Turbopack rejects this worktree's `node_modules` symlink as outside the filesystem root; webpack build verifies application code.
- Diff whitespace check passed.

Residual blockers:

- `/recruiting-ops` currently reads local registry/module state only; no persisted Supabase adapter is enabled.
- Dev/prod server visual QA is still pending.
- Enabling live persistence reads, production writes, external network calls, or live action adapters requires explicit the operator approval.

Next gate:

- Start a local dev server and perform a browser sanity check of `/recruiting-ops`; then close the goal if the worktree remains clean and all required checks still pass.

## 2026-06-24: Local Console Sanity Check

Completed gate:

- Started the local Next dev server with webpack on port `3010`.
- Requested `http://127.0.0.1:3010/recruiting-ops` and received HTTP `200`.
- Verified rendered HTML contains the expected console markers: `Command Center`, `WORKFLOW REGISTRY`, `PERSISTENCE LEDGER`, `ACTIVE BOUNDARIES`, and `RECOPS`.
- Left the server running at `http://localhost:3010` for local review.

Commands run:

- `./node_modules/.bin/next dev --webpack -p 3010`
- `curl -sS -o /tmp/recruiting-ops-console.html -w "%{http_code}" http://127.0.0.1:3010/recruiting-ops`
- `rg -n "Command Center|WORKFLOW REGISTRY|PERSISTENCE LEDGER|ACTIVE BOUNDARIES|RECOPS" /tmp/recruiting-ops-console.html`
- `npm run check:recruiting-ops`
- `npm test`
- `git diff --check`

Test results:

- Local route sanity check passed with HTTP `200` and expected server-rendered console content.
- RecOps check passed.
- Full test suite passed.
- Diff whitespace check passed.

Residual blockers:

- Default `npm run build` still fails in this worktree because Turbopack rejects the `node_modules` symlink as outside the filesystem root; `next build --webpack` passed for application compile verification.
- Live persistence reads, production adapters, external network calls, live Greenhouse writes, broad PII persistence, and retirement/cutover remain explicitly out of scope.

Next gate:

- Await the operator approval for any post-foundation workstream: live read adapters, Supabase persistence adapter/backfill, production output adapters, or action execution paths.

## 2026-06-24: Capability-First Documentation And Provenance Sweep

Completed gate:

- Added `DOCS_SOURCE_OF_TRUTH.md` as the first-read provenance map for future agents.
- Archived the superseded workflow-foundation spec and implementation plan under `archive/2026-06-24-workflow-foundation/`.
- Archived the historical reporting-platform spec under `archive/2026-06-22-reporting-platform/`.
- Moved transition-control and handover automation docs under `reference/transition/` and left redirect stubs at the prior paths.
- Added active capability-first docs for north star, inclusion rubric, audience/deliverable matrix, console IA, workflow-to-capability refactor map, deliverable readiness, action queue UX, platform spec, and refactor plan.
- Updated `GOAL.md`, `ARCHITECTURE_GUARDRAILS.md`, and `IMPLEMENTATION_SPEC_MODERNIZATION.md` to point future work at the capability-first platform.
- Updated the architecture checker to require the new active docs, reject stale active steering language, and require every inherited workflow to have an explicit capability-refactor disposition.
- Added checker tests for missing active docs, stale active docs, archived-doc exemptions, and workflow abstraction debt.

Files changed:

- `docs/recruiting-ops/**`
- `scripts/recruiting-ops-architecture-check.mjs`
- `test/recruiting-ops-architecture-check.test.ts`

Commands run:

- `npm run check:recruiting-ops`
- `npm test -- test/recruiting-ops-architecture-check.test.ts test/recruiting-ops-registries.test.ts`
- `npm test`
- Active-doc stale-language scan with path-qualified archive/reference excludes.
- `git diff --check`

Test results:

- RecOps check passed; architecture checker scanned 43 implementation files.
- Targeted architecture/registry tests passed: 2 files, 17 tests.
- Full test suite passed: 58 files, 381 tests.
- Active-doc stale-language scan returned no matches.
- Diff whitespace check passed.

Residual blockers:

- The runtime UI and code are still workflow-foundation shaped; the next goal should perform the capability-first code/UI refactor.
- Live persistence reads, production adapters, external network calls, live Greenhouse writes, broad PII persistence, and retirement/cutover remain explicitly out of scope.
- Default `npm run build` still has the known Turbopack/node_modules symlink issue; use `./node_modules/.bin/next build --webpack` for application compile verification.

Next gate:

- Implement `RECRUITING_OPS_CAPABILITY_REFACTOR_PLAN.md`: capability contracts, audience/deliverable contracts, legacy mapping contracts, capability-first module framing, and capability-first `/recruiting-ops` UI.

## 2026-06-24: Capability-First Enforcement (Gate 1)

Gate 1 of the capability-first correction pass — enforcement first, under the current 10 capabilities. Workflow rows are kept as legacy coverage (not deleted), so the change is additive and the full suite stayed green at every commit.

Implemented:

- `lib/recruiting-ops/capabilities.ts`: typed `capabilityRegistry` (the 10 capability IDs), `requiredCapabilityIds`, and `validateCapabilityRegistry()` enforcing contract completeness, durable-vs-transitional with a required `sunsetState`, and a full 1:1 partition of every workflow and module to exactly one capability.
- `capabilityId` is now required on `RecruitingOpsModuleDefinition`; all 21 runnable modules declare it and return through `finalizeModuleResult()`, which stamps the capability onto every produced run, source gap, discrepancy, and artifact. A producer test makes the (optional) substrate field non-optional in practice.
- Architecture checker inverted: a green `check:recruiting-ops` now requires the capability registry, module bindings, capability-doc consistency, full workflow→capability coverage, and a capability-first console; a workflow-id-first tree fails. The T##/S##/Q## rules remain as legacy coverage.
- `/recruiting-ops` leads with capabilities; the workflow registry table moved to the `/recruiting-ops/legacy-coverage` audit route.
- `RECRUITING_OPERATIONS_BRAIN_NORTH_STAR.md` carries a four-axis conflict block (Greenhouse role, production writes/autonomy, capability taxonomy, PII surface); the handover assessment's warehouse/Redshift recommendation is boxed as non-binding.

Verification: `npm run check:recruiting-ops` green; full suite 401 tests; `tsc --noEmit` clean; `next build --webpack` compiles `/recruiting-ops` and `/recruiting-ops/legacy-coverage`; `git diff --check` clean.

Residual blockers:

- Taxonomy is still the inherited 10 (action queue is mechanism-named; flagship T01 sits under a narrative capability; no requisition/headcount-lifecycle capability; transitional capabilities marked only by a sunset field).
- Recruiter/team/HOD and substage/core_stage attribution is still per-module `?? "unmapped"`; the shared resolution layer in `lib/` is unused by recruiting-ops modules.

Next gate:

- Gate 2: taxonomy migration (split the action queue, add requisition lifecycle, split structured-vs-narrative, mark transitional + sunset), shared dimension contracts + fixture config wired to the resolution vocabulary, T01/T05 report-fidelity restoration, and the automation-custody credential-rotation gate — as separate green commits.

## 2026-06-24: Gate 2 Taxonomy + Provenance Closeout

The inherited 10 capabilities are retired; the platform now carries **14 capabilities** (11 durable, 3 transitional). This supersedes the prior entry's "taxonomy is still the inherited 10" residual.

Implemented:

- `stakeholder_update_generation` split into `structured_hiring_status` (flagship T01) and `stakeholder_narrative_generation` (T06/T18); the mechanism-named `recops_action_queue` split into `requisition_lifecycle_control` (S01), `offer_administration` (S02, proposals-only), `access_and_identity_administration` (S05/S06/S07, dry-run, no scoped-MCP/provisioning), and `recruiting_inbox_triage` (S03/S04). The action queue is now the shared `/recruiting-ops/actions` delivery surface.
- `external_artifact_monitoring`, `automation_custody`, and `transition_readiness_control` marked transitional with a `sunsetState`; readiness model gained a Capability Sunset section; T08 un-double-mapped.
- `capabilityId` is now **required provenance**: `buildCommandCenterRun` requires it and stamps every nested `run.sourceGaps` / `run.artifactRefs`; the run validator and the persistence mappers require it; the five run-scoped Persisted* row types and migration `011` carry `capability_id`.
- The audience matrix is a first-class 14-row taxonomy (no split-by-note). North star, platform spec, refactor map, and readiness model carry all 14 IDs; the consistency checker enforces it.

Residual blockers:

- Recruiter/team/HOD and substage/core_stage attribution is still per-module `?? "unmapped"`; the shared resolution layer in `lib/` is unused by recruiting-ops modules (next gate).
- T01/T05 report fidelity and the offer target-vs-actual deliverable are not yet restored.

Next gate:

- Shared dimension contracts + fixture config (reusing `resolution-types.ts` vocab), then dimension wiring (replace `?? "unmapped"` with an `unresolved` `SourceGap`) with the scoped sentinel-fallback checker rule; then T01/T05 fidelity and the credential-rotation gate.

## 2026-06-24: Gate 2 Dimensions, Fidelity, and Custody Closeout

Gate 2 is complete. This supersedes the prior entry's residual blockers.

Implemented:

- Shared dimensions: `lib/recruiting-ops/dimensions/` defines `TeamResolution`/`StageResolution` reusing the W1 `resolution-types.ts` vocabulary (NULL identity + defect status, never a sentinel), pure `resolveTeam`/`resolveStage` resolvers with injected fixture-only `*.v1.ts` config, and unit tests covering resolved/unresolved/ambiguous/divergent.
- Dimension wiring: t07 (offer), t09 (ownership), t01 (weekly status) derive team/pod/HOD through `resolveTeam` and carry attribution as `string | null`; unresolved mappings surface as `SourceGap`s. New scoped `no-sentinel-attribution-fallback` checker rule bans `?? "unmapped"` on recruiter/sourcer/team/pod/HOD/stage fields in `modules/**` (comment-stripped).
- Report fidelity: T01 carries the six human-owned leadership fields (Billable/Priority/Role type/Job health/Job progress/Comments, null until filled); T05 restores submitter, screening team, interviewer match/mismatch, recommendation, and screening volume by team.
- Credential-rotation gate: t17 flags secret-bearing/unknown-owner credentials `rotation_required` and blocks preserve/export with a `credential_rotation` gap.

Verification: `npm run check:recruiting-ops` green; full suite 420; `tsc --noEmit` clean; `git diff --check` clean; the checker fails a crafted workflow-id-first / sentinel / evidenceRefs-only tree (negative tests) and passes the real tree.

Explicitly-deferred follow-ups (see Active Next Gate): stage-resolver wiring into t02/t03/t04/t05; generic task-owner `?? "unmapped"` migration; the offer target-vs-actual deliverable. None blocks the work done.

## 2026-06-24: Continuation — stage wiring, sentinel migration, n8n rotation gate

Closes two of the three deferred follow-ups above (the offer target-vs-actual deliverable remains, blocked on a targets input source).

- Stage dimension wired: t02 derives canonical `core_stage` + `core_stage_order` via `resolveStage()` (additive to the operational `stage_name`, which keeps terminal hired/rejected classes the core taxonomy omits); an unmapped *active* substage is a non-blocking `core_stage` SourceGap, a terminal/unknown row is null-by-design with no gap. t03/t04 thread `core_stage` through; t05's interview_stage is intentionally left (a distinct concept). The substage→core_stage dimension is no longer dead code.
- Attribution sentinels eliminated: the normalized-row `owner` (t08, t12–t20/t21, s-support) and t18's `lead_name` are now `string | null`; the per-row SourceGap fires on null instead of `"unmapped"`. The `no-sentinel-attribution-fallback` checker rule now also bans owner/lead fields; zero `"unmapped"` attribution sentinels remain in `lib/recruiting-ops/modules`.
- Gate-5 verification: t16 (n8n/Mailgun custody) modeled a `rotation_required` status but never blocked on it. Extended it to match t17 — a secret-bearing credential now blocks preserve/export with a `credential_rotation` gap. Apps Script (t17) and n8n/Mailgun (t16) are now the gated secret-bearing custody surfaces.

Verification: `npm run check:recruiting-ops` green (passes the real tree, fails crafted workflow-id-first / attribution-sentinel / owner-sentinel fixtures); full suite 423; `tsc --noEmit` clean; `next build --webpack` clean; `git diff --check` clean.

## 2026-07-08: Exec state-of-play content contract — tiers, taxonomy, page rebuild

Executes the approved `docs/recruiting-ops/exec-design/EXEC_SURFACE_CONTENT_SPEC.md` (the operator sign-off 2026-07-08: descriptive voice on non-search tiers, one-shot ship, recruiter-name adjacency kept).

- Definitions: `tierOf` (in_play / gone_quiet / filled_not_closed / no_search; 30d activity window, 14d ramp grace) and `attentionOf` (offer ≥14d, onsite ≥30d, stopped-this-week, feedback backlog ≥8, unowned, quiet 15–30d band) join `healthOf` as named, ordered, reason-bearing rule sets; `/holding bucket/i` added to the pool patterns (reclassifies the two Bengaluru/Gurugram parking reqs).
- E01 module: movement window 15→31d (v3 `/applications` carries no stage-recency field — verified live, 22-key census); new scoped boundary pull `fetchEngagedStageHistories` (`/application_stages?application_ids`, verified live: `entered_at`/`exited_at`/`current`); emits `conducted/advanced/added_last30`, `last_advance_at`, per-stage `movement_14d`, funnel `oldest/median_days`, `finalists[].in_stage_days`, `last_hire_accepted_on`, tier verdicts + attention flags; emit order = the page's reading order; rollup gains tier counts, `attention_count`, `positions_in_play`, `offers_out`.
- Taxonomy: migration 022 widens `stage_class` with `'none'` (applied); 46 governed rows seeded covering every label on open reqs — unclassified candidates collapsed 265→1 ("Jonathan eval"; "Hold"/"On-HOLD" left unmapped deliberately), three heuristic corrections (Phone interview/Phone Interview → RPS, AI Interview → Tech Screen), per-run stage gaps 41→21.
- Page: `/state-of-play` rebuilt to the contract IA (Needs a push → Moving → Gone quiet → Open on paper → Hired → Pools) with per-req pipeline strips, native-details depth layer, and module-verbatim reasons; `exec.css` generated from the token file by `scripts/build-exec-css.mjs` (APCA + token-registry gates); exec layout moves to Newsreader/Inter. Old-shape snapshots render an honest notice.

Verification: suite 765 green (tier/attention boundary tests + derivation emit tests added); `check:recruiting-ops-architecture` green; `tsc --noEmit` clean; `next build --webpack` clean; live E01 run succeeded (65 rows, 6,583 stage-history rows / 771 engaged apps, zero truncation, snapshot `e01_20260708223327911`); page walked in Chrome against that snapshot behind the Basic-auth proxy.

Deferred: none blocking. Design-iteration pass on the rendered page with the operator; ELT/legacy lanes untouched.
