# Recruiting Ops Capability Platform Architecture Guardrails

Status: Active
Date: 2026-06-26
Owner: the operator

## Source Hierarchy

1. Greenhouse Harvest v3 is canonical for ATS reads where the required object/event exists.
2. Capabilities are the product architecture.
3. Workbooks define legacy intent, coverage, output contracts, and artifact inventory.
4. `T##`, `S##`, and `Q##` IDs are legacy mappings/evidence only.
5. SQL, Looker/SQL Runner, Apps Script, Sheets, Docs, Power BI, n8n, Mailgun, Slack, Gmail, Google Admin, LinkedIn, and the BI vendor are evidence, custody, compatibility, source, or delivery surfaces.
6. Direct warehouse/dbt/Looker execution is optional later infrastructure, not a default path.

## Capability-First Rules

- Product-facing modules must attach to a capability ID.
- Product-facing UI must lead with capabilities, deliverables, action queues, discrepancies, and evidence.
- Workflow IDs may appear in legacy mapping, tests, evidence, archived docs, reference docs, and compatibility registries.
- Workflow IDs must not be the main product navigation, main module abstraction, or new implementation unit after the refactor.
- Apps Script, n8n, Power BI, Looker, Sheets, and Docs are not product capabilities unless the inclusion rubric explicitly promotes them.

## Forbidden Defaults

- No warehouse-first, Redshift-first, dbt-first, Looker-first, or manual-export-first architecture.
- No exact legacy parity as the default acceptance policy.
- No free-form SQL runner.
- No model-generated metrics, scope, write decisions, row classifications, or source-of-truth definitions.
- No production Google Sheets/Docs/Gmail/Slack/Admin write adapters in the foundation.
- No live Greenhouse writes.
- No direct Greenhouse write methods in the analytics client.
- No public summaries containing secrets, credentials, tokens, raw uploaded rows, candidate emails, phone numbers, or broad candidate payloads.

## Branch Boundaries

The command-center branch must not import or add recruiter-org scoped-MCP rollout files:

- `mcp/greenhouse/scoped-greenhouse/**`
- `mcp/greenhouse/scoped-recruiter-mcp/**`
- `app/api/slack/**`
- `lib/agent-*`
- `lib/recruiter-identity.ts`
- `supabase/migrations/014_recruiter_identity_directory.sql`
- `docs/recruiting-ops/SCOPED_GREENHOUSE_ORG_MCP_TECHNICAL_SPEC.md`

The scoped-MCP workstream may later contribute shared primitives only through deliberate review.

## Discrepancy Policy

Every modern-vs-legacy difference must be classified as one of:

- `legacy_bug`
- `stale_mapping`
- `source_gap`
- `intentional_modernization`
- `modern_bug`
- `business_definition_open`

Unclassified differences block cutover. Differences that do not affect a deliverable, action, audience need, or retirement decision should be de-prioritized.

## Output Policy

- Local JSON and CSV are preferred first.
- XLSX is allowed only to preserve stakeholder-visible output contracts.
- Public summaries must not include secrets, credentials, tokens, raw uploaded rows, candidate emails, phone numbers, or broad candidate payloads.
- Production writes require a later adapter gate, auth review, tests, rollback path, and the operator approval.

## Action Proposal Policy

- Action queues are dry-run only until separately approved.
- Every proposal must record capability, target system, target reference, source evidence, actor, reason, risk tier, approval state, and payload fingerprint.
- Never-tier actions remain blocked: final offer approval, candidate rejection, production access grants, vendor payment, LinkedIn changes, and legacy retirement.

## Phase 1-6 Long-Form Guardrails

- Continue across Phase 1-6 without stopping at phase boundaries when the next work remains local, fixture-backed, mock-backed, disabled, or read-only.
- Every claimed phase must record implementation evidence, targeted tests, validation commands, residual blockers, and next gate in `BUILD_PROGRESS.md`.
- Required validation for every committed phase/gate: `npm run check:recruiting-ops`, `npm run typecheck`, `npm test`, and `git diff --check`; run `./node_modules/.bin/next build --webpack` when TSX/app routes change.
- Stop before live network reads, real credentials, external-channel delivery, production writes, production persistence migrations, broad PII persistence, scoped-MCP imports, or retirement/cutover.
- Disabled/mock adapter scaffolds are allowed only when tests prove they cannot make network calls or sends by default.
