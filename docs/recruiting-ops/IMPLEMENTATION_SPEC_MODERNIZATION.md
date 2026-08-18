# Implementation Spec: Modernization

Status: Canonical pointer
Date: 2026-06-24

This modernization spec is controlled by:

- `DOCS_SOURCE_OF_TRUTH.md`
- `RECRUITING_OPS_CAPABILITY_PLATFORM_SPEC.md`
- `RECRUITING_OPS_CAPABILITY_REFACTOR_PLAN.md`
- `CAPABILITY_NORTH_STAR.md`
- `AUDIENCE_DELIVERABLE_MATRIX.md`

The prior workflow-foundation spec and implementation plan are archived under `archive/2026-06-24-workflow-foundation/`. The reporting/warehouse-oriented spec is archived under `archive/2026-06-22-reporting-platform/`.

## Binding Decisions

- The product is a capability-first Recruiting Ops platform.
- The current workflow-id foundation is useful substrate, not the final product architecture.
- `T##`, `S##`, and `Q##` identifiers are legacy coverage/evidence only.
- Every capability must define audience, consumption purpose, deliverable, delivery mechanism, automation boundary, human gate, evidence, and legacy mapping.
- Not every deliverable exists to drive a decision; visibility, accountability, context, alignment, and escalation prevention are valid consumption purposes.
- Greenhouse Harvest v3 remains canonical for ATS reads where the required object/event exists.
- Legacy SQL, Looker/SQL Runner output, Sheets, Apps Script, Docs, Power BI, n8n, Mailgun, Slack, Gmail, Google Admin, LinkedIn, and the BI vendor are evidence, custody, compatibility, source, or delivery surfaces.
- Apps Script, n8n, and Power BI default to artifact/custody/dependency status unless the inclusion rubric promotes them.
- No production writes, live Greenhouse writes, broad PII persistence, or legacy retirement are approved by default.

## Modernization Objective

Build the command center so inherited recruiting-ops work is transformed into durable capabilities that produce useful deliverables for defined audiences, with automation where appropriate and explicit human gates where judgment or authority is required.

## Required Implementation Order

1. Preserve the existing workflow-foundation substrate.
2. Add capability, audience, deliverable, readiness, and legacy-mapping contracts.
3. Reframe runnable modules under capability IDs.
4. Refactor `/recruiting-ops` into a capability-first operating console.
5. Keep workflow coverage as a legacy/audit view.
6. Tighten architecture checks against future workflow-id-first product drift.
7. Add production adapters, live persistence, retirement, and autonomy only after the operator approval.

## Stop Gates

- No live Greenhouse writes.
- No production output writes.
- No external network calls unless explicitly approved.
- No legacy Sheet/Doc/App Script/n8n/Power BI retirement without export/capture, replacement or accepted deletion, rollback decision, and the operator signoff.
- No Redshift/dbt/Looker-first architecture unless later justified by capability needs.
- No free-form SQL runner.

## Provenance

The active spec set was derived from:

- the four handover workbooks,
- the workflow-foundation build,
- the transcript decisions on 2026-06-24,
- the requirement to use handover artifacts as directional guidance rather than a product blueprint.
