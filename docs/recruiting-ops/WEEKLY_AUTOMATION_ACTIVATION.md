# Turning the weekly automation on

Six steps, in this order. Each is a production change; the code they activate is on `main` once
PR #38 merges. Order matters at step 1 only — see the note there.

## 1. Apply migration 030

`supabase/migrations/030_recruiting_ops_lease_heartbeat.sql`, in the Supabase SQL editor for
project `exampleanalyticsref0`. It adds two functions and grants them to `service_role`; it
creates no tables and alters no data.

Do this before step 4. The orchestrator claims a 600-second lease and renews it through these
functions, so an image that ships first would be renewing against something that does not exist.
It handles that — it re-claims the old 3600-second window and logs `liveness heartbeat
unavailable` — but the ten-minute crash recovery does not exist until the migration lands.

Confirm both functions are present before moving on:

```sql
select proname from pg_proc
where proname like 'heartbeat_recruiting_ops%';
```

## 2. Give the job and the service a Slack token

The alerts post as the existing bot. The secret is already in Secret Manager as
`slack-bot-token`; both the job and the service need it, because the run report comes from the
job and the missing-run alert comes from the service.

**Grant access first.** Both resources run as
`ta-ops-hydrator-run@example-project.iam.gserviceaccount.com`, but `slack-bot-token` currently
grants `secretAccessor` only to `ta-ops-analytics-run@` — a different account. Mounting the
secret without this grant fails when the container starts, not when the command runs, so the
error surfaces late and looks like a deploy problem:

```sh
gcloud secrets add-iam-policy-binding slack-bot-token \
  --project example-project \
  --member "serviceAccount:ta-ops-hydrator-run@example-project.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor
```

`cron-secret` has the same gap, so the same grant is needed if the operator curl in the runbook
is to work.

```sh
gcloud run jobs update ta-ops-staging-hydration \
  --region us-central1 --project example-project \
  --update-secrets SLACK_BOT_TOKEN=slack-bot-token:latest

gcloud run services update ta-ops-staging-hydrator \
  --region us-central1 --project example-project \
  --update-secrets SLACK_BOT_TOKEN=slack-bot-token:latest
```

## 3. Give a Thursday batch room to finish

```sh
gcloud run jobs update ta-ops-staging-hydration \
  --region us-central1 --project example-project \
  --task-timeout=3h
```

## 4. Deploy the image to both the job and the service

Build with Cloud Build, not local Docker — Cloudflare WARP intercepts TLS and a local build
fails:

```sh
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/example-project/recruiting/ta-ops-staging-hydrator:<sha> \
  --project example-project
```

Then deploy that exact tag to both resources, stamping the source commit on each:

```sh
gcloud run jobs update ta-ops-staging-hydration \
  --region us-central1 --project example-project \
  --image us-central1-docker.pkg.dev/example-project/recruiting/ta-ops-staging-hydrator:<sha> \
  --update-labels source-commit=<sha>

gcloud run services update ta-ops-staging-hydrator \
  --region us-central1 --project example-project \
  --image us-central1-docker.pkg.dev/example-project/recruiting/ta-ops-staging-hydrator:<sha> \
  --update-labels source-commit=<sha>
```

The label is what makes a divergence visible. On 2026-08-07 the job ran image `280ab88` while
its label still read `0250b13`, and the commit behind that image was on no remote branch at all.
Record the immutable digest at the same time — the incident runbook rolls back by digest and
never rebuilds.

The service carries the watchdog route; the job carries the orchestration and its run report, so
both need the same image.

## 5. Create the watchdog schedule, paused

08:30 Pacific each weekday, which is two hours after the morning slot and covers the previous
evening's slot in the same call. It mirrors the orchestration scheduler's identity exactly.

**Create it paused.** With the orchestration schedule off, no run is ever claimed, so every due
slot looks missed and the watchdog would alert every weekday morning — correctly, and uselessly.
It gets resumed in step 6 alongside the schedule it watches.

