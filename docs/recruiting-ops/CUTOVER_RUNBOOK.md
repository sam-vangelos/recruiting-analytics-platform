# Vercel → Cloud Run cutover runbook

The five-minute sitting that moves the scheduled workloads off Vercel and onto
the GCP substrate. Ordered to neutralize the one real hazard: `notify-drain`
must never run from both substrates at once (double-sent Slack notifications).
Sweeps tolerate a gap; the outbox pattern means a drain gap only *delays*
notifications, never loses them.

## Preflight facts (verified 2026-07-07)

- **Vercel production is NOT frozen at the June state.** A CLI deploy went out
  2026-07-06 14:26 PDT (`dpl_B9fPCdrC2MAhaVqoPPvt6wGz4qhJ`, no git ref —
  deployed from a working tree, pre-E01). Its crons are ACTIVE: `sweep_runs`
  shows an 18:00 UTC 2026-07-07 run. The double-drain hazard is real, not
  theoretical.
- **Cloud Run `ta-ops-analytics` (us-central1) is live and fully provisioned:**
  all 7 secrets incl. `SLACK_BOT_TOKEN` (notify-drain will send), all 5 legacy
  cron routes present and failing closed (401 bare), `/state-of-play` rendering
  the E01 snapshot behind Basic auth (verified 200 with the stored pair).
- **Six Scheduler jobs exist, all PAUSED** (sweep-referral hourly, sweep-agency
  4h, ytd-incremental 06:30Z, reconcile-identity 06:00Z, notify-drain :15,
  recruiting-ops-exec :45).
- **Vercel REST API token on this machine is dead** (`invalidToken`); the
  Vercel **CLI is authenticated** (`vercel whoami` → jordan-rivera). All Vercel
  steps below use the CLI.

## Step 1 — stop Vercel's crons

Preferred (zero-deploy, if available): Vercel dashboard → `ta-ops-analytics` →
Settings → Cron Jobs → **Disable**. Takes effect immediately; skip to Step 2.

CLI fallback (redeploy the same tree minus crons):

```bash
cd ~/work/ta-ops-analytics
cp vercel.json vercel.json.cutover-bak
python3 - <<'EOF'
import json
p = json.load(open("vercel.json"))
p.pop("crons", None)
json.dump(p, open("vercel.json", "w"), indent=2)
print("crons stripped")
EOF
vercel deploy --prod
```

Caution: this deploys the sibling working tree. It is very likely the same
tree behind the 2026-07-06 prod deploy (same directory, CLI deploys only),
so the delta is crons-only — but eyeball `git status` there first; stash
anything unexpected.

## Step 2 — verify Vercel stopped (one clean hour)

Wait past the next top of the hour, then confirm no new sweep run arrived:

```bash
cd ~/work/ta-ops-analytics
supabase db query --linked "select max(started_at) as latest_sweep, now() from sweep_runs"
```

`latest_sweep` must be BEFORE the strip. If a new row appears, Vercel is still
firing — stop and investigate before resuming anything on GCP.

## Step 3 — resume the five legacy jobs on GCP

```bash
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
for j in sweep-referral sweep-agency ytd-incremental reconcile-identity notify-drain; do
  gcloud scheduler jobs resume "$j" --project example-project --location us-central1
done
gcloud scheduler jobs list --project example-project --location us-central1 --format="value(ID,STATE)"
```

Leave `recruiting-ops-exec` PAUSED — that resume plus
`RECOPS_EXEC_ENABLED=true` on the service is the separate E01 flip, on its own
schedule.

## Step 4 — post-checks (next hour)

```bash
# a new sweep run wrote, from GCP this time
cd ~/work/ta-ops-analytics
supabase db query --linked "select max(started_at) from sweep_runs"

# scheduler executions succeeded
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
gcloud scheduler jobs describe sweep-referral --project example-project --location us-central1 \
  --format="value(status.lastAttemptTime,state)"

# no double-send: notification_delivery_attempts shows single attempts per intent
supabase db query --linked "select count(*) from notification_delivery_attempts where attempted_at > now() - interval '2 hours'"
```

## Rollback

```bash
# stop GCP
for j in sweep-referral sweep-agency ytd-incremental reconcile-identity notify-drain; do
  gcloud scheduler jobs pause "$j" --project example-project --location us-central1
done
# restore Vercel crons
cd ~/work/ta-ops-analytics
mv vercel.json.cutover-bak vercel.json && vercel deploy --prod
```

## After N clean days (separate decision)

Decommission the Vercel project entirely (it still serves the auth-walled YTD
tracker at the old URL; Cloud Run serves everything). Render follows after the
MCP second wave.
