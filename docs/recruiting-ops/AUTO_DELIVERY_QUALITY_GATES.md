# Auto-Delivery Quality Gates

Status: Active
Date: 2026-06-25
Owner: the operator

## Purpose

Auto-delivery is allowed only when every applicable gate passes immediately before delivery. Any failed gate auto-pauses the deliverable and writes a delivery-log entry.

## Gates

| Gate | Requirement | Failure result |
|---|---|---|
| Boundary | Channel and adapter are approved; production writes are still off unless separately approved. | `auto_paused: boundary_off` |
| Mode | Fixture runs never deliver to real audiences. | `auto_paused: unsafe_mode` |
| Source freshness | Required sources are observed inside the freshness TTL. | `auto_paused: stale_source` |
| Discrepancy tolerance | No blocking discrepancy or open business definition affects rendered fields. | `auto_paused: blocking_discrepancy` |
| Source gaps | No source gap blocks the deliverable. | `auto_paused: source_gap` |
| Template stability | Template hash matches the hash approved during promotion. | `auto_paused: template_drift` |
| Recipient scope | Every row passes the code-defined recipient scope rule. | `auto_paused: recipient_scope_violation` |
| PII posture | Payload respects the deliverable PII policy and public-safety checks. | `auto_paused: pii_violation` |
| Idempotency | No delivery with the same payload fingerprint already exists in the cadence window. | `auto_paused: idempotency_collision` |
| Trust period | Shadow and promotion criteria are satisfied. | `auto_paused: trust_window_regression` |
| Kill switch | Global, capability, and deliverable kill switches are off. | `auto_paused: kill_switch_on` |

## Logging

Every gate evaluation must write or attach:

- gate ID,
- pass/fail result,
- evidence pointer,
- affected deliverable,
- affected capability,
- run ID,
- payload fingerprint when available.

Auto-pause is explainable. The operator must be able to open the delivery log and see exactly which gate stopped delivery.

## Recovery

- `stale_source` and `idempotency_collision` may recover automatically when the condition clears.
- `blocking_discrepancy`, `business_definition_open`, `source_gap`, `template_drift`, `recipient_scope_violation`, `pii_violation`, `trust_window_regression`, and `kill_switch_on` require explicit human re-enable.
- Re-enable must write a delivery-log entry with actor, reason, and gate snapshot.

