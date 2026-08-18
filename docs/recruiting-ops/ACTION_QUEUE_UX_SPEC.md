# Action Queue UX Spec

Status: Active
Date: 2026-06-24
Owner: the operator

## Purpose

The action queue is the operating surface for human-gated RecOps action proposals. It should stage mutations, admin actions, candidate-impacting work, access/security changes, and irreversible work without executing live writes.

Routine deterministic visibility deliverables should not remain in action or review queues forever. If they pass the automation eligibility rubric, shadow mode, and delivery quality gates, they should graduate toward the `auto_delivery` lane.

## Action Card Contract

Each proposal should show:

- capability,
- target system,
- recommended action,
- why it exists,
- evidence refs,
- confidence or deterministic rule basis,
- risk tier,
- payload fingerprint,
- redacted payload summary,
- affected deliverables,
- approval state,
- allowed next actions.

## Approval States

| State | Meaning |
|---|---|
| `drafted` | System generated a dry-run proposal. |
| `needs_sam_review` | Proposal is ready for the operator review. |
| `approved_for_manual_execution` | the operator approved manual execution outside the system. |
| `rejected` | Proposal should not proceed. |
| `deferred` | Proposal remains unresolved but not blocked. |
| `blocked` | Proposal cannot proceed due to missing evidence, policy, or unsafe data posture. |

## Never-Tier Actions

Never automate or execute these without explicit future approval and a separate production adapter goal:

- final offer approval,
- candidate rejection,
- production access grants,
- LinkedIn account/license changes,
- vendor payment,
- legacy asset retirement or deletion.

## UX Rules

- Group actions by capability and risk, not by spreadsheet task ID.
- Make human gates visible before action details.
- Show evidence and affected deliverables before payload details.
- Keep candidate PII minimized and hidden from public summaries.
- Keep all production write controls visibly off until a later approved adapter phase.
- Do not render an approve affordance for never-tier actions.
- Do not use the action queue as the home for routine deterministic reporting deliverables that are eligible for auto-delivery.
