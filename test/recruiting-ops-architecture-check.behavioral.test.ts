import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

// BEHAVIORAL coverage for the architecture checker — it must FIRE on adversarial input,
// not merely pass a curated fixture. A deleted rule is caught only by the PAIR
// {fires-on-fixture here} + {real-repo-green here}: removing a rule body keeps the real
// repo green but stops the fixture from firing, so this file goes red.
//
// Closes the audit's ARCH-META gaps: checkNoProductionWrites and checkForbiddenImports
// had ZERO behavioral tests and were deletable with the suite still green
// (the internal control-plane excavation audit (2026-06-26), P5 + mutation probe).

const checker = join(process.cwd(), "scripts/recruiting-ops-architecture-check.mjs")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmpRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "recops-arch-behavioral-"))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

function run(root: string): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [checker, "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { status: 0, stderr: "" }
  } catch (error: unknown) {
    const err = error as { status?: number; stderr?: Buffer | string }
    return { status: err.status ?? 1, stderr: String(err.stderr ?? "") }
  }
}

describe("architecture checker fires on adversarial input", () => {
  test("[no-production-writes] fires on a Google Sheets production write", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/sheets-writer-fixture.ts":
        "export async function push(client: unknown) {\n  await client.spreadsheets.values.update({})\n}\n",
    })
    const result = run(root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("[no-production-writes]")
    expect(result.stderr).toContain("lib/recruiting-ops/sheets-writer-fixture.ts")
  })

  test("[no-production-writes] fires on productionWriteEnabled: true and googleapis", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/contract-fixture.ts":
        'import { google } from "googleapis"\nexport const contract = { productionWriteEnabled: true }\nvoid google\n',
    })
    const result = run(root)
    expect(result.stderr).toContain("[no-production-writes]")
  })

  test("[no-production-writes] permits Google writes only at the guarded staging boundary", () => {
    const allowed = tmpRepo({
      "lib/recruiting-ops/delivery/google-workspace-staging-client.ts":
        'import { google } from "googleapis"\n' +
        "void google\n" +
        "void requireStagingMutationTarget\n" +
        "void stagingHydrationEnabled\n" +
        "void assertStagingWritePermit\n" +
        "void client.spreadsheets.values.batchUpdate\n" +
        "void client.spreadsheets.batchUpdate\n" +
        "void client.documents.batchUpdate\n",
    })
    expect(run(allowed).stderr).not.toContain("[no-production-writes]")
    expect(run(allowed).stderr).not.toContain("[staging-google-write-boundary]")

    const wrongPath = tmpRepo({
      "lib/recruiting-ops/delivery/another-google-writer.ts":
        'import { google } from "googleapis"\nvoid client.spreadsheets.values.batchUpdate\nvoid google\n',
    })
    expect(run(wrongPath).stderr).toContain("[no-production-writes]")
  })

  test("[no-production-writes] permits the exact employee-referral master-sheet boundary", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/employee-referral-master-sheet.ts":
        'import { google } from "googleapis"\n' +
        'void "EMPLOYEE_REFERRAL_MASTER_SPREADSHEET_ID"\n' +
        "void readEmployeeReferralMasterSpreadsheetId\n" +
        "void google\n" +
        "void sheets.spreadsheets.values.update\n" +
        "void sheets.spreadsheets.batchUpdate\n",
    })
    const result = run(root)
    expect(result.stderr).not.toContain("[no-production-writes]")
    expect(result.stderr).not.toContain("[employee-referral-google-write-boundary]")
  })

  test("[staging-google-write-boundary] fires when the scoped adapter omits a guard", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/delivery/google-workspace-staging-client.ts":
        'import { google } from "googleapis"\nvoid google\nvoid client.documents.batchUpdate\n',
    })
    const result = run(root)
    expect(result.stderr).toContain("[staging-google-write-boundary]")
    expect(result.stderr).toContain("requireStagingMutationTarget")
  })

  test("[google-drive-least-privilege] rejects full Drive and permission-write capability", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/delivery/google-workspace-staging-client.ts":
        'const scope = "https://www.googleapis.com/auth/drive"\n' +
        "void client.drive.permissions.update\n" +
        "void scope\n",
    })
    expect(run(root).stderr).toContain("[google-drive-least-privilege]")
  })

  test("[canonical-parity-read-only-boundary] fires when the Google mutation boundary imports canonical ids", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/delivery/canonical-parity-registry.ts":
        'const row = baseline("all_hires", "google_sheet", "canonical-artifact-id")\nvoid row\n',
      "lib/recruiting-ops/delivery/google-workspace-staging-client.ts":
        'import { canonicalParityRegistry } from "./canonical-parity-registry"\n' +
        "void canonicalParityRegistry\n" +
        'void "canonical-artifact-id"\n',
    })
    const result = run(root)
    expect(result.stderr).toContain("[canonical-parity-read-only-boundary]")
    expect(result.stderr).toContain("must not import the canonical parity registry")
    expect(result.stderr).toContain("must not hard-code a canonical parity artifact id")
  })

  test("[scheduled-copy-only-targets] fires when a retired copy id reaches the scheduled surface", () => {
    const lanes = [
      ...Array.from({ length: 10 }, () => '    "weekday_morning",'),
      '    "weekday_evening",',
    ].join("\n")
    const retiredCopyId = "1ExampleDriveId00000000000000000000000000007"
    const root = tmpRepo({
      "lib/recruiting-ops/delivery/staging-artifact-registry.ts":
        `export const stagingArtifactRegistry = [\n${lanes}\n]\n` +
        "export const target = { mutationTarget: \"canonical\" }\n",
      "lib/recruiting-ops/delivery/staging-maintenance-cadence.ts":
        "const targets = stagingArtifactRegistry.filter(isScheduledArtifactTarget)\n" +
        "const ok = target.mutationTarget === \"canonical\" && " +
        "(target.kind === \"google_sheet\" || (target.key === \"elt_doc\" && target.kind === \"google_doc\"))\n" +
        "if (weekday === 5 && target.key === \"elt_doc\") void target\nvoid targets; void ok\n",
      "app/api/cron/recruiting-ops-staging-orchestration/route.ts":
        `void "${retiredCopyId}"\n`,
    })
    const result = run(root)
    expect(result.stderr).toContain("[scheduled-copy-only-targets]")
    expect(result.stderr).toContain("retired copy artifact id is reachable")
  })

  test("[scheduled-copy-only-targets] fires when a retired copy id leaks outside the p1-artifacts deny declaration", () => {
    const lanes = [
      ...Array.from({ length: 10 }, () => '    "weekday_morning",'),
      '    "weekday_evening",',
    ].join("\n")
    const retiredCopyId = "1ExampleDriveId00000000000000000000000000007"
    const root = tmpRepo({
      "lib/recruiting-ops/delivery/staging-artifact-registry.ts":
        `export const stagingArtifactRegistry = [\n${lanes}\n]\n` +
        "export const target = { mutationTarget: \"canonical\" }\n",
      "lib/recruiting-ops/delivery/staging-maintenance-cadence.ts":
        "const targets = stagingArtifactRegistry.filter(isScheduledArtifactTarget)\n" +
        "const ok = target.mutationTarget === \"canonical\" && " +
        "(target.kind === \"google_sheet\" || (target.key === \"elt_doc\" && target.kind === \"google_doc\"))\n" +
        "if (weekday === 5 && target.key === \"elt_doc\") void target\nvoid targets; void ok\n",
      "lib/recruiting-ops/delivery/p1-artifacts.ts":
        `export const stagingDocumentId = "${retiredCopyId}"\n`,
    })
    const result = run(root)
    expect(result.stderr).toContain("[scheduled-copy-only-targets]")
    expect(result.stderr).toContain("outside the approved deny declaration")
  })

  test("[scheduled-copy-only-targets] permits the retired ELT copy id only inside the exact deny declaration", () => {
    const lanes = [
      ...Array.from({ length: 10 }, () => '    "weekday_morning",'),
      '    "weekday_evening",',
    ].join("\n")
    const retiredCopyId = "1ExampleDriveId00000000000000000000000000007"
    const root = tmpRepo({
      "lib/recruiting-ops/delivery/staging-artifact-registry.ts":
        `export const stagingArtifactRegistry = [\n${lanes}\n]\n` +
        "export const target = { mutationTarget: \"canonical\" }\n",
      "lib/recruiting-ops/delivery/staging-maintenance-cadence.ts":
        "const targets = stagingArtifactRegistry.filter(isScheduledArtifactTarget)\n" +
        "const ok = target.mutationTarget === \"canonical\" && " +
        "(target.kind === \"google_sheet\" || (target.key === \"elt_doc\" && target.kind === \"google_doc\"))\n" +
        "if (weekday === 5 && target.key === \"elt_doc\") void target\nvoid targets; void ok\n",
      "lib/recruiting-ops/delivery/p1-artifacts.ts":
        `export const target = { deniedDocumentIds: ["${retiredCopyId}"] }\n`,
    })
    const result = run(root)
    expect(result.stderr).not.toContain("outside the approved deny declaration")
    expect(result.stderr).not.toContain("retired copy artifact id is reachable")
  })

  test("[scheduled-copy-only-targets] fires if the ELT compiler omits the fact-table boundary", () => {
    const lanes = [
      ...Array.from({ length: 10 }, () => '    "weekday_morning",'),
      '    "weekday_evening",',
    ].join("\n")
    const root = tmpRepo({
      "lib/recruiting-ops/delivery/staging-artifact-registry.ts":
        `export const stagingArtifactRegistry = [\n${lanes}\n]\n` +
        "export const target = { mutationTarget: \"canonical\" }\n",
      "lib/recruiting-ops/delivery/staging-maintenance-cadence.ts":
        "const targets = stagingArtifactRegistry.filter(isScheduledArtifactTarget)\n" +
        "const ok = target.mutationTarget === \"canonical\" && " +
        "(target.kind === \"google_sheet\" || (target.key === \"elt_doc\" && target.kind === \"google_doc\"))\n" +
        "if (weekday === 5 && target.key === \"elt_doc\") void target\nvoid targets; void ok\n",
      "lib/recruiting-ops/delivery/elt-doc-dry-run.ts":
        'export const plan = { mutationScope: "weekly_fact_table" }\n',
      "lib/recruiting-ops/delivery/elt-doc-staging-requests.ts":
        "insertHumanText(plan.renderedText)\n",
    })
    const result = run(root)
    expect(result.stderr).toContain("[scheduled-copy-only-targets]")
    expect(result.stderr).toContain("confined to the weekly fact-table scope")
  })

  test("[scheduled-copy-only-targets] rejects dead scope and appender text", () => {
    const lanes = [
      ...Array.from({ length: 10 }, () => '    "weekday_morning",'),
      '    "weekday_evening",',
    ].join("\n")
    const root = tmpRepo({
      "lib/recruiting-ops/delivery/staging-artifact-registry.ts":
        `export const stagingArtifactRegistry = [\n${lanes}\n]\n` +
        "export const target = { mutationTarget: \"canonical\" }\n",
      "lib/recruiting-ops/delivery/staging-maintenance-cadence.ts":
        "const targets = stagingArtifactRegistry.filter(isScheduledArtifactTarget)\n" +
        "const ok = target.mutationTarget === \"canonical\" && " +
        "(target.kind === \"google_sheet\" || (target.key === \"elt_doc\" && target.kind === \"google_doc\"))\n" +
        "if (weekday === 5 && target.key === \"elt_doc\") void target\nvoid targets; void ok\n",
      "lib/recruiting-ops/delivery/elt-doc-dry-run.ts":
        "export function planEltDocDryRun() {\n" +
        '  if (false) return { privatePlan: { mutationScope: "weekly_fact_table", factTable: desiredFactTable } }\n' +
        "  return { privatePlan: { factTable: desiredFactTable } }\n" +
        "}\n",
      "lib/recruiting-ops/delivery/elt-doc-staging-requests.ts":
        "function appendFactTableRequests() {}\n" +
        "export function buildEltDocBatchUpdateRequests(plan) {\n" +
        "  const requests = []\n" +
        "  if (false) appendFactTableRequests(requests, plan.tabId, plan.factTable, 1)\n" +
        "  requests.push({ insertText: { text: plan.renderedText } })\n" +
        "  return requests\n" +
        "}\n" +
        "export function buildEltDocRollbackRequests(plan) {\n" +
        "  const requests = []\n" +
        "  if (false) appendFactTableRequests(requests, plan.tabId, plan.rollbackFactTable, 1)\n" +
        "  return requests\n" +
        "}\n",
    })

    const result = run(root)
    expect(result.stderr).toContain("[scheduled-copy-only-targets]")
    expect(result.stderr).toContain("actively confined to the weekly fact-table scope")
  })

  test("[scheduled-copy-only-targets] accepts calls only when the live planner and compilers own them", () => {
    const lanes = [
      ...Array.from({ length: 10 }, () => '    "weekday_morning",'),
      '    "weekday_evening",',
    ].join("\n")
    const root = tmpRepo({
      "lib/recruiting-ops/delivery/staging-artifact-registry.ts":
        `export const stagingArtifactRegistry = [\n${lanes}\n]\n` +
        "export const target = { mutationTarget: \"canonical\" }\n",
      "lib/recruiting-ops/delivery/staging-maintenance-cadence.ts":
        "const targets = stagingArtifactRegistry.filter(isScheduledArtifactTarget)\n" +
        "const ok = target.mutationTarget === \"canonical\" && " +
        "(target.kind === \"google_sheet\" || (target.key === \"elt_doc\" && target.kind === \"google_doc\"))\n" +
        "if (weekday === 5 && target.key === \"elt_doc\") void target\nvoid targets; void ok\n",
      "lib/recruiting-ops/delivery/elt-doc-dry-run.ts":
        readFileSync(
          join(process.cwd(), "lib/recruiting-ops/delivery/elt-doc-dry-run.ts"),
          "utf8"
        ),
      "lib/recruiting-ops/delivery/elt-doc-staging-requests.ts":
        readFileSync(
          join(process.cwd(), "lib/recruiting-ops/delivery/elt-doc-staging-requests.ts"),
          "utf8"
        ),
    })

    expect(run(root).stderr).not.toContain("actively confined to the weekly fact-table scope")
  })

  test("[scheduled-copy-only-targets] rejects extra live narrative requests beside the fact appender", () => {
    const lanes = [
      ...Array.from({ length: 10 }, () => '    "weekday_morning",'),
      '    "weekday_evening",',
    ].join("\n")
    const root = tmpRepo({
      "lib/recruiting-ops/delivery/staging-artifact-registry.ts":
        `export const stagingArtifactRegistry = [\n${lanes}\n]\n` +
        "export const target = { mutationTarget: \"canonical\" }\n",
      "lib/recruiting-ops/delivery/staging-maintenance-cadence.ts":
        "const targets = stagingArtifactRegistry.filter(isScheduledArtifactTarget)\n" +
        "const ok = target.mutationTarget === \"canonical\" && " +
        "(target.kind === \"google_sheet\" || (target.key === \"elt_doc\" && target.kind === \"google_doc\"))\n" +
        "if (weekday === 5 && target.key === \"elt_doc\") void target\nvoid targets; void ok\n",
      "lib/recruiting-ops/delivery/elt-doc-dry-run.ts":
        "export function planEltDocDryRun() {\n" +
        "  const publicSummary = {}\n" +
        '  return { publicSummary, privatePlan: { mutationScope: "weekly_fact_table", factTable: desiredFactTable } }\n' +
        "}\n",
      "lib/recruiting-ops/delivery/elt-doc-staging-requests.ts":
        "function appendFactTableRequests() {}\n" +
        "export function buildEltDocBatchUpdateRequests(plan) {\n" +
        "  const requests = []\n" +
        "  appendFactTableRequests(requests, plan.tabId, plan.factTable, 1)\n" +
        "  requests.push({ insertText: { text: plan.renderedText } })\n" +
        "  return requests\n" +
        "}\n" +
        "export function buildEltDocRollbackRequests(plan) {\n" +
        "  const requests = []\n" +
        "  if (plan.rollbackFactTable) {\n" +
        "    appendFactTableRequests(requests, plan.tabId, plan.rollbackFactTable, 1)\n" +
        "  }\n" +
        "  return requests\n" +
        "}\n",
    })

    const result = run(root)
    expect(result.stderr).toContain("[scheduled-copy-only-targets]")
    expect(result.stderr).toContain("actively confined to the weekly fact-table scope")
  })

  test("[scheduled-copy-only-targets] rejects unreachable, shadowed, and aliased request bypasses", () => {
    const lanes = [
      ...Array.from({ length: 10 }, () => '    "weekday_morning",'),
      '    "weekday_evening",',
    ].join("\n")
    const planner = readFileSync(
      join(process.cwd(), "lib/recruiting-ops/delivery/elt-doc-dry-run.ts"),
      "utf8"
    )
    const validCompiler = readFileSync(
      join(process.cwd(), "lib/recruiting-ops/delivery/elt-doc-staging-requests.ts"),
      "utf8"
    )
    const bypasses = [
      {
        planner: planner.replace(
          "  return {\n    publicSummary,\n    privatePlan: {",
          "  if (false) { const privatePlan = {}; return { publicSummary, privatePlan } }\n" +
            "  return {\n" +
            "    publicSummary,\n" +
            "    privatePlan: {"
        ),
        compiler: validCompiler,
      },
      {
        planner,
        compiler: validCompiler.replace(
        "  appendFactTableRequests(requests, plan.tabId, plan.factTable, plan.insertAt!.index)\n",
        "  return requests\n" +
          "  appendFactTableRequests(requests, plan.tabId, plan.factTable, plan.insertAt!.index)\n"
        ),
      },
      {
        planner,
        compiler: validCompiler.replace(
          "  appendFactTableRequests(requests, plan.tabId, plan.factTable, plan.insertAt!.index)\n",
          "  const appendFactTableRequests = () => undefined\n" +
            "  appendFactTableRequests(requests, plan.tabId, plan.factTable, plan.insertAt!.index)\n"
        ),
      },
      {
        planner,
        compiler: validCompiler.replace(
          "  return requests\n}\n\nexport function buildEltDocRollbackRequests",
          "  requests[requests.length] = narrativeRequest\n" +
            "  return requests\n" +
            "}\n\n" +
            "export function buildEltDocRollbackRequests"
        ),
      },
      {
        planner,
        compiler: validCompiler.replace(
          "  const rows = [ELT_DOC_HIRE_TABLE_HEADERS, ...preface.hireRows]\n",
          '  requests.push({ insertText: { location: { tabId, index: insertionIndex }, text: "Narrative" } })\n' +
            "  const rows = [ELT_DOC_HIRE_TABLE_HEADERS, ...preface.hireRows]\n"
        ),
      },
      {
        planner,
        compiler: validCompiler.replace(
          '  if (plan.action === "no_op") throw new Error("ELT no-op has no rollback requests.")',
          '  if (false) throw new Error("ELT no-op has no rollback requests.")'
        ),
      },
    ]

    for (const bypass of bypasses) {
      const root = tmpRepo({
        "lib/recruiting-ops/delivery/staging-artifact-registry.ts":
          `export const stagingArtifactRegistry = [\n${lanes}\n]\n` +
          "export const target = { mutationTarget: \"canonical\" }\n",
        "lib/recruiting-ops/delivery/staging-maintenance-cadence.ts":
          "const targets = stagingArtifactRegistry.filter(isScheduledArtifactTarget)\n" +
          "const ok = target.mutationTarget === \"canonical\" && " +
          "(target.kind === \"google_sheet\" || (target.key === \"elt_doc\" && target.kind === \"google_doc\"))\n" +
          "if (weekday === 5 && target.key === \"elt_doc\") void target\nvoid targets; void ok\n",
        "lib/recruiting-ops/delivery/elt-doc-dry-run.ts": bypass.planner,
        "lib/recruiting-ops/delivery/elt-doc-staging-requests.ts": bypass.compiler,
      })
      const result = run(root)
      expect(result.stderr).toContain("[scheduled-copy-only-targets]")
      expect(result.stderr).toContain("actively confined to the weekly fact-table scope")
    }
    // Six subprocess runs over the real repo, one per bypass variant. This carried an
    // explicit 10_000 — identical to the old default, so it had NO headroom and failed on a
    // laptop at 13.4s while passing in CI. Sized well above observed cost so a slow or
    // loaded machine cannot turn a correctness gate into a coin flip.
  }, 60_000)

  test("[forbidden-imports] does NOT fire on mere existence of other workstreams' paths (post-merge semantics)", () => {
    // Phase B merged origin/main in: scoped-MCP/agent/identity paths legitimately exist.
    // The boundary is imports, not existence — locked by the next test.
    const root = tmpRepo({
      "mcp/greenhouse/scoped-greenhouse/leak-fixture.ts": "export const leak = true\n",
    })
    const result = run(root)
    expect(result.stderr).not.toContain("mcp/greenhouse/scoped-greenhouse/leak-fixture.ts")
  })

  test("[forbidden-imports] fires on a command-center module importing scoped-MCP/agent/identity code", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/importer-fixture.ts":
        'import { scope } from "../../mcp/greenhouse/scoped-recruiter-mcp/x"\nimport { id } from "../recruiter-identity"\nvoid scope; void id\n',
    })
    const result = run(root)
    expect(result.stderr).toContain("[forbidden-imports]")
    expect(result.stderr).toContain("lib/recruiting-ops/importer-fixture.ts")
  })

  test("[source-posture] fires on a warehouse_read foundation adapter", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/source-fixture.ts": 'export const adapter = "warehouse_read"\n',
    })
    expect(run(root).stderr).toContain("[source-posture]")
  })

  test("[greenhouse-write-boundary] fires on importing a write-capable Greenhouse helper", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/gh-fixture.ts":
        'import { greenhousePost } from "../greenhouse-client"\nvoid greenhousePost\n',
    })
    expect(run(root).stderr).toContain("[greenhouse-write-boundary]")
  })

  test("[no-freeform-sql] fires on free-form SQL surfaces", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/sql-fixture.ts": "export const cfg = { freeFormSqlAllowed: true }\n",
    })
    expect(run(root).stderr).toContain("[no-freeform-sql]")
  })

  test("[no-public-pii] fires when a public-output module emits an email field", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/public-summary-fixture.ts":
        "export const row = { candidate_email: redacted }\n",
    })
    expect(run(root).stderr).toContain("[no-public-pii]")
  })

  test("[module-capability-binding] fires on a module declaring an unknown capabilityId", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/capabilities.ts":
        'export const requiredCapabilityIds = ["known_cap"] as const\n',
      "lib/recruiting-ops/modules/ghost-fixture.ts":
        'export const def: RecruitingOpsModuleDefinition = { capabilityId: "ghost_cap" }\n',
    })
    const result = run(root)
    expect(result.stderr).toContain("[module-capability-binding]")
    expect(result.stderr).toContain("ghost_cap")
  })

  test("[no-sentinel-attribution-fallback] fires on a recruiter sentinel string", () => {
    const root = tmpRepo({
      "lib/recruiting-ops/modules/sentinel-fixture.ts":
        'export const row = { recruiter_name: someValue ?? "unmapped" }\n',
    })
    expect(run(root).stderr).toContain("[no-sentinel-attribution-fallback]")
  })
})

describe("architecture checker is clean on the real repository", () => {
  // Complements the fires-tests: together they catch a deleted/gutted rule. This alone
  // cannot (the repo passes either way); the fires-tests alone cannot (a curated fixture
  // can be made to pass). The pair is the real lock.
  test("the real repo passes with zero failures", () => {
    expect(run(process.cwd()).status).toBe(0)
  })
})
