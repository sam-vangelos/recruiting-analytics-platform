# Recruiting Ops Docs Source Of Truth

Status: Active
Date: 2026-06-26
Owner: the operator

## Read Order For Future Agents

Read these active docs before changing Recruiting Ops Command Center code:

1. `DOCS_SOURCE_OF_TRUTH.md`
2. `GOAL.md`
3. `CAPABILITY_NORTH_STAR.md`
4. `ARCHITECTURE_GUARDRAILS.md`
5. `AUTOMATION_CONTROL_PLANE.md`
6. `DELIVERY_AUTONOMY_MODEL.md`
7. `AUTOMATION_ELIGIBILITY_RUBRIC.md`
8. `AUTO_DELIVERY_QUALITY_GATES.md`
9. `SHADOW_MODE_AND_TRUST_PERIODS.md`
10. `DELIVERY_LOG_SPEC.md`
11. `AUTOMATION_CONTROL_PLANE_TECHNICAL_SPEC.md`
12. `AUTOMATION_CONTROL_PLANE_IMPLEMENTATION_PLAN.md`
13. `AUTOMATION_DELIVERABLE_SEED_MATRIX.md`
14. `AUTOMATION_CONTROL_PLANE_GOAL_PROMPT.md`
15. `AUTOMATION_CONTROL_PLANE_PHASE_1_6_ROADMAP.md`
16. `AUTOMATION_CONTROL_PLANE_PHASE_1_6_PHASE_MANIFEST.md`
17. `AUTOMATION_CONTROL_PLANE_PHASE_1_6_GOAL_PROMPT.md`
18. `AUTOMATION_CONTROL_PLANE_PHASE_1_6_REVIEW_PROMPT.md`
19. `RECRUITING_OPS_CAPABILITY_PLATFORM_SPEC.md`
20. `RECRUITING_OPS_CAPABILITY_REFACTOR_PLAN.md`
21. `AUDIENCE_DELIVERABLE_MATRIX.md`
22. `WORKFLOW_TO_CAPABILITY_REFACTOR_MAP.md`
23. `BUILD_PROGRESS.md`

## Binding Interpretation

The command center is now a capability-first Recruiting Ops automation control plane.

The inherited spreadsheets and workbook task IDs remain important, but only as:

- legacy coverage,
- provenance,
- evidence,
- transition control,
- compatibility references.

`T##`, `S##`, and `Q##` identifiers must not define the product architecture. Product-facing implementation should be organized around reusable capability IDs, audience needs, deliverables, delivery mechanisms, automation boundaries, delivery autonomy, human gates, and evidence.

The automation thesis is binding: automate routine recruiting operations as far as reliability allows; reserve human judgment for ambiguity, risk, narrative, audience sensitivity, and irreversible action. Readiness is not delivery authorization. Auto-delivery, review-assisted delivery, and action proposals are separate lanes.

This is now machine-enforced, not just documented. `lib/recruiting-ops/capabilities.ts` is the capability source of truth; every runnable module declares a `capabilityId`; and `scripts/recruiting-ops-architecture-check.mjs` fails any tree that drops the capability registry, leaves a module unbound, lets the capability docs drift from the registry, leaves a workflow uncovered, or makes the workflow registry the primary console surface. The `/recruiting-ops` console leads with capabilities; `/recruiting-ops/legacy-coverage` is the workflow audit surface.

Phase 0 and the post-Phase-0 F1-F5 hardening pass are complete. The Phase 1-6 launch artifacts are binding for the next goal-mode loop. Future implementation should continue through as many non-production phases as possible without stopping at phase boundaries, while stopping before live network reads, real credentials, external delivery, production writes, production persistence migration, broad PII persistence, scoped-MCP imports, or retirement/cutover.

## Active Implementation Docs

