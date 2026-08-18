# Delivery Log Spec

Status: Active
Date: 2026-06-25
Owner: the operator

## Purpose

The delivery log is the source of truth for what the automation control plane attempted, delivered, held, corrected, or stopped.

Run logs answer what was computed. Delivery logs answer what was delivered or withheld, to whom, under which authorization and gate snapshot.

## Required Record

Every shadow run, delivery attempt, auto-pause, correction, supersession, autonomy transition, and kill-switch change should record:

- delivery ID or event ID,
- deliverable ID,
- capability ID,
- audience or recipient fingerprint,
- lane,
- autonomy state at event time,
- run ID,
- artifact IDs,
- payload fingerprint,
- template hash,
- gate snapshot,
- delivered vs shadow vs paused status,
- delivery mechanism,
- actor or system,
- timestamp,
- correction or supersession link when applicable.

## Privacy

The delivery log must use recipient fingerprints and payload fingerprints in list views. It must not expose broad candidate PII, candidate contact details, tokens, credentials, or raw payloads in public/control summaries.

## Corrections

Corrections are append-only:

- local files write a corrigendum artifact,
- future Slack/email deliveries send a follow-up correction,
- future Sheets/Docs deliveries write a versioned correction,
- the original delivery remains in the log with a supersession pointer.

## Kill-Switch Events

Global, capability-level, and deliverable-level kill-switch changes are delivery-log events. Killing auto-delivery must be low-friction. Re-enabling must require actor, reason, and a fresh gate snapshot.

