# Recruiting-ops spreadsheet productization operator runbook

> **2026-08-06 canonical cutover.** Per the operator's directive, the mutation registry
> now targets the 11 CANONICAL artifacts directly; the the operator-owned copies below
> are retired/denied. See
> `docs/recruiting-ops/delivery/p1/PREREQUISITES.md`
> (RECOPS-ELT-FACT-TABLE-BOUNDARY-v3) for the canonical target table and the
> new live posture. The rest of this runbook predates the cutover and is kept
> for the parts of the operational mechanics (alerts, kill switch, rollback
> shape) that are unchanged; read "registered copy" below as "canonical
> artifact" and "dark"/"dry_run" posture as superseded by the live posture in
> the boundary section immediately following.

This runbook operated the eleven registered the operator-owned copies pre-cutover. the operator
had updated the canonical files manually, so canonical content and permission
changes were explicitly outside that earlier rollout; canonical is now the
live mutation target. Greenhouse is read-only. Use the fixed artifact registry
and never pass a Google file ID on an operator command.

## Fixed resources and current boundary

```sh
PROJECT=example-project
REGION=us-central1
SERVICE=ta-ops-staging-hydrator
JOB=ta-ops-staging-hydration
SCHEDULER=recops-staging-orchestration-weekday
GCLOUD=gcloud
```

**Current live posture (post-2026-08-06 cutover):** the unified private
Scheduler `recops-staging-orchestration-weekday` is ENABLED and is the only
active hydration trigger. The 11 legacy per-artifact `recops-staging-*`
Schedulers are superseded and stay PAUSED. Public service and Scheduler
resources are unrelated to Google-file writes and remain unchanged.

The live Job contains all eleven artifact keys in `RECOPS_JOB_ARTIFACTS`,
`RECOPS_JOB_MODE=write`, `RECOPS_STAGING_HYDRATION_ENABLED=true`, every
artifact write flag is `true`, and the durable
`recruiting_ops_staging_hydration` stop is disengaged for scheduled runs.
Changing the allowlist alone cannot authorize a write.

## Final readiness verification

Run the checked-in preflight from a clean protected-main checkout:

```sh
node scripts/recruiting-ops-control-plane-preflight.mjs
```

Exit zero means the authenticated CLI account, protected-main provenance,
private service and Job digest, IAM, unchanged public boundary, complete
Scheduler inventory, latest execution fence, public-safe logs, live write
flags, full eleven-artifact allowlist, the unified scheduler ENABLED, and the
11 legacy per-artifact Schedulers PAUSED all match the reviewed live boundary.
The command is read-only and secret-safe.

The accepted private runtime is source
`1111111111111111111111111111111111111111` on immutable digest
`sha256:1111111111111111111111111111111111111111111111111111111111111111`.
The public service was not deployed or changed. The final registered-copy
canary and exact replay completed at execution fence 66; the latest execution
is `ta-ops-staging-hydration-aaaaa`.

After the control-plane preflight, verify the durable stop is engaged and
active run, attempt, and source counts are all zero. Canonical Drive metadata,
values, formulas, topology, and structure are read-only comparison fences. A
canonical difference is never repaired by this system.

## Alerts

The checked-in native Cloud Monitoring policies are installed and inbox
delivery is proven for a failed Job, a Scheduler non-2xx response, and a
Scheduler configuration change. Verify them read-only:

```sh
"$GCLOUD" monitoring policies list \
  --project "$PROJECT" \
  --format='table(name,displayName,enabled,notificationChannels)'
```

Do not recreate a policy that already exists and do not send messages to an
operations team on the operator's behalf.

## Registered-copy readiness evidence

All eleven fixed registered-copy paths have deterministic planning, guarded
mutation or certified no-op behavior, independent readback, rollback handling,
and replay/idempotency evidence. The cadence registry is:

| Artifact | Normal cadence |
|---|---|
| `all_hires` | Weekdays at 06:30 PT |
| `delivery_roles_rps` | Weekdays at 23:30 PT |
| `elt_doc` | Thursday and Friday at 06:30 PT |
| `weekly_recruitment` | Thursday at 06:30 PT |
| `weekly_progress` | Thursday at 06:30 PT |
| `pipeline_890` | Thursday at 06:30 PT |
| `pipeline_907` | Thursday at 06:30 PT |
| `pipeline_1026_1027` | Thursday at 06:30 PT |
| `pipeline_1118_1119` | Thursday at 06:30 PT |
| `final_offer` | Thursday at 06:30 PT |
| `rps_tracking` | Thursday at 06:30 PT |

