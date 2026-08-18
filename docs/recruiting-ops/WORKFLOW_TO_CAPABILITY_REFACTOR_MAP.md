# Workflow To Capability Refactor Map

Status: Active
Date: 2026-06-24
Owner: the operator

## Purpose

This map prevents future agents from treating workbook task IDs as product modules.

Each inherited workflow remains covered, but its target treatment is capability-first.

Disposition values:

- `capability_refactor`: current workflow module should be reframed under a capability.
- `legacy_mapping`: workflow ID should remain only as coverage/provenance metadata.
- `evidence_only`: artifact supports audit/custody but not product UX.
- `reference_only`: preserve for traceability; no active product build.
- `human_only`: drafting/evidence support is allowed; final action stays human-owned.
- `exclude_or_dormant`: do not build unless a real audience and deliverable reappear.

## Map

| Workflow | Current surface | Target capability | Disposition | Refactor instruction |
|---|---|---|---|---|
| T01 | Weekly Recruitment Report | `structured_hiring_status` | `capability_refactor` | Compose the structured req-status rollup from capability facts; manual leadership fields stay human-owned; Q01-Q03 legacy evidence. |
| T02 | Role-Specific Pipeline Reports | `pipeline_movement_intelligence` | `capability_refactor` | Convert req-specific plumbing into configurable pipeline movement signals and deliverables. |
| T03 | Weekly Progress Sheet | `pipeline_movement_intelligence` | `capability_refactor` | Derive progress from pipeline movement facts; do not keep separate spreadsheet logic. |
| T04 | FDL Pipeline Graph | `pipeline_movement_intelligence` | `legacy_mapping` | Treat as visualization/output contract only if audience remains active. |
| T05 | RPS Tracking | `scorecard_accountability` | `capability_refactor` | Reframe as scorecard/interview accountability capability. |
| T06 | ELT Recruiting Updates | `stakeholder_narrative_generation` | `capability_refactor` | Render narrative visibility artifact over computed facts; human review remains required. |
| T07 | Final Offer Report | `offer_and_hire_lifecycle_intelligence` | `capability_refactor` | Reframe as offer lifecycle intelligence; Q12 remains evidence. |
| T08 | All Hires Tracker | `offer_and_hire_lifecycle_intelligence` | `capability_refactor` | Track accepted-hire/start-readiness; Apps Script is custody/evidence, not product architecture. |
| T09 | Role Assignment By Pod | `ownership_capacity_management` | `capability_refactor` | Reframe as ownership/capacity management and unmapped owner detection. |
| T10 | Recruiter Daily Report | `automation_custody` | `exclude_or_dormant` | Preserve template and resume gate; do not build unless consumer is reconfirmed. |
| T12 | RC Tracker Monitoring | `external_artifact_monitoring` | `legacy_mapping` | Treat as external artifact monitor and exception source. |
| T13 | Power BI Dashboard Monitoring | `external_artifact_monitoring` | `legacy_mapping` | Monitor dashboard inventory/alerts only; Power BI is not a product capability. |
| T14 | Power BI RLS / the BI vendor Coordination | `external_artifact_monitoring` | `human_only` | Keep access/vendor coordination human-owned with evidence. |
| T15 | Duplicate Candidate Check Agent | `candidate_identity_resolution` | `capability_refactor` | Rebuild as candidate identity review queue; n8n/Mailgun are custody evidence. |
| T16 | n8n Workflow Setup | `automation_custody` | `evidence_only` | Preserve/export workflow and credentials metadata; do not productize n8n. |
| T17 | Apps Script Development | `automation_custody` | `evidence_only` | Preserve/export script metadata and secrets posture; do not productize Apps Script. |
| T18 | Recruiter Lead Slack Updates | `stakeholder_narrative_generation` | `capability_refactor` | Reframe as recruiter-lead visibility deliverable with human-send gate. |
| T19 | Validation Coordination | `transition_readiness_control` | `legacy_mapping` | Keep as signoff/evidence workflow until capability validation replaces it. |
| T20/T21 | the operator Handoff Preparation | `transition_readiness_control` | `legacy_mapping` | Keep as handoff readiness evidence and closure ledger. |
| S01 | Open / Update Requisitions | `requisition_lifecycle_control` | `human_only` | Detect/draft/stage proposals only; human owns execution. |
| S02 | Approve / Update Offers | `offer_administration` | `human_only` | Offer approval remains never-tier; support evidence and drafts only. |
| S03 | Greenhouse Clarifications | `recruiting_inbox_triage` | `legacy_mapping` | Convert into clarification case queue and FAQ evidence. |
| S04 | Recruiting Inbox Responses | `recruiting_inbox_triage` | `human_only` | Draft/triage only; human-send required. |
| S05 | Create / Modify Greenhouse Users | `access_and_identity_administration` | `human_only` | Access grants remain human-owned; proposal queue only. |
| S06 | Update LinkedIn Users | `access_and_identity_administration` | `human_only` | Manual checklist/evidence; no API automation assumed. |
| S07 | Update Google Groups TA Team | `access_and_identity_administration` | `human_only` | Proposal queue only; Google Admin writes require future approval. |

## Rule

No future product-facing UI or module should be added primarily around a workflow ID unless this map explicitly says the item remains legacy coverage only.
