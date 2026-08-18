-- 025 — Finish adoption of the orphaned source-execution diagnostics shape.
--
-- The unmanaged table constrained public_diagnostics to a JSON array. New
-- source claims use a JSON object, while the one retained proof row must stay
-- byte-for-byte intact. Accept both PII-free shapes and reject every other
-- JSON type.

begin;

alter table public.recruiting_ops_source_executions
  drop constraint if exists recruiting_ops_source_executions_public_diagnostics_check,
  drop constraint if exists recruiting_ops_source_executions_public_diagnostics_shape_check,
  add constraint recruiting_ops_source_executions_public_diagnostics_shape_check
    check (jsonb_typeof(public_diagnostics) in ('object', 'array'));

commit;
