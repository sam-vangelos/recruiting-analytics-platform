#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REQUIRED_WORKFLOW_IDS = [
  "T01",
  "T02",
  "T03",
  "T04",
  "T05",
  "T06",
  "T07",
  "T08",
  "T09",
  "T10",
  "T12",
  "T13",
  "T14",
  "T15",
  "T16",
  "T17",
  "T18",
  "T19",
  "T20/T21",
  "S01",
  "S02",
  "S03",
  "S04",
  "S05",
  "S06",
  "S07",
];

const REQUIRED_QUERY_IDS = [
  "Q01",
  "Q02",
  "Q03",
  "Q04",
  "Q05",
  "Q06",
  "Q07",
  "Q08",
  "Q09",
  "Q10",
  "Q11",
  "Q12",
  "Q13",
  "Q14",
  "Q15",
];

const REQUIRED_DOCS = [
  "docs/recruiting-ops/DOCS_SOURCE_OF_TRUTH.md",
  "docs/recruiting-ops/GOAL.md",
  "docs/recruiting-ops/ARCHITECTURE_GUARDRAILS.md",
  "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE.md",
  "docs/recruiting-ops/DELIVERY_AUTONOMY_MODEL.md",
  "docs/recruiting-ops/AUTOMATION_ELIGIBILITY_RUBRIC.md",
  "docs/recruiting-ops/AUTO_DELIVERY_QUALITY_GATES.md",
  "docs/recruiting-ops/SHADOW_MODE_AND_TRUST_PERIODS.md",
  "docs/recruiting-ops/DELIVERY_LOG_SPEC.md",
  "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_TECHNICAL_SPEC.md",
  "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_IMPLEMENTATION_PLAN.md",
  "docs/recruiting-ops/AUTOMATION_DELIVERABLE_SEED_MATRIX.md",
  "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_GOAL_PROMPT.md",
  "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_ROADMAP.md",
  "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_PHASE_MANIFEST.md",
  "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_GOAL_PROMPT.md",
  "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_REVIEW_PROMPT.md",
  "docs/recruiting-ops/BUILD_PROGRESS.md",
  "docs/recruiting-ops/IMPLEMENTATION_SPEC_MODERNIZATION.md",
  "docs/recruiting-ops/RECRUITING_OPS_COMMAND_CENTER_SPEC.md",
  "docs/recruiting-ops/RECRUITING_OPS_COMMAND_CENTER_IMPLEMENTATION_PLAN.md",
  "docs/recruiting-ops/RECRUITING_REPORTING_PLATFORM_TECHNICAL_SPEC.md",
  "docs/recruiting-ops/CAPABILITY_NORTH_STAR.md",
  "docs/recruiting-ops/CAPABILITY_INCLUSION_RUBRIC.md",
  "docs/recruiting-ops/AUDIENCE_DELIVERABLE_MATRIX.md",
  "docs/recruiting-ops/CAPABILITY_CONSOLE_IA.md",
  "docs/recruiting-ops/WORKFLOW_TO_CAPABILITY_REFACTOR_MAP.md",
  "docs/recruiting-ops/DELIVERABLE_READINESS_MODEL.md",
  "docs/recruiting-ops/ACTION_QUEUE_UX_SPEC.md",
  "docs/recruiting-ops/RECRUITING_OPS_CAPABILITY_PLATFORM_SPEC.md",
  "docs/recruiting-ops/RECRUITING_OPS_CAPABILITY_REFACTOR_PLAN.md",
];

const COMMAND_CENTER_PREFIXES = [
  "lib/recruiting-ops/",
  "app/(workbench)/recruiting-ops/",
  "app/(exec)/",
  "scripts/recruiting-ops/",
  // ARCH-META-5: the plane's scheduled trigger lives under app/api and must
  // carry the same posture rules as every other command-center file.
  "app/api/cron/recruiting-ops-shadow/",
  "app/api/cron/recruiting-ops-exec/",
  "app/api/cron/recruiting-ops-staging-hydration/",
];

const CHECKER_PATH = "scripts/recruiting-ops-architecture-check.mjs";
const REGISTRY_PATH = "lib/recruiting-ops/registries.ts";
const WORKFLOW_REFACTOR_MAP_PATH = "docs/recruiting-ops/WORKFLOW_TO_CAPABILITY_REFACTOR_MAP.md";
const CAPABILITIES_PATH = "lib/recruiting-ops/capabilities.ts";
const RECRUITING_OPS_PAGE_PATH = "app/(workbench)/recruiting-ops/page.tsx";
const MODULES_PREFIX = "lib/recruiting-ops/modules/";
const BUILD_PROGRESS_PATH = "docs/recruiting-ops/BUILD_PROGRESS.md";
const PHASE1_6_MANIFEST_PATH = "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_PHASE_MANIFEST.md";
const AUTOMATION_CONTROL_PLANE_PATH = "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE.md";
const STAGING_GOOGLE_WRITE_BOUNDARY_PATH =
  "lib/recruiting-ops/delivery/google-workspace-staging-client.ts";
const EMPLOYEE_REFERRAL_GOOGLE_WRITE_BOUNDARY_PATH =
  "lib/recruiting-ops/employee-referral-master-sheet.ts";
const CANONICAL_PARITY_REGISTRY_PATH =
  "lib/recruiting-ops/delivery/canonical-parity-registry.ts";
const P1_ARTIFACT_TARGET_PATH = "lib/recruiting-ops/delivery/p1-artifacts.ts";
// Retired the operator-owned copy artifact ids, superseded by the 2026-08-06 canonical
// cutover. Only the explicit elt_doc deny declaration in p1-artifacts.ts may
// still reference one of these; every other active mutation path must not.
const RETIRED_COPY_IDS = [
  "1ExampleDriveId00000000000000000000000000007",
  "1ExampleDriveId00000000000000000000000000019",
  "1ExampleDriveId00000000000000000000000000011",
  "1ExampleDriveId00000000000000000000000000004",
  "1ExampleDriveId00000000000000000000000000015",
  "1ExampleDriveId00000000000000000000000000023",
  "1ExampleDriveId00000000000000000000000000006",
  "1ExampleDriveId00000000000000000000000000017",
  "1ExampleDriveId00000000000000000000000000001",
  "1ExampleDriveId00000000000000000000000000014",
  "1ExampleDriveId00000000000000000000000000010",
];
const STAGING_ARTIFACT_REGISTRY_PATH =
  "lib/recruiting-ops/delivery/staging-artifact-registry.ts";
const STAGING_MAINTENANCE_CADENCE_PATH =
  "lib/recruiting-ops/delivery/staging-maintenance-cadence.ts";
