# Automation Control Plane Phase 1-6 Review Prompt

Status: Active
Date: 2026-06-26
Owner: the operator

Use this prompt for the adversarial review after the Phase 1-6 goal-mode loop finishes.

```text
You are Claude Code in adversarial review mode. Do not implement fixes. Inspect the repo and produce a findings-first review of the Phase 1-6 Recruiting Ops Automation Control Plane expansion.

Workspace:
~/work/ta-ops-analytics-automation-control-plane-phase1-6

Expected branch:
codex/recruiting-ops-automation-control-plane-phase1-6

First verify actual state:
- git status --short --branch
- git log --oneline --decorate -30
- git diff --stat 7c211f4..HEAD

Read first:
- docs/recruiting-ops/DOCS_SOURCE_OF_TRUTH.md
- docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_ROADMAP.md
- docs/recruiting-ops/AUTOMATION_CONTROL_PLANE_PHASE_1_6_PHASE_MANIFEST.md
- docs/recruiting-ops/BUILD_PROGRESS.md

Primary review question:
Did the implementation continue across as many safe Phase 1-6 gates as possible inside the non-production envelope, or did it stop prematurely, drift into stale architecture, or cross a hard stop gate?

Review each claimed phase:
- Phase 1: fixture/local shadow deliverable expansion.
- Phase 2: local run catalog.
- Phase 3: read-only control-plane UI.
- Phase 4: disabled/mock live-read adapter scaffolds.
- Phase 5: disabled production-delivery adapter interfaces/design.
- Phase 6: autonomy promotion workflows, trust windows, kill switches, and operator controls.

For every claimed phase, verify:
- implementation evidence exists,
- targeted tests exist and are behavioral,
- BUILD_PROGRESS.md records files changed, commands run, test results, residual blockers, and next gate,
- readiness remains separate from delivery authorization,
- no production writes, live Greenhouse writes, external network calls, external-channel delivery, broad PII persistence, production persistence migrations, scoped-MCP imports, or legacy retirement/cutover were introduced.

Run validation:
- npm run check:recruiting-ops
- npm run typecheck
- npm test
- git diff --check
- ./node_modules/.bin/next build --webpack if app/TSX changed in the reviewed range.

Output:
1. Verdict: approve, approve-with-fixes, or reject.
2. Findings first, ordered by severity, with file/line references.
3. Claimed phase-by-phase completion assessment.
4. Validation results.
5. Whether the long-form loop stopped at a real hard stop or prematurely.
6. Concise remediation plan, but do not implement fixes.
```
