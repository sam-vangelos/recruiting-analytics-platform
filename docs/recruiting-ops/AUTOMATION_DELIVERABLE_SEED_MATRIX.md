# Automation Deliverable Seed Matrix

Status: Active
Date: 2026-06-25
Owner: the operator

## Purpose

This matrix binds every current concrete output contract to the automation-control-plane model. It is a launch seed, not delivery authorization. The TypeScript implementation must keep this matrix and `lib/recruiting-ops/output-contracts.ts` in one-to-one agreement.

Default posture:

- Deterministic recruiter-scoped or operational visibility reports can be `auto_delivery` candidates, but start in `shadow`.
- Leadership, narrative, sensitive, or human-owned-field deliverables start as `review_assisted`.
- Mutations, candidate-impacting actions, access/security changes, and irreversible work stay `action_proposal` or `never_auto`.

## Authority Model

This markdown table is the source of truth for the columns it contains: deliverable, capability, lane, initial autonomy state, auto-eligibility, shadow requirement, blocked reason, and never-auto rationale. The `recruiting-ops-automation-seed-matrix` test parses these columns and reconciles them against `lib/recruiting-ops/automation-seed-matrix.ts`, so the doc and code cannot drift on them.

Other per-deliverable fields are not represented as columns in this table and are code-authoritative in `lib/recruiting-ops/automation-seed-matrix.ts`: `freshnessTtlMinutes`, `staleBehavior`, `recipientScopeRuleIds`, `readinessStatesAllowed`, and `piiPolicy`. They are intentionally not duplicated here; the code is their single source of truth. The recipient-scope defaults below are descriptive guidance, not a row-bound contract.

## Matrix

