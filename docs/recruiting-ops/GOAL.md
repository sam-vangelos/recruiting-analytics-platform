# Recruiting Ops Capability Platform Goal

Status: Active
Date: 2026-06-26
Owner: the operator

## Objective

The workflow-foundation, capability-first correction, Phase 0 automation-control-plane contract foundation, and post-Phase-0 F1-F5 hardening passes are complete. The next goal is the long-form Phase 1-6 non-production expansion of the Recruiting Ops automation control plane.

Work in:

`~/work/ta-ops-analytics-automation-control-plane-phase1-6`

Branch:

`codex/recruiting-ops-automation-control-plane-phase1-6`

## Binding Direction

- Read `DOCS_SOURCE_OF_TRUTH.md` first.
- Treat the current workflow-id modules as useful substrate and provenance, not the final product model.
- Reframe product architecture around capabilities, audiences, consumption purposes, deliverables, delivery mechanisms, automation boundaries, delivery autonomy, human gates, evidence, and legacy mappings.
- Treat the command center as an automation control plane: automate routine deterministic deliverables as far as reliability allows; reserve human judgment for ambiguity, risk, narrative, audience sensitivity, and irreversible action.
- Keep readiness separate from delivery authorization.
- Treat `T##`, `S##`, and `Q##` IDs as legacy coverage/evidence only.
- Keep Greenhouse Harvest v3 as canonical for ATS reads where the required objects/events exist.
- Treat SQL, Looker/SQL Runner output, Sheets, Apps Script, Docs, n8n, Mailgun, Power BI, Slack, Gmail, Google Admin, LinkedIn, and the BI vendor as evidence, custody, compatibility, or delivery surfaces.
- Keep all production writes and live Greenhouse writes out of scope.

## In Scope For The Next Long-Form Loop

1. Phase 1: broaden fixture/local shadow deliverables across high-signal capabilities.
2. Phase 2: add a local run catalog over artifacts, delivery logs, gate results, discrepancies, source gaps, and action proposals.
3. Phase 3: build read-only `/recruiting-ops` control-plane UI over local/catalog data.
4. Phase 4: add disabled/mock live-read adapter scaffolds and readiness checks; no live reads unless approved.
5. Phase 5: add disabled production-delivery adapter interfaces/design only; no sends or writes.
6. Phase 6: add autonomy promotion workflows, trust windows, kill switches, and operator controls; no external auto-delivery activation.

## Long-Form Execution Rule

Continue across phases without stopping at phase boundaries. Commit coherent green gates as they complete. Stop only when the next step requires live network reads, real credentials, external-channel delivery, production writes, production persistence migration, broad PII persistence, scoped-MCP imports, or retirement/cutover.

## Out Of Scope

- Production Google Sheets, Docs, Gmail, Slack, or admin writes.
- Live Greenhouse writes.
- External network calls.
- Broad candidate PII persistence.
- Scoped recruiter MCP rollout, recruiter Slack agent, desktop auth, and identity/session artifacts.
- Legacy asset retirement or cutover.
- Treating legacy SQL as canonical truth.
- Warehouse/dbt/Redshift/Looker-first architecture.

## Done Criteria

- Phase 1-6 implementation claims are backed by code evidence, targeted tests, and `BUILD_PROGRESS.md` entries.
- Local/shadow deliverables, local run catalog, read-only UI, disabled/mock adapters, disabled production-delivery interfaces, and promotion controls are implemented as far as hard stop gates allow.
- Architecture checks prevent claimed-complete phase drift and premature adapter activation.
- `npm run check:recruiting-ops`, `npm run typecheck`, `npm test`, and `git diff --check` pass.

## Stop And Ask

Stop and ask before:

- enabling external network calls,
- enabling persistence reads/writes,
- enabling production output adapters,
- enabling live Greenhouse writes,
- storing broad candidate PII,
- retiring or replacing legacy assets,
- importing scoped-MCP or recruiter-agent code,
- changing the non-production safety posture.
