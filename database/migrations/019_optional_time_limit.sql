begin;

-- A null limit means the game never expires; expiry queries already treat null as "not overdue".
alter table public.challenges alter column time_limit_seconds drop not null;
alter table public.challenges drop constraint challenges_time_limit_seconds_check;
alter table public.challenges add constraint challenges_time_limit_seconds_check
  check (time_limit_seconds is null or time_limit_seconds > 0);

commit;
