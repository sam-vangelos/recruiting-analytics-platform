# Automation Control Plane Implementation Plan

Status: Active
Date: 2026-06-25
Owner: the operator

## Purpose

This is the next goal-mode implementation plan for the Recruiting Ops automation control plane. It starts with TypeScript contracts, validators, local ledgers, and one fixture-backed shadow deliverable. It deliberately avoids UI expansion and production adapters until the contract layer is proven.

Each gate must update `BUILD_PROGRESS.md`, add focused tests, pass `npm run check:recruiting-ops`, pass `npm test`, pass `git diff --check`, and commit a coherent checkpoint.

## Gate 1: TypeScript Autonomy Contracts And Validators

Add `lib/recruiting-ops/autonomy.ts` with lane, autonomy-state, readiness-state, recipient-scope, kill-switch, delivery-log, and gate-result types matching `AUTOMATION_CONTROL_PLANE_TECHNICAL_SPEC.md`.

Required behavior:

- Validate stable IDs, capability IDs, deliverable IDs, lane/state compatibility, freshness TTL, stale behavior, PII posture, shadow-run requirement, recipient-scope references, and blocked/never-auto rationale.
- Export lookup helpers for autonomy contracts and recipient-scope rules.
- Keep all contracts local/static; no database tables and no network calls.

Acceptance tests:

- Valid contract fixtures pass.
- Missing lane, autonomy state, recipient scope, freshness TTL, or blocked/never-auto rationale fails.
- `auto_delivering` is rejected unless the contract is already in an approved adapter posture; Phase 0 should not seed any deliverable in this state.

## Gate 2: Output And Action Contract Migration

Migrate `ConcreteOutputContract` and action proposal contracts to the automation model.

Required behavior:

- Every concrete output contract has `capabilityId`, `lane`, `initialAutonomyState`, `freshnessTtlMinutes`, `staleBehavior`, `recipientScopeRuleIds`, `deliveryLogRequired: true`, and `deliveryAuthorizationRequired: true`.
- Output validation proves readiness is separate from delivery authorization.
- Action proposal states migrate to `drafted`, `needs_review`, `approved_for_manual_execution`, `rejected`, `deferred`, `blocked`, and `executed_manually`.
- Action proposals gain deferral and manual-execution attestation metadata without adding live execution.

Acceptance tests:

- Every concrete output contract validates against the autonomy registry.
- Stale or missing freshness policy fails validation.
- Never-tier/action-proposal records cannot be auto-authorized.
- Manual-execution attestation is metadata only and preserves `noLiveExecution: true`.

## Gate 3: Lane Default Seed Matrix

Implement the seed matrix from `AUTOMATION_DELIVERABLE_SEED_MATRIX.md` as source-controlled TypeScript data.

Required behavior:

- Every concrete output contract appears exactly once in the seed matrix.
- Every matrix row has capability, lane, initial autonomy state, auto-eligibility, shadow requirement, blocked reason, and never-auto reason where applicable.
- Docs and code remain consistent through tests.

Acceptance tests:

- Missing deliverable in the matrix fails.
- Extra unknown deliverable fails.
- `auto_delivery` candidate without a shadow requirement fails.
- `never_auto` row without a rationale fails.

## Gate 4: Local JSONL Delivery Ledger

Add a local-only JSONL delivery ledger for shadow runs, gate failures, pauses, corrections, and manual-execution attestations.

Required behavior:

- Ledger writes only to local artifact directories.
- Every ledger row includes capability ID, deliverable ID, run ID, lane, autonomy state, readiness state, recipient fingerprint, payload fingerprint, gate snapshot, status, and timestamp.
- Ledger validation rejects raw email, phone, token, or candidate payload fields in public summaries.

Acceptance tests:

- Appending a valid shadow entry writes one JSONL record.
- Missing recipient or payload fingerprint fails.
- PII-bearing public payload summaries fail.
- Ledger writes do not call production adapters.

## Gate 5: Gate Evaluator Skeleton

Implement the deterministic delivery gate evaluator.

Required behavior:

- Evaluate boundary, mode, freshness, discrepancy tolerance, source gap, template stability, recipient scope, PII posture, idempotency, trust period, and kill-switch gates.
- Return a final verdict: `authorized_for_shadow`, `authorized_for_review`, `authorized_for_auto_delivery`, `paused`, or `blocked`.
- Any failed gate writes or returns enough data for a delivery-log entry.
- `auto_delivering` remains unreachable in Phase 0 because no production adapter has been approved.

Acceptance tests:

- Kill switch forces `paused`.
- Stale data follows `warn` vs `block` behavior.
- Recipient-scope mismatch blocks.
- Insufficient shadow history blocks auto-delivery but permits shadow when other gates pass.

## Gate 6: First Fixture-Backed Shadow Deliverable

Add the first local shadow deliverable: recruiter-scoped weekly req progress over existing fixture facts.

Required behavior:

- Use existing Greenhouse-style fixtures only; no live reads.
- Produce local JSON/CSV artifacts and a JSONL shadow delivery-log entry.
- Use `pipeline_movement_intelligence` and deterministic facts from T02/T03-style fixtures.
- Keep recipient identity fingerprinted and do not emit raw email/contact data.
- Do not add UI routes in this gate.

Acceptance tests:

- Fixture run produces an artifact and a shadow log entry.
- Gate evaluator authorizes shadow but not production delivery.
- Public summary is PII-safe.
- Re-running the same input is idempotent by payload fingerprint.

## Global Stop Gates

- No production writes.
- No live Greenhouse writes.
- No external network calls without explicit approval.
- No external-channel delivery.
- No production persistence migration.
- No broad PII persistence.
- No scoped-MCP imports.
- No legacy retirement or cutover.
