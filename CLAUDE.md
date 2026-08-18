@AGENTS.md

# CLAUDE.md

Working notes for agents and new contributors. The README is the engineering
overview; this file is the mechanics. `AGENTS.md` (imported above) carries the
Next.js version warning — read the vendored docs before writing framework code.

## Commands

```bash
npm run dev          # Dev server on localhost:3000
npm run build        # Production build (CI builds with --webpack)
npm run typecheck    # tsc --noEmit; globs test/red too
npm test             # Vitest green board (excludes test/red)
npm run test:red     # Quarantined red specs — must FAIL by assertion when non-empty
npm run test:mutation                     # Seeded mutations must all be caught
npm run check:recruiting-ops-architecture # AST rule engine over the real repo
```

All of the credential-free tier runs on a fresh clone with no environment
configured. Suites that need credentials or a database skip or are excluded by
design. The boundary suites derive their file set from `git ls-files`, so they
require a git working tree — run them from a checkout, never a tarball.

## Environment

Copy `.env.example` to `.env.local`. Supabase (URL + service-role key),
Greenhouse (OAuth2 client credentials), Slack bot token, and a Google
service-account key cover the live paths. Additional knobs:
`EMPLOYEE_REFERRAL_CORPORATE_EMAIL_DOMAIN`, `SWEEP_HEAD_OF_TA_SLACK_ID`,
`SWEEP_RECRUITING_OPS_ALERT_SLACK_ID`, and the dormant-by-default capability
flags (`RECOPS_SHADOW_ENABLED`, `RECOPS_EXEC_ENABLED`).

## Layout and boundaries

- `app/` — five dashboard routes plus ~30 HTTP handlers. **Never holds
  business logic**; handlers parse, authorize, and delegate to `lib/`.
- `lib/` — the domain: sweeps, YTD facts, identity resolution, notification
  outbox, Greenhouse client.
- `lib/recruiting-ops/` — the control plane: capability registry, module
  definitions (`modules/`), governed dimensions (`dimensions/config/`), and
  the delivery pipeline (`delivery/`) that writes to Google Workspace under
  structural write permits.
- `supabase/migrations/` — 26 hand-written SQL migrations, applied in
  filename order; headers argue the schema decisions.
- `scripts/` — the architecture checker, control-plane preflight, and
  operational CLIs (`scripts/recruiting-ops/`).
- `test/` — Vitest suites, boundary suites, fixtures; `test/red/` is the
  quarantined backlog (empty = goal state, and CI enforces its semantics).
- `docs/recruiting-ops/` — specs, runbooks, and `monitoring/` alert policies
  checked in beside the outage narratives they close.

The architecture checker enforces the boundaries above (and more) at the AST
level; its behavioral suite mutates a scratch repo to prove each rule fires.
If a change trips a rule, the rule is telling you where the code belongs —
change the design, not the checker, unless the rule itself is the defect.

## Conventions that bite

- **Write permits are not optional.** Anything that mutates a Google
  Workspace artifact goes through the delivery pipeline's permit path —
  fingerprinted source cut, HMAC grant, revision pin. No direct `googleapis`
  writes outside `lib/recruiting-ops/delivery/`.
- **Scheduled routes verify identity twice**: the OIDC token's
  service-account against a pinned constant, and the environment's declared
  value against the same constant. Cloud Scheduler sends the SHORT job id in
  `X-CloudScheduler-JobName` — compare with `schedulerJobNameMatches`, which
  accepts both forms, because comparing against the full resource path once
  rejected the scheduler's only lifetime fire.
- **Unresolved beats misresolved.** Identity resolution and the roster
  dimension return explicit `unresolved` defects rather than sentinel
  buckets; surfaces render those honestly (no `Unknown` placeholders — the
  DataTable contract forbids them).
- **Public output is redaction-checked.** Anything rendered outside the
  operator surface passes `safe-public-output` and its word-level
  vocabulary drift-lock; person names may appear only via exact canonical
  phrases.
- **Fixture data is synthetic.** Rosters, Drive ids, Slack ids, and personas
  in this repository are shaped placeholders; keep new fixtures synthetic
  and shaped like the real thing so permit and parity paths still exercise.