const ELT_FACT_PLAN_PATH = "lib/recruiting-ops/delivery/elt-doc-dry-run.ts";
const ELT_FACT_REQUESTS_PATH = "lib/recruiting-ops/delivery/elt-doc-staging-requests.ts";
const SCHEDULED_COPY_SURFACE_PATHS = [
  STAGING_ARTIFACT_REGISTRY_PATH,
  STAGING_MAINTENANCE_CADENCE_PATH,
  "app/api/cron/recruiting-ops-staging-hydration/route.ts",
  "app/api/cron/recruiting-ops-staging-orchestration/route.ts",
  "lib/recruiting-ops/delivery/staging-hydration-orchestrator.ts",
  "lib/recruiting-ops/delivery/staging-hydration-runner.ts",
  "lib/recruiting-ops/delivery/staging-recurring-sheet-lifecycle-runner.ts",
  STAGING_GOOGLE_WRITE_BOUNDARY_PATH,
];
const CAPABILITY_DOC_PATHS = [
  "docs/recruiting-ops/CAPABILITY_NORTH_STAR.md",
  "docs/recruiting-ops/RECRUITING_OPS_CAPABILITY_PLATFORM_SPEC.md",
  "docs/recruiting-ops/AUDIENCE_DELIVERABLE_MATRIX.md",
];
const AUTOMATION_DOC_REQUIREMENTS = [
  {
    file: "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE.md",
    requirements: [
      {
        pattern: /Automate routine recruiting operations as far as reliability allows/i,
        reason: "automation control plane doc must state the automation thesis",
      },
      {
        pattern: /Readiness\s*!=\s*Delivery Authorization/i,
        reason: "automation control plane doc must separate readiness from delivery authorization",
      },
      {
        pattern: /\bauto_delivery\b[\s\S]*\breview_assisted\b[\s\S]*\baction_proposal\b/i,
        reason: "automation control plane doc must define all three lanes",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/AUTOMATION_ELIGIBILITY_RUBRIC.md",
    requirements: [
      {
        pattern: /No LLM-authored auto-delivery/i,
        reason: "automation eligibility rubric must ban LLM-authored auto-delivery",
      },
      {
        pattern: /No mutation/i,
        reason: "automation eligibility rubric must ban mutation auto-delivery",
      },
      {
        pattern: /Bounded PII/i,
        reason: "automation eligibility rubric must require bounded PII",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/AUTO_DELIVERY_QUALITY_GATES.md",
    requirements: [
      {
        pattern: /auto-pauses?/i,
        reason: "auto-delivery quality gates must define auto-pause behavior",
      },
      {
        pattern: /kill switch/i,
        reason: "auto-delivery quality gates must include kill switches",
      },
      {
        pattern: /delivery-log entry/i,
        reason: "auto-delivery quality gates must write delivery-log entries",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/SHADOW_MODE_AND_TRUST_PERIODS.md",
    requirements: [
      {
        pattern: /shadow/i,
        reason: "shadow/trust doc must define shadow mode",
      },
      {
        pattern: /trust/i,
        reason: "shadow/trust doc must define trust periods",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/DELIVERY_LOG_SPEC.md",
    requirements: [
      {
        pattern: /delivery log/i,
        reason: "delivery log spec must define the delivery log",
      },
      {
        pattern: /recipient fingerprint/i,
        reason: "delivery log spec must require recipient fingerprints",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_TECHNICAL_SPEC.md",
    requirements: [
      {
        pattern: /Readiness\s*!=\s*Delivery Authorization/i,
        reason: "automation technical spec must state Readiness != Delivery Authorization",
      },
      {
        pattern: /(?=[\s\S]*DeliverableAutonomyContract)(?=[\s\S]*DeliverableAutonomyState)(?=[\s\S]*DeliveryLogEntry)(?=[\s\S]*KillSwitchState)(?=[\s\S]*RecipientScopeRule)/i,
        reason: "automation technical spec must define the Phase 0 autonomy contracts",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_IMPLEMENTATION_PLAN.md",
    requirements: [
      {
        pattern: /Gate 1[\s\S]*Gate 2[\s\S]*Gate 3[\s\S]*Gate 4[\s\S]*Gate 5[\s\S]*Gate 6/i,
        reason: "automation implementation plan must include Gates 1 through 6",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/AUTOMATION_DELIVERABLE_SEED_MATRIX.md",
    requirements: [
      {
        pattern: /Lane[\s\S]*Initial autonomy state[\s\S]*Auto-eligibility[\s\S]*Shadow requirement[\s\S]*Never-auto rationale/i,
        reason: "automation seed matrix must include lane, autonomy state, auto-eligibility, shadow requirement, and never-auto rationale",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_GOAL_PROMPT.md",
    requirements: [
      {
        pattern: /codex\/recruiting-ops-automation-control-plane[\s\S]*Phase 0[\s\S]*no UI/i,
        reason: "automation goal prompt must bind the branch, Phase 0, and no-UI scope",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_ROADMAP.md",
    requirements: [
      {
        pattern: /Continue across phases without stopping at phase boundaries/i,
        reason: "Phase 1-6 roadmap must require continuous long-form execution across phase boundaries",
      },
      {
        pattern: /Phase 1[\s\S]*Phase 2[\s\S]*Phase 3[\s\S]*Phase 4[\s\S]*Phase 5[\s\S]*Phase 6/i,
        reason: "Phase 1-6 roadmap must define all six phase outcomes",
      },
      {
        pattern: /npm run typecheck/i,
        reason: "Phase 1-6 roadmap must require typecheck validation",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_PHASE_MANIFEST.md",
    requirements: [
      {
        pattern: /Phase outcome[\s\S]*Allowed implementation envelope[\s\S]*Required evidence surfaces[\s\S]*Required tests[\s\S]*Validation commands[\s\S]*Stop gates/i,
        reason: "Phase 1-6 manifest must include outcome, envelope, evidence, tests, validation, and stop gates",
      },
      {
        pattern: /Phase 1[\s\S]*Phase 6/i,
        reason: "Phase 1-6 manifest must list every phase",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_GOAL_PROMPT.md",
    requirements: [
      {
        pattern: /ta-ops-analytics-automation-control-plane-phase1-6[\s\S]*Continue across Phase 1 through Phase 6/i,
        reason: "Phase 1-6 goal prompt must bind the worktree and long-form execution rule",
      },
      {
        pattern: /npm run check:recruiting-ops[\s\S]*npm run typecheck[\s\S]*npm test[\s\S]*git diff --check/i,
        reason: "Phase 1-6 goal prompt must require the validation stack",
      },
    ],
  },
  {
    file: "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_REVIEW_PROMPT.md",
    requirements: [
      {
        pattern: /adversarial review mode[\s\S]*Phase 1-6/i,
        reason: "Phase 1-6 review prompt must be ready before implementation starts",
      },
    ],
  },
];

const PHASE1_6_REQUIRED_PROGRESS_SECTIONS = [
  "Completed gate:",
  "Files changed:",
  "Commands run:",
  "Test results:",
  "Residual blockers:",
  "Next gate:",
];

const PHASE0_CLAIMED_GATE_REQUIREMENTS = [
  {
    gate: 0,
    label: "claimed-gate implementation guardrail",
    requirements: [
      requiredFile(CHECKER_PATH, "architecture checker must enforce claimed Phase 0 gates", [
        /phase0-claimed-gate-implementation/,
        /checkPhase0ClaimedGateImplementation/,
      ]),
      requiredFile("test/recruiting-ops-architecture-check.test.ts", "architecture checker tests must cover claimed Phase 0 gates", [
        /unfinished Phase 0 gates/,
        /claimed Phase 0 Gate 1 complete/,
      ]),
    ],
  },
  {
    gate: 1,
    label: "TypeScript autonomy contracts",
    requirements: [
      requiredFile("lib/recruiting-ops/autonomy.ts", "autonomy module must export Phase 0 contracts and validators", [
        /export interface RecipientScopeRule\b/,
        /export interface DeliverableAutonomyContract\b/,
        /export interface DeliveryLogEntry\b/,
        /export interface KillSwitchState\b/,
        /validateDeliverableAutonomyContract/,
        /createDeliverableAutonomyLookup/,
      ]),
      requiredFile("lib/recruiting-ops/index.ts", "recruiting-ops barrel must export autonomy contracts", [
        /export \* from "\.\/autonomy"/,
      ]),
      requiredFile("test/recruiting-ops-autonomy.test.ts", "autonomy contracts need targeted tests", [
        /validateDeliverableAutonomyContract/,
        /auto_delivering requires an approved external delivery adapter/,
      ]),
    ],
  },
  {
    gate: 2,
    label: "output and action autonomy migration",
    requirements: [
      requiredFile("lib/recruiting-ops/output-contracts.ts", "output contracts must carry autonomy metadata without authorizing delivery", [
        /capabilityId/,
        /initialAutonomyState/,
        /freshnessTtlMinutes/,
        /staleBehavior/,
        /recipientScopeRuleIds/,
        /deliveryLogRequired:\s*true/,
        /deliveryAuthorizationRequired:\s*true/,
      ]),
      requiredFile("lib/recruiting-ops/action-proposals.ts", "action proposals must use the reconciled manual-execution vocabulary", [
        /approved_for_manual_execution/,
        /executed_manually/,
        /deferUntil/,
        /manualExecutionAttestedAt/,
        /externalReference/,
        /noLiveExecution:\s*true/,
      ]),
      requiredFile("test/recruiting-ops-action-proposals.test.ts", "action proposal tests must cover the reconciled state model", [
        /deferred/,
        /manual execution/i,
      ]),
      requiredFile("test/recruiting-ops-substrate.test.ts", "output contract tests must prove readiness does not authorize delivery", [
        /deliveryAuthorizationRequired/,
        /Readiness != Delivery Authorization/,
      ]),
    ],
  },
  {
    gate: 3,
    label: "lane/default seed matrix",
    requirements: [
      requiredFile("lib/recruiting-ops/automation-seed-matrix.ts", "seed matrix module must codify the documented automation defaults", [
        /export const deliverableAutomationSeedMatrix/,
        /docs\/recruiting-ops\/AUTOMATION_DELIVERABLE_SEED_MATRIX\.md/,
        /validateDeliverableAutomationSeedMatrix/,
      ]),
      requiredFile("lib/recruiting-ops/index.ts", "recruiting-ops barrel must export the seed matrix", [
        /export \* from "\.\/automation-seed-matrix"/,
      ]),
      requiredFile("test/recruiting-ops-automation-seed-matrix.test.ts", "seed matrix tests must reconcile docs, code, and output contracts", [
        /AUTOMATION_DELIVERABLE_SEED_MATRIX\.md/,
        /concreteOutputContracts/,
      ]),
      requiredFile("package.json", "check:recruiting-ops must run the seed matrix consistency test", [
        /recruiting-ops-automation-seed-matrix\.test\.ts/,
      ]),
    ],
  },
  {
    gate: 4,
    label: "local JSONL delivery ledger",
    requirements: [
      requiredFile("lib/recruiting-ops/delivery-ledger.ts", "delivery ledger must be local JSONL only", [
        /LOCAL_DELIVERY_LEDGER_MECHANISM/,
        /appendLocalDeliveryLedgerEntry/,
        /serializeLocalDeliveryLedgerEntry/,
        /jsonl/i,
      ]),
      requiredFile("lib/recruiting-ops/index.ts", "recruiting-ops barrel must export the local delivery ledger", [
        /export \* from "\.\/delivery-ledger"/,
      ]),
      requiredFile("test/recruiting-ops-delivery-ledger.test.ts", "delivery ledger needs targeted local JSONL tests", [
        /appendLocalDeliveryLedgerEntry/,
        /jsonl/i,
      ]),
    ],
  },
  {
    gate: 5,
    label: "deterministic gate evaluator",
    requirements: [
      requiredFile("lib/recruiting-ops/delivery-gates.ts", "delivery gate evaluator must return deterministic authorization results and ledger entries", [
        /evaluateDeliveryGates/,
        /DeliveryGateEvaluationResult/,
        /externalDeliveryAdapterApproved/,
        /deliveryLogEntry/,
      ]),
      requiredFile("lib/recruiting-ops/delivery-gates.ts", "delivery gate evaluator must fail freshness not_applicable closed whenever the contract requires freshness (P2)", [
        /Freshness cannot be not_applicable when the contract requires it/,
        /freshnessTtlMinutes > 0/,
      ]),
      requiredFile("lib/recruiting-ops/index.ts", "recruiting-ops barrel must export delivery gates", [
        /export \* from "\.\/delivery-gates"/,
      ]),
      requiredFile("test/recruiting-ops-delivery-gates.test.ts", "delivery gate evaluator needs deterministic tests", [
        /authorized_for_shadow/,
        /external delivery adapter/i,
        /fails closed when auto-delivery freshness timestamp is missing/,
      ]),
    ],
  },
  {
    gate: 6,
    label: "recruiter weekly req progress shadow deliverable",
    requirements: [
      requiredFile("lib/recruiting-ops/modules/recruiter-weekly-req-progress-shadow.ts", "shadow deliverable module must stay local and fixture-backed", [
        /recruiterWeeklyReqProgressShadowDefinition/,
        /runRecruiterWeeklyReqProgressShadow/,
        /appendLocalDeliveryLedgerEntry/,
        /evaluateDeliveryGates/,
        /collectShadowLedgerHistory/,
      ]),
      requiredFile("lib/recruiting-ops/modules/ownership-capacity-shadow.ts", "ownership shadow module must source trust/idempotency evidence from its own ledger (P3)", [
        /collectShadowLedgerHistory/,
        /appendLocalDeliveryLedgerEntry/,
        /evaluateDeliveryGates/,
      ]),
      requiredFile("lib/recruiting-ops/modules/scorecard-accountability-shadow.ts", "scorecard shadow module must source trust/idempotency evidence from its own ledger (P3)", [
        /collectShadowLedgerHistory/,
        /appendLocalDeliveryLedgerEntry/,
        /evaluateDeliveryGates/,
      ]),
      requiredFile("lib/recruiting-ops/index.ts", "recruiting-ops barrel must export the shadow deliverable", [
        /export \* from "\.\/modules\/recruiter-weekly-req-progress-shadow"/,
      ]),
      requiredFile("test/recruiting-ops-recruiter-weekly-req-progress-shadow.test.ts", "shadow deliverable needs fixture-backed tests", [
        /greenhouseFacts/,
        /deliveryLedgerEntry/,
      ]),
    ],
  },
];

// Phase B (2026-07-01): origin/main is merged into this branch, so the other
// workstreams' paths (scoped MCP, Slack agent, identity migration) legitimately
// EXIST here now. The isolation boundary is enforced where it actually matters:
// command-center implementation files must never IMPORT them (patterns below).
const forbiddenImportPatterns = [
  {
    pattern: /from\s+["'][^"']*mcp\/greenhouse\/scoped/i,
    reason: "command-center code cannot import scoped-MCP code",
  },
  {
    pattern: /from\s+["'][^"']*app\/api\/slack/i,
    reason: "command-center code cannot import Slack recruiter-agent routes",
  },
  {
    pattern: /from\s+["'][^"']*agent-(home|loop|render|tools)/i,
    reason: "command-center code cannot import recruiter Slack agent modules",
  },
  {
    pattern: /from\s+["'][^"']*recruiter-identity/i,
    reason: "command-center code cannot import recruiter identity rollout code",
  },
  {
    pattern: /from\s+["'][^"']*(dbt|warehouse|redshift|pre[-_]?dbt|old[-_]?scaffold)/i,
    reason: "command-center code cannot import warehouse/dbt/old-scaffold modules",
  },
];

const sourcePosturePatterns = [
  {
    pattern: /\bwarehouse_read\b/i,
    reason: "warehouse_read cannot be a command-center foundation adapter",
  },
  {
    pattern: /\bredshift\b/i,
    reason: "Redshift must not become a default implementation dependency",
  },
  {
    pattern: /\bpre[-_]?dbt\b/i,
    reason: "pre-dbt scaffold language belongs to the old attempt",
  },
  {
    pattern: /\bexact[-\s]?parity\b/i,
    reason: "exact parity cannot be the default acceptance policy",
  },
  {
    pattern: /\bdefault\w*\s*[:=]\s*["']looker_api["']/i,
    reason: "looker_api can be evidence/access, not the default Phase 1 path",
  },
];

const freeFormSqlPatterns = [
  {
    pattern: /freeFormSqlAllowed\s*:\s*true/,
    reason: "free-form SQL execution is forbidden",
  },
  {
    pattern: /\b(rawSql|executeSql)\b/,
    reason: "registered query IDs must be used instead of free-form SQL surfaces",
  },
  {
    pattern: /\bsql\s*:\s*string\b/,
    reason: "interfaces must accept registered query IDs, not arbitrary SQL strings",
  },
];

const productionWritePatterns = [
  {
    pattern: /["']googleapis["']/,
    reason: "Google API clients are confined to the explicit staging delivery boundary",
    stagingBoundaryAllowed: true,
  },
  {
    pattern: /\bspreadsheets\.values\.(update|append|batchUpdate|clear|batchClear)\b/,
    reason: "Google Sheets value writes are confined to the explicit staging delivery boundary",
    stagingBoundaryAllowed: true,
    stagingMutation: true,
  },
  {
    pattern: /\bspreadsheets\.batchUpdate\b/,
    reason: "Google Sheets structural writes are confined to the explicit staging delivery boundary",
    stagingBoundaryAllowed: true,
    stagingMutation: true,
  },
  {
    pattern: /\bsheets\.copyTo\b/,
    reason: "Google Sheets tab copies are confined to the explicit staging delivery boundary",
    stagingBoundaryAllowed: true,
    stagingMutation: true,
  },
  {
    pattern: /\bdocuments\.batchUpdate\b/,
    reason: "Google Docs writes are confined to the explicit staging delivery boundary",
    stagingBoundaryAllowed: true,
    stagingMutation: true,
  },
  {
    pattern: /\bdrive\.files\.(copy|update|delete)\b/,
    reason: "Google Drive mutations are confined to the explicit staging delivery boundary",
    stagingBoundaryAllowed: true,
    stagingMutation: true,
  },
  {
    pattern: /\bgmail\.users\.messages\.send\b/,
    reason: "Gmail sends are forbidden in Phase 1",
  },
  {
    pattern: /\bproductionWriteEnabled\s*:\s*true\b/,
    reason: "output contracts must keep production writes disabled",
  },
];

const greenhouseWriteImportPattern =
  /import\s+\{[^}]*\bgreenhouse(Post|Patch|Put|Delete)\b[^}]*\}\s+from\s+["'][^"']*greenhouse-client["']/i;

const publicOutputPathPattern =
  /(^|\/)(public|summary|summaries|leadership|rollup|rollups|slack|renderer|renderers|control-output|output)\b/i;

const publicPiiPatterns = [
  {
    pattern: /\b(candidate_?email|personal_?email|email)\b/i,
    reason: "public/control output modules must not emit email fields",
  },
  {
    pattern: /\b(phone|phone_number|mobile)\b/i,
    reason: "public/control output modules must not emit phone fields",
  },
  {
    pattern: /\b(token|api[_-]?key|secret)\b/i,
    reason: "public/control output modules must not emit token or secret fields",
  },
  {
    pattern: /\b(candidate(Row|Rows|Payload|Payloads)|raw(Application|Candidate)Payload)\b/,
    reason: "public/control output modules must not dump candidate-row payloads",
  },
];

const nonActiveDocPrefixes = [
  "docs/recruiting-ops/archive/",
  "docs/recruiting-ops/reference/",
  "docs/recruiting-ops/consultation-packets/",
];

const staleActiveDocPatterns = [
  {
    pattern: /\bFirst Goal-Mode Objective\b/i,
    reason: "active docs must not point future agents at the completed workflow-foundation objective",
  },
  {
    pattern: /\bP1 Substrate\s*\|\s*Next\b/i,
    reason: "active docs must not describe the completed P1 substrate as the next phase",
  },
  {
    pattern: /\bNot yet present\b/i,
    reason: "active docs must not use stale baseline language for completed foundation components",
  },
  {
    pattern: /\bready_for_sam_review\b/i,
    reason: "active docs must use ready_for_review and keep readiness separate from delivery authorization",
  },
  {
    pattern: /The active next gate is Phase 0 TypeScript Autonomy Contracts/i,
    reason: "active docs must not point future agents at completed Phase 0 contract foundations as the next gate",
  },
  {
    pattern: /The active next gate is Contract Foundations for the Automation Control Plane/i,
    reason: "active docs must not point future agents at completed Phase 0 contract foundations as the next gate",
  },
];

const allowedWorkflowDispositions = [
  "capability_refactor",
  "legacy_mapping",
  "evidence_only",
  "reference_only",
  "human_only",
  "exclude_or_dormant",
];

function parseArgs(argv) {
  const rootFlag = argv.indexOf("--root");
  if (rootFlag >= 0) {
    const root = argv[rootFlag + 1];
    if (!root) throw new Error("--root requires a path");
    return { root };
  }
  return { root: null };
}

function resolveRoot(explicitRoot) {
  if (explicitRoot) return explicitRoot;
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function gitFiles(root) {
  try {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
    const gitBackedFiles = [...new Set([...tracked, ...untracked])].sort();
    if (gitBackedFiles.length > 0) return gitBackedFiles;
  } catch {
    // Fixture tests can run against plain temporary directories.
  }
  return walkFiles(root);
}

function walkFiles(root, dir = root) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(root, absolute));
      continue;
    }
    if (entry.isFile()) files.push(normalizePath(relative(root, absolute)));
  }
  return files.sort();
}

function read(root, file) {
  return readFileSync(join(root, file), "utf8");
}

function parseTypeScript(root, file) {
  return ts.createSourceFile(
    file,
    read(root, file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

// Tamper-evidence pins: the ELT planner and request compiler decide what a
// scheduled run is allowed to touch in a document full of hand-written prose, so
// any edit to either must be re-approved here deliberately rather than ridden in
// on an unrelated change. Recompute with `syntaxFingerprint` below, and diff the
// token streams first to prove the change is what you think it is.
//
// Both fingerprints last moved when inserts generalized from the top
// of the archive to any governed boundary. Planner change verified as three
// purely additive token hunks (1703 -> 1964, zero removals or replacements)
// inside the absent-week branch: the declared-backfill-week mid path with its
// bracket selection and three refusals; every existing token, including the
// never-overwrite and top-insert paths, is unmoved. Compiler change (3832 ->
// 3920): the two heading updateParagraphStyle ranges became
// insertionIndex-relative, the plan validator's top-index gate became
// action-aware with insertAt-consistency checks for inserts, and the rollback
// expectedStart became plan.insertAt.index. Previously moved for the
// `emptyTableExtentEndIndex` off-by-one (`+ 1` -> `+ 2`), a single-token
// change that made Docs reject every batch with HTTP 400.
const APPROVED_ELT_PLANNER_AST_FINGERPRINT =
  "sha256:31d02343ba874c59813f339c2ac6bb44bd4ba7a50be48197191af84d85e03973";
const APPROVED_ELT_REQUEST_COMPILER_AST_FINGERPRINT =
  "sha256:0983cf73d1e01fb44c62bbc3d86b6908d45ae1d5d2f4ac4646e5febe8c73d0dd";

function topLevelFunction(source, name) {
  const matches = source.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name
  );
  return matches.length === 1 ? matches[0] : null;
}

function syntaxFingerprint(node) {
  if (!node) return null;
  const parts = [];
  function visit(current) {
    parts.push(String(current.kind));
    if (
      ts.isIdentifier(current) ||
      ts.isStringLiteralLike(current) ||
      ts.isNumericLiteral(current) ||
      ts.isRegularExpressionLiteral(current)
    ) {
      parts.push(current.text);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return `sha256:${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function eltFactPlannerAndCompilerAreApproved(planSource, requestSource) {
  const planner = topLevelFunction(planSource, "planEltDocDryRun");
  return (
    syntaxFingerprint(planner) === APPROVED_ELT_PLANNER_AST_FINGERPRINT &&
    syntaxFingerprint(requestSource) === APPROVED_ELT_REQUEST_COMPILER_AST_FINGERPRINT
  );
}

function isImplementationFile(file) {
  if (!/\.(ts|tsx|js|jsx|mjs)$/.test(file)) return false;
  if (file === CHECKER_PATH) return false;
  return COMMAND_CENTER_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function publicOutputFiles(files) {
  return files.filter((file) => isImplementationFile(file) && publicOutputPathPattern.test(file));
}

function activeDocFiles(files) {
  return files.filter(
    (file) =>
      file.startsWith("docs/recruiting-ops/") &&
      file.endsWith(".md") &&
      !nonActiveDocPrefixes.some((prefix) => file.startsWith(prefix))
  );
}

function addFailure(failures, rule, message, file = null) {
  failures.push({ rule, file, message });
}

function requiredFile(file, reason, patterns = []) {
  return { file, reason, patterns };
}

function checkForbiddenImports({ root, files, implementationFiles, failures }) {
  for (const file of implementationFiles) {
    const text = read(root, file);
    for (const { pattern, reason } of forbiddenImportPatterns) {
      if (pattern.test(text)) addFailure(failures, "forbidden-imports", reason, file);
    }
  }
}

function checkSourcePosture({ root, implementationFiles, failures }) {
  for (const file of implementationFiles) {
    const text = read(root, file);
    for (const { pattern, reason } of sourcePosturePatterns) {
      if (pattern.test(text)) addFailure(failures, "source-posture", reason, file);
    }
  }
}

function checkGreenhouseWriteBoundary({ root, implementationFiles, failures }) {
  const greenhouseClient = "lib/greenhouse-client.ts";
  if (existsSync(join(root, greenhouseClient))) {
    const text = read(root, greenhouseClient);
    const forbiddenExports = /\bexport\s+(async\s+)?function\s+greenhouse(Post|Patch|Put|Delete)\b/i;
    if (forbiddenExports.test(text)) {
      addFailure(
        failures,
        "greenhouse-write-boundary",
        "direct Greenhouse write helper export is forbidden",
        greenhouseClient
      );
    }
  }

  for (const file of implementationFiles) {
    const text = read(root, file);
    if (greenhouseWriteImportPattern.test(text)) {
      addFailure(
        failures,
        "greenhouse-write-boundary",
        "command-center modules cannot import write-capable Greenhouse helpers",
        file
      );
    }
  }
}

function checkNoFreeFormSql({ root, implementationFiles, failures }) {
  for (const file of implementationFiles) {
    const text = read(root, file);
    for (const { pattern, reason } of freeFormSqlPatterns) {
      if (pattern.test(text)) addFailure(failures, "no-freeform-sql", reason, file);
    }
  }
}

function checkNoProductionWrites({ root, implementationFiles, failures }) {
  const canonicalParityIds = existsSync(join(root, CANONICAL_PARITY_REGISTRY_PATH))
    ? extractIds(
        read(root, CANONICAL_PARITY_REGISTRY_PATH),
        /\bbaseline\(\s*["'][^"']+["']\s*,\s*["'][^"']+["']\s*,\s*["']([^"']+)["']/g
      )
    : [];
  for (const file of implementationFiles) {
    const text = read(root, file);
    const isStagingGoogleWriteBoundary = file === STAGING_GOOGLE_WRITE_BOUNDARY_PATH;
    const isEmployeeReferralGoogleWriteBoundary =
      file === EMPLOYEE_REFERRAL_GOOGLE_WRITE_BOUNDARY_PATH;
    for (const { pattern, reason, stagingBoundaryAllowed } of productionWritePatterns) {
      if (
        (isStagingGoogleWriteBoundary || isEmployeeReferralGoogleWriteBoundary) &&
        stagingBoundaryAllowed
      ) {
        continue;
      }
      if (pattern.test(text)) addFailure(failures, "no-production-writes", reason, file);
    }
    if (
      isStagingGoogleWriteBoundary &&
      productionWritePatterns.some(({ pattern, stagingMutation }) => stagingMutation && pattern.test(text))
    ) {
      for (const requiredGuard of [
        "requireStagingMutationTarget",
        "stagingHydrationEnabled",
        "assertStagingWritePermit",
      ]) {
        if (!text.includes(requiredGuard)) {
          addFailure(
            failures,
            "staging-google-write-boundary",
            `Staging Google adapter must enforce ${requiredGuard} before any mutation`,
            file
          );
        }
      }
    }
    if (isStagingGoogleWriteBoundary) {
      if (text.includes("canonical-parity-registry")) {
        addFailure(
          failures,
          "canonical-parity-read-only-boundary",
          "The Google mutation boundary must not import the canonical parity registry",
          file
        );
      }
      for (const artifactId of canonicalParityIds) {
        if (text.includes(artifactId)) {
          addFailure(
            failures,
            "canonical-parity-read-only-boundary",
            "The Google mutation boundary must not hard-code a canonical parity artifact id",
            file
          );
        }
      }
    }
    if (isEmployeeReferralGoogleWriteBoundary) {
      for (const requiredGuard of [
        "readEmployeeReferralMasterSpreadsheetId",
        "EMPLOYEE_REFERRAL_MASTER_SPREADSHEET_ID",
      ]) {
        if (!text.includes(requiredGuard)) {
          addFailure(
            failures,
            "employee-referral-google-write-boundary",
            `Employee referral Google Sheet writer must enforce ${requiredGuard}`,
            file
          );
        }
      }
      if (/\bdrive[.]/.test(text)) {
        addFailure(
          failures,
          "employee-referral-google-write-boundary",
          "Employee referral writer must not expose Google Drive mutations",
          file
        );
      }
    }
  }
}

function checkGoogleDriveLeastPrivilege({ root, failures }) {
  if (!existsSync(join(root, STAGING_GOOGLE_WRITE_BOUNDARY_PATH))) return;
  const text = read(root, STAGING_GOOGLE_WRITE_BOUNDARY_PATH);
  const driveScopes = extractIds(
    text,
    /["'](https:\/\/www[.]googleapis[.]com\/auth\/drive[^"']*)["']/g
  );
  if (
    driveScopes.length !== 1 ||
    driveScopes[0] !== "https://www.googleapis.com/auth/drive.metadata.readonly" ||
    /\bdrive[.]permissions[.](create|update|delete)\b/.test(text)
  ) {
    addFailure(
      failures,
      "google-drive-least-privilege",
      "The staging writer must use only Drive metadata.readonly and expose no permission mutation",
      STAGING_GOOGLE_WRITE_BOUNDARY_PATH
    );
  }
}

function checkScheduledCopyOnlyTargets({ root, failures }) {
  const registryExists = existsSync(join(root, STAGING_ARTIFACT_REGISTRY_PATH));
  const cadenceExists = existsSync(join(root, STAGING_MAINTENANCE_CADENCE_PATH));
  if (!registryExists && !cadenceExists) return;
  if (!registryExists || !cadenceExists) {
    addFailure(
      failures,
      "scheduled-copy-only-targets",
      "Scheduled copied-artifact maintenance requires the staging registry and cadence resolver"
    );
    return;
  }

  const registry = read(root, STAGING_ARTIFACT_REGISTRY_PATH);
  const cadence = read(root, STAGING_MAINTENANCE_CADENCE_PATH);
  const scheduledLaneCount = (
    registry.match(/^\s{4}"weekday_(?:morning|evening)",$/gm) ?? []
  ).length;
  if (
    scheduledLaneCount !== 11 ||
    !/mutationTarget:\s*"canonical"/.test(registry) ||
    !/stagingArtifactRegistry\.filter\(isScheduledArtifactTarget\)/.test(cadence) ||
    !/target\.mutationTarget\s*===\s*"canonical"/.test(cadence) ||
    !/target\.kind\s*===\s*"google_sheet"\s*\|\|\s*\(target\.key\s*===\s*"elt_doc"\s*&&\s*target\.kind\s*===\s*"google_doc"\)/.test(cadence) ||
    !/weekday\s*===\s*5[\s\S]*target\.key\s*===\s*"elt_doc"/.test(cadence)
  ) {
    addFailure(
      failures,
      "scheduled-copy-only-targets",
      "The cadence resolver must select ten Sheets plus the fact-only ELT canonical Doc",
      STAGING_MAINTENANCE_CADENCE_PATH
    );
  }

  if (
    !existsSync(join(root, ELT_FACT_PLAN_PATH)) ||
    !existsSync(join(root, ELT_FACT_REQUESTS_PATH))
  ) {
    addFailure(
      failures,
      "scheduled-copy-only-targets",
      "Scheduled ELT mutations require the fact-only planner and request compiler"
    );
  } else {
    const planSource = parseTypeScript(root, ELT_FACT_PLAN_PATH);
    const requestSource = parseTypeScript(root, ELT_FACT_REQUESTS_PATH);
    if (
      !eltFactPlannerAndCompilerAreApproved(planSource, requestSource)
    ) {
      addFailure(
        failures,
        "scheduled-copy-only-targets",
        "Scheduled ELT mutations must be actively confined to the weekly fact-table scope",
        ELT_FACT_REQUESTS_PATH
      );
    }
  }

  // Post-cutover: canonical ids are the intended mutation targets, so the
  // registry/cadence/runner surface is now SUPPOSED to carry them. What must
  // stay unreachable from every active mutation path is a RETIRED copy id —
  // except the one explicit elt_doc deny declaration in p1-artifacts.ts, and
  // except the registry's own "retired for history" comment block (it is the
  // approved place to document retired ids; they are not a live binding
  // there).
  for (const file of SCHEDULED_COPY_SURFACE_PATHS) {
    if (file === STAGING_ARTIFACT_REGISTRY_PATH) continue;
    if (!existsSync(join(root, file))) continue;
    const text = read(root, file);
    for (const artifactId of RETIRED_COPY_IDS) {
      if (text.includes(artifactId)) {
        addFailure(
          failures,
          "scheduled-copy-only-targets",
          "A retired copy artifact id is reachable from the scheduled mutation control plane",
          file
        );
      }
    }
  }
  if (existsSync(join(root, P1_ARTIFACT_TARGET_PATH))) {
    const p1Text = read(root, P1_ARTIFACT_TARGET_PATH);
    for (const artifactId of RETIRED_COPY_IDS) {
      const isTheExplicitEltDocDenyEntry =
        artifactId === RETIRED_COPY_IDS[0] &&
        new RegExp(`deniedDocumentIds:\\s*\\[\\s*["']${artifactId}["']\\s*\\]`).test(p1Text);
      if (!isTheExplicitEltDocDenyEntry && p1Text.includes(artifactId)) {
        addFailure(
          failures,
          "scheduled-copy-only-targets",
          "A retired copy artifact id appears outside the approved deny declaration",
          P1_ARTIFACT_TARGET_PATH
        );
      }
    }
  }
}

function checkNoPublicPii({ root, files, failures }) {
  for (const file of publicOutputFiles(files)) {
    const text = read(root, file);
    for (const { pattern, reason } of publicPiiPatterns) {
      if (pattern.test(text)) addFailure(failures, "no-public-pii", reason, file);
    }
  }
}

function extractIds(text, pattern) {
  const ids = [];
  for (const match of text.matchAll(pattern)) ids.push(match[1]);
  return ids;
}

function missingIds(actual, required) {
  const actualSet = new Set(actual);
  return required.filter((id) => !actualSet.has(id));
}

function checkDocsRegistryDrift({ root, failures }) {
  for (const path of REQUIRED_DOCS) {
    if (!existsSync(join(root, path))) {
      addFailure(failures, "docs-registry-drift", `Missing required command-center doc: ${path}`);
    }
  }

  const registryFile = join(root, REGISTRY_PATH);
  if (!existsSync(registryFile)) {
    addFailure(failures, "docs-registry-drift", `Missing command-center registry module: ${REGISTRY_PATH}`);
    return;
  }

  const registry = read(root, REGISTRY_PATH);
  const workflowIds = extractIds(registry, /\bworkflow\(\s*["']([^"']+)["']/g);
  const queryIds = extractIds(registry, /\bquery\(\s*["']([^"']+)["']/g);
  const requiredWorkflowConstantIds = extractIds(
    registry.match(/requiredWorkflowIds\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? "",
    /["']([^"']+)["']/g
  );
  const requiredQueryConstantIds = extractIds(
    registry.match(/requiredQueryIds\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? "",
    /["']([^"']+)["']/g
  );

  for (const [label, actual, required] of [
    ["workflow registry rows", workflowIds, REQUIRED_WORKFLOW_IDS],
    ["query registry rows", queryIds, REQUIRED_QUERY_IDS],
    ["requiredWorkflowIds constant", requiredWorkflowConstantIds, REQUIRED_WORKFLOW_IDS],
    ["requiredQueryIds constant", requiredQueryConstantIds, REQUIRED_QUERY_IDS],
  ]) {
    const missing = missingIds(actual, required);
    if (missing.length > 0) {
      addFailure(failures, "docs-registry-drift", `${label} missing: ${missing.join(", ")}`, REGISTRY_PATH);
    }
  }
}

function checkActiveDocsDoNotDrift({ root, files, failures }) {
  for (const file of activeDocFiles(files)) {
    const text = read(root, file);
    for (const { pattern, reason } of staleActiveDocPatterns) {
      if (pattern.test(text)) addFailure(failures, "docs-provenance-drift", reason, file);
    }
  }
}

function checkAutomationControlPlaneDocs({ root, failures }) {
  if (!existsSync(join(root, AUTOMATION_CONTROL_PLANE_PATH))) {
    addFailure(
      failures,
      "automation-control-plane-docs",
      `Missing automation control plane doc: ${AUTOMATION_CONTROL_PLANE_PATH}`
    );
    return;
  }

  for (const { file, requirements } of AUTOMATION_DOC_REQUIREMENTS) {
    if (!existsSync(join(root, file))) {
      addFailure(failures, "automation-control-plane-docs", `Missing automation-control-plane doc: ${file}`);
      continue;
    }
    const text = read(root, file);
    for (const { pattern, reason } of requirements) {
      if (!pattern.test(text)) addFailure(failures, "automation-control-plane-docs", reason, file);
    }
  }
}

function checkImplementationDoesNotUseStaleReadiness({ root, implementationFiles, failures }) {
  for (const file of implementationFiles) {
    if (/\bready_for_sam_review\b/.test(read(root, file))) {
      addFailure(
        failures,
        "readiness-authorization-separation",
        "implementation must not use ready_for_sam_review; use ready_for_review plus delivery authorization",
        file
      );
    }
  }
}

const prematureAutoDeliveryPatterns = [
  {
    pattern: /\b(?:externalDeliveryAdapterApproved|externalAdapterApproved|approvedExternalDeliveryAdapter)\s*(?::|=)\s*(?:\{\s*)?true\b/,
    reason:
      "production code cannot set an external adapter approved flag to true before an external delivery adapter phase is approved",
  },
  {
    pattern: /\brequestedDeliveryMode\s*(?::|=)\s*(?:\{\s*)?["']auto_delivery["']/,
    reason:
      "production code cannot request auto_delivery before an external delivery adapter phase is approved",
  },
  {
    pattern: /\bautonomyState\s*(?::|=)\s*(?:\{\s*)?["']auto_delivering["']/,
    reason:
      "production code cannot enter the auto_delivering autonomy state before an external delivery adapter phase is approved",
  },
];

// Central auto-delivery interlock: production command-center code under
// lib/recruiting-ops/**, app/recruiting-ops/**, and command-center scripts must
// not opt into external auto-delivery before an adapter phase is approved. The
// evaluator may still model auto-delivery in tests (test files are not
// implementation files), but no shipped module may flip the adapter on, request
// auto_delivery, or enter the auto_delivering state.
function checkNoPrematureAutoDelivery({ root, implementationFiles, failures }) {
  for (const file of implementationFiles) {
    const text = stripComments(read(root, file));
    for (const { pattern, reason } of prematureAutoDeliveryPatterns) {
      if (pattern.test(text)) addFailure(failures, "auto-delivery-interlock", reason, file);
    }
  }
}

function checkPhase0ClaimedGateImplementation({ root, failures }) {
  if (!existsSync(join(root, BUILD_PROGRESS_PATH))) return;
  const progress = read(root, BUILD_PROGRESS_PATH);

  for (const gate of PHASE0_CLAIMED_GATE_REQUIREMENTS) {
    if (!phase0GateClaimedComplete(progress, gate.gate)) continue;

    for (const requirement of gate.requirements) {
      if (!existsSync(join(root, requirement.file))) {
        addFailure(
          failures,
          "phase0-claimed-gate-implementation",
          `BUILD_PROGRESS.md claims Phase 0 Gate ${gate.gate} (${gate.label}) is complete, but required file is missing: ${requirement.reason}`,
          requirement.file
        );
        continue;
      }

      const text = read(root, requirement.file);
      for (const pattern of requirement.patterns) {
        if (!pattern.test(text)) {
          addFailure(
            failures,
            "phase0-claimed-gate-implementation",
            `BUILD_PROGRESS.md claims Phase 0 Gate ${gate.gate} (${gate.label}) is complete, but ${requirement.reason}`,
            requirement.file
          );
        }
      }
    }
  }
}

function checkPhase1_6ClaimedPhaseEvidence({ root, failures }) {
  if (!existsSync(join(root, BUILD_PROGRESS_PATH))) return;
  if (!existsSync(join(root, PHASE1_6_MANIFEST_PATH))) {
    addFailure(
      failures,
      "phase1-6-claimed-phase-evidence",
      `Missing Phase 1-6 phase manifest: ${PHASE1_6_MANIFEST_PATH}`,
      PHASE1_6_MANIFEST_PATH
    );
    return;
  }

  const progress = read(root, BUILD_PROGRESS_PATH);
  const manifest = read(root, PHASE1_6_MANIFEST_PATH);

  for (const match of progress.matchAll(/^##\s+([^\n]*Phase 1-6 Phase (\d+)\b[^\n]*)$/gim)) {
    const heading = match[1];
    const phase = Number(match[2]);
    const entryStart = match.index ?? 0;
    const afterHeading = progress.slice(entryStart + match[0].length);
    const nextHeadingOffset = afterHeading.search(/^##\s+/m);
    const entry = nextHeadingOffset >= 0
      ? progress.slice(entryStart, entryStart + match[0].length + nextHeadingOffset)
      : progress.slice(entryStart);

    if (!manifest.includes(`| Phase ${phase} |`)) {
      addFailure(
        failures,
        "phase1-6-claimed-phase-evidence",
        `BUILD_PROGRESS.md claims ${heading}, but Phase ${phase} is missing from the Phase 1-6 manifest`,
        PHASE1_6_MANIFEST_PATH
      );
    }

    for (const section of PHASE1_6_REQUIRED_PROGRESS_SECTIONS) {
      if (!entry.includes(section)) {
        addFailure(
          failures,
          "phase1-6-claimed-phase-evidence",
          `BUILD_PROGRESS.md claims ${heading}, but the entry is missing required section: ${section}`,
          BUILD_PROGRESS_PATH
        );
      }
    }
  }
}

function phase0GateClaimedComplete(progress, gate) {
  return new RegExp(`^##\\s+[^\\n]*Phase 0 Gate ${gate}\\b`, "im").test(progress);
}

function checkWorkflowAbstractionDebt({ root, failures }) {
  const mapFile = join(root, WORKFLOW_REFACTOR_MAP_PATH);
  if (!existsSync(mapFile)) {
    addFailure(
      failures,
      "workflow-abstraction-debt",
      `Missing workflow-to-capability refactor map: ${WORKFLOW_REFACTOR_MAP_PATH}`
    );
    return;
  }

  const lines = read(root, WORKFLOW_REFACTOR_MAP_PATH).split("\n");
  for (const id of REQUIRED_WORKFLOW_IDS) {
    const row = lines.find((line) => line.includes(`| ${id} |`));
    if (!row) {
      addFailure(
        failures,
        "workflow-abstraction-debt",
        `Workflow ${id} is missing from the capability refactor map`,
        WORKFLOW_REFACTOR_MAP_PATH
      );
      continue;
    }
    const hasDisposition = allowedWorkflowDispositions.some((disposition) => row.includes(`\`${disposition}\``));
    if (!hasDisposition) {
      addFailure(
        failures,
        "workflow-abstraction-debt",
        `Workflow ${id} needs an explicit allowed disposition`,
        WORKFLOW_REFACTOR_MAP_PATH
      );
    }
  }
}

function checkPackageScripts({ root, failures }) {
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    addFailure(failures, "docs-registry-drift", "Missing package.json");
    return;
  }

  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (pkg.scripts?.["check:recruiting-ops-architecture"] !== "node scripts/recruiting-ops-architecture-check.mjs") {
    addFailure(
      failures,
      "docs-registry-drift",
      "package.json must expose check:recruiting-ops-architecture"
    );
  }
  if (
    pkg.scripts?.["check:recruiting-ops"] !==
    "npm run check:recruiting-ops-architecture && npm test -- test/recruiting-ops-registries.test.ts test/recruiting-ops-capabilities.test.ts test/recruiting-ops-capability-binding.test.ts test/recruiting-ops-automation-seed-matrix.test.ts"
  ) {
    addFailure(failures, "docs-registry-drift", "package.json must expose check:recruiting-ops");
  }
  if (pkg.scripts?.typecheck !== "tsc --noEmit") {
    addFailure(failures, "docs-registry-drift", "package.json must expose typecheck");
  }
}

function stripComments(text) {
  // Drop block and line comments so a capability id mentioned only in a comment
  // never counts as a real binding. Keeps the char before `//` to avoid eating `://`.
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function readRequiredCapabilityIds(root) {
  if (!existsSync(join(root, CAPABILITIES_PATH))) return null;
  const text = read(root, CAPABILITIES_PATH);
  const block = text.match(/requiredCapabilityIds\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!block) return [];
  return extractIds(block[1], /["']([^"']+)["']/g);
}

function checkCapabilityRegistryPresent({ root, failures }) {
  if (!existsSync(join(root, CAPABILITIES_PATH))) {
    addFailure(
      failures,
      "capability-registry-present",
      `Missing capability registry: ${CAPABILITIES_PATH} (the capability-first product source of truth)`
    );
    return;
  }
  const text = read(root, CAPABILITIES_PATH);
  if (!/export const capabilityRegistry\b/.test(text)) {
    addFailure(failures, "capability-registry-present", "capabilities.ts must export capabilityRegistry", CAPABILITIES_PATH);
  }
  if (!/export const requiredCapabilityIds\b/.test(text)) {
    addFailure(failures, "capability-registry-present", "capabilities.ts must export requiredCapabilityIds", CAPABILITIES_PATH);
  }
}

function checkModuleCapabilityBinding({ root, files, failures }) {
  const capabilityIds = readRequiredCapabilityIds(root);
  if (!capabilityIds) return; // capability-registry-present already reports the missing file
  const allowed = new Set(capabilityIds);
  const moduleFiles = files.filter(
    (file) => file.startsWith(MODULES_PREFIX) && file.endsWith(".ts") && file !== `${MODULES_PREFIX}types.ts`
  );
  for (const file of moduleFiles) {
    // Strip comments first: a capability id mentioned only in a comment is not a binding.
    const code = stripComments(read(root, file));
    if (!code.includes("RecruitingOpsModuleDefinition")) continue;
    // Any explicit `capabilityId: "literal"` must name a known capability.
    const declared = extractIds(code, /capabilityId:\s*["']([^"']+)["']/g);
    for (const id of declared) {
      if (!allowed.has(id)) {
        addFailure(failures, "module-capability-binding", `module declares unknown capabilityId: ${id}`, file);
      }
    }
    // The module must bind to a known capability — either a `capabilityId: "x"`
    // literal, or a capability id passed positionally through a config factory.
    const bindsKnown = [...allowed].some((id) => code.includes(`"${id}"`) || code.includes(`'${id}'`));
    if (!bindsKnown) {
      addFailure(failures, "module-capability-binding", "runnable module declares no capabilityId", file);
    }
  }
}

function checkCapabilityDocConsistency({ root, failures }) {
  const capabilityIds = readRequiredCapabilityIds(root);
  if (!capabilityIds || capabilityIds.length === 0) return;
  for (const docPath of CAPABILITY_DOC_PATHS) {
    if (!existsSync(join(root, docPath))) {
      addFailure(failures, "capability-id-consistency", `Missing capability doc: ${docPath}`);
      continue;
    }
    const text = read(root, docPath);
    const missing = capabilityIds.filter((id) => !text.includes(id));
    if (missing.length > 0) {
      addFailure(
        failures,
        "capability-id-consistency",
        `doc is out of sync with the capability registry; missing capability ids: ${missing.join(", ")}`,
        docPath
      );
    }
  }
}

function checkWorkflowCapabilityCoverage({ root, failures }) {
  if (!existsSync(join(root, CAPABILITIES_PATH))) return; // capability-registry-present reports the missing file
  const text = read(root, CAPABILITIES_PATH);
  // Coverage must come from the `workflowIds` arrays only — a workflow id that
  // appears merely in evidenceRefs (or anywhere else) is NOT mapped to a capability.
  const covered = new Set();
  for (const match of text.matchAll(/workflowIds:\s*\[([\s\S]*?)\]/g)) {
    for (const id of extractIds(match[1], /["']([^"']+)["']/g)) covered.add(id);
  }
  const missing = REQUIRED_WORKFLOW_IDS.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    addFailure(
      failures,
      "workflow-capability-coverage",
      `workflow IDs are legacy coverage and must each map to a capability via workflowIds; not covered: ${missing.join(", ")}`,
      CAPABILITIES_PATH
    );
  }
}

function checkUiCapabilityFirst({ root, failures }) {
  if (!existsSync(join(root, RECRUITING_OPS_PAGE_PATH))) {
    addFailure(failures, "ui-capability-first", `Missing primary console page: ${RECRUITING_OPS_PAGE_PATH}`);
    return;
  }
  const text = read(root, RECRUITING_OPS_PAGE_PATH);
  // Must render real capability data, not merely contain the word "CAPABILITIES".
  if (!/\bcapabilityRows\b/.test(text)) {
    addFailure(
      failures,
      "ui-capability-first",
      "primary console must render capability data (capabilityRows), not just the word CAPABILITIES",
      RECRUITING_OPS_PAGE_PATH
    );
  }
  if (/WORKFLOW REGISTRY/.test(text)) {
    addFailure(
      failures,
      "ui-capability-first",
      "workflow registry must not be the primary console surface; move it to legacy coverage",
      RECRUITING_OPS_PAGE_PATH
    );
  }
}

function checkNoSentinelAttributionFallback({ root, files, failures }) {
  // Scoped to module implementation files only, and to attribution fields. Recruiter /
  // sourcer / team / pod / HOD / stage / owner / lead attribution must resolve to a NULL
  // defect — never a sentinel like `?? "unmapped"`. Comments and unrelated fields (e.g.
  // status) are not flagged.
  const pattern = /\b(recruiter|sourcer|team|pod|hod|core_stage|owner|lead)\w*\s*:[^,}\n]*["']unmapped["']/i;
  const moduleFiles = files.filter((file) => file.startsWith(MODULES_PREFIX) && file.endsWith(".ts"));
  for (const file of moduleFiles) {
    const code = stripComments(read(root, file));
    for (const line of code.split("\n")) {
      if (pattern.test(line)) {
        addFailure(
          failures,
          "no-sentinel-attribution-fallback",
          'recruiter/sourcer/team/pod/HOD/stage/owner/lead attribution must resolve to a NULL defect, not a sentinel string like "unmapped"',
          file
        );
        break;
      }
    }
  }
}

export function runArchitectureCheck(options = {}) {
  const root = resolveRoot(options.root ?? null);
  const files = gitFiles(root);
  const implementationFiles = files.filter(isImplementationFile);
  const failures = [];
  const context = { root, files, implementationFiles, failures };

  checkForbiddenImports(context);
  checkSourcePosture(context);
  checkGreenhouseWriteBoundary(context);
  checkNoFreeFormSql(context);
  checkNoProductionWrites(context);
  checkGoogleDriveLeastPrivilege(context);
  checkScheduledCopyOnlyTargets(context);
  checkNoPublicPii(context);
  checkDocsRegistryDrift(context);
  checkActiveDocsDoNotDrift(context);
  checkAutomationControlPlaneDocs(context);
  checkImplementationDoesNotUseStaleReadiness(context);
  checkPhase0ClaimedGateImplementation(context);
  checkPhase1_6ClaimedPhaseEvidence(context);
  checkNoPrematureAutoDelivery(context);
  checkWorkflowAbstractionDebt(context);
  checkPackageScripts(context);
  checkCapabilityRegistryPresent(context);
  checkModuleCapabilityBinding(context);
  checkCapabilityDocConsistency(context);
  checkWorkflowCapabilityCoverage(context);
  checkUiCapabilityFirst(context);
  checkNoSentinelAttributionFallback(context);

  return {
    root,
    implementationFiles,
    failures,
  };
}

function formatFailure(failure) {
  const location = failure.file ? `${failure.file}: ` : "";
  return `[${failure.rule}] ${location}${failure.message}`;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const result = runArchitectureCheck({ root });

  if (result.failures.length > 0) {
    console.error("Recruiting ops architecture check failed:");
    for (const failure of result.failures) {
      console.error(`- ${formatFailure(failure)}`);
    }
    process.exit(1);
  }

  console.log("Recruiting ops architecture check passed.");
  console.log(
    `Checked ${result.implementationFiles.length} implementation file(s) from ${
      relative(process.cwd(), result.root) || "."
    }.`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
