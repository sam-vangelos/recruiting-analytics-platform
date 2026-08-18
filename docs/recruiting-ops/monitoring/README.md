# Cloud Monitoring alert policies

Checked-in Cloud Monitoring alert policies for the recruiting-ops control plane.
The JSON is the source of truth; applying it is a manual `gcloud` step so an alert
is never silently created or changed by a deploy.

| File | Fires when | Covers a gap that already bit |
|---|---|---|
| `recops-job-failed.json` | The hydration Cloud Run Job completes with a failed result | — |
| `recops-scheduler-non2xx.json` | The unified staging orchestration Scheduler gets a non-2xx | — |
| `recops-scheduler-mutated.json` | That Scheduler is paused, deleted, or updated | — |
| `recops-sweep-non2xx.json` | Any of `sweep-referral` / `sweep-agency` / `notify-drain` / `reconcile-identity` returns a non-2xx | **Yes** — the referral sweep failed on Greenhouse 401s for eleven days (11–16 Jun 2026) with no alert, because nothing watched the sweep lane and the dashboard read completed-only. |

The sweep routes return HTTP 500 on a thrown run (e.g. `app/api/cron/sweep-referral/route.ts` → `noStoreServerErrorJson`), so a Scheduler non-2xx is the native signal for a failed sweep — no log-based metric needed. This policy pairs with the in-app health banner (`lib/sweep-health.ts`), which makes the same failure visible to anyone looking at the tracker; the policy makes it visible to anyone who is not.

## Apply / update

Inventory first, then create if absent or update the existing policy by resource name — never blind-create a duplicate:

```sh
PROJECT=example-project
GCLOUD=gcloud

"$GCLOUD" monitoring policies list --project "$PROJECT" \
  --format='table(name,displayName,enabled)'

# create (only if no policy with this displayName exists):
"$GCLOUD" monitoring policies create --project "$PROJECT" \
  --policy-from-file=docs/recruiting-ops/monitoring/recops-sweep-non2xx.json

# or update an existing one:
# "$GCLOUD" monitoring policies update POLICY_RESOURCE_NAME \
#   --project "$PROJECT" --policy-from-file=docs/recruiting-ops/monitoring/recops-sweep-non2xx.json
```

The notification channel id is the same live email channel the other policies use
(`.../notificationChannels/7758655357028186974`). Confirm it still exists before
applying:

```sh
"$GCLOUD" beta monitoring channels list --project "$PROJECT" \
  --format='value(name,type,displayName)'
```
