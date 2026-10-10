-- Advisory per-session activity log (leaving the game, returning, starting a guess); never affects scoring.
create table public.submission_activity (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  kind text not null check (kind in ('away', 'back', 'typing')),
  at timestamptz not null default clock_timestamp()
);
create index submission_activity_submission_idx on public.submission_activity(submission_id, at);

alter table public.submission_activity enable row level security;
revoke all on public.submission_activity from public, anon, authenticated, service_role, riddle_app;
grant select, insert on public.submission_activity to service_role, riddle_app;
create policy backend_access on public.submission_activity to riddle_app using (true) with check (true);
