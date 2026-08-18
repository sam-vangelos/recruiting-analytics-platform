# Delivery Autonomy Model

Status: Active
Date: 2026-06-25
Owner: the operator

## Purpose

Delivery autonomy defines whether a deliverable is disabled, in development, proving itself in shadow mode, awaiting review, eligible for automation, auto-delivering, auto-paused, or never allowed to automate.

Readiness != Delivery Authorization.

## Lanes

| Lane | Meaning |
|---|---|
| `auto_delivery` | Deterministic visibility deliverables that can eventually deliver automatically after gates pass. |
| `review_assisted` | Deliverables requiring human review because of narrative, audience sensitivity, open business definitions, or ambiguity. |
| `action_proposal` | Mutations and high-risk work staged for human approval/execution; never a routine reporting lane. |

## Autonomy States

| State | Meaning |
|---|---|
| `disabled` | Registered but not running. |
| `dev_only` | Runs only in development or fixtures; no delivery log obligation beyond local evidence. |
| `shadow` | Runs on schedule and writes artifacts/logs, but does not deliver externally. |
| `review_required` | Artifact can be reviewed and manually released by a human. |
| `auto_eligible` | Passed the eligibility and shadow requirements, but auto-delivery is not enabled. |
| `auto_delivering` | Runs on schedule and delivers automatically when all gates pass. |
| `auto_paused` | Was eligible or delivering, but a gate, boundary, or kill switch stopped delivery. |
| `never_auto` | Explicitly barred from automation. |

## Transitions

- `disabled -> dev_only -> shadow` is normal implementation progression.
- `shadow -> auto_eligible` requires the trust-period criteria in `SHADOW_MODE_AND_TRUST_PERIODS.md`.
- `auto_eligible -> auto_delivering` requires an explicit logged authorization event.
- `auto_delivering -> auto_paused` happens automatically when any delivery quality gate fails.
- `auto_paused -> auto_delivering` requires gates to clear; PII, recipient-scope, template-drift, business-definition, trust-regression, and kill-switch pauses also require human re-enable.
- `review_required` may stay permanent for narrative, leadership-sensitive, or human-owned deliverables.
- `never_auto` is sticky and may only change through an explicit architecture review.

## Logging Requirements

Every autonomy transition must record:

- deliverable ID,
- capability ID,
- previous state,
- next state,
- actor or system,
- reason,
- timestamp,
- evidence or gate snapshot.

## Defaults

Fresh deliverables default to `disabled` or `dev_only`. External-channel delivery defaults to paused until production delivery adapters are approved. Local/shadow delivery is the first allowed proof path.

