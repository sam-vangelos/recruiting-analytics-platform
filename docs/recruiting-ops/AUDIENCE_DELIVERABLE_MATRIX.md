# Audience Deliverable Matrix

Status: Active
Date: 2026-06-24
Owner: the operator

## Purpose

Every capability must declare who consumes it, why they consume it, and how the output reaches them.

Consumption purpose is broader than decision support. Deliverables may exist for visibility, accountability, alignment, escalation prevention, narrative/context, operational control, exception review, audit, or approval.

## Matrix

| Capability | Primary audience | Consumption purpose | Deliverables | Delivery mechanism | Cadence | Human gate | Visibility/PII posture | Legacy mapping |
|---|---|---|---|---|---|---|---|---|
| Offer and hire lifecycle intelligence | Operator, recruiting leadership, HODs | Visibility, exception review, escalation prevention | Offer lifecycle summary, stuck offer queue, accepted-hire/start-readiness summary | Command Center, local CSV/JSON, later Sheet/Doc/email behind approval | Weekly/monthly plus exception-driven | Operator reviews before stakeholder delivery; no live writes | Aggregated or operational rows; no public candidate contact fields | T07, T08, Q12, final offer sheet, all hires Apps Script |
| Scorecard accountability | Recruiters, hiring managers, recruiting leads, operator | Accountability, exception review, escalation | Overdue scorecard digest, owner follow-up draft, scorecard health summary | Command Center, local CSV, later Slack/email draft | Weekly plus exception-driven | Operator approves nudges/escalations | Owner/task-level rows; no raw candidate payloads in public summaries | T05, Q11, RPS tracking sheet |
| Pipeline movement intelligence | Operator, recruiter leads, leadership | Visibility, pipeline diagnosis, escalation prevention | Stage movement summary, stuck candidate exceptions, progress digest, graph data | Command Center, local CSV/JSON, later stakeholder digest | Weekly plus exception-driven | Operator reviews stakeholder output | Aggregate by role/stage by default; detailed rows internal only | T02, T03, T04, Q04-Q10, role pipeline/progress/graph sheets |
| Ownership capacity management | Operator, recruiting leads | Planning, accountability, operational hygiene | Workload review, unmapped owner queue, capacity imbalance summary | Command Center, local CSV, later admin proposal queue | Weekly | Operator approves reassignment proposals | Owner/job-level rows; no public candidate payloads | T09, Q13, Q14, role assignment sheet |
| Structured hiring status | Bob/CEO, executives, HODs, operator | Visibility, operational control, escalation prevention | Weekly req-status rollup incl. Billable/Priority/Role Type/Job Health/Progress/Comments | Command Center, local CSV first; later Sheet behind approval | Weekly | the operator finalizes; leadership-priority fields human-owned | Aggregate, leadership-safe; candidate details excluded | T01, Q01-Q03 |
| Stakeholder narrative generation | ELT, org heads, recruiter leads, operator | Narrative/context, alignment, escalation prevention | ELT update draft, recruiter-lead update draft | Local Markdown/Doc/CSV first; later Doc/Slack with approval | Weekly | Operator reviews and sends; human owns the story | Aggregate, leadership-safe | T06, T18 |
| Candidate identity resolution | the operator, RecOps/admin owners | Exception review, financial risk reduction, audit | Duplicate review queue, merge/no-merge proposal packet | Command Center action queue, local CSV/JSON | Exception-driven | Human adjudication required; no auto-merge | Internal review only; minimized candidate identifiers | T15, n8n duplicate workflow, Mailgun evidence |
| Requisition lifecycle control | the operator, RecOps owner, approved admins | Operational control, visibility, approval, audit | Open/tracked/excluded/closed req reconciliation; requisition proposal queue | Command Center, local artifacts | Daily/weekly + ad hoc | Human approval to open/update a req; dry-run only | Req/role metadata; redacted fingerprints | S01, T01 req-list |
| Offer administration | the operator, RecOps owner, approved admins | Operational control, approval, audit | Offer approve/update proposal queue (proposals only) | Command Center, local artifacts | Daily/ad hoc | Offer approval never-tier; human owns execution | Redacted summaries and payload fingerprints | S02 |
| Access and identity administration | the operator, RecOps owner, approved admins | Operational control, approval, audit | GH-user / LinkedIn / Google-Groups proposal queues (dry-run) | Command Center, local artifacts; no provisioning/auth implementation | Ad hoc | Access grants human-owned; dry-run only | Role/scope metadata; no credentials | S05, S06, S07 |
| Recruiting inbox triage | the operator, RecOps owner | Operational control, exception review, audit | Inbox triage + drafts; Greenhouse clarification log | Command Center, local artifacts; human-send only | Daily/ad hoc | Human sends every response; clarification decisions human-owned | Case/item metadata; no candidate payloads | S03, S04 |
| External artifact monitoring (transitional) | the operator, systems owners, vendor owners | Dependency management, continuity, escalation | Sheet/dashboard/Power BI/vendor health packet, alert triage | Command Center, local evidence packet | Weekly/ad hoc | the operator or named owner resolves | Metadata only unless explicitly approved | T12, T13, T14, Power BI, the BI vendor |
| Automation custody (transitional) | the operator, systems owner | Transition safety, retirement planning, operational control | Apps Script inventory, n8n/Mailgun custody packet, credential-rotation flags | Command Center evidence view, local JSON/CSV | Transition/ad hoc | the operator signs replacement/retirement; exposed secrets flagged for rotation | No secrets; no copied credentials | T10, T16, T17, Apps Script (incl. the T08 all-hires script as a custody asset), n8n, Mailgun |
| Transition readiness control (transitional) | the operator | Handoff readiness, audit, transition safety | Source package ledger, signoff log, blocker dashboard | Command Center, local Markdown/CSV | Transition | the operator signs off closure | Internal operational metadata | T19, T20/T21, transition tracker |

