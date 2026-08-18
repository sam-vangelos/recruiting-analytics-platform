# A9 — corrected implementation plan (post-validation, 2026-08-05)

Status: **approved and implemented** (Jordan Rivera, 2026-08-06, via A9 expanded-scope
approval — recorded as RECOPS-ELT-FACT-TABLE-BOUNDARY-v2 in `PREREQUISITES.md`,
superseding v1). This document is the
implementation contract.

## What changes for the reader

Each week the ELT Recruiting Updates doc (the operator-owned copy only) gains the three Role
Progress sections the automation currently omits: per-section QTD offer line, numbered
stage lines, and the offer-accepted line — the same content a human has always written
after the hires table. The passed-count display fix rides along: a stage with
`0 conducted / 1 passed` currently renders no passed clause at all, hiding a real pass.

## The five pieces (the original spec listed three)

### 1. Carry Role Progress data into the plan (new — validation finding)

`ExecEltFacts.sections` already computes everything the renderer needs (A6 corrected
these numbers; merged in PR #30). The gap is transport: `EltDocWeekPrefacePlan`
(elt-doc-dry-run.ts:181–188) carries only weekLabel + display texts + hireRows, and
`weekPrefaceForFacts` (:1050) maps hires only.

Widen `EltDocWeekPrefacePlan` with a rendered narrative tail:

```
narrativeParagraphs: readonly EltDocParagraph[]   // kind, text, namedStyleType, bold, tone
```

populated in `weekPrefaceForFacts` from the Role Progress portion of
`renderEltDocBlock(facts)` (the `section_heading` + `body` paragraphs after the hires
block — reuse the renderer, do not duplicate its formatting). The renderer thereby gains
its production caller.

### 2. Capture the observed old narrative for rollback (new — validation finding)

On `replace_top_week` (the routine Friday refresh), `rollbackFactTable` is the only
rollback source and it is table-only. Extend the observed-preimage capture
(`observedWeekPreface`, elt-doc-dry-run.ts:1028–1047) to also read the paragraphs between
`table.endIndex` and `archiveBlockRange.endIndex` — text, namedStyleType, bold — into a
`rollbackNarrativeParagraphs` field on the private plan. Rollback recompiles them.
If the observed tail contains structures the capture cannot faithfully reconstruct
(nested tables, images, unknown elements), the plan must **block, not approximate** —
a rollback that rewrites leadership prose imperfectly is fabrication.

### 3. Widen the mutation-owned range in lockstep (spec's piece 1)

`certifyEltDocFactTablePostimage` + `topWeekFactShape` (elt-doc-dry-run.ts ~:822/:886)
and `locateEltDocRollbackFactRange` (google-workspace-staging-client.ts ~:4011) both end
the fact range at `table.endIndex`. All three learn the variable-length narrative tail, on
insert and replace paths. The `contentGuardRange`/`deleteRange` invariants in
`assertEltDocPrivatePlan` (elt-doc-staging-requests.ts:421–521) move with them.

### 4. Build the compiler and its inverse (spec's pieces 2 and 3)

In `buildEltDocBatchUpdateRequests` (elt-doc-staging-requests.ts:91): append the narrative
tail after the table as one `insertText` (paragraph texts joined by newlines) plus
per-paragraph `updateParagraphStyle`/`updateTextStyle`. Index arithmetic: the empty
table's extent is deterministic (`emptyTableCellInsertionIndex`, :343 — cells at
`start + 3 + row*(cols*2+1) + col*2`), so the tail's insertion point is computable before
cell fill. Emit tail requests **before** the cell-fill requests, consistent with the
existing highest-position-first discipline (:238, reverse iteration) so earlier
lower-index inserts never shift already-emitted positions. Invert in
`buildEltDocRollbackRequests` (:108) using piece 2's captured paragraphs.

### 5. The display fix (spec's rider)

`elt-doc-renderer.ts:77`: always render the passed clause; never clamp
passed > conducted (entry-windowed vs exit-windowed — the historical SQL has the same
property).

## Governance record

PREREQUISITES.md's RECOPS-ELT-FACT-TABLE-BOUNDARY-v1 (:29–38) forbids narrative writes.
the operator ruled in the 2026-08-05 handover that the PII boundary is not a gate for the
the operator-owned copy. This change supersedes v1 with a v2 record in the same file: same copy,
same ACL, mutation scope widened from the fact table to the full top-week block
(heading + table + Role Progress), canonical doc still read-only and out of scope.
The archive fingerprint over prior weeks' hand-written history stays load-bearing and
untouched.

## Tests

- `test/recruiting-ops-elt-doc-staging-requests.test.ts` — full-array `toEqual` lock;
  rewrite against the new request stream (no additive path exists).
- `test/recruiting-ops-elt-doc-plan.test.ts` — beyond `insertedSmartChipDoc`, the
  boundary is hardcoded at :611/:686/:1004/:1195 regions (targetEndIndex 464,
  contentGuardRange endIndices); all move.
- Golden fixture `test/fixtures/recruiting-ops/elt-doc-render-golden.json` — regenerate.
- **New:** a renderer test for conducted=0/passed>0 (no existing fixture exercises it —
  a reverted display fix must fail a test).
- Architecture tripwires: AST fingerprints in
  scripts/recruiting-ops-architecture-check.mjs (~:734/:736) and the behavioral
  narrative-rejection test (recruiting-ops-architecture-check.behavioral.test.ts ~:241)
  updated deliberately as part of the change.
- Revert check on every new lock.

## Size and sequencing

Estimate: 500–650 lines net (vs the original 400 budget) — pieces 1–2 are the growth.
Implemented after A8 lands, as one commit. Acceptance: a rendered week containing all
three Role Progress sections with the outside-content fingerprint unchanged; full suite,
typecheck, architecture check, eslint clean.