| Deliverable | Capability | Lane | Initial autonomy state | Auto-eligibility | Shadow requirement | Blocked reason | Never-auto rationale |
|---|---|---|---|---|---:|---|---|
| `final_offer_sheet` | `offer_and_hire_lifecycle_intelligence` | `review_assisted` | `review_required` | `blocked` | 4 | Contains offer/hire lifecycle rows with internal identifiers; stakeholder delivery needs review until audience-specific summaries exist. | N/A |
| `all_hires_sheet` | `offer_and_hire_lifecycle_intelligence` | `review_assisted` | `review_required` | `blocked` | 4 | All-hires custody and status context is operationally sensitive until scoped views are defined. | N/A |
| `rps_tracking_sheet` | `scorecard_accountability` | `auto_delivery` | `shadow` | `candidate` | 4 | N/A | N/A |
| `role_pipeline_sheets` | `pipeline_movement_intelligence` | `review_assisted` | `shadow` | `blocked` | 4 | Detailed pipeline rows can contain internal identifiers; auto-delivery requires recruiter-scoped recipient views. | N/A |
| `weekly_progress_sheet` | `pipeline_movement_intelligence` | `auto_delivery` | `shadow` | `candidate` | 4 | N/A | N/A |
| `pipeline_graph_sheet` | `pipeline_movement_intelligence` | `auto_delivery` | `shadow` | `candidate` | 4 | N/A | N/A |
| `role_assignment_sheet` | `ownership_capacity_management` | `auto_delivery` | `shadow` | `candidate` | 4 | N/A | N/A |
| `weekly_recruitment_sheet` | `structured_hiring_status` | `review_assisted` | `review_required` | `blocked` | 4 | Leadership-priority fields remain human-owned and need review before delivery. | N/A |
| `elt_recruiting_doc` | `stakeholder_narrative_generation` | `review_assisted` | `review_required` | `blocked` | 4 | Narrative and leadership-sensitive framing require human review. | N/A |
| `recruiter_lead_slack_draft` | `stakeholder_narrative_generation` | `review_assisted` | `review_required` | `blocked` | 4 | Slack content is a draft over deterministic facts; sending remains human-owned. | N/A |
| `requisition_action_queue` | `requisition_lifecycle_control` | `action_proposal` | `review_required` | `never_auto` | 0 | N/A | Opening, closing, or updating requisitions is a mutation and requires human execution. |
| `offer_action_queue` | `offer_administration` | `action_proposal` | `never_auto` | `never_auto` | 0 | N/A | Offer approval or offer mutation is irreversible/sensitive and must never auto-execute. |
| `greenhouse_user_action_queue` | `access_and_identity_administration` | `action_proposal` | `never_auto` | `never_auto` | 0 | N/A | Access grants and identity changes require human execution. |
| `linkedin_manual_action_queue` | `access_and_identity_administration` | `action_proposal` | `never_auto` | `never_auto` | 0 | N/A | LinkedIn identity/admin work must remain manual and externally controlled. |
| `google_groups_action_queue` | `access_and_identity_administration` | `action_proposal` | `never_auto` | `never_auto` | 0 | N/A | Google group membership affects access and must never auto-execute. |
| `recruiting_inbox_queue` | `recruiting_inbox_triage` | `review_assisted` | `review_required` | `blocked` | 7 | Drafts and triage can be assisted, but human sends and owns responses. | N/A |
| `greenhouse_clarification_log` | `recruiting_inbox_triage` | `review_assisted` | `review_required` | `blocked` | 7 | Clarification decisions can affect recruiting process state and need review. | N/A |
| `duplicate_candidate_review_queue` | `candidate_identity_resolution` | `action_proposal` | `never_auto` | `never_auto` | 0 | N/A | Candidate merge/no-merge adjudication is candidate-impacting and must never auto-execute. |
| `rc_tracker_sheet` | `external_artifact_monitoring` | `auto_delivery` | `shadow` | `candidate` | 4 | N/A | N/A |
| `power_bi_dashboard_alerts` | `external_artifact_monitoring` | `auto_delivery` | `shadow` | `candidate` | 4 | N/A | N/A |
| `power_bi_rls_matrix` | `external_artifact_monitoring` | `action_proposal` | `review_required` | `never_auto` | 0 | N/A | RLS/access/vendor coordination affects permissions and payment-adjacent work; human execution required. |
| `recruiter_daily_sheet` | `automation_custody` | `review_assisted` | `review_required` | `blocked` | 4 | Transitional automation custody output; replacement/retirement decisions need review. | N/A |
| `n8n_custody_packet` | `automation_custody` | `review_assisted` | `review_required` | `blocked` | 4 | Credential/export custody and rotation risks require human review. | N/A |
| `apps_script_asset_registry` | `automation_custody` | `review_assisted` | `review_required` | `blocked` | 4 | Script ownership/export/trigger custody requires human review and may expose credential rotation needs. | N/A |
| `validation_signoff_log` | `transition_readiness_control` | `review_assisted` | `review_required` | `blocked` | 4 | Signoff is human-owned; automation can collect evidence only. | N/A |
| `handoff_readiness_dashboard` | `transition_readiness_control` | `review_assisted` | `review_required` | `blocked` | 4 | Retirement/cutover readiness requires human signoff. | N/A |
| `exec_state_of_play_snapshot` | `structured_hiring_status` | `review_assisted` | `review_required` | `blocked` | 4 | Carries finalist candidate names and Greenhouse profile links for the exec page; delivery beyond the authed page requires review. | N/A |

## Recipient Scope Defaults

| Scope rule | Applies to | Default posture |
|---|---|---|
| `recruiter_scoped_visibility` | Recruiter-owned req progress and accountability views | Fingerprinted recipient, no raw contact data, `auto_delivery` candidate in `shadow`. |
| `team_scoped_visibility` | Team/lead rollups | Fingerprinted team audience, aggregate rows, review before external-channel delivery. |
| `leadership_visibility` | Executive/HOD rollups | Aggregate only, human review by default. |
| `admin_action_review` | Mutation/access/candidate-impacting queues | Human review and manual execution only. |
| `internal_audit` | Custody, validation, delivery logs | Local/internal visibility only until production persistence is approved. |
