# Recruiting Ops Capability Platform Spec

Status: Active implementation spec
Date: 2026-06-24
Owner: the operator

## Purpose

Build the Recruiting Ops Command Center as a capability-first platform.

The current workflow-id-first foundation is useful substrate, but the product architecture must now move to:

```text
Capability
  -> Audience
  -> Consumption Purpose
  -> Deliverable
  -> Delivery Mechanism
  -> Automation Boundary
  -> Delivery Autonomy
  -> Human Gate
  -> Evidence
  -> Legacy Mapping
```

The execution model extends this to:

```text
Capability
  -> Deliverable
  -> Lane
  -> Readiness
  -> Delivery Authorization
  -> Gate Evaluation
  -> Delivery Log
```

Readiness != Delivery Authorization. A deliverable can be factually ready without being authorized to deliver, and an authorized deliverable can be auto-paused when freshness, discrepancy, source-gap, recipient-scope, PII, idempotency, trust-period, or kill-switch gates fail.

## Current Baseline

Already present in the branch:

- P0 source/workflow/query/script/output registries.
- Greenhouse read-adapter contracts and fake-client mapping tests.
- Local modules for all registered workflow/action surfaces.
- Local JSON/CSV renderers.
- Run/evidence ledger, discrepancy classes, source gaps, and action proposals.
- Persistence table shapes with live adapter disabled.
- Read-only `/recruiting-ops` console over local state.
- Architecture guardrail checker and tests.

This baseline should not be expanded as workflow-id-first product architecture.

## Product Model

### Capability

First-class product unit. Owns a durable recruiting-ops outcome.

Required fields:

- capability ID,
- outcome,
- audience contracts,
- source facts,
- signals,
- deliverables,
- action proposal types,
- automation boundary,
- human gates,
- evidence refs,
- legacy mappings.

### Audience Contract

Defines who consumes a capability and why.

Required fields:

- audience,
- consumption purpose,
- deliverables,
- cadence,
- delivery mechanism,
- visibility/PII posture,
- human gate.

### Deliverable

Stakeholder or internal output.

Required fields:

- deliverable ID,
- capability ID,
- audience,
- readiness state,
- lane,
- delivery authorization state,
- auto-delivery eligibility posture,
- delivery mechanism,
- evidence refs,
- discrepancy blockers,
- PII posture.

Routine deterministic deliverables may become `auto_delivery` after shadow and quality gates pass. Narrative, leadership-sensitive, and business-definition-open deliverables are `review_assisted`. Mutations and high-risk admin/candidate/access work are `action_proposal` or `never_auto`.

### Legacy Mapping

Provenance link to inherited `T##`, `S##`, `Q##`, workbook tab, script, dashboard, or external workflow.

Legacy mappings are required for coverage, but they do not define capabilities.

## Required Capability IDs

- `offer_and_hire_lifecycle_intelligence`
- `scorecard_accountability`
- `pipeline_movement_intelligence`
- `ownership_capacity_management`
- `structured_hiring_status`
- `stakeholder_narrative_generation`
- `candidate_identity_resolution`
- `requisition_lifecycle_control`
- `offer_administration`
- `access_and_identity_administration`
- `recruiting_inbox_triage`
- `external_artifact_monitoring`
- `automation_custody`
- `transition_readiness_control`

## UI Model

The `/recruiting-ops` UI should become capability-first:

- Overview
- Auto-Delivery
- Review
- Capabilities
- Deliverables
- Action Queue
- Deliveries
- Discrepancies
- Evidence
- Legacy Coverage
- Boundaries/Gates

The current workflow registry view is useful as `Legacy Coverage`, not the main operating surface.

## Boundaries

- Greenhouse Harvest v3 remains canonical for ATS reads where it exposes needed objects/events.
- Legacy SQL, Looker/SQL Runner, Sheets, Apps Script, n8n, Power BI, and Docs remain evidence, custody, compatibility, or delivery surfaces.
- No production writes or live Greenhouse writes.
- No broad candidate PII in public summaries.
- No legacy retirement without the operator signoff, replacement/accepted deletion, and rollback decision.

## Acceptance For The Next Code Refactor

The next implementation goal is successful when:

- every runnable module declares a capability ID,
- every `T##/S##` item maps to a capability disposition,
- the UI home surface is capability-first,
- legacy workflow IDs are moved to coverage/evidence surfaces,
- deliverables expose audience and consumption purpose,
- deliverables expose lane, readiness, delivery authorization, and quality-gate posture,
- action proposals group by capability and risk,
- current non-production boundaries remain enforced.
