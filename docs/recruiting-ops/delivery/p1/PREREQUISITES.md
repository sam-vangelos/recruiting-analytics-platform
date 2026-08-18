# P1 ELT prerequisite-resolution framework

Prepared 2026-07-23. These gates apply to the held
`codex/elt-fact-table-cadence-20260722` branch. A later green gate does not
override an earlier block, and code readiness does not authorize an operational
write.

| Gate | Current evidence | Status | Resolution required |
|---|---|---|---|
| Protected release | ELT cadence, copied-Doc writer, durable evidence, rollback, and replay behavior exist only on a held draft branch. | **Blocked for deployment** | Finish review and required CI, merge through protected main, pass merged-main CI, then build one immutable private service/Job digest. Do not deploy merely for documentation. |
| Database compatibility | Migration `028` is additive: one immutable validator plus one `NOT VALID`/`VALIDATE` constraint, with no columns, rewrite, index, or replacement RPC. Read-only live checks on 2026-07-23 show the remote migration ledger ending at `027` and both `028` objects absent from the live `public` schema. | Ready to apply before producer code | Apply and validate `028` before deploying code that can emit `elt_fact_table_v1`; re-read the constraint and retain evidence. |
| Source identity and freshness | The private durable path requires one immutable E01 `shadow` source, exact governed period, zero suspected truncation, and a 120-minute hard freshness limit. Greenhouse access is read-only. | Ready in code; live evidence pending | Require one fresh, complete, untruncated real source in every dry proof, canary, and shadow. |
| Private cadence | The existing private Scheduler-to-service-to-Job path resolves ELT in the Thursday weekly 06:30 Pacific cycle and the Friday 06:30 refresh. Due artifacts are intersected with the explicit Job allowlist. | Ready in held code; inactive | Keep all Schedulers paused until the relevant real gate and keep ELT out of the active Job allowlist until the prior gates pass. Never substitute a manual Job for a missed identity. |
| Staging identity | Exact copied document ID/title, only tab `t.0`, no child tabs, and canonical/unknown-ID denial are enforced before mutation I/O. | Ready in code | Re-read exact copy metadata, topology, revision, values, and structure immediately before an approved canary. |
| Recipient and PII boundary | The output contract is `internal_review_identifiers`. Permitted content is the hire-table row fields (Role, Dept., Priority, Candidate Name, Start Date) plus the Role Progress narrative tail's QTD/weekly offer-accepted candidate names, for the exact last-complete Friday-through-Thursday week. | **Explicit human approval required** | Obtain the operator's exact approval statement below before applying any write configuration or running a copy canary. No programmatic approval latch substitutes for it. |
| Exact ACL fence | The writer accepts exactly two permissions: the operator as owner and `recops-sheets-writer@example-project.iam.gserviceaccount.com` as writer. Permission pagination, any third permission, or any ACL change blocks. | Ready in code; live recheck required | Independently confirm the exact copy ACL immediately before the canary and again after settlement. |
| Google capability boundary | ADC impersonates the fixed writer identity without a key file. Drive capability is `drive.metadata.readonly`; the adapter contains metadata/permission reads but no permission mutation. The Docs capability is reachable only through the registered-copy write chokepoint. | Ready in code; live IAM recheck required | Reconfirm Token Creator, copy edit access, exact scopes, service/Job identity, and unchanged IAM before release. |
| Fact-table scope | The compiler changes only `elt_doc_top_week_facts`, widened by A9 (RECOPS-ELT-FACT-TABLE-BOUNDARY-v2) to the full top-week block: the newest week heading, five-column hire table, and Role Progress narrative tail (per-section QTD offer line, numbered stage lines, offer-accepted line). Older weeks' hand-written history stays outside the mutation and covered by an all-tab HMAC. | Ready in code | Independently inspect the compiled request set and require an unchanged outside-content fingerprint after every canary/shadow. |
| Kill switch and dark flags | The writer requires an explicit durable staging-hydration `DISENGAGED` state and no broader blocker, re-read immediately before mutation. Global and ELT flags are also required at authorization, mutation, and commit. | **Intentionally stopped** | Keep the durable stop engaged and Job/global/artifact flags false outside one separately approved copied-artifact window. Re-engage and verify the stop immediately afterward. |
| Revision, Drive, and ACL fencing | Stable reads require two identical all-tab Docs snapshots bracketed by an unchanged Drive version and ACL HMAC. The mutation uses one `batchUpdate` with `requiredRevisionId`; settlement requires an advanced Drive version, exact committed revision, unchanged ACL, and certified postimage. | Ready in code | Run the first real canary only under an exclusive version fence and retain pre/post Drive, revision, permission, outside-content, and fact-table evidence. |
| Failure and rollback | A safely fenced rejected postimage is rolled back under its exclusive revision and re-read. Ambiguous/interruptible mutation boundaries are non-retryable; no blind replay or rollback occurs. | Ready in tests; live proof pending | Prove guarded write, no-op, rollback, settlement, and crash-safe resume on the registered copy before scheduling ELT writes. |
| Durable evidence | Successful terminal ELT attempts must satisfy both in-process certification and migration `028`'s exact `elt_fact_table_v1` database constraint. Public evidence is name-free and live HMAC salt is mandatory. | Ready in held code; migration pending | Apply `028`, provision `RECOPS_PII_FINGERPRINT_SALT`, and independently read back the durable run/source/attempt after the canary. |
| Live parity and production acceptance | No approved live copied-artifact canary or qualifying ELT shadow is established by this branch. The canonical remains read-only. | **Not run** | Complete the approved absent-week write/re-read/no-op sequence in `PARITY.md`, then obtain 5/5 qualifying real-cadence copied-artifact shadows, final review, an unattended copy cycle, separate canonical promotion approval, and two clean post-promotion cycles. |

