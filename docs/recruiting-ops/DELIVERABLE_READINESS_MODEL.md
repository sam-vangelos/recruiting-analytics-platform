# Deliverable Readiness Model

Status: Active
Date: 2026-06-24
Owner: the operator

## Purpose

Deliverables should tell the operator whether an output can be consumed, reviewed, sent, or must be blocked.

Readiness != Delivery Authorization.

Readiness describes whether the artifact is factually complete and safe. Delivery authorization describes whether the system may deliver it automatically, hold it in shadow, queue it for review, or never automate it.

## Readiness States

| State | Meaning | Allowed delivery |
|---|---|---|
| `draft_only` | Local artifact exists but needs the operator review before use. | Command Center/local file only. |
| `ready_for_review` | Output is complete enough for human review; no production send/write implied. | Command Center/local file or review-assisted lane. |
| `ready_for_delivery` | Output is factually ready and can be considered for delivery if authorization and quality gates allow. | Requires delivery authorization; readiness alone does not permit delivery. |
| `ready_with_warnings` | Output can be reviewed or shared only if warnings are acknowledged. | the operator-approved local/exported delivery only. |
| `blocked` | Output has source gaps, unresolved business definitions, or unsafe data posture. | No stakeholder delivery. |
| `evidence_only` | Artifact supports provenance/custody but is not a stakeholder deliverable. | Evidence/legacy coverage views only. |
| `human_only` | Work remains judgment-owned and should not be automated beyond drafting/support. | Human workflow with evidence. |
| `retired_by_signoff` | Legacy item has the operator signoff, replacement or accepted deletion, and rollback decision. | Hidden from active delivery; visible in legacy coverage. |

## Required Fields

Every deliverable contract should declare:

- capability ID,
- audience,
- consumption purpose,
- delivery mechanism,
- cadence,
- readiness state,
- delivery lane,
- delivery authorization state,
- human gate,
- blocking discrepancies,
- evidence refs,
- PII posture,
- legacy mappings.

## Authorization Axis

Readiness states are paired with the autonomy states in `DELIVERY_AUTONOMY_MODEL.md`:

- `disabled`
- `dev_only`
- `shadow`
- `review_required`
- `auto_eligible`
- `auto_delivering`
- `auto_paused`
- `never_auto`

`ready_for_delivery` is necessary but not sufficient for auto-delivery. The deliverable must also be in the `auto_delivery` lane, authorized for `auto_delivering`, and pass the quality gates in `AUTO_DELIVERY_QUALITY_GATES.md`.

## Blocking Conditions

Mark a deliverable `blocked` when:

- source facts are unavailable,
- source-gap discrepancies affect the output,
- business definition is open,
- public output would expose broad PII,
- production write/send is required but not approved,
- the target audience or consumption purpose is unknown.

## Capability Sunset

Readiness above describes deliverables. Capabilities themselves are marked `durable` or `transitional` in `lib/recruiting-ops/capabilities.ts`. Transitional capabilities — those that exist only for the handover window (`external_artifact_monitoring`, `automation_custody`, `transition_readiness_control`) — carry a capability-level `sunsetState`:

| State | Meaning |
|---|---|
| `active` | Still needed during the transition. |
| `sunsetting` | Replacement or retirement is in progress; do not invest in new surface. |
| `retired_by_signoff` | the operator has signed off; the capability's deliverables move to evidence/legacy coverage only. |

Durable capabilities must not declare a `sunsetState`; transitional capabilities must. A transitional capability does not graduate to durable — when its handover purpose ends, it sunsets rather than persisting as permanent product surface.
