# Exec state-of-play — content contract

**Status: APPROVED by the operator, 2026-07-08.** The §7 questions are decided: (1) Tiers 3/4 speak descriptively plus one neutral section-level line — no "close it" imperative; (2) one-shot ship — module changes and taxonomy seeding land before the page build; (3) recruiter names stay adjacent to delinquency facts. This contract is now the build spec.

This document decides what the exec state-of-play surface says: which requisitions lead, which fold away, what every field means to a reader with zero recruiting-ops training, and what the E01 module must additionally emit. It is the contract the page build implements; the design system (`exec-design-tokens.json`) decides how it looks, this decides what it is.

Every threshold in here was tested against the live snapshot of 2026-07-06 23:53Z (run `e01_20260706235323325`, 66 reqs) plus two read-only Harvest probes run 2026-07-07: an org-wide active-applications pull (15,562 records — verified which v3 fields actually populate) and a stage-history pull for all 743 engaged applications (6,446 stage rows — true last-advance dates and time-in-stage, unbounded by the module's 15-day window). Numbers below are those measurements, not estimates.

---

## 0. Depth posture — the reversal this contract encodes

Prior passes treated "executive audience" as "surface-level information" and cut detail in the name of restraint (the Cloris rule R8, "when in doubt, hide", written for a different product). the operator has ruled that out. The failure of the current page is **undifferentiated** detail — 20 rows shouting equally — not the presence of detail.

The operating rule for every field decision in §3:

> Depth is welcome wherever hierarchy subordinates it. A fact is killed only when it serves **no** executive question at **any** depth — never because "it's too much information." A fact that fails at the lead can still earn the supporting line; a fact that fails the row can still earn the disclosure.

Concretely, this contract *adds* detail the current page lacks (per-req stage-by-stage pipeline, time-in-stage for finalists, a 14-day movement narrative, a per-req disclosure layer) while *removing* alarm inflation (dormant reqs presented as urgent) and untranslated jargon ("SEATS", "1 write-up owed").

---

## 1. The tiering model — active-first triage

### 1.1 The defect being fixed

The current page groups 57 roles by health (20 red / 10 amber / 27 green) and presents red as one "needs attention" wall. Measured against true movement dates, that wall mixes four populations that demand different treatment:

- reqs with an **offer out right now** going cold (req 980: offer sitting 25d; req 1031: offer 22d) — genuinely urgent;
- reqs whose pipeline **parked months ago** (req 1025: last stage movement 231d ago; req 1112: 95d) — not urgent, not even really "searches" anymore;
- reqs that **hired and were never closed** (reqs 1160/1158/1157/1153 — the `[Fulfillment] Delivery` batch — last hire 21–40d ago, zero candidates left in pipe) — an admin decision, not a recruiting problem;
- reqs where **no search ever ran** (req 1169 Head of R&D, 1162 Product Design Intern, 1187 Principal Architect, 1156: empty pipeline, no movement, no hires) — same.

`days_open` cannot make these distinctions and must never be the urgency signal: req 752 (242d open) ran 46 advances in the last 7 days, while req 1187 (48d open) is empty and silent. Age says nothing about liveness — this is the measured confirmation of directive 2.

### 1.2 The tiers

One classification, computed in `lib/recruiting-ops/exec-definitions.ts` (pure, alongside `healthOf`) and emitted in the snapshot. The page does no math.

| Tier | Name (exec-facing) | Rule (first match wins) | Live count |
|---|---|---|---|
| — | Pools & campaigns | `req_class != "role"`, **plus** names matching `/holding bucket/i` (new pool pattern) | 9 + 2 = 11 |
| 1 | **In play** | any of: interviews conducted or stage advances in last 30d · candidates added in last 7d · last engaged-candidate stage-advance ≤ 30d ago · opened ≤ 14d ago (ramp-up grace) | **43 roles, 68 positions** |
| 2 | **Gone quiet** | candidates sitting mid-process (`engaged_depth > 0`) but no movement in >30d | **4 roles** (1108 @43d, 1147 @48d, 1112 @95d, 1025 @231d) |
| 3 | **Filled, not closed** | empty pipeline, no movement, but ≥1 accepted offer in trailing 12wk | **4 roles** (Delivery batch; last hires 21–40d ago) |
| 4 | **No search running** | empty pipeline, no movement, no recent hires | **4 roles** (1156, 1169, 1162, 1187) |

Why 30 days: it is the operator's stated heuristic, and the measured distribution vindicates it. The zero-14d-signal roles bucket by true last advance as 3 roles at 15–30d (all three are *offer-stage* reqs worth chasing: 980, 1031, 1159), then a gap, then 40–48d (1117, 1108, 1147), 90–95d, 231d. The 30d cut keeps every chase-able stall in play and demotes only genuine debris. At N=45 the tier would absorb req 1108's 43-day-old pipeline — nothing an exec can act on. The threshold is a named constant (`TIER_ACTIVITY_WINDOW_DAYS = 30`); the page states last-movement dates on every quiet row, so the reader is never asked to trust the cutoff blindly.

Why the grace period: req 1119 (Research Engineer — Colombia) is 11 days old with 29 applicants awaiting first screen and no interviews yet. A brand-new req is "in play" by intent; `RAMP_UP_GRACE_DAYS = 14` already exists for health (exec-definitions.ts:36).

Why holding buckets reclassify: reqs 1117/1116 ("GenAI Engineer, Bengaluru/Gurugram **holding bucket**") are candidate-parking constructs, not searches — the name says so. They currently sit in the red wall with 50 and 17 parked candidates. They join pools via one added pattern in `POOL_PATTERNS` (exec-definitions.ts:160).

### 1.3 Exec-facing treatment per tier

**Tier 1 — In play** leads the page and splits into two groups:

- **Needs a push** (measured: 15 of 43) — rows matching any *attention rule*, ordered by severity: offer sitting ≥14d → onsite candidate waiting ≥30d → activity stopped this week with people mid-process → interview-feedback backlog ≥8 → no recruiter assigned → no movement 15–30d. Each row leads with the blocker sentence, not a color word: "Offer out 25 days — no response logged." These rules are named and ordered like `healthOf`'s, live in exec-definitions, and the fired rule's text is the row's reason. The live 15: 980, 1026, 1031, 1159, 1171, 1027, 1103, 890, 1135, 1149, 1204, 907, 1167, 8888, 1210.
- **Moving** (28) — everything else in play, sorted closest-to-hire first (deepest engaged stage, then 14d activity). These rows prove the machine is working; their detail is one disclosure away.

**Tier 2 — Gone quiet** renders as a compact group after Moving. Each row leads with the fact that matters: "Nothing has moved since May 25 (43 days)" — the date, not an alarm. These are honest statements of staleness, not calls to action; the wrong treatment (today's) is presenting a 231-day-old pipeline as this week's emergency.

**Tiers 3+4 — Open on paper** render as one folded section of one-line rows, sub-grouped "Filled, not closed" (lead fact: "hired 3, last on May 28 — req still open, nothing in pipeline") and "No search running" (lead fact: "no candidates, no activity; opened Apr 29"). The section exists because leadership is the audience that can force the close-or-restaff decision; it folds because eight rows of hygiene must not compete with 43 live searches.

**Pools & campaigns** stay segregated at the bottom in prose form (current treatment is right), gaining the two holding buckets.

The masthead lede re-anchors on the tier numbers: "**43 searches** are in play for **68 positions** — **15 need a push**, including **9 offers out** (7 waiting two weeks or more). **12 more reqs are open on paper but not being worked.**" The current "57 open roles · 20 need attention" overstates the portfolio by 14 non-searches and the alarm by 5.

---

## 2. The per-req status model — both sides of the story

Directive 3: every req tells (a) what the pipeline **is**, stage by stage, and (b) what **happened** in the trailing 14 days. Confirmed against the module: the snapshot already stores per-req `funnel` `{stage, count}[]` (exec-state-of-play.ts:79,540 → persisted whole at exec-snapshot-store.ts:64; non-empty on 54/66 live rows). The page simply never rendered it. Stage-by-stage costs **zero** new pull.

### 2.1 The row (lead + supporting reads)

```
[Role name] [chips: hiring N · tag · confidential]   [recruiter]   [pipeline strip]   [14d movement]
[state sentence — the one thing to know about this req]
```

- **Pipeline strip** — the current pipeline as counts across fixed slots: `awaiting review N │ Screen · HM · Tech · Assess · Onsite · Offer`, engaged-stage labels in a per-group header row, blank slot = 0. Counts, never proportional bars: req 1108's 4,754 awaiting review must not visually flatten its 33 real candidates; magnitude lives in the number. "Awaiting review" merges Sourced + Application Review on the row (split shown in the disclosure).
- **14d movement** — "6 interviews · 9 moved forward", with "+120 applicants" when the week's story is inflow (req 1208: 465 new applicants, 27 advances). Direction (accelerating/slowing) is carried by the state sentence only when it *is* the story ("activity stopped this week — 3 events the week before, none since").
- **State sentence** — the fired attention/health/tier rule's reason, verbatim from the snapshot. Every row has one; green rows say what's working ("24 interviews conducted, 14 advances in the last two weeks").
- **Finalist names** ride the row's second line for Needs-a-push and Moving rows ("Closest: A—— B—— (Offer, 25d) · C—— D—— (Onsite)"), because "who is close to a hire" is a first-class exec question (the page exists partly to answer founder-pings). Names stay behind the auth wall as today.

### 2.2 The disclosure (on-demand depth, one click, still on the page)

Every req row is a native `<details>` disclosure — no routing, no client JS, consistent with the server-rendered zero-fetch page. Open, it shows:

1. **Full pipeline table** — all 8 canonical stages plus "Other in-process" (unclassified), each with count and **oldest-sitting** time-in-stage ("Onsite Interview — 3 candidates, longest waiting 62d"). Time-in-stage is the fact that turns a static count into a judgment: probe data shows 44 finalist-depth candidates sitting >14d, topping out at 256d.
2. **Movement, last 14 days, by stage** — interviews conducted per stage and candidates advanced into each stage, split last week / week before. (New emit; see §4.)
3. **In the final stretch** — every finalist with stage, time in stage, and Greenhouse link.
4. **What's blocking** — feedback outstanding ("9 interviews conducted, write-up not yet filed"), offer age, unowned status. Only lines that apply.
5. **Housekeeping** — opened date, requisition id (linked to Greenhouse), department, recruiter, positions, hires from this req in 12wk.

Depth placement rule: the row answers "does this need me and is it moving"; the disclosure answers "why, exactly"; Greenhouse (linked) answers "let me work the req." Nothing exec-relevant requires leaving the page; nothing operational (scorecard contents, activity feeds, notes) is duplicated onto it.

### 2.3 Where this depth model was previously wrong

The v2 mockup's row carried `IN PROCESS / IN REVIEW / FURTHEST` — three numbers and a stage name. "Furthest" is strictly weaker than the strip (it names the deepest non-empty slot and nothing else) and dies in favor of it. The strip *is* the quantitative snapshot directive 3(a) asks for, at the grain execs think in ("2 at onsite, 1 at offer"), and it was cut from prior passes purely on the hide-bias this contract reverses.

---

## 3. Field-by-field rulings — the depth ladder

Ladder: **LEAD** (in the row, first read) · **SUPPORTING** (in the row, second read) · **ON-DEMAND** (inside the disclosure) · **TRANSLATE** (keep the fact, fix the label) · **KILL** (serves no exec question at any depth). Every KILL is justified by uselessness, never by volume.

| Field (snapshot) | Ruling | Exec question it answers | Treatment |
|---|---|---|---|
| `role` | LEAD | "Which job is this?" | Cleaned title + ATS suffix tag as chip (`\| DB`, `\| Bench` — never deleted; they distinguish twin reqs) |
| `seats` | LEAD + **TRANSLATE** | "How many are we hiring?" | The word "seats" dies ("I actually still have no idea what the fuck that's supposed to mean"). Chip `hiring 3` when >1; lede says "positions." Req 8888 renders `hiring 10`. |
| `owner` | LEAD when absent, SUPPORTING otherwise | "Who do I ask?" / "Is anyone on this?" | Name in row; "No recruiter assigned" is an attention rule (live: 1204 — a CFO search — and 1210) |
| `funnel` | **LEAD** (strip) + ON-DEMAND (full table) | "What does the pipeline look like right now?" | §2.1/§2.2. Already emitted; never rendered until now |
| `conducted_last7/prior7`, `advanced_last7/prior7` | LEAD + TRANSLATE | "What happened in the last two weeks?" | "6 interviews · 9 moved forward"; weekly split in disclosure. "Conducted/advanced" as words die |
| `added_last7` | SUPPORTING | "Is anyone feeding the top of this funnel?" | "+120 applicants this week" when it's the story; always in disclosure |
| `pending_writeups` | SUPPORTING + **TRANSLATE** | "Why is this stuck?" / "Are we dropping the ball after interviews?" | "1 write-up owed" dies → "N interviews awaiting feedback." Never a column: it appears in the state sentence when it explains a stall (890: 14 outstanding, activity stopped) and in every disclosure's blockers |
| `finalists[]` | LEAD (top rows) / SUPPORTING (moving rows) | "Who's close? Whom might we land?" | Names + stage inline; full list with time-in-stage in disclosure |
| `finalists[].in_stage_days` (new) | SUPPORTING | "How long has our closest candidate been waiting?" | "(Offer, 25d)" — the single highest-value addition per probe data |
| `engaged_depth` | LEAD + TRANSLATE | "How many real candidates are in process?" | "In process" survives barely but the strip makes it concrete; the summary number labels as "interviewing" |
| `application_pile` | SUPPORTING + TRANSLATE | "Is there raw inflow?" | "In review" → "awaiting review"; separated from interviewing so 4,754 never masquerades as pipeline depth (req 1108) |
| `unclassified_count` | ON-DEMAND | "Why don't these numbers add up?" | Disclosure line "N on unmapped stages" + one page footnote with the total. Never silently folded into engaged |
| `days_open` / `opened_on` | SUPPORTING + TRANSLATE | "How long has this been going?" | Render as "opened Mar 12" in the row meta. Never the urgency signal (§1.1); stalled rows lead with last-movement date instead |
| `health` / `health_reason` | LEAD (as grouping + sentence) | "Is this OK?" | Words red/amber/green never render; the reason sentence does. Dots on section headers only |
| `health_rule` | KILL (display) | — | Internal rule id; the reason text carries the meaning |
| `momentum` | **KILL** (display) | — | Five more vocabulary words ("dormant", "sourcing only"…) recomputable from facts already shown; the tier + state sentence say it better. Stays in the snapshot for ELT/ops |
| `furthest_stage` | **KILL** | — | Subsumed by the pipeline strip (§2.3) |
| `req_id` | ON-DEMAND | "Is this the req Bob mentioned as 1108?" | Disclosure housekeeping, hyperlinked to Greenhouse. Execs speak role names, not req ids |
| `job_id` | KILL (display) | — | Pure plumbing; survives as the link href |
| `department` | SUPPORTING | "Which org is hiring?" | Small text after role name, abbreviated ("Enterprise AI") |
| `confidential` | SUPPORTING | "Should I mention this aloud?" | Chip. Policy (my call, veto-able): confidential rows render the title but suppress finalist names on the row; names remain in Greenhouse via link. Zero confidential reqs today |
| `req_class` | structural KILL | — | Drives sectioning; never a visible column |
| `owner_kind`, `owner_on_roster` | KILL (this surface) | — | Roster governance diagnostics; belong to the ops console and run gaps |
| `offers_accepted_12wk` (per req) | ON-DEMAND / LEAD for Tier 3 | "Did this req produce hires?" | Disclosure housekeeping; for Filled-not-closed rows it IS the lead sentence |
| `week_stage_activity` | KILL (this surface) | — | Reporting-week (Fri-anchored) grain exists for the ELT doc; the page speaks trailing-14d. Two time-grains on one row would lie. Stays emitted for ELT |
| `hires[]` (org-wide) | LEAD (own section) | "Who did we land?" | This-week hires in the lede by name; 12-week table with role/dept/priority/start; unchanged from v2 direction |
| rollup counts | LEAD (lede) | "State of play in one breath" | Re-anchored on tier numbers (§1.3) |
| `last_advance_at` (new) | LEAD for quiet rows | "When did this actually stop?" | "Nothing has moved since May 25 (43d)" |
| `last_hire_accepted_on` (new) | LEAD for Tier 3 | "When did we fill it?" | "Hired 3, last on May 28 — req still open" |
| `conducted_last30/advanced_last30/added_last30` (new) | internal | — | Tier inputs; not directly rendered |
| `tier` / `tier_reason` (new) | structural | — | Sectioning + reason sentences |
| `movement_14d[]` per stage (new) | ON-DEMAND | "Where exactly did the week go?" | Disclosure movement table (§2.2.2) |
| stage `oldest_days` (new) | ON-DEMAND | "Is someone rotting in there?" | Disclosure pipeline table; also feeds attention rules |

**Vocabulary contract** (test: comprehensible to an exec with zero recruiting-ops training, without asking): *seats* → positions / "hiring N" · *write-ups owed* → "interviews awaiting feedback" · *conducted* → interviews (held) · *advanced* → moved forward · *in process* → interviewing · *in review* → awaiting review · *sourced* → folded into awaiting review on rows, named in disclosure · *momentum labels* → killed · *red/amber/green* → never words, dots + sentences · stage strip labels: Screen · HM · Tech · Assess · Onsite · Offer (full canonical names in disclosures and legends). Anything Greenhouse-jargon that survives to the page must appear with enough sentence around it to self-define.

---

## 4. Required module changes (platform computes; the page renders)

All computation stays in E01 + exec-definitions; the page reads the snapshot. No migration needed — snapshot rows are jsonb (021), new fields ride along; bump the artifact contract's `schemaVersion`.

1. **Widen the movement window**: `MOVEMENT_WINDOW_MARGIN_DAYS` 15 → 31 (exec-live-workflow.ts:29). Verified live: v3 `/applications` records carry **no** stage-recency field (22-key census; `stage_changed_at`/`current_stage_at` absent), so a true 30d conducted/advanced signal must come from the windowed `/application_stages` + scorecard pulls. Volume ≈ doubles (~60k stage rows/15d measured → ~120k), inside the 200k cap; per-pull diagnostics already make truncation loud.
2. **New scoped pull — stage history for engaged applications**: collect engaged application ids during derivation (like `collectExecCandidateIds`, exec-state-of-play.ts:193), then `/application_stages?application_ids=` chunked. Verified live: filter works; rows carry `entered_at`, `exited_at`, `current`, `days_in_stage` precomputed (9-field census). Today: 743 engaged apps → ~19 chunk calls, 6,446 rows.
3. **New emits per req** (from 1+2, all pure derivation): `conducted_last30`, `advanced_last30`, `added_last30`; `last_advance_at` (max `entered_at` across engaged apps' histories, null when none — render ">30d" honestly when null but engaged>0 is impossible by construction since histories are unbounded); `movement_14d: [{stage, conducted, advanced_in}]` (reuse the `stageBump` grid machinery with `windowHalfOf`); funnel entries gain `oldest_days`/`median_days` for engaged stages; `finalists[].in_stage_days`; `last_hire_accepted_on` (from offers already pulled); `tier`, `tier_rule`, `tier_reason`; `attention_rules: string[]`.
4. **exec-definitions.ts additions** (pure, tested like `healthOf`): `TIER_ACTIVITY_WINDOW_DAYS = 30`; `tierOf(facts)` with the §1.2 rules; `attentionOf(facts)` with the §1.3 named/ordered rules; `POOL_PATTERNS` + `/holding bucket/i`. `healthOf` survives untouched for ELT/ops continuity, but the page's grouping key becomes tier + attention (health's red/amber semantics are subsumed; `stalled_14d` inside Tier 2 is tautological).
5. **Rollup additions**: tier counts, `offers_out {count, waiting_14d_plus}`, attention count — so the lede is also zero-math.
6. **PII posture unchanged**: stage names remain VALUES (arrays of `{stage, …}`), never object keys — the certifier lesson (exec-state-of-play.ts:78,96).

Not required: any new Supabase table, any page-side computation, any change to the six-module runner or ELT facts (`week_stage_activity` and `eltFacts` are untouched).

---

## 5. Sorting & filtering

**Ruling: no interactive controls at launch. The hierarchy is the interface.**

The two reading modes both get served by fixed editorial order:

- The **10-second founder-ping glance** reads the lede (tier numbers, offers out, this-week hires) and, if needed, the Needs-a-push group — which is already sorted by severity (offer age desc → onsite age desc → stopped → backlog → unowned). The answer to "what's going on with hiring?" is the first screenful by construction.
- The **deliberate pre-meeting deep-dive** reads groups in order, opens disclosures where depth is wanted, and jumps via the masthead index (anchor nav with counts, as v2). Within Moving, closest-to-hire-first ordering means the walk down the list is also a walk down the funnel; Gone quiet orders most-recent-stall-first (most salvageable at top); Open on paper orders by last-hire recency then age.

Fifty-five roles across five sections do not need user-driven sort, and a department filter over a 13-department spread (largest: Enterprise AI at 13 reqs) saves less than it costs in state, affordance, and print/copy breakage on a server-rendered zero-JS page. The one control that earns existence is the native disclosure toggle (plus a "open all details" affordance for the deep-dive mode, which is still zero-state HTML). Revisit triggers, stated now: portfolio >90 roles, a second audience with different questions (e.g. HM-level readers), or observed Ctrl-F behavior from real use. the operator's directive 1 asked whether these controls need to exist at all: measured against both reading modes — no.

---

## 6. The thing you're not seeing

1. **Taxonomy seeding graduates from housekeeping to launch gate.** The pipeline strip is now the row's centerpiece, and 260 candidates sit on unmapped stages concentrated in exactly the rows people will look at: req 1026 (153 of 252 unclassified), 1027 (65), 774 (30). Those three strips are *wrong*, not just incomplete, until `funnel_stage` taxonomy rows are seeded from the 41 named gap labels each run already emits. Seed before the page build, not after.
2. **The page will surface data rot as if it were recruiting failure — by design, but say so.** An offer showing 62 days (req 890) may be a dead offer nobody resolved in Greenhouse. First weeks of this surface will trigger "is that real?" conversations; that is the mechanism working (the sheet died because nobody looked). Expect a hygiene flush, and expect the numbers to *improve* as a result.
3. **Attention rules put a recruiter's name next to a delinquency flag.** "Offer out 62 days · 14 interviews awaiting feedback" renders adjacent to the owning recruiter's name. That's accountability by design — and a culture decision (§7 Q3).
4. **Health and tier will drift apart unless health is demoted on this surface.** A Tier-2 req is red by `stalled_14d` forever — tautologically. If the page groups by tier but colors by health, rows contradict their sections. Ruling in §4.4: tier + attention rules own this surface; health stays for ELT/ops.
5. **Conveyor reqs break "no pipeline = dead."** Req 1152 hired 6 in 12 weeks, advanced someone last week, and has zero candidates in pipe — it's actively converting, in waves. The tier rules already keep it In play (activity signal), but its state sentence must speak the pattern: "moved 1 to hire last week; pipeline now empty." Fixed sentences per rule, with the between-waves case covered.
6. **The snapshot table already accretes history** (one row per run, 021 keeps them all). "What changed since last Thursday" at portfolio level — the question execs ask next — is answerable later with zero new storage. Out of scope now; don't design it out by accident (keep run rows, never overwrite).
7. **Department "Confidential" is a real department name** on 7 reqs (Greenhouse org quirk), distinct from the per-req confidential flag. The dept chip will print "Confidential" and read as a redaction. Render it as-is (it is the truth) but know it's coming.

---

## 7. Questions only the operator can answer

1. **Voice toward leadership on Tiers 3/4.** May the page say "close it or restaff it" (a recommendation), or must it stay descriptive ("open on paper, nothing running") and let Bob draw the conclusion? My recommendation: descriptive rows plus one neutral section-level line ("these eight reqs are open in Greenhouse but not being worked — a close-or-restart decision, not a recruiting task"). It's leadership-facing copy; the register is yours and Bob's to own.
2. **Launch sequencing.** The module changes (§4) are roughly a day of work and the taxonomy seeding another chunk; the alternative is shipping the IA restructure on today's 14d-only signals and fast-following with the 30d/stage-age fields. My recommendation: one shot — the tier model without true last-movement dates degrades into exactly the guesswork this contract exists to kill. But Bob-visibility timing is your call.
3. **Recruiter names adjacent to delinquency flags** (§6.3). Accountability-by-design, or fact-without-name on the attention rows? My recommendation: keep the adjacency — the page's whole thesis is that named, dated facts move orgs — but this is a culture call I can't make for the TA team.

---

*Companion artifact: `build-mockup-v3.mjs` renders this contract from the live snapshot (both design gates green — APCA floors + token-derived-values lint). Mockup data and rendered HTML stay out of the repo (finalist names); the generator and tokens are the reviewable spec.*
