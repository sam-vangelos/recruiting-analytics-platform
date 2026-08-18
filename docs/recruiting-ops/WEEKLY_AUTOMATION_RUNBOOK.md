# Weekly automation runbook

The eleven canonical recruiting artifacts maintain themselves from one Cloud Run job,
`ta-ops-staging-hydration` in `example-project` / `us-central1`. Cloud Scheduler calls the
`ta-ops-staging-hydrator` service, which launches the job with the scheduled instant in
`RECOPS_SCHEDULED_AT`; the cadence resolver decides from that instant alone which artifacts are
due. This page covers what to do when a cycle goes wrong.

## What runs when

`recops-staging-orchestration-weekday` fires at 06:30 and 23:30 Pacific, Monday through Friday.
The resolver then intersects the lane with each artifact's cadence:

| Slot | Artifacts |
| --- | --- |
| Thursday 06:30 | All ten weekday-morning artifacts — the ELT doc, Weekly Recruitment, Weekly Progress, All Hires, the four pipeline sheets, Final Offer, RPS Tracking |
| Monday–Wednesday and Friday 06:30 | All Hires only |
| Every weekday 23:30 | Delivery Roles RPS |

The ten per-artifact schedulers (`recops-staging-elt-doc`, `recops-staging-weekly-progress`, and
the rest) are superseded by that one trigger and stay paused.

## What arrives in Slack

Every run sends one direct message when it finishes, whatever the outcome, so silence means the
job did not run rather than that it ran cleanly. The first line separates the three cases —
all reports landed, some landed and some did not, or none did — and a partial or failed run then
names each report that did not update, with the ledger's failure code and what it means.

A separate check runs at 08:30 Pacific each weekday and asks the one question a run cannot ask
about itself: did the slots that were due actually produce a run at all? It covers this morning's
slot and the previous evening's. When one is missing — the scheduler never fired, the launch call
failed, or the job never started — it sends its own message and answers 503, so Cloud Scheduler's
failure count records the same fact independently of Slack.

Both messages carry artifact names, failure codes, and the run's own identifiers. Neither carries
a candidate, recruiter, or requisition.

You can ask the check yourself at any time, by triggering its schedule rather than calling the
URL. The hydrator service is `ingress: internal`, so a request from a laptop gets Google's own
404 and never reaches the app — the only callers that can reach it are Google-internal ones like
Cloud Scheduler.

```sh
gcloud scheduler jobs run recops-staging-hydration-watchdog \
  --location us-central1 --project example-project

gcloud logging read \
  'resource.labels.service_name="ta-ops-staging-hydrator" AND textPayload:"watchdog"' \
  --project example-project --limit 1 --format="value(textPayload)" --freshness=10m
```

A paused job refuses to run on demand, so resume it, run it, and pause it again if the schedule
is not live yet.

## Re-running a cycle

A run that ended `partial`, `failed`, or `timed_out` **resumes on its own**: the next execution
reclaims the same run and retries only the artifacts that never certified. Executing the job
again is enough, and no nonce is involved.

Two situations need a genuinely new run instead:

- The cycle ended `succeeded` or `no_change` but the numbers are wrong. A terminal success
  replays its stored outcome and will not do any work again.
- The run's stored source snapshot can no longer be replayed. Its durable summary reads
  `failure_code: source_replay_rejected`, which means the snapshot was written by an image whose
  payload contract this build no longer accepts. Retrying can only re-read the same snapshot.

Both are the same command — the same scheduled slot, plus a nonce that mints a fresh run and a
fresh Greenhouse cut:

```sh
gcloud run jobs execute ta-ops-staging-hydration \
  --region us-central1 --project example-project --async \
  --update-env-vars \
RECOPS_SCHEDULED_AT=2026-08-13T13:30:00.000Z,RECOPS_HYDRATION_RUN_NONCE=rerun-20260813-01
```

**`--async`, never `--wait`.** Interrupting a `--wait` sends a cancel to the execution it is
watching, which killed a live write on 2026-08-06. Launch detached and watch it separately:

```sh
gcloud run jobs executions list --job ta-ops-staging-hydration \
  --region us-central1 --project example-project --limit 3
```

`RECOPS_SCHEDULED_AT` is the Pacific slot expressed in UTC — 06:30 Pacific is `13:30:00.000Z`
under daylight time and `14:30:00.000Z` under standard time. The resolver rejects any instant
that is not 06:30 or 23:30 Pacific on a weekday, so a typo fails immediately rather than writing
the wrong week.

The nonce must be 8 to 80 characters of letters, digits, underscores, or hyphens. Use a fresh one
each time — reusing a nonce reuses its run, which replays rather than re-runs. Dating it
(`rerun-20260813-01`) keeps that automatic.

`--update-env-vars` on `jobs execute` overrides only that one execution. Setting either variable
on the job itself with `gcloud run jobs update` would apply it to every scheduled cycle, which is
never what a re-run wants.

## When a run will not start

Every claim is refused while another run holds an unexpired lease, and the response reads
`overlap_in_progress`. Since the lease-heartbeat change a lease is renewed every 60 seconds by the live process and
expires 600 seconds after the last renewal, so a container that died releases its claim within
ten minutes and the next execution takes over by itself. Waiting is the correct response; there
is nothing to release by hand.

If `overlap_in_progress` persists for more than ten minutes, a live process really is holding the
lease. Confirm before doing anything else:

```sh
gcloud run jobs executions list --job ta-ops-staging-hydration \
  --region us-central1 --project example-project --limit 5
```

## Reading a failed run

Per-artifact outcomes live in `recruiting_ops_hydration_artifact_attempts`, one row per attempt,
carrying `failure_code` and `failure_stage`. The run-level summary in
`recruiting_ops_hydration_runs.public_summary` names the run-level cause:

| `failure_code` | What happened | What to do |
| --- | --- | --- |
| `execution_failed` | An artifact or the source load raised | Re-execute; the run resumes |
| `source_replay_rejected` | The bound snapshot predates this image's payload contract | Re-run with a fresh nonce |
| `hydration_lease_lost` | A successor took the lease; this process stood down | Nothing — the successor owns the cycle |
| `hydration_run_lease_expired` | A claim retired a dead run's lease | Nothing — recovery already happened |

## Deploy order

The orchestrator claims a 600-second lease and renews it through
`heartbeat_recruiting_ops_hydration_run` and `heartbeat_recruiting_ops_source_execution`
(migration 030). Apply that migration before shipping an image that depends on it. If the
functions are missing the orchestrator falls back to the 3600-second pre-heartbeat window and
logs `liveness heartbeat unavailable`, so a wrong-order deploy degrades to the old behavior
rather than failing every run — but the ten-minute recovery is gone until the migration lands.
