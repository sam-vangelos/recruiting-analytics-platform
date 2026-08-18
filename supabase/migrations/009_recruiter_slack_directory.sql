-- 009 — recruiter_id -> slack_id directory (P3). The durable map the drain reads to route an
-- alert DM to the owning recruiter instead of the head-of-TA. Keyed on greenhouse_user_id (a
-- PERSON), NOT job_id — a recruiter is a person, and greenhouse_job_ownership (job-keyed, empty
-- in prod) is the wrong grain.
--
-- Populated daily by the reconcile-identity cron (refreshRecruiterSlackDirectory) behind the
-- NOTIFY_SLACK_RESOLVER_ENABLED gate: GH /users -> primary_email -> Slack users.lookupByEmail.
-- resolution_status carries WHY a row has no slack id (an honest defect, never a fabricated id):
--   resolved       — slack_user_id is a real Slack id
--   email_missing   — GH user has no primary_email to look up
--   slack_not_found — lookupByEmail returned users_not_found (no Slack account for that email)
--   scope_blocked   — the bot token lacks users:read.email (add the scope + reinstall)
--   deactivated     — reserved for a later departed-recruiter sweep

create table if not exists recruiter_slack_directory (
  greenhouse_user_id bigint primary key,
  primary_email text,
  slack_user_id text,
  resolution_status text not null default 'unresolved'
    check (resolution_status in
      ('resolved','unresolved','email_missing','slack_not_found','scope_blocked','deactivated')),
  evidence_detail jsonb,
  first_seen_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now()
);

-- The drain looks up many recruiter ids per tick by primary key, so no extra index is needed;
-- the health endpoint scans by status (small table, a few dozen rows) without one too.
