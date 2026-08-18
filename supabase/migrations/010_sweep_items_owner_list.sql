-- 015 — the requisition's full recruiter list, on the HOURLY cadence.
--
-- WHY. Fan-out routes an alert to every recruiter on the requisition, and it read that
-- list from ytd_application_facts.recruiter_ids. That table is written by ytd-incremental, which
-- runs ONCE A DAY at 06:30 UTC. So a referral arriving after that had no owner list until the next
-- morning, and fan-out fell back to the head-of-TA. Measured 2026-08-07: of six unresolved alerts
-- raised that day, ONE had a facts row and five had none. The headline feature — alert the recruiter
-- within the hour — could not route precisely the alerts it exists to accelerate.
--
-- The referral sweep runs hourly and ALREADY fetches every owner row for every job in its batch
-- (sweep-referral.ts listJobOwners), then collapses that to a single primary recruiter and throws
-- the rest away. This column keeps the list, putting owner resolution on the same cadence as
-- detection. The enqueuer prefers this over the daily facts table.
--
-- Distinct from recruiter_id (005), which is the single elected primary and stays as-is: the
-- dashboard and the ownership-defect contract both depend on it.
--
-- bigint[] to match ytd_application_facts.recruiter_ids and greenhouse user ids. NULL means the
-- sweep that wrote the row predates this column — an honest "not known here", never an empty list,
-- so the enqueuer can tell "no owners" apart from "not recorded" and fall back rather than
-- concluding the requisition is unowned.

alter table sweep_items
  add column if not exists recruiter_ids bigint[];

comment on column sweep_items.recruiter_ids is
  'Every recruiter-type owner on the requisition at sweep time (Greenhouse user ids), for alert '
  'fan-out. NULL = not recorded by this sweep (pre-015 row); empty array = genuinely no recruiters '
  'on the hiring team. Written hourly, unlike ytd_application_facts.recruiter_ids which is daily.';

-- The enqueuer looks these up by application_id for the alerted batch, which is already the access
-- path loadLatestSweepItems uses (application_id + created_at desc), so no new index is needed.
