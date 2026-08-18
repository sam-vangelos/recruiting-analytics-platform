# Capability Console IA

Status: Active
Date: 2026-06-24
Owner: the operator

## Product Principle

The user does not come to the command center to inspect implementation registries.

The user comes to see the recruiting-ops automation boundary: what is already automated, what is eligible, what is paused, what needs review, what requires human action, what should never automate, and what legacy risks remain.

## Top-Level Navigation

| Route | Purpose |
|---|---|
| `/recruiting-ops` | Automation-control-plane overview: lane posture, auto-pauses, review needs, action needs, blockers, and boundaries. |
| `/recruiting-ops/auto` | Auto-delivery lane: shadow, eligible, auto-delivering, auto-paused, and local-only delivery status. |
| `/recruiting-ops/review` | Review-assisted deliverables awaiting human review or release. |
| `/recruiting-ops/actions` | Human-gated action proposal queue for mutations and never-tier work. |
| `/recruiting-ops/capabilities` | Capability map and drilldown; not the primary daily operating surface. |
| `/recruiting-ops/deliverables` | Stakeholder-facing outputs, readiness states, lane, and delivery authorization. |
| `/recruiting-ops/deliveries` | Append-only delivery/shadow/pause/correction/kill-switch log. |
| `/recruiting-ops/discrepancies` | Classified differences that affect decisions, deliverables, or cutover. |
| `/recruiting-ops/evidence` | Source refs, run artifacts, legacy artifacts, checksums, and provenance. |
| `/recruiting-ops/legacy-coverage` | Handover coverage and disposition of `T##/S##/Q##` items. |
| `/recruiting-ops/boundaries` | Adapter gates, production boundary flags, future auth controls, and kill switches. |

## Overview

Show:

- lane posture across `auto_delivery`, `review_assisted`, and `action_proposal`,
- auto-delivering and auto-paused deliverables,
- shadow and auto-eligible deliverables,
- review-assisted deliverables awaiting release,
- action proposals awaiting approval,
- high-risk discrepancies and source gaps,
- active boundaries and kill switches.

Do not show by default:

- raw query IDs,
- full spreadsheet tab lists,
- implementation module names,
- raw candidate payloads,
- credentials or tokens,
- technical registry counts unless they affect a human decision.
- raw capability-grid navigation as the primary daily surface.

## Capability Detail

Each capability page should show:

- outcome owned,
- audience and consumption purpose,
- lane composition,
- readiness and delivery authorization,
- quality-gate posture,
- active signals,
- exceptions,
- deliverables,
- action proposals,
- evidence,
- legacy mapping.

Legacy mapping belongs at the bottom or in a secondary tab. It should prove coverage, not define the page.

## Legacy Coverage

The legacy coverage view answers:

```text
Have we accounted for everything handed over?
Was it replaced, partially covered, downgraded, preserved as evidence, human-only, or excluded?
```

It is an audit surface, not the primary operating console.