## Exact operational approval required

**RECOPS-ELT-FACT-TABLE-BOUNDARY-v1 — superseded by v2 below (2026-08-06).**
Recorded for history only; v1 forbade narrative writes entirely, which the A9
expanded-scope approval (v2) supersedes for the the operator-owned copy. Do not act on
v1 alone.

> I approve RECOPS-ELT-FACT-TABLE-BOUNDARY-v1: internal-review candidate names
> and candidate-associated Role, Dept., Priority, and Start Date may be written
> only to copy `1ExampleDriveId00000000000000000000000000007` / tab `t.0` /
> `elt_doc_top_week_facts` for the exact last-complete Fri-Thu week, visible
> only under the exact copy ACL (the operator owner +
> `recops-sheets-writer@example-project.iam.gserviceaccount.com` writer), with
> public evidence name-free, all narrative/other identifiers/permission
> changes forbidden, the writer Drive token reduced to metadata-readonly, and
> canonical `1ExampleDriveId00000000000000000000000000021` remaining read-only
> until a separate artifact-specific promotion approval.

**RECOPS-ELT-FACT-TABLE-BOUNDARY-v2 — current.** Same copy document ID, same
ACL, same canonical-read-only boundary; mutation scope widened from the fact
table alone to the full top-week block (week heading, five-column hire table,
and the Role Progress narrative tail — per-section QTD offer line, numbered
stage lines, offer-accepted line). The canonical document remains unchanged
and read-only, out of scope, exactly as under v1.

> I approve RECOPS-ELT-FACT-TABLE-BOUNDARY-v2: internal-review candidate names
> and candidate-associated Role, Dept., Priority, Start Date, and Role
> Progress QTD/weekly offer-accepted narrative may be written only to copy
> `1ExampleDriveId00000000000000000000000000007` / tab `t.0` /
> `elt_doc_top_week_facts`, widened to cover the full top-week block (heading
> + hires table + Role Progress sections), for the exact last-complete Fri-Thu
> week, visible only under the exact copy ACL (the operator owner +
> `recops-sheets-writer@example-project.iam.gserviceaccount.com` writer),
> with public evidence name-free, all other identifiers/permission changes
> forbidden, older archive weeks' hand-written history remaining outside
> mutation and covered by the outside-content HMAC, the writer Drive token
> reduced to metadata-readonly, and canonical
> `1ExampleDriveId00000000000000000000000000021` remaining read-only until a
> separate artifact-specific promotion approval.
>
> — Jordan Rivera, 2026-08-06, via A9 expanded-scope approval

This approval is a human operational gate. It is not represented by a new
environment flag, database field, or caller-supplied token. Until the exact
approval is recorded, operators must leave ELT write flags false, keep the
durable stop engaged, and keep ELT out of an active write allowlist.

**RECOPS-ELT-FACT-TABLE-BOUNDARY-v3 — current, supersedes v2's copy binding.**
Per the operator's 2026-08-06 canonical-cutover directive, the mutation target for
every P1/P2/P3/P4/P5 delivery artifact — not only the ELT doc — moved from the
the operator-owned copy to the CANONICAL artifact. For the ELT doc specifically: the
write target is now canonical `1ExampleDriveId00000000000000000000000000021`
(title "ELT Recruiting Updates"), and the retired copy
`1ExampleDriveId00000000000000000000000000007` is now the explicit deny target
(inverted from v1/v2, where the copy was the write target and the canonical
was denied). The ACL fence is no longer an exact-two-permission match: it now
REQUIRES owner `doc-owner@example.com` and writer
`recops-sheets-writer@example-project.iam.gserviceaccount.com` to be present
(paginated reads are followed, bounded, until both are found) and TOLERATES
additional permissions, since the canonical doc is shared with readers. Mutation
scope, kill-switch/flag discipline, revision/Drive fencing, rollback behavior,
and durable evidence requirements are unchanged from v2.

