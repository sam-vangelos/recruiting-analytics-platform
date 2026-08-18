import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { KillSwitchState } from "../lib/recruiting-ops/autonomy"
import { createPayloadFingerprint, PII_FINGERPRINT_SALT_ENV } from "../lib/recruiting-ops/checksums"
import {
  ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
  ELT_DOC_HIRE_TABLE_BODY_FONT_PT,
  ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT,
  ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT,
  ELT_DOC_HIRE_TABLE_HEADERS,
  ELT_DOC_HIRE_TABLE_STRIPE_RGB,
  type GoogleDocsDocumentSnapshot,
  type GoogleDocsStructuralElement,
} from "../lib/recruiting-ops/delivery/elt-doc-dry-run"
import {
  StagingEltDocWriteExecutionError,
  type GoogleWorkspaceStagingClients,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { P1_ELT_DOC_TARGET } from "../lib/recruiting-ops/delivery/p1-artifacts"
import {
  runStagingEltDocHydration,
  type StagingEltDocHydrationPorts,
} from "../lib/recruiting-ops/delivery/staging-elt-doc-hydration-runner"
import {
  getStagingArtifact,
  STAGING_HYDRATION_ENABLED_AT_ENV,
  STAGING_HYDRATION_EXPIRES_AT_ENV,
  STAGING_HYDRATION_GLOBAL_FLAG,
} from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import { STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID } from "../lib/recruiting-ops/delivery/staging-kill-switch"
import type { ExecSnapshotRow } from "../lib/recruiting-ops/exec-snapshot-store"
import type { ExecEltFacts } from "../lib/recruiting-ops/modules/exec-state-of-play"
import { assertPublicSafe } from "../lib/recruiting-ops/safe-public-output"

const originalSalt = process.env[PII_FINGERPRINT_SALT_ENV]

beforeEach(() => {
  process.env[PII_FINGERPRINT_SALT_ENV] = "elt-staging-runner-test-salt"
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalSalt === undefined) delete process.env[PII_FINGERPRINT_SALT_ENV]
  else process.env[PII_FINGERPRINT_SALT_ENV] = originalSalt
})

const facts: ExecEltFacts = {
  generatedAt: "2026-07-11T01:45:00.000Z",
  weekLabel: "Jul 3, 2026 - Jul 9, 2026",
  weekShort: "Jul 3 - Jul 9",
  hires: [],
  hiresNote: "",
  sections: [],
}

function snapshot(overrides: Partial<ExecSnapshotRow> = {}): ExecSnapshotRow {
  return {
    run_id: "e01_20260711015000000",
    workflow_id: "E01",
    mode: "shadow",
    generated_at: "2026-07-11T01:50:00.000Z",
    org_rollup: {
      as_of: "2026-07-11T01:45:00.000Z",
      reporting_week_friday: "2026-07-10",
      open_roles: 0,
      pools_campaigns_templates: 0,
      red: 0,
      amber: 0,
      green: 0,
      seats: 0,
      unowned_roles: 0,
      offers_accepted_12wk: 0,
      momentum: {},
      tiers: { in_play: 0, gone_quiet: 0, filled_not_closed: 0, no_search: 0 },
      attention_count: 0,
      positions_in_play: 0,
      offers_out: { count: 0, waiting_14d_plus: 0 },
      off_scope_scorecards: 0,
      conducted_unattributed_stage: 0,
      truncation_suspected_pulls: 0,
    },
    req_rows: [],
    hires: [],
    elt_facts: facts,
    ...overrides,
  }
}

function dateChipHeading(
  startIndex: number,
  startDisplay: string,
  endDisplay: string
): GoogleDocsStructuralElement {
  return {
    startIndex,
    endIndex: startIndex + 8,
    paragraph: {
      paragraphStyle: { namedStyleType: "HEADING_2" },
      elements: [
        {
          dateElement: {
            dateElementProperties: {
              displayText: startDisplay,
              timestamp: new Date(`${startDisplay} 12:00:00 UTC`).toISOString(),
              locale: "en",
              dateFormat: "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
              timeFormat: "TIME_FORMAT_DISABLED",
            },
          },
        },
        { textRun: { content: " - " } },
        {
          dateElement: {
            dateElementProperties: {
              displayText: endDisplay,
              timestamp: new Date(`${endDisplay} 12:00:00 UTC`).toISOString(),
              locale: "en",
              dateFormat: "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
              timeFormat: "TIME_FORMAT_DISABLED",
            },
          },
        },
        { textRun: { content: "  \n" } },
      ],
    },
  }
}