Record the exact run, source, attempt, mutation, version, structure, and replay
evidence in the acceptance ledger. Canonical comparisons are read-only
reconciliation only; differences caused by the operator's manual canonical updates are
not copied back or treated as a request to mutate canonical content.

## Start recurring registered-copy updates later

No recurring Google-file updates are enabled by this closure. When the operator later
asks to start them:

1. Run the final readiness preflight, confirm no active durable work, engage the
   stop, and keep the unified Scheduler paused.
2. Update only the private Job to `RECOPS_JOB_MODE=write`, global enablement
   true, and the eleven fixed artifact flags true. Do not change the existing
   complete allowlist, image, identity, retry, timeout, or registry.
3. The checked-in preflight intentionally accepts only the dark posture.
   Before activation, merge a reviewed active-boundary update, then verify the
   changed Job against that boundary. Independently record the registered-copy
   and read-only canonical version fences.
4. Disengage the durable stop, then resume only
   `recops-staging-orchestration-weekday`. Do not resume any legacy private
   Scheduler.
5. Verify the first normal cycle, exact durable evidence, independent copy
   readback, canonical no-change fence, and idempotent replay. On any mismatch,
   use the rollback procedure below.

This is the only deferred activation action. It is deliberately not performed
while the operator is continuing to update the files manually.

## Superseded writer inventory and retirement

These eleven legacy private Schedulers are superseded and currently paused:

- `recops-staging-all-hires`
- `recops-staging-delivery-rps`
- `recops-staging-elt-doc`
- `recops-staging-final-offer`
- `recops-staging-pipeline-1026-1027`
- `recops-staging-pipeline-1118-1119`
- `recops-staging-pipeline-890`
- `recops-staging-pipeline-907`
- `recops-staging-rps-tracking`
- `recops-staging-weekly-progress`
- `recops-staging-weekly-recruitment`

After the operator authorizes recurring copy updates and one unified cycle succeeds,
export these exact definitions, delete only these eleven jobs, verify them
absent, and retain the export as the rollback source. Re-creation must restore
them paused.

The manual canonical writers
`weekly_recruitment_apps_script`, `role_pipeline_apps_script`,
`all_hires_apps_script`, and `recruiter_daily_apps_script` are not retired by this
rollout because canonical cutover was explicitly skipped. Public Schedulers are
not Google-file writers and remain untouched.

## Incident and rollback

1. Stop new writes first, in this order:

   ```sh
   node --env-file=.env.local node_modules/.bin/jiti scripts/recruiting-ops/staging-kill-switch-operator.ts --action=ENGAGED --operator="$OPERATOR" --reason="$REASON" --execute
   "$GCLOUD" scheduler jobs pause "$SCHEDULER" --project "$PROJECT" --location "$REGION"
   "$GCLOUD" run jobs update "$JOB" --project "$PROJECT" --region "$REGION" --update-env-vars=RECOPS_JOB_MODE=dry_run,RECOPS_STAGING_HYDRATION_ENABLED=false
   ```

2. Read the latest execution, public-safe logs, durable run/attempt evidence,
   and independent Drive versions. Do not run another write to diagnose.
3. For an artifact defect, keep its flag false but preserve the complete fixed
   `RECOPS_JOB_ARTIFACTS` registry. Re-enable unrelated artifacts only after a
   reviewed active-boundary update and the start sequence above.
4. Restore a registered-copy preimage only when the recorded version fence
   proves there was no human or concurrent edit. If ownership is ambiguous,
   leave the file untouched; never blind-restore a Drive version and never
   restore a canonical file.
5. Roll back code only for a confirmed code regression, using the previously
   recorded immutable digest and source SHA while the stop is engaged and the
   Scheduler is paused:

   ```sh
   "$GCLOUD" run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --image="$IMAGE@$LAST_GOOD_DIGEST" --update-labels=source-commit="$LAST_GOOD_SHA"
   "$GCLOUD" run jobs update "$JOB" --project "$PROJECT" --region "$REGION" --image="$IMAGE@$LAST_GOOD_DIGEST" --update-labels=source-commit="$LAST_GOOD_SHA"
   ```

6. Re-run final readiness verification before any resume. Canonical targets
   remain read-only throughout this system.

The rollback path has both failure and success evidence: the pre-fix ELT canary
restored its registered-copy preimage under an exact fence, and the final ELT
write plus replay proved postimage verification and idempotency. Code rollback
uses immutable digests; no rebuild is part of an incident rollback.
