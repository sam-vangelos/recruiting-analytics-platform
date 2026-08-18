-- 020 — Run-integrity columns from the C2 boundary lens.
--
-- children_checksum: the parent-row checksums (input/normalized) do not cover
-- source gaps or discrepancies, so a same-runId re-persist whose gap or
-- discrepancy CONTENT differed could silently coalesce as "already persisted".
-- The writer now stores a checksum over the child rows and requires it to
-- match; nullable so pre-020 rows verify by child-row counts alone.
--
-- legacy_artifact_refs: the in-memory run object tracks which legacy artifacts
-- a run was diffed against, but no column existed — the audit lineage died at
-- persistence.
--
-- Wrapped in an explicit transaction so constraint/column changes are atomic
-- regardless of the apply tool's default wrapping (lens finding on 018's
-- unwrapped drop+add).

begin;

alter table recruiting_ops_runs
  add column if not exists children_checksum text,
  add column if not exists legacy_artifact_refs text[] not null default '{}';

commit;
