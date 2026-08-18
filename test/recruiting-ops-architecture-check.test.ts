import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "vitest"

const checker = join(process.cwd(), "scripts/recruiting-ops-architecture-check.mjs")

const requiredWorkflowIds = [
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
]

const requiredQueryIds = [
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
]

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const FIXTURE_CAPABILITY_IDS = ["test_capability"]

const capabilityDocPaths = [
  "docs/recruiting-ops/CAPABILITY_NORTH_STAR.md",
  "docs/recruiting-ops/RECRUITING_OPS_CAPABILITY_PLATFORM_SPEC.md",
  "docs/recruiting-ops/AUDIENCE_DELIVERABLE_MATRIX.md",
]

function makeFixture(options: {
  registry?: string
  files?: Record<string, string>
  omitDoc?: string
  map?: string
  capabilities?: string
  omitCapabilities?: boolean
  capabilityIds?: string[]
  page?: string
  omitPage?: boolean
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), "recops-architecture-"))
  roots.push(root)
  const capabilityIds = options.capabilityIds ?? FIXTURE_CAPABILITY_IDS

  write(root, "package.json", JSON.stringify({
    scripts: {
      "check:recruiting-ops-architecture": "node scripts/recruiting-ops-architecture-check.mjs",
      "check:recruiting-ops": "npm run check:recruiting-ops-architecture && npm test -- test/recruiting-ops-registries.test.ts test/recruiting-ops-capabilities.test.ts test/recruiting-ops-capability-binding.test.ts test/recruiting-ops-automation-seed-matrix.test.ts",
      "typecheck": "tsc --noEmit",
    },
  }))
  for (const doc of requiredDocs()) {
    if (doc === options.omitDoc) continue
    write(root, doc, capabilityDocPaths.includes(doc) ? capabilityDocContent(doc, capabilityIds) : defaultDocContent(doc))
  }
  write(root, "lib/recruiting-ops/registries.ts", options.registry ?? registryContent())
  write(root, "lib/recruiting-ops/final-offer.ts", "export const moduleId = \"T07\"\n")
  if (!options.omitCapabilities) {
    write(root, "lib/recruiting-ops/capabilities.ts", options.capabilities ?? capabilitiesContent({ capabilityIds }))
  }
  if (!options.omitPage) {
    write(root, "app/(workbench)/recruiting-ops/page.tsx", options.page ?? pageContent())
  }
  write(root, "docs/recruiting-ops/WORKFLOW_TO_CAPABILITY_REFACTOR_MAP.md", options.map ?? workflowMapContent())

  for (const [path, content] of Object.entries(options.files ?? {})) {
    write(root, path, content)
  }

  return root
}

function pageContent(): string {
  return "export default function Page() {\n  const rows = data.capabilityRows\n  return <section><h2>CAPABILITIES</h2>{rows.length}</section>\n}\n"
}

function capabilityDocContent(path: string, capabilityIds: string[]): string {
  const ids = capabilityIds.map((id) => `- \`${id}\``).join("\n")
  return `# ${path.split("/").at(-1)}\n\nStatus: Active\n\n${ids}\n`
}

