# Automation Control Plane Phase 1-6 Phase Manifest

Status: Active
Date: 2026-06-26
Owner: the operator

## Purpose

This manifest is the compact machine-checkable reference for Phase 1-6. `BUILD_PROGRESS.md` may only claim a Phase 1-6 phase complete when this manifest contains the phase and the progress entry records implementation evidence, targeted tests, validation commands, and residual blockers.

## Manifest

| Phase | Phase outcome | Allowed implementation envelope | Required evidence surfaces | Required tests | Validation commands | Stop gates |
|---|---|---|---|---|---|---|
| Phase 1 | Broaden fixture/local shadow deliverables across high-signal capabilities. | Fixtures, local renderers, local ledger, deterministic gate evaluator, no live reads. | Shadow modules, local artifacts, delivery-log entries, capability bindings, BUILD_PROGRESS entry. | Targeted shadow-deliverable tests plus existing delivery gate/ledger tests. | `npm run check:recruiting-ops`; `npm run typecheck`; `npm test`; `git diff --check`. | Live network reads; real credentials; external delivery; broad PII. |
| Phase 2 | Add a local run catalog over artifacts, delivery logs, gate results, discrepancies, source gaps, and action proposals. | Local files, fixtures, in-memory/static indexes, no production persistence. | Catalog contracts, lookup helpers, PII-safe summaries, BUILD_PROGRESS entry. | Catalog indexing, filtering, lineage, and PII-safety tests. | `npm run check:recruiting-ops`; `npm run typecheck`; `npm test`; `git diff --check`. | Production persistence migration; live persistence; broad PII. |
| Phase 3 | Build read-only `/recruiting-ops` control-plane UI over local/catalog data. | Read-only Next.js UI over local/static/catalog data; no external mutations. | Overview and lane/detail routes, control-plane IA alignment, BUILD_PROGRESS entry. | Component/data tests and `next build --webpack` when TSX/app code changes. | `npm run check:recruiting-ops`; `npm run typecheck`; `npm test`; `git diff --check`; `./node_modules/.bin/next build --webpack` if UI changed. | External delivery controls; live mutation controls; raw candidate payload display. |
| Phase 4 | Add disabled/mock live-read adapter scaffolds and readiness checks. | Interfaces, mocks, fixtures, disabled feature flags; no network by default. | Adapter contracts, disabled-readiness diagnostics, mock tests, BUILD_PROGRESS entry. | Tests proving disabled adapters cannot make network calls by default. | `npm run check:recruiting-ops`; `npm run typecheck`; `npm test`; `git diff --check`. | Real credentials; live API calls; live reads. |
| Phase 5 | Add disabled production-delivery adapter interfaces/design only. | Interfaces, mocks, disabled flags, approval preflights; no sends or writes. | Adapter interfaces, approval preflight contracts, disabled-by-default checks, BUILD_PROGRESS entry. | Tests proving no external send/write path is reachable. | `npm run check:recruiting-ops`; `npm run typecheck`; `npm test`; `git diff --check`. | Slack/Gmail/Sheets/Docs/Greenhouse/LinkedIn/Power BI/n8n writes or sends. |
| Phase 6 | Add autonomy promotion workflows, trust windows, kill switches, and operator controls. | Local/read-only/pending states and simulated authorization events only. | Promotion contracts, trust-window evidence, kill-switch events, audit records, BUILD_PROGRESS entry. | State-machine, trust-window, kill-switch, and audit tests. | `npm run check:recruiting-ops`; `npm run typecheck`; `npm test`; `git diff --check`. | External auto-delivery activation; unattended writes; legacy retirement/cutover. |

## Claimed Completion Rule

A phase is claimed only by a dated `BUILD_PROGRESS.md` heading containing `Phase 1-6 Phase N`. Each claimed phase entry must include the sections `Completed gate:`, `Files changed:`, `Commands run:`, `Test results:`, `Residual blockers:`, and `Next gate:`. Claims that omit these sections are invalid.
