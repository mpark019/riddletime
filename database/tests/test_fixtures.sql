-- A scratch table with no foreign keys or business-invariant triggers, used
-- only by web/src/lib/db.test.ts to exercise withTransaction's generic
-- commit/rollback/retry behavior without coupling it to the app schema.

create table if not exists public.test_scratch (
  id uuid primary key default gen_random_uuid(),
  label text not null
);
grant select, insert, delete on public.test_scratch to riddle_app;
