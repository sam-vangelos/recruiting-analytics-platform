# Capability Inclusion Rubric

Status: Active
Date: 2026-06-24
Owner: the operator

## Purpose

Use this rubric before promoting any handover task, script, dashboard, or workflow into product architecture.

## Dispositions

Every inherited item must receive one disposition:

| Disposition | Meaning |
|---|---|
| `capability` | Durable recruiting-ops outcome deserving first-class product treatment. |
| `legacy_mapping` | Coverage/provenance reference for a capability. |
| `legacy_artifact` | Evidence or compatibility target; not product architecture. |
| `adapter` | Delivery/source integration for a capability. |
| `custody_item` | Automation or artifact to preserve, audit, replace, or retire. |
| `human_only` | Work should remain manual or judgment-owned. |
| `excluded` | No active audience, deliverable, or operational value. |

## Capability Test

Promote to `capability` only when all of these are true:

- It represents a recurring recruiting-ops outcome, not a one-off artifact.
- It has a known audience.
- It has a defined consumption purpose.
- It produces or supports a deliverable, queue, signal, or operational view.
- It can be generalized beyond a single spreadsheet tab or departing person's process.
- It has an automation boundary and human gate.

If any answer is unknown, the default disposition is `legacy_mapping` or `custody_item`, not `capability`.

## Artifact Test

Use `legacy_artifact` when the item is useful because it contains:

- business logic,
- legacy output shape,
- source evidence,
- validation hints,
- historical context,
- compatibility requirements.

Legacy artifacts can be essential without being product capabilities.

## Custody Test

Use `custody_item` when the item is a script, external workflow, dashboard, credentialed automation, or vendor-owned surface that could create continuity risk.

Apps Script, n8n, Power BI, Looker, Sheets, and Docs default to custody/artifact/adapter status unless they pass the capability test.

## Exclusion Test

Use `excluded` when the item has no confirmed current audience, no active deliverable, and no business logic worth preserving.

Excluded items still need provenance if they appeared in the handover. The exclusion record should state who can reverse the decision and what evidence would justify reactivation.

## Required Question

Before building anything new, answer:

```text
Is this a capability, an artifact, an adapter, a custody item, human-only work, or an exclusion?
```