function observedHireTable(
  startIndex: number,
  hireRows: readonly (readonly [string, string, string, string, string])[]
): GoogleDocsStructuralElement {
  const rows = [ELT_DOC_HIRE_TABLE_HEADERS, ...hireRows]
  const dimension = (magnitude: number) => ({ magnitude, unit: "PT" })
  const gray = { color: { rgbColor: { red: 0.8, green: 0.8, blue: 0.8 } } }
  const border = (width: number, withColor: boolean) => ({
    ...(withColor ? { color: gray } : {}),
    width: dimension(width),
    dashStyle: "SOLID",
  })
  const textLength = rows.flat().reduce((sum, text) => sum + text.length, 0)
  return {
    startIndex,
    endIndex: startIndex + 2 + rows.length * 11 + textLength,
    table: {
      rows: rows.length,
      columns: 5,
      tableStyle: {
        tableColumnProperties: ELT_DOC_HIRE_TABLE_COLUMN_WIDTHS_PT.map((width) => ({
          widthType: "FIXED_WIDTH",
          width: dimension(width),
        })),
      },
      tableRows: rows.map((row, rowIndex) => ({
        tableRowStyle: { minRowHeight: dimension(27) },
        tableCells: row.map((text) => ({
          tableCellStyle: {
            ...(rowIndex > 0
              ? {
                  backgroundColor: {
                    color: {
                      rgbColor:
                        rowIndex % 2 === 1
                          ? { red: 1, green: 1, blue: 1 }
                          : ELT_DOC_HIRE_TABLE_STRIPE_RGB,
                    },
                  },
                }
              : {}),
            borderLeft: border(
              rowIndex === 0
                ? ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT
                : ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
              rowIndex === 0
            ),
            borderRight: border(
              rowIndex === 0
                ? ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT
                : ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
              rowIndex === 0
            ),
            borderTop: border(
              rowIndex === 0
                ? ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT
                : ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
              true
            ),
            borderBottom: border(
              rowIndex === 0
                ? ELT_DOC_HIRE_TABLE_HEADER_BORDER_PT
                : ELT_DOC_HIRE_TABLE_BODY_BORDER_PT,
              true
            ),
            paddingLeft: dimension(2),
            paddingRight: dimension(2),
            paddingTop: dimension(2),
            paddingBottom: dimension(2),
            contentAlignment: "MIDDLE",
          },
          content: [
            {
              paragraph: {
                paragraphStyle: {
                  namedStyleType: "NORMAL_TEXT",
                  alignment: "CENTER",
                  ...(rowIndex > 0 ? { lineSpacing: 115, spacingMode: "COLLAPSE_LISTS" } : {}),
                },
                elements: [
                  {
                    textRun: {
                      content: `${text}\n`,
                      textStyle:
                        rowIndex === 0
                          ? { bold: true }
                          : { bold: false, fontSize: dimension(ELT_DOC_HIRE_TABLE_BODY_FONT_PT) },
                    },
                  },
                ],
              },
            },
          ],
        })),
      })),
    },
  }
}

function document(): GoogleDocsDocumentSnapshot {
  const table = observedHireTable(10, [])
  // The fixture's `facts` has zero hires and zero sections, so the desired
  // Role Progress narrative tail is empty too — the observed document must
  // match that exactly (nothing between the table and the next boundary) for
  // this to be a genuine no-op, since A9 narrative is now part of the match.
  const nextBoundaryStart = table.endIndex!
  return {
    documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
    title: P1_ELT_DOC_TARGET.expectedTitle,
    revisionId: "revision-copy-11",
    tabs: [
      {
        tabProperties: { tabId: P1_ELT_DOC_TARGET.tabId },
        documentTab: {
          body: {
            content: [
              { startIndex: 0, endIndex: 1, sectionBreak: {} },
              dateChipHeading(1, "Jul 3, 2026", "Jul 9, 2026"),
              {
                startIndex: 9,
                endIndex: 10,
                paragraph: {
                  paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                  elements: [{ textRun: { content: "\n" } }],
                },
              },
              table,
              dateChipHeading(nextBoundaryStart, "Jun 26, 2026", "Jul 2, 2026"),
              {
                startIndex: nextBoundaryStart + 8,
                endIndex: nextBoundaryStart + 14,
                paragraph: { elements: [{ textRun: { content: "Keep\n" } }] },
              },
            ],
          },
        },
      },
    ],
  }
}

