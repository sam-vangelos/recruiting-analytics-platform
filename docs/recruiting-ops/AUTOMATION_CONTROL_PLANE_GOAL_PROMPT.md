# Automation Control Plane Goal Prompt

Status: Active
Date: 2026-06-25
Owner: the operator

Use this prompt to launch the next long-form Codex goal-mode implementation loop.

```text
In ~/work/ta-ops-analytics-command-center on branch codex/recruiting-ops-automation-control-plane, implement Phase 0 of the Recruiting Ops automation control plane.

Read these docs first, in order:
- docs/recruiting-ops/DOCS_SOURCE_OF_TRUTH.md
- docs/recruiting-ops/GOAL.md
- docs/recruiting-ops/CAPABILITY_NORTH_STAR.md
- docs/recruiting-ops/ARCHITECTURE_GUARDRAILS.md
- docs/recruiting-ops/AUTOMATION_CONTROL_PLANE.md
- docs/recruiting-ops/DELIVERY_AUTONOMY_MODEL.md
- docs/recruiting-ops/AUTOMATION_ELIGIBILITY_RUBRIC.md
- docs/recruiting-ops/AUTO_DELIVERY_QUALITY_GATES.md
- docs/recruiting-ops/SHADOW_MODE_AND_TRUST_PERIODS.md
- docs/recruiting-ops/DELIVERY_LOG_SPEC.md
- docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_TECHNICAL_SPEC.md
- docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_IMPLEMENTATION_PLAN.md
- docs/recruiting-ops/AUTOMATION_DELIVERABLE_SEED_MATRIX.md
- docs/recruiting-ops/RECRUITING_OPS_CAPABILITY_PLATFORM_SPEC.md
- docs/recruiting-ops/RECRUITING_OPS_CAPABILITY_REFACTOR_PLAN.md
- docs/recruiting-ops/AUDIENCE_DELIVERABLE_MATRIX.md
- docs/recruiting-ops/WORKFLOW_TO_CAPABILITY_REFACTOR_MAP.md
- docs/recruiting-ops/BUILD_PROGRESS.md

Objective:
Build the Phase 0 automation-control-plane contract foundation, not the UI and not production delivery. The core invariant is: Readiness != Delivery Authorization. A deliverable being structurally ready does not authorize external delivery.

Work through these gates sequentially:
1. Add TypeScript autonomy contracts and validators.
2. Migrate output and action contracts to the autonomy model.
3. Implement the lane/default seed matrix and doc/code consistency tests.
4. Add a local JSONL delivery ledger only.
5. Add a deterministic gate evaluator skeleton.
6. Add the first fixture-backed recruiter weekly req progress shadow deliverable.

For every gate:
- update docs/recruiting-ops/BUILD_PROGRESS.md,
- add targeted tests,
- run npm run check:recruiting-ops,
- run npm test,
- run git diff --check,
- commit a coherent green checkpoint before moving to the next gate.

Stop and ask the operator before enabling any external network call, production adapter, external-channel delivery, live Greenhouse write, broad PII persistence, production persistence migration, legacy retirement, or cutover.

Hard out of scope:
- no UI routes in Phase 0,
- no Google Sheets/Docs/Slack/Gmail/Greenhouse/LinkedIn/Power BI/n8n write path,
- no live Greenhouse writes,
- no external delivery,
- no broad candidate PII persistence,
- no LLM-authored auto-delivery,
- no scoped-MCP imports,
- no legacy retirement.
```
