# Automation Control Plane Phase 1-6 Roadmap

Status: Active
Date: 2026-06-26
Owner: the operator

## Purpose

This is the binding roadmap for the next long-form goal-mode loop. Phase 0 and the post-Phase-0 F1-F5 hardening pass are complete. The next loop should keep moving across Phase 1 through Phase 6 until it reaches a real stop gate, not stop merely because one phase has finished.

This roadmap is non-production by default. It may build local, fixture-backed, mock-backed, disabled, or read-only surfaces. It must not enable external delivery, production writes, live Greenhouse writes, production persistence migrations, broad PII persistence, scoped-MCP imports, or legacy retirement/cutover.

## Long-Form Execution Rule

Continue across phases without stopping at phase boundaries. Commit coherent green gates as they complete. Stop only when the next step requires live network reads, real credentials, external-channel delivery, production writes, production persistence migration, broad PII persistence, scoped-MCP imports, or retirement/cutover.

Each claimed phase must update `BUILD_PROGRESS.md`, name implementation evidence, name targeted tests, pass `npm run check:recruiting-ops`, pass `npm run typecheck`, pass `npm test`, pass `git diff --check`, and land as a coherent commit.

## Phase Outcomes

| Phase | Outcome | Allowed envelope | Required evidence | Stop gate |
|---|---|---|---|---|
| Phase 1 | Broaden fixture/local shadow deliverables across high-signal capabilities. | Existing fixtures, local renderers, local ledger, gate evaluator, no live reads. | Shadow modules, artifacts, delivery-log entries, capability bindings, targeted tests. | Stop before live Greenhouse/API reads, external delivery, or broad PII. |
| Phase 2 | Add a local run catalog over artifacts, delivery logs, gate results, discrepancies, and action proposals. | Local files/in-memory fixtures and existing local artifact roots. | Catalog contracts, lookup helpers, local fixture tests, PII-safe summaries. | Stop before production DB migrations or live persistence. |
| Phase 3 | Build read-only `/recruiting-ops` control-plane UI over local/catalog data. | Read-only Next.js routes/components backed by local/static data; no actions that mutate external systems. | Overview, auto/review/actions/deliveries/boundaries surfaces, browser/build validation if TSX changes. | Stop before external delivery controls or live mutation controls. |
| Phase 4 | Add disabled/mock live-read adapter scaffolds and readiness checks. | Interfaces, mocks, fixtures, disabled feature flags, readiness diagnostics. | Adapter contracts, disabled-by-default checks, tests proving no network by default. | Stop before using real credentials, live network calls, or live reads. |
| Phase 5 | Add disabled production-delivery adapter interfaces/design only. | Type contracts, mocks, disabled flags, approval preflight checks, no sends/writes. | Adapter interface tests, architecture checks that adapters are disabled, docs for approval requirements. | Stop before Slack/Gmail/Sheets/Docs/Greenhouse/LinkedIn/Power BI/n8n writes or sends. |
| Phase 6 | Add autonomy promotion workflows, trust windows, kill switches, and operator controls. | Local/read-only/pending states, simulated authorization events, disabled external activation. | Promotion state-machine tests, trust-window evidence, kill-switch behavior, audit records. | Stop before activating external auto-delivery or unattended writes. |

## Exit Criteria For The Whole Loop

- The non-production control plane can demonstrate multiple local/shadow deliverables across capabilities.
- Local run catalog surfaces artifacts, ledger events, gate results, discrepancies, source gaps, and action proposals.
- Read-only UI presents the automation boundary clearly without raw candidate payloads or implementation-first navigation.
- Mock/disabled adapters and promotion workflows are scaffolded without enabling external side effects.
- Architecture checks prevent false phase completion and premature adapter activation.
- Validation passes: `npm run check:recruiting-ops`, `npm run typecheck`, `npm test`, and `git diff --check`.
