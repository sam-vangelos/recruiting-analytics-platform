import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { createLocalPiiFingerprint } from "../../lib/recruiting-ops/checksums"
import { runPipelineModule, type GreenhousePipelineStageFact } from "../../lib/recruiting-ops/modules/t02-pipeline"
import {
  runRecruiterWeeklyReqProgressShadow,
} from "../../lib/recruiting-ops/modules/recruiter-weekly-req-progress-shadow"
import {
  runSupportQueueModule,
  type GreenhouseClarificationFact,
} from "../../lib/recruiting-ops/modules/s-support-queues"
import type { RecruitingOpsModuleResult } from "../../lib/recruiting-ops/modules/types"

/**
 * Characterization safety net for the upcoming P7 refactor (extracting a shared
 * `runRecruitingOpsModule` runner from ~21 copy-paste module scaffolds).
 *
 * This locks the runner ORCHESTRATION CONTRACT — the invariants a behavior-preserving
 * extraction must keep — over three modules chosen to span the variation in the family:
 *   1. runPipelineModule (t02-pipeline)                 — plain fixture module
 *   2. runRecruiterWeeklyReqProgressShadow (T03 shadow) — gated *-shadow module (gates + ledger)
 *   3. runSupportQueueModule (S03 / s-support-queues)   — S-queue module
 *
 * It deliberately does NOT snapshot business values — row contents, offer counts, names,
 * rendered bytes. Those belong to the per-module tests and the quarantined red specs;
 * pinning them here would canonize the T01/T05/sentinel bugs the audit found. We assert
 * only contract-shaped invariants that a correct refactor preserves and an accidental
 * orchestration change breaks.
 *
 * The only real per-call non-determinism is `RunArtifact.path` (it embeds the fresh
 * os.tmpdir() rootDir). We strip every artifact path before deep-equality; checksums
 * (`normalizedChecksum`, `inputChecksum`, artifact `checksum`) stay in the compare, so
 * checksum stability rides on the determinism assertion as well as its own explicit check.
 */

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-runner-char-"))
  roots.push(root)
  return root
}

// Fixed clocks so the only run-to-run variation is the rootDir-bearing artifact path.
const STARTED_AT = "2026-06-24T14:00:00.000Z"
const GENERATED_AT = "2026-06-24T14:01:00.000Z"

// Reuse each module's existing-test fixture shapes so inputs are valid against the real
// run-fn signatures (see test/recruiting-ops-t02-t03-pipeline.test.ts,
// test/recruiting-ops-recruiter-weekly-req-progress-shadow.test.ts,
// test/recruiting-ops-s-support-queues.test.ts).
const pipelineFacts: GreenhousePipelineStageFact[] = [
  {
    applicationId: "app_201",
    jobId: "job_890",
    reqId: "890",
    stageName: "Application Review",
    stageChangedAt: "2026-06-18T10:00:00.000Z",
  },
  {
    applicationId: "app_202",
    jobId: "job_890",
    reqId: "890",
    stageName: "Recruiter Phone Screen",
    stageChangedAt: "2026-06-19T10:00:00.000Z",
  },
]

const clarificationFacts: GreenhouseClarificationFact[] = [
  {
    caseId: "gh_case_1",
    topic: "Offer approval boundary",
    status: "ready",
    owner: "Jordan",
    evidenceIds: ["legacy_s03_greenhouse_clarification_log"],
    decisionRequired: true,
  },
]

// One adapter per module: same fixed input every time, a fresh rootDir each call.
type ModuleRunner = () => Promise<RecruitingOpsModuleResult<unknown>>

const moduleCases: ReadonlyArray<{ name: string; run: ModuleRunner }> = [
  {
    name: "runPipelineModule (t02-pipeline, plain fixture module)",
    run: () =>
      runPipelineModule({
        rootDir: tempRoot(),
        startedAt: STARTED_AT,
        generatedAt: GENERATED_AT,
        greenhouseFacts: pipelineFacts,
        legacyRows: [
          {
            application_id: "app_201",
            stage_name: "Application Review",
            week_bucket: "2026-06-15",
          },
        ],
      }),
  },
  {
    name: "runRecruiterWeeklyReqProgressShadow (recruiter-weekly-req-progress-shadow, gated *-shadow module)",
    run: () =>
      runRecruiterWeeklyReqProgressShadow({
        rootDir: tempRoot(),
        startedAt: STARTED_AT,
        generatedAt: GENERATED_AT,
        greenhouseFacts: pipelineFacts,
        recruiterScope: {
          recipientFingerprint: createLocalPiiFingerprint("recruiter_fixture_alpha", "test_recipient"),
          reqIds: ["890"],
        },
      }),
  },
  {
    name: "runSupportQueueModule (s03-greenhouse-clarification-log, S-queue module)",
    run: () =>
      runSupportQueueModule({
        rootDir: tempRoot(),
        startedAt: STARTED_AT,
        generatedAt: GENERATED_AT,
        workflowId: "S03",
        clarificationFacts,
      }),
  },
]

