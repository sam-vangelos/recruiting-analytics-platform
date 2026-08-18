# Employee Referral Master Sheet Runbook

Owner: TA Operations technical owner

Business owners: People Ops and Payroll

Production: GCP project `example-project`, Cloud Run service
`ta-ops-analytics`, region `us-central1`

The monthly workflow extracts the previous completed Los Angeles calendar
month from Greenhouse and upserts accepted Employee Referral offers into the
native master Google Sheet. It does not send email.

## Runtime configuration

The Cloud Run runtime service account is:

```text
ta-ops-analytics-run@example-project.iam.gserviceaccount.com
```

Share the exact master Sheet with that identity as Editor. Required runtime
configuration:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
GREENHOUSE_CLIENT_ID
GREENHOUSE_CLIENT_SECRET
RECOPS_PII_FINGERPRINT_SALT
EMPLOYEE_REFERRAL_MASTER_SPREADSHEET_ID
EMPLOYEE_REFERRAL_REPORT_SEND_ENABLED=false
EMPLOYEE_REFERRAL_REPORT_OPERATOR_MODE=false
EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE=https://ta-ops-analytics-abcdefghij-uc.a.run.app
EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT=ta-ops-ref-report-scheduler@example-project.iam.gserviceaccount.com
```

The Scheduler request must use a Google-signed OIDC token from the configured
service account with the canonical service URL as its audience. The job must
not contain a static `Authorization` header.

## Sheet contract

- Tabs are named `YYYY-MM` and are created only for months containing accepted
  referral offers.
- Offer month is based on Greenhouse accepted-offer `resolved_at` in
  `America/Los_Angeles`.
- Automated columns are refreshed on every run.
- Manual columns D:G are preserved.
- Rows are upserted by stable Greenhouse application/offer key.
- A retry cannot create a duplicate row.
- Historical rows absent from a later extraction are retained.
- Body rows remain plain, without alternating banding.
- Candidate/referrer data and report bodies must not appear in logs.

The initial historical sync is May and June 2026:

```sh
node employee-referral-report-operator-launcher.mjs \
  --sync-sheet \
  --period-start 2026-05-01 \
  --period-end 2026-07-01
```

Run the identical command twice during launch and verify the second run adds no
record keys and preserves D:G. The obsolete empty `2026-04` tab may be deleted
only after confirming it contains no data beyond its header.

## Release

1. Run focused tests, full tests, typecheck, architecture checks, changed-file
   lint, the production build, and `git diff --check`.
2. Merge the focused PR.
3. Build one Artifact Registry image from the resulting protected-main SHA and
   record its immutable digest.
4. Deploy that digest as a zero-traffic tagged Cloud Run revision with sending
   and operator mode false.
5. Verify unauthenticated and retired-static-bearer requests return 401.
6. Create a temporary zero-retry Cloud Run Job from the same digest, enable
   operator mode only there, and run the May–June sync twice.
7. Delete the temporary Job after the readback succeeds.

## Scheduler

Production job:

```text
name: employee-referral-monthly-report
schedule: 0 9 3 * *
time zone: America/Los_Angeles
route: GET /api/cron/employee-referral-report
OIDC service account: ta-ops-ref-report-scheduler@example-project.iam.gserviceaccount.com
audience: https://ta-ops-analytics-abcdefghij-uc.a.run.app
attempt deadline: 900s
retry count: 5
maximum retry duration: 7200s
```

Before resuming it, point the job at the immutable tagged revision and manually
execute it once while paused. Require HTTP 200 and a Sheet readback showing the
expected completed-month tab with unique record keys. Scheduler retries are
safe because the writer is idempotent.

The former `employee-referral-monthly-watchdog` monitors email delivery ledger
state and must remain paused for this Sheet-only workflow.

## Rollback

Pause `employee-referral-monthly-report`. Do not delete Sheet data or manual
decisions. Retarget the job to the retained prior revision only after its
behavior is understood; public Cloud Run traffic does not need to move.
