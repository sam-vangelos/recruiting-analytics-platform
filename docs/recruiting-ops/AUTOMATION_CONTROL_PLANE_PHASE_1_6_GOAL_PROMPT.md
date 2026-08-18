# Automation Control Plane Phase 1-6 Goal Prompt

Status: Active
Date: 2026-06-26
Owner: the operator

Use this prompt to launch the long-form Phase 1-6 Codex goal-mode implementation loop.

```text
[$define-goal](~/.codex/skills/define-goal/SKILL.md)

In ~/work/ta-ops-analytics-automation-control-plane-phase1-6 on branch codex/recruiting-ops-automation-control-plane-phase1-6, implement the non-production Phase 1-6 expansion of the Recruiting Ops automation control plane.

Read first, in order:
- docs/recruiting-ops/DOCS_SOURCE_OF_TRUTH.md
- docs/recruiting-ops/GOAL.md
- docs/recruiting-ops/ARCHITECTURE_GUARDRAILS.md
- docs/recruiting-ops/AUTOMATION_CONTROL_PLANE.md
- docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_ROADMAP.md
- docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_PHASE_MANIFEST.md
- docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_REVIEW_PROMPT.md
- docs/recruiting-ops/BUILD_PROGRESS.md

Objective:
Continue across Phase 1 through Phase 6 without stopping at phase boundaries, committing coherent green gates as they complete. Stop only when the next step requires live network reads, real credentials, external-channel delivery, production writes, production persistence migration, broad PII persistence, scoped-MCP imports, or retirement/cutover.

Phase order:
1. Broaden fixture/local shadow deliverables across high-signal capabilities.
2. Add a local run catalog over artifacts, delivery logs, gate results, discrepancies, source gaps, and action proposals.
3. Build read-only /recruiting-ops control-plane UI over local/catalog data.
4. Add disabled/mock live-read adapter scaffolds and readiness checks; no live reads unless approved.
5. Add disabled production-delivery adapter interfaces/design only; no sends or writes.
6. Add autonomy promotion workflows, trust windows, kill switches, and operator controls; no external auto-delivery activation.

Per phase/gate:
- update docs/recruiting-ops/BUILD_PROGRESS.md,
- add targeted tests,
- run npm run check:recruiting-ops,
- run npm run typecheck,
- run npm test,
- run git diff --check,
- run ./node_modules/.bin/next build --webpack if TSX/app route code changed,
- commit a coherent green checkpoint before continuing.

Hard stop and ask the operator before enabling external network calls, real credentials, external delivery, production writes, live Greenhouse writes, broad PII persistence, production persistence migrations, scoped-MCP imports, UI mutation controls, or legacy retirement/cutover.

Do not touch ~/work/ta-ops-analytics.
Do not touch docs/recruiting-ops/consultation-packets unless explicitly asked.
```