/**
 * Project a result down to its `RecruitingOpsModuleResult` core orchestration contract with
 * every rootDir-bearing artifact path stripped. This is what a behavior-preserving refactor
 * must keep byte-for-byte across identical runs. Checksums are intentionally retained.
 *
 * For the shadow module this drops its extra fields (gateEvaluation, deliveryLedgerEntry,
 * deliveryLedgerPath — the last of which is also a rootDir-bearing path); the shared runner
 * owns the core result, which is the contract under test here.
 */
function coreProjectionWithoutArtifactPaths(result: RecruitingOpsModuleResult<unknown>) {
  // eslint guard against the future runner returning a path through a renamed key.
  const stripPath = ({ path: _path, ...rest }: { path: string }) => rest
  return {
    definition: result.definition,
    normalizedRows: result.normalizedRows,
    discrepancies: result.discrepancies,
    sourceGaps: result.sourceGaps,
    artifacts: result.artifacts.map(stripPath),
    run: {
      ...result.run,
      artifactRefs: result.run.artifactRefs.map(stripPath),
    },
  }
}

describe("recruiting-ops runner orchestration contract (P7 refactor characterization)", () => {
  for (const moduleCase of moduleCases) {
    describe(moduleCase.name, () => {
      test("INVARIANT 1 — determinism: identical input yields a deeply-equal result after stripping artifact paths", async () => {
        const first = await moduleCase.run()
        const second = await moduleCase.run()

        // The only difference between two identical runs is the fresh-tmp-dir artifact paths.
        expect(first.artifacts.map((artifact) => artifact.path)).not.toEqual(
          second.artifacts.map((artifact) => artifact.path)
        )

        expect(coreProjectionWithoutArtifactPaths(first)).toStrictEqual(
          coreProjectionWithoutArtifactPaths(second)
        )
      })

      test("INVARIANT 2 — structural completeness and capability propagation", async () => {
        const result = await moduleCase.run()

        // Capability is set on the run and propagated to every nested record the runner stamps.
        expect(typeof result.run.capabilityId).toBe("string")
        expect(result.run.capabilityId.length).toBeGreaterThan(0)
        for (const artifact of result.artifacts) {
          expect(artifact.capabilityId).toBe(result.run.capabilityId)
        }
        for (const artifact of result.run.artifactRefs) {
          expect(artifact.capabilityId).toBe(result.run.capabilityId)
        }
        for (const gap of result.sourceGaps) {
          expect(gap.capabilityId).toBe(result.run.capabilityId)
        }
        for (const discrepancy of result.discrepancies) {
          expect(discrepancy.capabilityId).toBe(result.run.capabilityId)
        }

        // Row accounting is internally consistent and identity fields are populated.
        expect(result.run.normalizedRowCount).toBe(result.normalizedRows.length)
        expect(typeof result.run.moduleId).toBe("string")
        expect(result.run.moduleId.length).toBeGreaterThan(0)
        expect(typeof result.run.workflowId).toBe("string")
        expect(result.run.workflowId.length).toBeGreaterThan(0)
        // The runner must echo the definition it was given, unmodified.
        expect(result.run.moduleId).toBe(result.definition.moduleId)
        expect(result.run.workflowId).toBe(result.definition.workflowId)
        expect(result.run.capabilityId).toBe(result.definition.capabilityId)
      })

      test("INVARIANT 3 — checksum stability across identical runs", async () => {
        const first = await moduleCase.run()
        const second = await moduleCase.run()

        // Content-derived checksums must not depend on the rootDir or any wall clock.
        expect(first.run.normalizedChecksum).toBe(second.run.normalizedChecksum)
        expect(first.run.inputChecksum).toBe(second.run.inputChecksum)
        expect(first.artifacts.map((artifact) => artifact.checksum)).toEqual(
          second.artifacts.map((artifact) => artifact.checksum)
        )
      })
    })
  }
})
