#!/usr/bin/env node
// Mutation corpus: proves the catcher/behavioral tests actually catch regressions, not just
// pass on clean fixtures. For each seeded one-line mutation of PRODUCTION code, the named test
// MUST fail by AssertionError. A mutation that leaves the suite green is an untested guard
// (the exact defect the audit found: 5/20 probe mutations survived). A failure that is a
// compile/load error rather than an AssertionError is a FALSE KILL and also reported.
//
// Mechanism: in-place save -> mutate -> run only the named test -> restore from memory,
// SEQUENTIALLY (never parallel), with exit/SIGINT guards so a crash always restores. The
// working tree is byte-identical before and after. Seeds = the audit's known survivors + the
// two deletable architecture-checker rules + a few pre-existing good guards, for breadth.
// Run: `npm run test:mutation` (use the project-pinned node).

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()

/** @type {{id:string,file:string,find:string,replace:string,mustFailTest:string,finding:string}[]} */
const corpus = [
  {
    id: "idempotency-gate-disabled",
    finding: "SAFETY-GATES-5",
    file: "lib/recruiting-ops/delivery-gates.ts",
    find: "  if (input.priorPayloadFingerprintsInWindow.includes(input.payloadFingerprint)) {",
    replace: "  if (false && input.priorPayloadFingerprintsInWindow.includes(input.payloadFingerprint)) {",
    mustFailTest: "test/recruiting-ops-gate-promotion-catchers.test.ts",
  },
  {
    id: "discrepancy-gate-disabled",
    finding: "delivery-gates discrepancy_tolerance",
    file: "lib/recruiting-ops/delivery-gates.ts",
    find: "  if (input.blockingDiscrepancyCount > 0 || input.businessDefinitionOpenCount > 0) {",
    replace: "  if (false && (input.blockingDiscrepancyCount > 0 || input.businessDefinitionOpenCount > 0)) {",
    mustFailTest: "test/recruiting-ops-gate-promotion-catchers.test.ts",
  },
  {
    id: "source-gap-gate-disabled",
    finding: "delivery-gates source_gap",
    file: "lib/recruiting-ops/delivery-gates.ts",
    find: "  if (input.blockingSourceGapCount > 0) {",
    replace: "  if (false && input.blockingSourceGapCount > 0) {",
    mustFailTest: "test/recruiting-ops-gate-promotion-catchers.test.ts",
  },
  {
    id: "trust-window-promotion-check-disabled",
    finding: "AUTONOMY trust_window guard",
    file: "lib/recruiting-ops/autonomy-operator-controls.ts",
    find: '      input.requestedState === "auto_eligible" && trustWindow.status !== "satisfied" ? "fail" : "pass",',
    replace: '      false ? "fail" : "pass",',
    mustFailTest: "test/recruiting-ops-gate-promotion-catchers.test.ts",
  },
  {
    id: "kill-switch-gate-disabled",
    finding: "delivery-gates kill_switch",
    file: "lib/recruiting-ops/delivery-gates.ts",
    find: "  const activeSwitch = input.killSwitches.find((state) => state.enabled && appliesToInput(state, input))",
    replace: "  const activeSwitch = input.killSwitches.find((state) => false && state.enabled && appliesToInput(state, input))",
    mustFailTest: "test/recruiting-ops-delivery-gates.test.ts",
  },
  {
    id: "pii-inspection-disabled",
    finding: "safe-public-output detection",
    file: "lib/recruiting-ops/safe-public-output.ts",
    find: "  visitPublicValue(value, path, violations, options)",
    replace: "  // MUTATED: visitPublicValue(value, path, violations, options)",
    mustFailTest: "test/recruiting-ops-public-output.test.ts",
  },
  {
    id: "arch-no-production-writes-gutted",
    finding: "ARCH-META-2 / P5",
    file: "scripts/recruiting-ops-architecture-check.mjs",
    find: "function checkNoProductionWrites({ root, implementationFiles, failures }) {",
    replace: "function checkNoProductionWrites({ root, implementationFiles, failures }) {\n  return;",
    mustFailTest: "test/recruiting-ops-architecture-check.behavioral.test.ts",
  },
  {
    id: "arch-forbidden-imports-gutted",
    finding: "ARCH-META / P5",
    file: "scripts/recruiting-ops-architecture-check.mjs",
    find: "function checkForbiddenImports({ root, files, implementationFiles, failures }) {",
    replace: "function checkForbiddenImports({ root, files, implementationFiles, failures }) {\n  return;",
    mustFailTest: "test/recruiting-ops-architecture-check.behavioral.test.ts",
  },
]

function runTest(testPath) {
  try {
    const out = execFileSync("npm", ["test", "--", testPath], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { exit: 0, out }
  } catch (error) {
    return { exit: error.status ?? 1, out: String(error.stdout ?? "") + String(error.stderr ?? "") }
  }
}

let active = null
const restore = () => {
  if (active) {
    writeFileSync(active.path, active.original)
    active = null
  }
}
process.on("exit", restore)
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restore()
    process.exit(130)
  })
}

// Refuse to run if any target file is already dirty vs HEAD. Otherwise a leftover mutation
// from a crashed/killed run would be read as the baseline and silently baked in — exactly how
// an earlier SIGTERM'd run left `return;` in checkNoProductionWrites. Clean tree in, clean out.
for (const target of [...new Set(corpus.map((m) => m.file))]) {
  try {
    execFileSync("git", ["diff", "--quiet", "--", target], { cwd: root })
  } catch {
    console.error(`Refusing to run: ${target} has uncommitted changes. Run on a clean tree (git restore it first).`)
    process.exit(2)
  }
}

const caught = []
const survived = []
const falseKills = []

for (const m of corpus) {
  const path = join(root, m.file)
  const original = readFileSync(path, "utf8")
  const occurrences = original.split(m.find).length - 1
  if (occurrences !== 1) {
    survived.push({ ...m, reason: `find string occurs ${occurrences}x (expected exactly 1) — stale corpus entry` })
    console.log(`STALE  ${m.id} (find not unique: ${occurrences})`)
    continue
  }

  active = { path, original }
  writeFileSync(path, original.replace(m.find, m.replace))
  const { exit, out } = runTest(m.mustFailTest)
  writeFileSync(path, original)
  active = null
  if (readFileSync(path, "utf8") !== original) {
    console.error(`FATAL: failed to restore ${m.file}`)
    process.exit(2)
  }

  if (exit === 0) {
    survived.push({ ...m, reason: "named test still PASSED — the guard is untested (mutation not caught)" })
    console.log(`SURVIVED  ${m.id} -> ${m.mustFailTest}`)
  } else if (!out.includes("AssertionError")) {
    falseKills.push({ ...m, reason: "test failed by a non-assertion (load/compile) error — false kill, not real coverage" })
    console.log(`FALSEKILL ${m.id} -> ${m.mustFailTest}`)
  } else {
    caught.push(m)
    console.log(`CAUGHT    ${m.id} -> ${m.mustFailTest}`)
  }
}

console.log(`\nmutation corpus: ${caught.length}/${corpus.length} caught; ${survived.length} survived; ${falseKills.length} false-kill`)
if (survived.length > 0 || falseKills.length > 0) {
  for (const s of [...survived, ...falseKills]) console.error(`  GAP [${s.finding}] ${s.id}: ${s.reason}`)
  process.exit(1)
}
console.log("All seeded mutations are caught by their tests (by AssertionError).")