| Path | Role |
|---|---|
| `GOAL.md` | Current objective and stop gates. |
| `ARCHITECTURE_GUARDRAILS.md` | Enforced architecture boundaries. |
| `IMPLEMENTATION_SPEC_MODERNIZATION.md` | Pointer to the active modernization spec set. |
| `RECRUITING_OPS_CAPABILITY_PLATFORM_SPEC.md` | Active technical/product spec. |
| `RECRUITING_OPS_CAPABILITY_REFACTOR_PLAN.md` | Active execution plan for the next coding goal. |
| `CAPABILITY_NORTH_STAR.md` | Strategy and product principle. |
| `AUTOMATION_CONTROL_PLANE.md` | Automation-control-plane thesis, lanes, and IA. |
| `DELIVERY_AUTONOMY_MODEL.md` | Delivery lane, autonomy state, and transition model. |
| `AUTOMATION_ELIGIBILITY_RUBRIC.md` | Criteria for auto-delivery eligibility and disqualifiers. |
| `AUTO_DELIVERY_QUALITY_GATES.md` | Per-delivery gates, auto-pause, and recovery policy. |
| `SHADOW_MODE_AND_TRUST_PERIODS.md` | Shadow runs, trust windows, promotion, and regression checks. |
| `DELIVERY_LOG_SPEC.md` | Append-only audit model for delivery, pause, correction, and kill-switch events. |
| `AUTOMATION_CONTROL_PLANE_TECHNICAL_SPEC.md` | Binding Phase 0 TypeScript contract spec. |
| `AUTOMATION_CONTROL_PLANE_IMPLEMENTATION_PLAN.md` | Completed six-gate Phase 0 implementation plan; provenance for the current contract layer. |
| `AUTOMATION_DELIVERABLE_SEED_MATRIX.md` | Deliverable-by-deliverable lane, autonomy, shadow, and never-auto defaults. |
| `AUTOMATION_CONTROL_PLANE_GOAL_PROMPT.md` | Completed Phase 0 goal prompt; provenance for the current contract layer. |
| `AUTOMATION_CONTROL_PLANE_PHASE_1_6_ROADMAP.md` | Binding roadmap for the next long-form non-production expansion loop. |
| `AUTOMATION_CONTROL_PLANE_PHASE_1_6_PHASE_MANIFEST.md` | Phase 1-6 manifest used by humans and architecture checks. |
| `AUTOMATION_CONTROL_PLANE_PHASE_1_6_GOAL_PROMPT.md` | Paste-ready goal-mode prompt for the Phase 1-6 implementation loop. |
| `AUTOMATION_CONTROL_PLANE_PHASE_1_6_REVIEW_PROMPT.md` | Paste-ready adversarial review prompt for the Phase 1-6 output. |
| `CAPABILITY_INCLUSION_RUBRIC.md` | Inclusion/exclusion rubric for capabilities and artifacts. |
| `AUDIENCE_DELIVERABLE_MATRIX.md` | Audience, consumption purpose, deliverable, and delivery contracts. |
| `CAPABILITY_CONSOLE_IA.md` | UI information architecture for `/recruiting-ops`. |
| `WORKFLOW_TO_CAPABILITY_REFACTOR_MAP.md` | Required disposition for every workflow-id-first artifact. |
| `DELIVERABLE_READINESS_MODEL.md` | Readiness states for deliverables. |
| `ACTION_QUEUE_UX_SPEC.md` | Human-gated action proposal UX. |
| `BUILD_PROGRESS.md` | Append-only build ledger plus current next gate. |

## Reference Docs

Transition-era reference material (handover assessments, transition-control plans, the
aspirational north-star vision) informed the registries' provenance entries but is not part
of this public cut. The registries themselves carry the surviving provenance.

## Archived Docs

Archived docs preserve the sequence of events and prior build basis. Do not implement from them.

| Path | Role |
|---|---|
| `archive/2026-06-24-workflow-foundation/RECRUITING_OPS_COMMAND_CENTER_SPEC.md` | Superseded workflow-foundation spec. |
| `archive/2026-06-24-workflow-foundation/RECRUITING_OPS_COMMAND_CENTER_IMPLEMENTATION_PLAN.md` | Superseded workflow-foundation implementation plan. |
| `archive/2026-06-22-reporting-platform/RECRUITING_REPORTING_PLATFORM_TECHNICAL_SPEC.md` | Historical reporting/warehouse-oriented spec. |

## Provenance Rule

If a future agent sees an old prompt pointing at an archived or reference doc, it must follow that doc only for provenance and then return to the active read order above.
