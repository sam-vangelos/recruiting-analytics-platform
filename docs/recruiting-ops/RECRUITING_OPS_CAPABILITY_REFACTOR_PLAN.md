# Recruiting Ops Capability Refactor Plan

Status: Active execution plan
Date: 2026-06-24
Owner: the operator

## Goal-Mode Launch Contract

Any future goal-mode Codex instance must read these files before editing:

1. `docs/recruiting-ops/DOCS_SOURCE_OF_TRUTH.md`
2. `docs/recruiting-ops/GOAL.md`
3. `docs/recruiting-ops/CAPABILITY_NORTH_STAR.md`
4. `docs/recruiting-ops/ARCHITECTURE_GUARDRAILS.md`
5. `docs/recruiting-ops/AUTOMATION_CONTROL_PLANE.md`
6. `docs/recruiting-ops/DELIVERY_AUTONOMY_MODEL.md`
7. `docs/recruiting-ops/AUTOMATION_ELIGIBILITY_RUBRIC.md`
8. `docs/recruiting-ops/AUTO_DELIVERY_QUALITY_GATES.md`
9. `docs/recruiting-ops/SHADOW_MODE_AND_TRUST_PERIODS.md`
10. `docs/recruiting-ops/DELIVERY_LOG_SPEC.md`
11. `docs/recruiting-ops/RECRUITING_OPS_CAPABILITY_PLATFORM_SPEC.md`
12. `docs/recruiting-ops/RECRUITING_OPS_CAPABILITY_REFACTOR_PLAN.md`
13. `docs/recruiting-ops/AUDIENCE_DELIVERABLE_MATRIX.md`
14. `docs/recruiting-ops/WORKFLOW_TO_CAPABILITY_REFACTOR_MAP.md`

Work only in:

`~/work/ta-ops-analytics-command-center`

Work on:

`codex/recruiting-ops-command-center`

Do not touch:

`~/work/ta-ops-analytics`

## Current State

The workflow-foundation build and capability-first correction pass are complete and committed. The branch now has capability-first docs, registries, module bindings, shared dimensions, local renderers, dry-run action proposals, and non-production guardrails.

The next implementation goal is contract foundations for the automation control plane, not another capability refactor or UI surface.

## Implementation Order

1. Add automation autonomy contracts.
   - Add deliverable autonomy, autonomy state, delivery log, kill switch, and recipient scope contracts.
   - Keep adapters disabled.
   - Validate lane assignment, state names, and required logging fields.

2. Split readiness from authorization.
   - Keep readiness as artifact safety/completeness.
   - Add delivery authorization as the autonomy state.
   - Remove stale the operator-review-specific readiness terminology.

3. Tighten output/action contracts.
   - Add freshness TTL and stale behavior to output contracts.
   - Reconcile action proposal approval states with the action queue spec.
   - Add deferral and manual-execution attestation fields.

4. Prepare later UI surfaces.
   - Do not build UI in the contract-foundation gate.
   - Later UI should render automation state from autonomy/delivery ledgers, not invent state in React.

5. Tighten checks.
   - Add tests/checks that active docs include the automation control plane.
   - Add tests/checks that active docs/code do not collapse readiness into authorization.
   - Add tests/checks that auto-delivery docs retain no-LLM, no-mutation, bounded-PII, shadow, auto-pause, kill-switch, and delivery-log rules.

## Verification

Run after each coherent gate:

```bash
npm run check:recruiting-ops
npm test
git diff --check
```

For UI gates, also run:

```bash
./node_modules/.bin/next build --webpack
```

Default `npm run build` may still fail in this worktree because of the known Turbopack/node_modules symlink issue; use webpack build for application compile verification unless the worktree layout changes.

## Stop Gates

Stop and ask the operator before:

- external network calls,
- live persistence adapters,
- production output adapters,
- live Greenhouse writes,
- broad candidate PII persistence,
- legacy retirement or cutover,
- importing scoped-MCP/recruiter-agent code.

## Completion Criteria

The next contract-foundation gate is complete when:

- active docs and checks enforce the automation-control-plane architecture,
- readiness and delivery authorization are separate in docs and checks,
- lane defaults are documented,
- TypeScript autonomy contracts are added and tested in the next code gate,
- existing non-production safety checks remain green.
