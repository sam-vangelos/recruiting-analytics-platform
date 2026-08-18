# Employee Referral Master Sheet — Production Contract

## Definition of done

- The native master Sheet contains May and June 2026 tabs and no empty April
  tab.
- The same-image historical sync can run twice without duplicate rows or
  overwriting manual columns D:G.
- The OIDC-protected cron route updates the previous completed month without
  loading email configuration or delivery state.
- `employee-referral-monthly-report` runs at 09:00 on day 3 in
  `America/Los_Angeles`.
- The August 3 run creates or updates `2026-07`.
- Public Cloud Run traffic remains unchanged.

## Report contract

- “Accepted” means a current accepted offer whose `resolved_at` falls within
  the half-open local-month interval `[month start, next month start)`.
- Referral attribution uses the governed Greenhouse Employee Referral source.
- Each row includes the candidate, planned start date, referring employee,
  hiring manager, function, country, reference bonus, currency, preliminary
  eligibility, reason, and estimated 90-day date.
- Unknown policy mappings remain visible for People Ops review.
- Automated fields refresh on rerun; manual decisions and payout tracking in
  D:G remain authoritative.
- Empty months do not receive tabs and historical rows are not automatically
  deleted.

## Production activation

1. Merge the focused change and build an immutable image from protected main.
2. Grant the runtime service account Editor access to the exact Sheet.
3. Dark-deploy the image with email sending disabled.
4. Run `--sync-sheet --period-start 2026-05-01 --period-end 2026-07-01`
   twice from a temporary Job built from the same digest.
5. Verify May and June, unique record keys, preserved manual columns, plain
   formatting, and no April tab.
6. Point the monthly Scheduler at the immutable revision tag and preserve its
   OIDC identity, audience, schedule, timezone, and retries.
7. Manually execute the paused Scheduler once and verify HTTP 200 plus the
   expected Sheet readback.
8. Pause the obsolete email-ledger watchdog and resume the monthly job.
9. After August 3 at 09:00, verify the `2026-07` tab and unique record keys.

## Rollback

Pause the monthly Scheduler and preserve the Sheet. Public service traffic and
the historical Sheet ledger do not need to move.
