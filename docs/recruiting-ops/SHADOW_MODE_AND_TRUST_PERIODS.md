# Shadow Mode And Trust Periods

Status: Active
Date: 2026-06-25
Owner: the operator

## Purpose

Shadow mode proves that a deliverable can run reliably before it is authorized for auto-delivery.

## Shadow Mode

A deliverable in `shadow`:

- runs on its intended cadence,
- renders the same artifact it would deliver,
- evaluates the auto-delivery quality gates,
- writes delivery-log entries as `shadow`,
- does not deliver to an external audience,
- records discrepancies, source gaps, template hashes, payload fingerprints, and evidence pointers.

Shadow mode is not a mock. It does everything except external delivery.

## Trust Period Defaults

| Cadence | Default shadow minimum | Clean window |
|---|---:|---:|
| Weekly | 4 shadow runs | 3 consecutive clean runs |
| Daily | 14 shadow runs | 7 consecutive clean runs |
| Ad hoc | Not auto-eligible by default | Requires explicit review |

These defaults may be tightened per deliverable. Loosening them requires a documented reason.

## Promotion Criteria

Promotion from `shadow` to `auto_eligible` requires:

- required shadow runs completed,
- clean window satisfied,
- source freshness gates passed,
- no blocking discrepancy affecting rendered fields,
- no open business definition affecting rendered fields,
- template hash stable,
- recipient scope rule stable and tested,
- no PII posture violations,
- delivery-log evidence complete.

Promotion from `auto_eligible` to `auto_delivering` requires a separate logged authorization event.

## Regression

After promotion, regression checks continue. A new blocking discrepancy, template drift, recipient-scope violation, PII violation, or trust-window regression auto-pauses delivery.