function capabilitiesContent(options: { capabilityIds?: string[]; workflowIds?: string[] } = {}): string {
  const ids = options.capabilityIds ?? FIXTURE_CAPABILITY_IDS
  const workflows = options.workflowIds ?? requiredWorkflowIds
  return `
export const requiredCapabilityIds = [
${ids.map((id) => `  "${id}",`).join("\n")}
] as const

export const capabilityRegistry = [
  {
    capabilityId: "${ids[0]}",
    workflowIds: [
${workflows.map((id) => `      "${id}",`).join("\n")}
    ],
    moduleIds: ["fixture-module"],
  },
]
`
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function registryContent(options: { omitQuery?: string } = {}): string {
  const queryIds = requiredQueryIds.filter((id) => id !== options.omitQuery)
  return `
const workflow = (...args: unknown[]) => args
const query = (...args: unknown[]) => args

export const workflowRegistry = [
${requiredWorkflowIds.map((id) => `  workflow("${id}", "${id}"),`).join("\n")}
]

export const queryRegistry = [
${queryIds.map((id) => `  query("${id}", "${id}"),`).join("\n")}
]

export const requiredWorkflowIds = [
${requiredWorkflowIds.map((id) => `  "${id}",`).join("\n")}
] as const

export const requiredQueryIds = [
${queryIds.map((id) => `  "${id}",`).join("\n")}
] as const
`
}

function requiredDocs(): string[] {
  return [
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
  ]
}

function defaultDocContent(path: string): string {
  if (path.endsWith("AUTOMATION_CONTROL_PLANE.md")) {
    return [
      "# Automation Control Plane",
      "Status: Active",
      "Automate routine recruiting operations as far as reliability allows.",
      "Readiness != Delivery Authorization.",
      "`auto_delivery`, `review_assisted`, and `action_proposal` lanes are required.",
    ].join("\n")
  }
  if (path.endsWith("AUTOMATION_ELIGIBILITY_RUBRIC.md")) {
    return [
      "# Automation Eligibility Rubric",
      "Status: Active",
      "No LLM-authored auto-delivery.",
      "No mutation.",
      "Bounded PII.",
    ].join("\n")
  }
  if (path.endsWith("AUTO_DELIVERY_QUALITY_GATES.md")) {
    return [
      "# Auto Delivery Quality Gates",
      "Status: Active",
      "Gate failures auto-pause delivery.",
      "Every failed gate writes a delivery-log entry.",
      "A kill switch is required.",
    ].join("\n")
  }
  if (path.endsWith("SHADOW_MODE_AND_TRUST_PERIODS.md")) {
    return [
      "# Shadow Mode And Trust Periods",
      "Status: Active",
      "Shadow mode proves delivery before automation.",
      "Trust periods govern promotion.",
    ].join("\n")
  }
  if (path.endsWith("DELIVERY_LOG_SPEC.md")) {
    return [
      "# Delivery Log Spec",
      "Status: Active",
      "The delivery log records delivery attempts.",
      "Every record includes a recipient fingerprint.",
    ].join("\n")
  }
  if (path.endsWith("AUTOMATION_CONTROL_PLANE_TECHNICAL_SPEC.md")) {
    return [
      "# Automation Control Plane Technical Spec",
      "Status: Active",
      "Readiness != Delivery Authorization.",
      "DeliverableAutonomyContract",
      "DeliverableAutonomyState",
      "DeliveryLogEntry",
      "KillSwitchState",
      "RecipientScopeRule",
    ].join("\n")
  }
  if (path.endsWith("AUTOMATION_CONTROL_PLANE_IMPLEMENTATION_PLAN.md")) {
    return [
      "# Automation Control Plane Implementation Plan",
      "Status: Active",
      "Gate 1: contracts",
      "Gate 2: outputs",
      "Gate 3: seed matrix",
      "Gate 4: ledger",
      "Gate 5: evaluator",
      "Gate 6: shadow deliverable",
    ].join("\n")
  }
  if (path.endsWith("AUTOMATION_DELIVERABLE_SEED_MATRIX.md")) {
    return [
      "# Automation Deliverable Seed Matrix",
      "Status: Active",
      "| Deliverable | Capability | Lane | Initial autonomy state | Auto-eligibility | Shadow requirement | Blocked reason | Never-auto rationale |",
    ].join("\n")
  }
  if (path.endsWith("AUTOMATION_CONTROL_PLANE_GOAL_PROMPT.md")) {
    return [
      "# Automation Control Plane Goal Prompt",
      "Status: Active",
      "codex/recruiting-ops-automation-control-plane",
      "Phase 0",
      "no UI routes in Phase 0",
    ].join("\n")
  }
  if (path.endsWith("AUTOMATION_CONTROL_PLANE_PHASE_1_6_ROADMAP.md")) {
    return [
      "# Automation Control Plane Phase 1-6 Roadmap",
      "Status: Active",
      "Continue across phases without stopping at phase boundaries.",
      "Phase 1 broadens shadow deliverables.",
      "Phase 2 adds a local run catalog.",
      "Phase 3 adds read-only UI.",
      "Phase 4 adds disabled mock live-read scaffolds.",
      "Phase 5 adds disabled delivery adapter interfaces.",
      "Phase 6 adds promotion workflows.",
      "npm run typecheck",
    ].join("\n")
  }
  if (path.endsWith("AUTOMATION_CONTROL_PLANE_PHASE_1_6_PHASE_MANIFEST.md")) {
    return [
      "# Automation Control Plane Phase 1-6 Phase Manifest",
      "Status: Active",
      "| Phase | Phase outcome | Allowed implementation envelope | Required evidence surfaces | Required tests | Validation commands | Stop gates |",
      "| Phase 1 | Shadow deliverables | Local | Evidence | Tests | npm run typecheck | Stop gates |",
      "| Phase 2 | Run catalog | Local | Evidence | Tests | npm run typecheck | Stop gates |",
      "| Phase 3 | Read-only UI | Local | Evidence | Tests | npm run typecheck | Stop gates |",
      "| Phase 4 | Mock adapters | Disabled | Evidence | Tests | npm run typecheck | Stop gates |",
      "| Phase 5 | Delivery adapter interfaces | Disabled | Evidence | Tests | npm run typecheck | Stop gates |",
      "| Phase 6 | Promotion workflows | Local | Evidence | Tests | npm run typecheck | Stop gates |",
    ].join("\n")
  }
  if (path.endsWith("AUTOMATION_CONTROL_PLANE_PHASE_1_6_GOAL_PROMPT.md")) {
    return [
      "# Automation Control Plane Phase 1-6 Goal Prompt",
      "Status: Active",
      "ta-ops-analytics-automation-control-plane-phase1-6",
      "Continue across Phase 1 through Phase 6.",
      "npm run check:recruiting-ops",
      "npm run typecheck",
      "npm test",
      "git diff --check",
    ].join("\n")
  }
  if (path.endsWith("AUTOMATION_CONTROL_PLANE_PHASE_1_6_REVIEW_PROMPT.md")) {
    return [
      "# Automation Control Plane Phase 1-6 Review Prompt",
      "Status: Active",
      "You are Claude Code in adversarial review mode.",
      "Review Phase 1-6.",
    ].join("\n")
  }
  return `# ${path.split("/").at(-1)}\n\nStatus: Active\n`
}

function workflowMapContent(options: { omitWorkflow?: string; disposition?: string } = {}): string {
  const disposition = options.disposition ?? "legacy_mapping"
  return `
# Workflow To Capability Refactor Map

| Workflow | Current surface | Target capability | Disposition | Refactor instruction |
|---|---|---|---|---|
${requiredWorkflowIds
  .filter((id) => id !== options.omitWorkflow)
  .map((id) => `| ${id} | ${id} | test_capability | \`${disposition}\` | Fixture coverage. |`)
  .join("\n")}
