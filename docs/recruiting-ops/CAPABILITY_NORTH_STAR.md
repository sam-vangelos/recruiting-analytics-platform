# Capability North Star

Status: Active
Date: 2026-06-24
Owner: the operator

## Principle

Do not rebuild the handover.

The four handover spreadsheets are evidence of recurring recruiting-ops outcomes. They are not the product architecture.

The Recruiting Ops Command Center should become a capability-first operating system for modern recruiting operations:

```text
Capability
  -> audience
  -> consumption purpose
  -> deliverable
  -> delivery mechanism
  -> automation boundary
  -> delivery autonomy
  -> human gate
  -> evidence
  -> legacy mapping
```

`T##`, `S##`, and `Q##` identifiers are legacy coverage and provenance. They should not be the first-class product model.

The automation control plane thesis is:

```text
Automate routine recruiting operations as far as reliability allows;
reserve human judgment for ambiguity, risk, narrative, audience sensitivity,
and irreversible action.
```

the operator should define, monitor, and adjust the automation boundary. the operator should not remain the permanent reviewer of every deterministic recurring report.

## What The Current Foundation Is

The current branch contains useful substrate:

- Greenhouse read boundaries and fixture-backed mapping tests.
- Local workflow runners.
- Run/evidence ledger contracts.
- Discrepancy classes.
- Local JSON/CSV renderers.
- Dry-run action proposals.
- Persistence shapes with adapters disabled.
- A read-only `/recruiting-ops` console.
- Guardrails against production writes, free-form SQL, warehouse/dbt/Redshift defaults, Looker-default paths, scoped-MCP imports, and public PII.

This substrate is salvageable. The next work is to refactor its primary abstraction from workflow IDs into reusable recruiting-ops capabilities.

## Capability Areas

The initial platform capabilities are:

| Capability ID | Outcome |
|---|---|
| `offer_and_hire_lifecycle_intelligence` | Monitor offer, accepted-hire, and start-readiness lifecycle health. |
| `scorecard_accountability` | Make interview/scorecard ownership and overdue accountability visible. |
| `pipeline_movement_intelligence` | Monitor stage movement, stalled candidates, and pipeline progress. |
| `ownership_capacity_management` | Show recruiter/owner workload, unmapped ownership, and capacity risk. |
| `structured_hiring_status` | Produce the org-wide weekly hiring-status rollup (req/headcount/offer/pipeline) with leadership-priority fields. |
| `stakeholder_narrative_generation` | Draft leadership/ELT and recruiter-lead narrative over computed facts; human owns the story. |
| `candidate_identity_resolution` | Surface duplicate/dual-agency candidate conflicts for review. |
| `requisition_lifecycle_control` | Reconcile open/tracked/excluded/closed requisitions; stage requisition action proposals. |
| `offer_administration` | Stage human-gated offer-admin proposals; offer approval stays never-tier. |
| `access_and_identity_administration` | Stage dry-run access/identity proposals (GH users, LinkedIn, Groups); execution stays human-owned. |
| `recruiting_inbox_triage` | Triage the recruiting inbox and clarification cases; draft responses, human sends. |
| `external_artifact_monitoring` | Track health of legacy sheets, dashboards, vendor packets, and alerts. |
| `automation_custody` | Capture, classify, preserve, replace, or retire legacy automations. |
| `transition_readiness_control` | Track handoff readiness, signoff evidence, and unresolved transition risk. |

## Automation Lanes

### `auto_delivery`

Routine deterministic visibility deliverables can graduate into auto-delivery after quality gates and shadow trust periods pass.

Examples:

- recruiter-scoped weekly req progress,
- scoped pipeline snapshots,
- scorecard reminders,
- source-health and custody packets.

### `review_assisted`

Outputs with ambiguity, narrative, tone, business-definition questions, leadership sensitivity, or LLM-authored prose require human review before delivery.

Examples:

- structured hiring status for executives/HODs,
- ELT narrative,
- exception escalation,
- stakeholder prose drafts.

### `action_proposal`

Mutations, admin actions, irreversible work, candidate-impacting work, access/security changes, and legacy retirement belong in human-gated action proposals. Some are never-auto.

Never automate:

- final offer approval,
- candidate rejection,
- LinkedIn account changes,
- production access grants,
- vendor payment,
- legacy asset retirement.

Readiness is not delivery authorization. A deliverable can be ready, shadowing, eligible, auto-delivering, auto-paused, review-required, or never-auto depending on lane, gates, and delivery authorization.

## Inclusion Rule

Do not add a product capability because a workbook tab, Apps Script, n8n workflow, dashboard, or query exists.

A product capability must represent a durable recruiting-ops outcome consumed by a real audience through a useful deliverable. Otherwise it is a legacy artifact, adapter, custody item, reference, or exclusion.