function fixture(snapshotValue = snapshot()) {
  const get = vi.fn(async () => ({ data: document() }))
  const batchUpdate = vi.fn()
  const clients = {
    docs: { documents: { get, batchUpdate } },
    sheets: {},
    drive: {},
  } as unknown as GoogleWorkspaceStagingClients
  const loadLatestSnapshot = vi.fn<StagingEltDocHydrationPorts["loadLatestSnapshot"]>()
  loadLatestSnapshot.mockResolvedValue({ status: "available", snapshot: snapshotValue })
  const readKillSwitchStates = vi.fn<StagingEltDocHydrationPorts["readKillSwitchStates"]>()
  const writeDocument = vi.fn<StagingEltDocHydrationPorts["writeDocument"]>()
  return { clients, get, batchUpdate, loadLatestSnapshot, readKillSwitchStates, writeDocument }
}

const clearSwitch: KillSwitchState = {
  scope: "global",
  scopeId: STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID,
  enabled: false,
  reason: "copy validation authorized",
  updatedAt: "2026-07-11T02:49:00.000Z",
  updatedBy: "operator",
}

describe("copied ELT document hydration runner", () => {
  test("uses an injected reporting-cut snapshot without reading an independent latest snapshot", async () => {
    const value = fixture()
    const result = await runStagingEltDocHydration({
      nowMs: Date.parse("2026-07-11T02:50:00.000Z"),
      clients: value.clients,
      snapshot: snapshot(),
      ports: {
        loadLatestSnapshot: value.loadLatestSnapshot,
        readKillSwitchStates: value.readKillSwitchStates,
        writeDocument: value.writeDocument,
      },
    })

    expect(result.status).toBe("dry_run")
    expect(value.loadLatestSnapshot).not.toHaveBeenCalled()
  })

  test("defaults to a public-safe dry run with no mutation or kill-switch read", async () => {
    const value = fixture()
    const result = await runStagingEltDocHydration({
      nowMs: Date.parse("2026-07-11T02:50:00.000Z"),
      clients: value.clients,
      ports: {
        loadLatestSnapshot: value.loadLatestSnapshot,
        readKillSwitchStates: value.readKillSwitchStates,
        writeDocument: value.writeDocument,
      },
    })

    expect(result).toMatchObject({
      artifactKey: "elt_doc",
      mode: "dry_run",
      status: "dry_run",
      runId: "e01_20260711015000000",
      plan: {
        status: "no_change",
        action: "no_op",
        mutationCallCount: 0,
      },
    })
    expect(value.get).toHaveBeenCalledOnce()
    expect(value.get).toHaveBeenCalledWith({
      documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
      includeTabsContent: true,
    })
    expect(value.batchUpdate).not.toHaveBeenCalled()
    expect(value.readKillSwitchStates).not.toHaveBeenCalled()
    expect(value.writeDocument).not.toHaveBeenCalled()
    expect(() => assertPublicSafe(result)).not.toThrow()
    expect(JSON.stringify(result)).not.toContain("Existing copied block")
  })

  test("threads the declared backfill week through to the planner", async () => {
    // An invalid declared week can only be refused by the planner, so the
    // refusal reaching the public outcome proves the option is threaded.
    const value = fixture()
    const result = await runStagingEltDocHydration({
      nowMs: Date.parse("2026-07-11T02:50:00.000Z"),
      clients: value.clients,
      ports: { loadLatestSnapshot: value.loadLatestSnapshot },
      eltBackfillWeekFriday: "2026-07-08",
    })
    expect(result).toMatchObject({ status: "blocked", blockCode: "plan_blocked" })
    expect(result.plan?.blockingReasons.join(" ")).toContain("not a valid Friday date")
  })

  test("rejects canonical and unknown targets before snapshot or Google access", async () => {
    for (const targetDocumentId of [
      P1_ELT_DOC_TARGET.deniedDocumentIds[0],
      "unknown-document-id",
    ]) {
      const value = fixture()
      const result = await runStagingEltDocHydration({
        targetDocumentId,
        clients: value.clients,
        ports: { loadLatestSnapshot: value.loadLatestSnapshot },
      })
      expect(result).toMatchObject({ status: "blocked", blockCode: "target_not_registered_copy" })
      expect(value.loadLatestSnapshot).not.toHaveBeenCalled()
      expect(value.get).not.toHaveBeenCalled()
      expect(value.batchUpdate).not.toHaveBeenCalled()
    }
  })

  test("fails closed on unavailable, stale, and truncated snapshots before reading the Doc", async () => {
    const unavailable = fixture()
    unavailable.loadLatestSnapshot.mockResolvedValueOnce({
      status: "unavailable",
      reason: "private database detail",
    })
    await expect(
      runStagingEltDocHydration({
        clients: unavailable.clients,
        ports: { loadLatestSnapshot: unavailable.loadLatestSnapshot },
      })
    ).resolves.toMatchObject({ status: "blocked", blockCode: "snapshot_unavailable" })
    expect(unavailable.get).not.toHaveBeenCalled()

    const stale = fixture()
    const staleResult = await runStagingEltDocHydration({
      nowMs: Date.parse("2026-07-11T03:50:00.001Z"),
      clients: stale.clients,
      ports: { loadLatestSnapshot: stale.loadLatestSnapshot },
    })
    expect(staleResult).toMatchObject({ status: "blocked", blockCode: "plan_blocked" })
    expect(staleResult.plan?.blockingReasons.join(" ")).toContain("freshness limit")
    expect(stale.get).not.toHaveBeenCalled()

    const truncated = fixture(
      snapshot({
        org_rollup: { ...snapshot().org_rollup, truncation_suspected_pulls: 1 },
      })
    )
    const truncatedResult = await runStagingEltDocHydration({
      nowMs: Date.parse("2026-07-11T02:50:00.000Z"),
      clients: truncated.clients,
      ports: { loadLatestSnapshot: truncated.loadLatestSnapshot },
    })
    expect(truncatedResult).toMatchObject({ status: "blocked", blockCode: "plan_blocked" })
    expect(truncatedResult.plan?.blockingReasons.join(" ")).toContain("truncated")
    expect(truncated.get).not.toHaveBeenCalled()
  })

  test("requires the durable clear state, then issues an exact copy-only permit to the writer", async () => {
    const artifact = getStagingArtifact("elt_doc")
    const env = {
      [STAGING_HYDRATION_GLOBAL_FLAG]: "true",
      [artifact.hydrationFlag]: "true",
      [STAGING_HYDRATION_ENABLED_AT_ENV]: "2026-07-11T02:49:00.000Z",
      [STAGING_HYDRATION_EXPIRES_AT_ENV]: "2026-07-11T03:00:00.000Z",
    }

    const blocked = fixture()
    blocked.readKillSwitchStates.mockResolvedValue([])
    const blockedResult = await runStagingEltDocHydration({
      mode: "write",
      nowMs: Date.parse("2026-07-11T02:50:00.000Z"),
      env,
      clients: blocked.clients,
      ports: {
        loadLatestSnapshot: blocked.loadLatestSnapshot,
        readKillSwitchStates: blocked.readKillSwitchStates,
        writeDocument: blocked.writeDocument,
      },
    })
    expect(blockedResult).toMatchObject({
      status: "blocked",
      blockCode: "kill_switch_blocked",
      plan: { liveFlagEnabled: true },
    })
    expect(blocked.writeDocument).not.toHaveBeenCalled()

    const clear = fixture()
    clear.readKillSwitchStates.mockResolvedValue([clearSwitch])
    clear.writeDocument.mockImplementation(async ({ plan }) => ({
      artifactKey: "elt_doc",
      runId: plan.runId,
      status: "written",
      action: plan.action,
      requestCount: 6,
      mutationCallCount: 1,
      beforeRevisionId: plan.requiredRevisionId,
      afterRevisionId: "revision-copy-12",
      beforeDriveVersion: "100",
      afterDriveVersion: "101",
      preimageFingerprint: plan.preimageFingerprint,
      beforePermissionFingerprint: `hmac-sha256:${"e".repeat(64)}`,
      afterPermissionFingerprint: `hmac-sha256:${"e".repeat(64)}`,
      beforeOutsideContentFingerprint: plan.outsideContentFingerprint,
      afterOutsideContentFingerprint: plan.outsideContentFingerprint,
      rollbackRequestCount: 6,
      rollbackAttempted: false,
    }))
    const clearResult = await runStagingEltDocHydration({
      mode: "write",
      nowMs: Date.parse("2026-07-11T02:50:00.000Z"),
      currentTimeMs: () => Date.parse("2026-07-11T02:50:00.000Z"),
      env,
      clients: clear.clients,
      ports: {
        loadLatestSnapshot: clear.loadLatestSnapshot,
        readKillSwitchStates: clear.readKillSwitchStates,
        writeDocument: clear.writeDocument,
      },
    })

    expect(clearResult).toMatchObject({
      artifactKey: "elt_doc",
      mode: "write",
      status: "written",
      write: {
        status: "written",
        mutationCallCount: 1,
        beforeDriveVersion: "100",
        afterDriveVersion: "101",
        beforePermissionFingerprint: `hmac-sha256:${"e".repeat(64)}`,
        afterPermissionFingerprint: `hmac-sha256:${"e".repeat(64)}`,
      },
    })
    expect(clear.writeDocument).toHaveBeenCalledOnce()
    expect(clear.writeDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        clients: clear.clients,
        env,
        plan: expect.objectContaining({
          documentId: P1_ELT_DOC_TARGET.stagingDocumentId,
          tabId: P1_ELT_DOC_TARGET.tabId,
          dataProvenance: "live",
        }),
        permit: expect.objectContaining({
          artifactKey: "elt_doc",
          artifactId: P1_ELT_DOC_TARGET.stagingDocumentId,
          kind: "google_doc",
          killSwitchStoreReachable: true,
          killSwitchClear: true,
          canonicalOnly: true,
        }),
      })
    )
    expect(JSON.stringify(clearResult)).not.toContain("renderedText")
    expect(() => assertPublicSafe(clearResult)).not.toThrow()
  })

  test("returns only a bounded writer failure stage and suppresses the private cause", async () => {
    const artifact = getStagingArtifact("elt_doc")
    const env = {
      [STAGING_HYDRATION_GLOBAL_FLAG]: "true",
      [artifact.hydrationFlag]: "true",
      [STAGING_HYDRATION_ENABLED_AT_ENV]: "2026-07-11T02:49:00.000Z",
      [STAGING_HYDRATION_EXPIRES_AT_ENV]: "2026-07-11T03:00:00.000Z",
    }
    const value = fixture()
    value.readKillSwitchStates.mockResolvedValue([clearSwitch])
    value.writeDocument.mockRejectedValue(
      new StagingEltDocWriteExecutionError(
        "postimage_validation",
        Object.assign(
          new Error(
            "Invalid requests[137].updateTableCellStyle: candidate-private document content"
          ),
          {
            response: {
              status: 400,
              data: {
                error: {
                  message:
                    "Invalid requests[137].updateTableCellStyle: candidate-private document content",
                },
              },
            },
          }
        ),
        {
          mutationCallCount: 1,
          beforeRevisionId: "revision-before",
          afterRevisionId: "revision-after",
          certificationStatus: "postimage_rejected",
        }
      )
    )

    const result = await runStagingEltDocHydration({
      mode: "write",
      nowMs: Date.parse("2026-07-11T02:50:00.000Z"),
      env,
      clients: value.clients,
      ports: {
        loadLatestSnapshot: value.loadLatestSnapshot,
        readKillSwitchStates: value.readKillSwitchStates,
        writeDocument: value.writeDocument,
      },
    })

    expect(result).toMatchObject({
      status: "blocked",
      blockCode: "write_failed",
      failureStage: "postimage_validation",
      failure: {
        failureStage: "postimage_validation",
        mutationCallCount: 1,
        providerHttpStatus: 400,
        providerRequestIndex: 137,
        beforeRevisionFingerprint: createPayloadFingerprint("revision-before"),
        afterRevisionFingerprint: createPayloadFingerprint("revision-after"),
        certificationStatus: "postimage_rejected",
      },
    })
    expect(JSON.stringify(result)).not.toContain("candidate-private")
    expect(() => assertPublicSafe(result)).not.toThrow()
  })
})