## Canonical Capability IDs

The `Capability` column above uses readable labels; the authoritative capability contracts (audience, consumption purpose, deliverables, automation boundary, human gates, durability) live in `lib/recruiting-ops/capabilities.ts`. The action queue is the shared `/recruiting-ops/actions` delivery surface every capability feeds, not a capability itself. The canonical machine IDs are:

| Label | Capability ID |
|---|---|
| Offer and hire lifecycle intelligence | `offer_and_hire_lifecycle_intelligence` |
| Scorecard accountability | `scorecard_accountability` |
| Pipeline movement intelligence | `pipeline_movement_intelligence` |
| Ownership capacity management | `ownership_capacity_management` |
| Structured hiring status | `structured_hiring_status` |
| Stakeholder narrative generation | `stakeholder_narrative_generation` |
| Candidate identity resolution | `candidate_identity_resolution` |
| Requisition lifecycle control | `requisition_lifecycle_control` |
| Offer administration | `offer_administration` |
| Access and identity administration | `access_and_identity_administration` |
| Recruiting inbox triage | `recruiting_inbox_triage` |
| External artifact monitoring | `external_artifact_monitoring` |
| Automation custody | `automation_custody` |
| Transition readiness control | `transition_readiness_control` |

## Rule

If a capability cannot name an audience, consumption purpose, deliverable, and delivery mechanism, it is not ready for implementation.

## Automation Lane Defaults

Lane defaults describe the intended automation posture for each capability's deliverables. They do not authorize production delivery; delivery authorization depends on `DELIVERY_AUTONOMY_MODEL.md`, `AUTO_DELIVERY_QUALITY_GATES.md`, and approved adapters.

| Capability | Default lane | Initial autonomy state | Rationale |
|---|---|---|---|
| Offer and hire lifecycle intelligence | `review_assisted` for cross-org leadership views; `auto_delivery` candidate for recruiter-scoped visibility | `shadow` for scoped views; `review_required` for leadership views | Lifecycle metrics are deterministic, but cross-org/HOD delivery is sensitive until trust is proven. |
| Scorecard accountability | `auto_delivery` for recruiter/interviewer-scoped reminders; `review_assisted` for cross-org rollups | `shadow` | Deterministic, scoped accountability outputs can automate after quality gates pass. |
| Pipeline movement intelligence | `auto_delivery` for recruiter/req-scoped progress; `review_assisted` for leadership aggregate rollups | `shadow` | Deterministic stage and progress outputs are strong automation candidates once stage taxonomy and recipient scope hold. |
| Ownership capacity management | `auto_delivery` for pod/lead-scoped snapshots; `review_assisted` for cross-pod capacity summaries | `shadow` | Scoped visibility can automate; leadership planning context may require review. |
| Structured hiring status | `review_assisted` | `review_required` | Computed fields are deterministic, but leadership-priority fields remain human-owned. |
| Stakeholder narrative generation | `review_assisted` | `review_required` | Narrative, tone, and LLM-authored prose require human review. |
| Candidate identity resolution | `action_proposal` | `never_auto` for adjudication | Detection can automate; merge/no-merge decisions are candidate-impacting and never auto. |
| Requisition lifecycle control | `action_proposal` | `review_required` or `never_auto` by action risk | Requisition mutations require human approval/execution. |
| Offer administration | `action_proposal` | `never_auto` for offer approval | Offer approval is irreversible/high-risk and never auto. |
| Access and identity administration | `action_proposal` | `never_auto` | Access, LinkedIn, and group/admin changes are security-sensitive. |
| Recruiting inbox triage | `review_assisted` for drafts; `action_proposal` for decisions | `review_required` | Drafting can assist; human sends candidate or stakeholder-facing responses. |
| External artifact monitoring | `auto_delivery` for internal health packets | `shadow` | Metadata/status digests can automate when scoped to named owners. |
| Automation custody | `auto_delivery` for local/internal custody packets | `shadow` | Internal metadata packets are low-risk and useful automation proof paths. |
| Transition readiness control | `review_assisted` | `review_required` | Transitional closure and signoff remain human-owned. |

## Lane Rule

Routine deterministic visibility deliverables should move toward `auto_delivery`. Narrative, leadership-sensitive, and business-definition-open outputs default to `review_assisted`. Mutations, candidate-impacting work, access/security changes, and legacy retirement live in `action_proposal` and may be `never_auto`.
