# P1 ELT document parity report

Prepared 2026-07-11.

## Status

Live hydrated-copy parity: **NOT RUN — no hydration occurred**.

This continuation intentionally produced no Google write. It would be false to
compare the untouched staging copy with a hypothetical platform render or to
classify that comparison as passed. The required post-hydration categories
remain:

- `platform-correct`
- `legacy-error`
- `needs-investigation`

Every observed difference must carry source evidence and a classification; no
bare numeric delta is acceptable.

## What is proven now

The TypeScript renderer has strict fixture-level paragraph-intent parity with
the existing `scripts/build-elt-update.py` text semantics:

- week and section headings;
- number-word and pluralization behavior;
- optional hire location, department, priority, and `TBD` start date;
- RPS unnumbered, later stages numbered `1` through `4`, and offers numbered
  `5`;
- `passed` suffix only when `conducted > 0`;
- QTD and in-week offer splits and names;
- zero-hire and blank-note behavior.

That is renderer-contract evidence, not a visual DOCX comparison and not live
artifact parity.

## Required live parity sequence

After the prerequisites are approved and live read access is available:

1. Export a fresh successful E01 shadow snapshot and a revision-bearing read of
   the exact staging document/tab.
2. Run the public-safe dry-run and retain only hashes, indices, counts, and the
   revision ID in secure review evidence.
3. Review the private render without committing or logging candidate names.
4. Only after separate write approval, hydrate the designated block with a
   required-revision guard.
5. Re-read the document, prove the outside-content fingerprint is unchanged,
   and classify every in-block difference against the manual baseline.
6. Re-run the same period and require `no_op`.

Production parity remains out of scope until the operator separately approves staging
parity and flips the artifact-specific target/configuration.