`
}

function phase0GateProgress(gate: number): string {
  return `
# Recruiting Ops Command Center Build Progress

Status: Active

## 2026-06-26: Phase 0 Gate ${gate} Complete

Completed gate:

- Phase 0 Gate ${gate} is complete.
`
}

function phase1_6Progress(phase: number, sections = true): string {
  return sections
    ? `
# Recruiting Ops Command Center Build Progress

Status: Active

## 2026-06-26: Phase 1-6 Phase ${phase} Complete

Completed gate:
- Completed.

Files changed:
- lib/recruiting-ops/example.ts

Commands run:
- npm run check:recruiting-ops
- npm run typecheck
- npm test
- git diff --check

Test results:
- Passed.

Residual blockers:
- None beyond stop gates.

Next gate:
- Continue.
`
    : `
# Recruiting Ops Command Center Build Progress

Status: Active

## 2026-06-26: Phase 1-6 Phase ${phase} Complete

Completed gate:
- Completed.
`
}

function run(root: string): { status: number; stdout: string; stderr: string } {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [checker, "--root", root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    }
  } catch (error: unknown) {
    const err = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      status: err.status ?? 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    }
  }
}

describe("recruiting ops architecture check", () => {
  test("passes a valid command-center fixture", () => {
    const result = run(makeFixture())

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Recruiting ops architecture check passed")
  })

  test("does not require unfinished Phase 0 gates", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/BUILD_PROGRESS.md": `
# Recruiting Ops Command Center Build Progress

Status: Active

## Active Next Gate

