# Recruiting Ops Automation Control Plane

Status: Active
Date: 2026-06-25
Owner: the operator

## Thesis

Automate routine recruiting operations as far as reliability allows; reserve human judgment for ambiguity, risk, narrative, audience sensitivity, and irreversible action.

The Recruiting Ops Command Center is not just an operator review console. It is a capability-first automation control plane. the operator should define, monitor, and adjust automation boundaries, not review every routine deterministic deliverable forever.

## Product Model

```text
Capability
  -> Deliverable
  -> Lane
  -> Readiness
  -> Delivery Authorization
  -> Gate Evaluation
  -> Delivery Log
```

Readiness != Delivery Authorization.

A deliverable can be factually ready but not authorized to deliver. It can be authorized but auto-paused because a freshness, discrepancy, PII, recipient-scope, idempotency, trust-period, or kill-switch gate failed.

## Lanes

| Lane | Purpose | Examples | Default gate |
|---|---|---|---|
| `auto_delivery` | Routine deterministic visibility outputs. | Recruiter weekly req progress, scoped pipeline snapshots, scorecard reminders, custody/source-health packets. | Auto-deliver only after quality gates pass and delivery authorization permits it. |
| `review_assisted` | Outputs with ambiguity, narrative, tone, leadership sensitivity, open business definitions, or LLM-authored text. | ELT narrative, HOD/CEO rollup during trust period, exception escalation, structured hiring status with human-owned fields. | Human review/release. |
| `action_proposal` | Mutations, admin actions, irreversible work, candidate-impacting work, and access/security changes. | Offer approval, requisition update, access grant, candidate merge/reject, legacy retirement. | Human approval/execution; some actions are never-auto. |

## Control Plane Questions

The `/recruiting-ops` surface should answer:

1. What is already automated?
2. What is eligible to become automated?
3. What is blocked from automation and why?
4. What failed quality gates?
5. What needs human judgment?
6. What should never be automated?
7. What did the system deliver, to whom, from which facts, under which contract?

## Route-Level IA

| Route | Role |
|---|---|
| `/recruiting-ops` | Automation-control-plane overview: lane posture, paused deliverables, review needs, action needs, and boundary state. |
| `/recruiting-ops/auto` | Auto-delivery lane: shadow, eligible, auto-delivering, auto-paused, and local-only delivery status. |
| `/recruiting-ops/review` | Review-assisted deliverables awaiting human review or release. |
| `/recruiting-ops/actions` | Human-gated action proposal queue for mutations, admin work, and never-tier actions. |
| `/recruiting-ops/deliverables` | Deliverable readiness, lane, authorization, freshness, and blockers. |
| `/recruiting-ops/deliveries` | Append-only log of shadow runs, delivery attempts, pauses, corrections, and kill-switch changes. |
| `/recruiting-ops/capabilities` | Capability map and drilldown, not the primary daily operating surface. |
| `/recruiting-ops/capabilities/[id]` | Capability detail, lane composition, eligibility status, evidence, and legacy mapping. |
| `/recruiting-ops/discrepancies` | Classified differences that block or warn deliverables and automation. |
| `/recruiting-ops/evidence` | Source refs, run artifacts, checksums, provenance, and legacy evidence. |
| `/recruiting-ops/legacy-coverage` | Handover coverage audit for `T##`, `S##`, and `Q##`. |
| `/recruiting-ops/boundaries` | Adapter gates, production boundary flags, live-read/write posture, and kill switches. |

## Boundary

External-channel auto-delivery remains blocked until production delivery adapters are separately approved. Local/shadow delivery is allowed as the first proof path. Production writes, live Greenhouse writes, broad candidate PII persistence, and legacy retirement remain out of scope.

