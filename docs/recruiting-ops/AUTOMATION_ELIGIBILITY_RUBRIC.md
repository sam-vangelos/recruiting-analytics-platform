# Automation Eligibility Rubric

Status: Active
Date: 2026-06-25
Owner: the operator

## Purpose

This rubric decides whether a deliverable may ever enter the `auto_delivery` lane. Passing the rubric does not authorize delivery; authorization is controlled by the autonomy state and quality gates.

## Required For Auto-Delivery Eligibility

An auto-delivery candidate must satisfy all of the following:

1. Deterministic output: every metric, row, status, and recommendation is computed by code from registered facts and dimensions.
2. Scoped audience: the audience is named and addressable; recipient scope is enforced in code and tests.
3. Bounded PII: auto-delivery payloads use `public_safe` or minimized internal identifiers only; no broad candidate PII.
4. No mutation: the deliverable does not change Greenhouse, Google Workspace, LinkedIn, vendor systems, legacy assets, or any production system.
5. No LLM-authored auto-delivery: if an LLM authors prose, classification, or recommendations in the payload, the deliverable is `review_assisted`.
6. Stable template: schema, manual-field set, audience scope, and delivery template have a stable hash across the shadow window.
7. Fresh sources: source observations fall within the deliverable freshness TTL.
8. Clean discrepancy posture: no blocking discrepancy and no open `business_definition_open` item affecting rendered fields.
9. Source-gap safety: no source gap blocks the deliverable.
10. Idempotency: duplicate delivery is prevented by cadence window and payload fingerprint.
11. Correction path: the delivery mechanism has a documented correction or supersession path.
12. Delivery log: every shadow run, delivery attempt, auto-pause, and correction writes a delivery-log entry.

## Disqualifiers

Any of the following makes a deliverable or action ineligible for auto-delivery:

- offer approval,
- candidate rejection,
- candidate merge/no-merge adjudication,
- production access grants,
- LinkedIn account/license changes,
- Google group or admin access changes,
- requisition mutation,
- vendor payment or commitment,
- legacy asset retirement or deletion,
- candidate-facing communication,
- restricted PII payloads,
- LLM-authored stakeholder narrative.

## Initial Auto-Delivery Candidates

Good candidates for shadow-first automation:

- recruiter-scoped weekly req progress,
- recruiter/interviewer scorecard reminders,
- recruiter-lead or pod-scoped ownership/capacity snapshots,
- internal source-health/custody packets,
- external artifact monitoring digests scoped to named systems owners.

Leadership rollups, ELT narrative, exception escalation, access/admin queues, candidate identity adjudication, and offer administration default to `review_assisted`, `action_proposal`, or `never_auto`.