The active next gate is Phase 0 Gate 1 TypeScript Autonomy Contracts.
`,
      },
    }))

    expect(result.status).toBe(0)
  })

  test("accepts a claimed Phase 0 Gate 0 guardrail when checker and tests are present", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/BUILD_PROGRESS.md": phase0GateProgress(0),
        "scripts/recruiting-ops-architecture-check.mjs":
          "const rule = \"phase0-claimed-gate-implementation\"\nfunction checkPhase0ClaimedGateImplementation() {}\n",
        "test/recruiting-ops-architecture-check.test.ts":
          "it covers unfinished Phase 0 gates and a claimed Phase 0 Gate 1 complete fixture\n",
      },
    }))

    expect(result.status).toBe(0)
  })

  const claimedPhase0GateCases = [
    { gate: 1, expectedFile: "lib/recruiting-ops/autonomy.ts" },
    { gate: 2, expectedFile: "lib/recruiting-ops/output-contracts.ts" },
    { gate: 3, expectedFile: "lib/recruiting-ops/automation-seed-matrix.ts" },
    { gate: 4, expectedFile: "lib/recruiting-ops/delivery-ledger.ts" },
    { gate: 5, expectedFile: "lib/recruiting-ops/delivery-gates.ts" },
    { gate: 6, expectedFile: "lib/recruiting-ops/modules/recruiter-weekly-req-progress-shadow.ts" },
  ] as const

  for (const { gate, expectedFile } of claimedPhase0GateCases) {
    test(`reports missing implementation when BUILD_PROGRESS claimed Phase 0 Gate ${gate} complete`, () => {
      const result = run(makeFixture({
        files: {
          "docs/recruiting-ops/BUILD_PROGRESS.md": phase0GateProgress(gate),
        },
      }))

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("[phase0-claimed-gate-implementation]")
      expect(result.stderr).toContain(expectedFile)
    })
  }

  test("reports a claimed Phase 0 gate whose file exists but omits a required export", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/BUILD_PROGRESS.md": phase0GateProgress(1),
        "lib/recruiting-ops/autonomy.ts": [
          "export interface RecipientScopeRule { scopeId: string }",
          "export interface DeliverableAutonomyContract { deliverableId: string }",
          "export interface DeliveryLogEntry { deliveryLogId: string }",
          "export interface KillSwitchState { scope: string }",
          "export function validateDeliverableAutonomyContract() { return { ok: true } }",
          "// the lookup-helper export is intentionally omitted to exercise the symbol-missing branch",
        ].join("\n"),
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[phase0-claimed-gate-implementation]")
    expect(result.stderr).toContain("lib/recruiting-ops/autonomy.ts")
    expect(result.stderr).toMatch(/is complete, but autonomy module must export/)
  })

  test("reports a claimed gate evaluator that omits the contract-required freshness not-applicable guard", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/BUILD_PROGRESS.md": phase0GateProgress(5),
        "lib/recruiting-ops/delivery-gates.ts": [
          "export interface DeliveryGateEvaluationResult { verdict: string }",
          "export function evaluateDeliveryGates() { return { deliveryLogEntry: {} } }",
          "const externalDeliveryAdapterApproved = false",
        ].join("\n"),
        "lib/recruiting-ops/index.ts": 'export * from "./delivery-gates"\n',
        "test/recruiting-ops-delivery-gates.test.ts": [
          "it('authorized_for_shadow external delivery adapter fails closed when auto-delivery freshness timestamp is missing', () => {})",
        ].join("\n"),
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[phase0-claimed-gate-implementation]")
    expect(result.stderr).toContain("fail freshness not_applicable closed whenever the contract requires freshness")
  })

  test("blocks production code that opts into auto-delivery before an adapter phase", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/premature-adapter.ts": [
          "export const evaluation = {",
          "  externalDeliveryAdapterApproved: true,",
          "  requestedDeliveryMode: \"auto_delivery\",",
          "  autonomyState: \"auto_delivering\",",
          "}",
        ].join("\n"),
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[auto-delivery-interlock]")
    expect(result.stderr).toContain("lib/recruiting-ops/premature-adapter.ts")
  })

  test("blocks recruiting-ops UI files that request auto_delivery", () => {
    const result = run(makeFixture({
      files: {
        "app/(workbench)/recruiting-ops/premature-auto-delivery.tsx": [
          "export function PrematureControl() {",
          "  const request = { requestedDeliveryMode: \"auto_delivery\" }",
          "  return <button>{request.requestedDeliveryMode}</button>",
          "}",
        ].join("\n"),
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[auto-delivery-interlock]")
    expect(result.stderr).toContain("app/(workbench)/recruiting-ops/premature-auto-delivery.tsx")
  })

  test("blocks recruiting-ops UI files that enter auto_delivering", () => {
    const result = run(makeFixture({
      files: {
        "app/(workbench)/recruiting-ops/premature-state.tsx": [
          "export function PrematureState() {",
          "  const state = { autonomyState: \"auto_delivering\" }",
          "  return <span>{state.autonomyState}</span>",
          "}",
        ].join("\n"),
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[auto-delivery-interlock]")
    expect(result.stderr).toContain("app/(workbench)/recruiting-ops/premature-state.tsx")
  })

  test("blocks recruiting-ops UI files that set externalAdapterApproved true", () => {
    const result = run(makeFixture({
      files: {
        "app/(workbench)/recruiting-ops/premature-card-adapter.tsx": [
          "export function PrematureAdapter() {",
          "  const card = { externalAdapterApproved: true }",
          "  return <span>{String(card.externalAdapterApproved)}</span>",
          "}",
        ].join("\n"),
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[auto-delivery-interlock]")
    expect(result.stderr).toContain("app/(workbench)/recruiting-ops/premature-card-adapter.tsx")
  })

  test("blocks recruiting-ops UI files that set externalDeliveryAdapterApproved true", () => {
    const result = run(makeFixture({
      files: {
        "app/(workbench)/recruiting-ops/premature-gate-adapter.tsx": [
          "export function PrematureGateAdapter() {",
          "  const gate = { externalDeliveryAdapterApproved: true }",
          "  return <span>{String(gate.externalDeliveryAdapterApproved)}</span>",
          "}",
        ].join("\n"),
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[auto-delivery-interlock]")
    expect(result.stderr).toContain("app/(workbench)/recruiting-ops/premature-gate-adapter.tsx")
  })

  test("blocks recruiting-ops code that sets approvedExternalDeliveryAdapter true", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/premature-contract-adapter.ts": [
          "export const validation = {",
          "  approvedExternalDeliveryAdapter: true,",
          "}",
        ].join("\n"),
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[auto-delivery-interlock]")
    expect(result.stderr).toContain("lib/recruiting-ops/premature-contract-adapter.ts")
  })

  test("ignores auto-delivery interlock tokens that appear only in comments", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/commented-adapter.ts":
          "// externalDeliveryAdapterApproved: true is intentionally not enabled here\nexport const adapterApproved = false\n",
      },
    }))

    expect(result.stderr).not.toContain("[auto-delivery-interlock]")
  })

  test("reports source-posture violations by rule name", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/final-offer.ts": "export const adapter = \"warehouse_read\"\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[source-posture]")
    expect(result.stderr).toContain("warehouse_read")
  })

  test("reports no-freeform-sql violations by rule name", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/query-runner.ts": "export interface QueryRequest { sql: string }\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[no-freeform-sql]")
    expect(result.stderr).toContain("registered query IDs")
  })

  test("reports Greenhouse write-boundary violations by rule name", () => {
    const result = run(makeFixture({
      files: {
        "lib/greenhouse-client.ts": "export async function greenhousePost() {}\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[greenhouse-write-boundary]")
    expect(result.stderr).toContain("direct Greenhouse write helper export")
  })

  test("reports public PII violations by rule name", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/renderers/leadership-summary.ts": "export const fields = [\"candidate_email\"]\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[no-public-pii]")
    expect(result.stderr).toContain("email fields")
  })

  test("reports registry drift by rule name", () => {
    const result = run(makeFixture({
      registry: registryContent({ omitQuery: "Q15" }),
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[docs-registry-drift]")
    expect(result.stderr).toContain("Q15")
  })

  test("reports missing active docs by rule name", () => {
    const missingDoc = "docs/recruiting-ops/DOCS_SOURCE_OF_TRUTH.md"
    const result = run(makeFixture({ omitDoc: missingDoc }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[docs-registry-drift]")
    expect(result.stderr).toContain(missingDoc)
  })

  test("reports stale active steering language by rule name", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/GOAL.md": "# Goal\n\nFirst Goal-Mode Objective\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[docs-provenance-drift]")
    expect(result.stderr).toContain("completed workflow-foundation objective")
  })

  test("reports active docs that still point future agents at Phase 0 contract foundations", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/BUILD_PROGRESS.md": "# Progress\n\nStatus: Active\n\nThe active next gate is Phase 0 TypeScript Autonomy Contracts.\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[docs-provenance-drift]")
    expect(result.stderr).toContain("completed Phase 0 contract foundations")
  })

  test("ignores stale language in archived docs", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/archive/2026-06-24-workflow-foundation/OLD.md": "First Goal-Mode Objective\nP1 Substrate | Next\nNot yet present\nready_for_sam_review\n",
      },
    }))

    expect(result.status).toBe(0)
  })

  test("reports a missing automation control plane doc by rule name", () => {
    const missingDoc = "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE.md"
    const result = run(makeFixture({ omitDoc: missingDoc }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[docs-registry-drift]")
    expect(result.stderr).toContain(missingDoc)
  })

  test("reports missing automation launch artifact docs", () => {
    const missingDoc = "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_TECHNICAL_SPEC.md"
    const result = run(makeFixture({ omitDoc: missingDoc }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[docs-registry-drift]")
    expect(result.stderr).toContain(missingDoc)
  })

  test("reports missing Phase 1-6 launch docs", () => {
    const missingDoc = "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_ROADMAP.md"
    const result = run(makeFixture({ omitDoc: missingDoc }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[docs-registry-drift]")
    expect(result.stderr).toContain(missingDoc)
  })

  test("accepts a claimed Phase 1-6 phase when progress evidence is complete", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/BUILD_PROGRESS.md": phase1_6Progress(1),
      },
    }))

    expect(result.status).toBe(0)
  })

  test("reports a claimed Phase 1-6 phase with missing progress evidence", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/BUILD_PROGRESS.md": phase1_6Progress(1, false),
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[phase1-6-claimed-phase-evidence]")
    expect(result.stderr).toContain("Files changed:")
  })

  test("reports a claimed Phase 1-6 phase missing from the manifest", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/BUILD_PROGRESS.md": phase1_6Progress(7),
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[phase1-6-claimed-phase-evidence]")
    expect(result.stderr).toContain("Phase 7")
  })

  test("reports stale ready_for_sam_review terminology in active docs", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/DELIVERABLE_READINESS_MODEL.md": "# Readiness\n\nready_for_sam_review\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[docs-provenance-drift]")
    expect(result.stderr).toContain("ready_for_review")
  })

  test("reports stale ready_for_sam_review terminology in implementation files", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/readiness.ts": "export const state = \"ready_for_sam_review\"\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[readiness-authorization-separation]")
    expect(result.stderr).toContain("ready_for_review")
  })

  test("reports automation docs missing lane and readiness authorization language", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE.md": "# Automation\n\nStatus: Active\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[automation-control-plane-docs]")
    expect(result.stderr).toContain("automation thesis")
    expect(result.stderr).toContain("separate readiness from delivery authorization")
    expect(result.stderr).toContain("define all three lanes")
  })

  test("reports automation technical spec missing contract language", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_TECHNICAL_SPEC.md": "# Technical Spec\n\nStatus: Active\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[automation-control-plane-docs]")
    expect(result.stderr).toContain("Readiness != Delivery Authorization")
    expect(result.stderr).toContain("Phase 0 autonomy contracts")
  })

  test("reports automation implementation plan missing the six gates", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_IMPLEMENTATION_PLAN.md": "# Plan\n\nStatus: Active\nGate 1 only\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[automation-control-plane-docs]")
    expect(result.stderr).toContain("Gates 1 through 6")
  })

  test("reports automation seed matrix missing required columns", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/AUTOMATION_DELIVERABLE_SEED_MATRIX.md": "# Matrix\n\nStatus: Active\n| Deliverable | Capability |",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[automation-control-plane-docs]")
    expect(result.stderr).toContain("never-auto rationale")
  })

  test("reports workflow abstraction debt by rule name", () => {
    const result = run(makeFixture({
      map: workflowMapContent({ omitWorkflow: "T07" }),
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[workflow-abstraction-debt]")
    expect(result.stderr).toContain("T07")
  })

  test("reports a missing capability registry by rule name", () => {
    const result = run(makeFixture({ omitCapabilities: true }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[capability-registry-present]")
    expect(result.stderr).toContain("Missing capability registry")
  })

  test("reports a runnable module without a capabilityId by rule name", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/modules/orphan.ts":
          "import type { RecruitingOpsModuleDefinition } from \"./types\"\nexport const def: RecruitingOpsModuleDefinition = { moduleId: \"orphan\", workflowId: \"T07\" } as RecruitingOpsModuleDefinition\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[module-capability-binding]")
  })

  test("reports a module with an unknown capabilityId by rule name", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/modules/wrong.ts":
          "import type { RecruitingOpsModuleDefinition } from \"./types\"\nexport const def = { moduleId: \"wrong\", capabilityId: \"not_a_capability\", workflowId: \"T07\" } satisfies RecruitingOpsModuleDefinition\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[module-capability-binding]")
    expect(result.stderr).toContain("not_a_capability")
  })

  test("reports a capability doc out of sync with the registry by rule name", () => {
    const result = run(makeFixture({
      files: {
        "docs/recruiting-ops/AUDIENCE_DELIVERABLE_MATRIX.md": "# AUDIENCE_DELIVERABLE_MATRIX.md\n\nStatus: Active\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[capability-id-consistency]")
    expect(result.stderr).toContain("test_capability")
  })

  test("reports a workflow not covered by any capability by rule name", () => {
    const result = run(makeFixture({
      capabilities: capabilitiesContent({ workflowIds: requiredWorkflowIds.filter((id) => id !== "T07") }),
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[workflow-capability-coverage]")
    expect(result.stderr).toContain("T07")
  })

  test("reports a workflow-registry-first console page by rule name", () => {
    const result = run(makeFixture({
      page: "export default function Page() {\n  const rows = data.capabilityRows\n  return <section><h2>WORKFLOW REGISTRY</h2>{rows.length}</section>\n}\n",
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[ui-capability-first]")
    expect(result.stderr).toContain("workflow registry must not be the primary console surface")
  })

  test("does not count a capability id that appears only in a comment as a module binding", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/modules/commented.ts":
          "import type { RecruitingOpsModuleDefinition } from \"./types\"\n// this module is about test_capability work\nexport const def = { moduleId: \"commented\", workflowId: \"T07\" } as RecruitingOpsModuleDefinition\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[module-capability-binding]")
    expect(result.stderr).toContain("declares no capabilityId")
  })

  test("does not count a workflow id that appears only in evidenceRefs as coverage", () => {
    const capabilities = `
