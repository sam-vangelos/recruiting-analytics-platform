-- 007_advisory_lock_functions.sql — W2 follow-up (NOT auto-applied; run via `supabase db push`
-- after review, alongside 005/006).
--
-- Ships the session-scoped advisory-lock RPCs that lib/sweep-agency.ts calls for the C6
-- concurrent-run guard: try_advisory_lock (sweep-agency.ts:130-133) and advisory_unlock
-- (:142-145). Without these functions runAgencySweep THROWS at the lock gate — the untyped
-- supabase client (lib/supabase.ts) hid the missing RPC from tsc, so the W2 build compiled and
-- tested green while being run-fatal in production. Param names (p_namespace, p_key) and arg
-- types (int4) match the supabase.rpc(..., { p_namespace, p_key }) calls exactly.
--
-- POOLING CAVEAT (follow-up, not blocking the un-break): these are SESSION-scoped
-- (pg_try_advisory_lock), so the lock lives only as long as the backend connection. Under
-- Supabase's transaction-mode pooler a later query in the same logical run may land on a
-- different backend and the lock/unlock would not pair, making the guard unreliable. Safer
-- long-term: switch the caller to pg_try_advisory_xact_lock (auto-released at transaction end,
-- pooler-safe) and drop advisory_unlock. Tracked in the W2 review follow-ups.

create or replace function try_advisory_lock(p_namespace int, p_key int)
returns boolean
language sql
as $$
  select pg_try_advisory_lock(p_namespace, p_key)
$$;

create or replace function advisory_unlock(p_namespace int, p_key int)
returns boolean
language sql
as $$
  select pg_advisory_unlock(p_namespace, p_key)
$$;