Canonical mutation targets (retired the operator-owned copy id in parentheses, now
denied/unreachable from every active mutation path):

| Artifact key | Canonical id (live target) | Retired copy id |
|---|---|---|
| elt_doc | `1ExampleDriveId00000000000000000000000000021` | `1ExampleDriveId00000000000000000000000000007` |
| weekly_recruitment | `1ExampleDriveId00000000000000000000000000016` | `1ExampleDriveId00000000000000000000000000019` |
| weekly_progress | `1ExampleDriveId00000000000000000000000000002` | `1ExampleDriveId00000000000000000000000000011` |
| all_hires | `1ExampleDriveId00000000000000000000000000018` | `1ExampleDriveId00000000000000000000000000004` |
| pipeline_890 | `1ExampleDriveId00000000000000000000000000020` | `1ExampleDriveId00000000000000000000000000015` |
| pipeline_907 | `1ExampleDriveId00000000000000000000000000009` | `1ExampleDriveId00000000000000000000000000023` |
| pipeline_1026_1027 | `1ExampleDriveId00000000000000000000000000022` | `1ExampleDriveId00000000000000000000000000006` |
| pipeline_1118_1119 | `1ExampleDriveId00000000000000000000000000005` | `1ExampleDriveId00000000000000000000000000017` |
| final_offer | `1ExampleDriveId00000000000000000000000000003` | `1ExampleDriveId00000000000000000000000000001` |
| rps_tracking | `1ExampleDriveId00000000000000000000000000008` | `1ExampleDriveId00000000000000000000000000014` |
| delivery_roles_rps | `1ExampleDriveId00000000000000000000000000013` | `1ExampleDriveId00000000000000000000000000010` |

New live posture (steady state after cutover): `RECOPS_JOB_MODE=write`,
`RECOPS_STAGING_HYDRATION_ENABLED=true`, all 11 `RECOPS_HYDRATE_*=true`, the
unified scheduler `recops-staging-orchestration-weekday` ENABLED, and the 11
legacy per-artifact schedulers PAUSED (superseded by the unified scheduler,
kept only for rollback/history). This is asserted by
`scripts/recruiting-ops-control-plane-preflight.mjs`.

> — Jordan Rivera, 2026-08-06, canonical cutover directive.

**RECOPS-ELT-BACKFILL-WEEK-v1 — extends v3; the archive gains one governed
backfill path.** Per the 2026-08-08 decision (choosing built
capability over a hand paste), an ELT week that the scheduled job never wrote
may be inserted at its date-ordered position below the newest archive block.
The scope of the relaxation is exactly one case: the week must be ABSENT from
the archive, declared explicitly (`eltBackfillWeekFriday`, driven only by
`scripts/recruiting-ops/elt-doc-week-catchup.ts`), a complete Fri–Thu week
strictly older than the current reporting week, and bracketed by two adjacent
retained blocks. Everything else is unchanged from v3: a week that exists
anywhere in the archive still refuses ("refusing to rewrite history"), the
scheduled path never passes the declared week and behaves byte-identically,
the source cut's generatedAt stays the live clock (the freshness fence is
satisfied honestly, never bypassed), the outside-content HMAC covers every
retained block through the mid-document insert unchanged, and a failed insert
rolls back to the proven preimage. The backfilled entry is unmarked, per the operator's
instruction, and its numbers are recomputed from dated Greenhouse events —
with the standing recompute semantics disclosed in the tracking issue (stage
counts filter to currently-open jobs; retroactive Greenhouse edits are
reflected). Direct driver runs bypass the hydration orchestration ledger
(migration 028 derives the reporting week from the source timestamp, so an
orchestrated backfill row is structurally impossible); pre/post Drive
recorded revisions are the compensating evidence.

> — Recorded 2026-08-11; both ELT AST fingerprint pins
> re-approved with token-stream diffs in the same change.

## Remaining P1 surface disposition

- Four pipeline copies remain blocked by absent current-week value-only ranges
  and absent candidate-event rows from E01.
- Weekly Progress remains blocked except for the pre-existing `FDE/PE!Y2:Y7`
  range, whose stage-row measure definition is unresolved.
- All Hires appends remain blocked because the visible pivot source is fixed at
  `Data sheet!A1:I36`.

Those conflicts require either platform emits or separately approved structural
changes. The delivery adapter must not infer rows or modify form to work around
them.