export const requiredCapabilityIds = ["test_capability"] as const

export const capabilityRegistry = [
  {
    capabilityId: "test_capability",
    workflowIds: [
${requiredWorkflowIds.filter((id) => id !== "T07").map((id) => `      "${id}",`).join("\n")}
    ],
    evidenceRefs: ["T07"],
    moduleIds: ["fixture-module"],
  },
]
`
    const result = run(makeFixture({ capabilities }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[workflow-capability-coverage]")
    expect(result.stderr).toContain("T07")
  })

  test("does not count a bare CAPABILITIES word as a capability-first console", () => {
    const result = run(makeFixture({
      page: "export default function Page() {\n  return <section><h2>CAPABILITIES</h2></section>\n}\n",
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[ui-capability-first]")
    expect(result.stderr).toContain("capabilityRows")
  })

  test("reports a recruiter/team attribution that falls back to a sentinel string", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/modules/sentinel.ts": "export const row = { team_name: fact.teamName ?? \"unmapped\" }\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[no-sentinel-attribution-fallback]")
  })

  test("reports an owner/lead attribution that falls back to a sentinel string", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/modules/ownersentinel.ts": "export const row = { owner: fact.owner ?? \"unmapped\" }\n",
      },
    }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[no-sentinel-attribution-fallback]")
  })

  test("does not flag an unrelated field or a banned word inside a comment", () => {
    const result = run(makeFixture({
      files: {
        "lib/recruiting-ops/modules/unrelated.ts":
          "// team_name was historically \"unmapped\"\nexport const row = { status: fact.status ?? \"unmapped\" }\n",
      },
    }))

    expect(result.stderr).not.toContain("[no-sentinel-attribution-fallback]")
  })
})