```sh
gcloud scheduler jobs create http recops-staging-hydration-watchdog \
  --location us-central1 --project example-project \
  --schedule "30 8 * * 1-5" \
  --time-zone "America/Los_Angeles" \
  --http-method GET \
  --uri "https://ta-ops-staging-hydrator-000000000000.us-central1.run.app/api/cron/recruiting-ops-staging-hydration-watchdog" \
  --oidc-service-account-email "ta-ops-hydration-scheduler@example-project.iam.gserviceaccount.com" \
  --oidc-token-audience "https://ta-ops-staging-hydrator-000000000000.us-central1.run.app" \
  --attempt-deadline 60s \
  --max-retry-attempts 1

gcloud scheduler jobs pause recops-staging-hydration-watchdog \
  --location us-central1 --project example-project
```

`--max-retry-attempts 1` matters. The route answers 503 when a run is missing, so the Scheduler's
own failure count records the miss independently of Slack — but the default retry policy has no
duration limit, and every retry would send another identical message about a state that cannot
change in seconds. One attempt keeps the second signal and drops the noise.

The route accepts a scheduler call only from a job with this exact name, so the name above is not
cosmetic.

## 6. Resume both schedules — only once all eleven artifacts pass

the operator's call, 2026-08-07: the schedule waits until every artifact writes cleanly rather than going
live with known failures. The canonical-writes session set the same bar independently — *"do not
enable the schedule until a full clean run happens."* A Thursday that reports four failures every
week trains everyone to ignore the message.

Check the current state before resuming, reading the ledger rather than trusting memory.
The run's mode has to come with it: a dry run and a verified-identical write both record
`no_change` on the artifact row, so without the join a dry run passes this gate. On
2026-08-07 Weekly Recruitment read `no_change` from a dry run while its last real write had
failed, which is exactly the case this join catches:

```sql
select distinct on (a.artifact_key)
       a.artifact_key, r.mode, a.outcome, a.failure_code, a.failure_stage, a.completed_at
from recruiting_ops_hydration_artifact_attempts a
join recruiting_ops_hydration_runs r on r.run_id = a.run_id
order by a.artifact_key, a.completed_at desc;
```

All eleven should read `written` or `no_change` **with `mode = write`**. An artifact whose
newest row is a dry run has not been proven; re-run it for real before resuming.

Two of these outcomes deserve a second look rather than a tick:

- `no_change` on All Hires means the projection found nothing to place, which it also
  reports when a hire sits on a requisition the display map has no entry for. Read
  `public_summary` for the unmapped count before believing it.
- A dry run cannot exercise the write path at all for the recurring-sheet artifacts: the
  weekly row lifecycle's post-verification is unreachable in dry-run mode, and a dated tab
  that does not exist yet sends the run down the projected branch. A clean dry run is not
  evidence that a write will succeed.

Then:

```sh
gcloud scheduler jobs resume recops-staging-hydration-watchdog \
  --location us-central1 --project example-project

gcloud scheduler jobs resume recops-staging-orchestration-weekday \
  --location us-central1 --project example-project
```

`30 6,23 * * 1-5` Pacific stays as it is. The cadence resolver decides what is actually due:
Thursday morning carries all ten weekday-morning artifacts, the other four mornings carry All
Hires alone, and every weekday evening carries Delivery Roles RPS. The ten per-artifact schedulers
stay paused — they are superseded by this one.

## Then watch one real Thursday

Nothing above proves the reports maintain themselves. Four things need one observed scheduled run:
the job fires on its own, all eleven artifacts land or a message names the ones that did not, a
mid-flight death recovers by itself, and a run that never starts still reaches you.

After the first Thursday morning slot, three things should agree:

```sh
gcloud run jobs executions list --job ta-ops-staging-hydration \
  --region us-central1 --project example-project --limit 3
```

```sql
select business_date, mode, status, outcome, claim_count, public_summary
from recruiting_ops_hydration_runs
order by created_at desc limit 3;
```

And a Slack DM naming what landed. If the DM arrived and the run row says `succeeded`, the cycle
is genuinely unattended. If the DM never arrived and the run row exists, the Slack token or the
recipient is wrong. If neither arrived, the 08:30 watchdog will say so on its own.
