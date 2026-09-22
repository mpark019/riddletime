-- ============================================
-- RiddleTime Initial Database Schema
-- ============================================

begin;

-- Runtime login: Provision its password separately; never connect the app as postgres.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'riddle_app') then
    create role riddle_app login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  -- Roles are cluster-wide. Reuse only the expected restricted login, never silently alter it.
  if exists (select 1 from pg_roles where rolname = 'riddle_app' and
      (not rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
     or exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.member
       where r.rolname = 'riddle_app') then
    raise exception 'riddle_app must be a restricted LOGIN NOINHERIT role with no role memberships'
      using errcode = '23514';
  end if;
end;
$$;

-- Future objects: Run every migration as this same owner (postgres in Supabase).
-- Revoke both global and schema-scoped defaults; schema revokes cannot undo global grants.
-- Global revokes affect this owner's future objects in every schema in this database.
alter default privileges revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema public revoke all on tables from public, anon, authenticated, service_role;
alter default privileges revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated, service_role;

-- Profiles: Application identity for Supabase Auth users
create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (length(btrim(display_name)) > 0),
  -- Application role: server-managed; only players participate in scored games.
  role text not null default 'spectator' check (role in ('spectator', 'player', 'admin')),
  avatar_url text check (avatar_url is null or avatar_url ~ '^https://[^/[:space:]]+[^[:space:]]*$'),
  created_at timestamptz not null default now()
);

-- Invitations: Durable onboarding intent, saved before contacting the email provider
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(btrim(email)) and length(email) > 0),
  display_name text not null check (length(btrim(display_name)) > 0),
  role text not null check (role in ('spectator', 'player', 'admin')),
  opening_amount integer,
  invited_by uuid not null references public.profiles(id) on delete restrict,
  auth_user_id uuid references auth.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'cancelled')),
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'sent', 'failed')),
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  constraint invitations_opening_amount check (
    (role = 'player' and opening_amount is not null and opening_amount >= 0)
    or (role <> 'player' and opening_amount is null)
  ),
  constraint invitations_lifecycle check (
    (status = 'pending' and accepted_at is null and cancelled_at is null)
    or (status = 'accepted' and auth_user_id is not null and accepted_at is not null and cancelled_at is null)
    or (status = 'cancelled' and cancelled_at is not null and accepted_at is null)
  ),
  constraint invitations_delivery check (delivery_status <> 'sent' or last_sent_at is not null),
  constraint invitations_timestamp_order check (
    accepted_at >= created_at and cancelled_at >= created_at and last_sent_at >= created_at
  )
);
create unique index invitations_one_pending_email on public.invitations(email) where status = 'pending';
create unique index invitations_one_pending_account on public.invitations(auth_user_id)
  where status = 'pending' and auth_user_id is not null;
create index invitations_invited_by_idx on public.invitations(invited_by);
create index invitations_auth_user_id_idx on public.invitations(auth_user_id);

-- Daily challenges: One schedule per date, with shared or personal puzzles
create table public.daily_challenges (
  id uuid primary key default gen_random_uuid(),
  active_date date not null unique,
  mode text not null check (mode in ('shared', 'personal')),
  allowed_types text[] not null check (
    cardinality(allowed_types) > 0 and array_ndims(allowed_types) = 1
    and array_position(allowed_types, null) is null
    and allowed_types <@ array['riddle', 'character_puzzle']::text[]
  ),
  difficulty_selection text not null
    check (difficulty_selection in ('fixed', 'random_daily', 'random_player')),
  difficulty_presets jsonb not null check (jsonb_typeof(difficulty_presets) = 'object' and difficulty_presets <> '{}'::jsonb),
  selected_difficulty text,
  generation_prompt text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  notification_status text not null default 'disabled'
    check (notification_status in ('disabled', 'pending', 'sent', 'failed')),
  sent_at timestamptz,
  constraint daily_challenges_sent_timestamp check (notification_status <> 'sent' or sent_at is not null),
  constraint daily_challenges_random_mode check (difficulty_selection <> 'random_player' or mode = 'personal'),
  constraint daily_challenges_selected_difficulty check (
    (difficulty_selection = 'random_player' and selected_difficulty is null)
    or (difficulty_selection <> 'random_player' and selected_difficulty is not null
      and difficulty_presets ? selected_difficulty)
  ),
  unique (id, mode)
);
create index daily_challenges_created_by_idx on public.daily_challenges(created_by);

-- Challenges: Saved puzzle content and resolved settings; never rerolled on refresh
create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  daily_challenge_id uuid not null,
  mode text not null,
  type text not null check (type in ('riddle', 'character_puzzle')),
  assigned_to uuid references public.profiles(id) on delete restrict,
  difficulty text not null check (length(btrim(difficulty)) > 0),
  prompt text not null check (length(btrim(prompt)) > 0),
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  answer_data jsonb not null check (jsonb_typeof(answer_data) = 'object'),
  max_attempts integer not null check (max_attempts > 0),
  time_limit_seconds integer not null check (time_limit_seconds > 0),
  scoring_policy jsonb not null check (jsonb_typeof(scoring_policy) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (daily_challenge_id, mode)
    references public.daily_challenges(id, mode) on delete restrict,
  constraint challenges_assignment check (
    (mode = 'shared' and assigned_to is null)
    or (mode = 'personal' and assigned_to is not null)
  ),
  unique (id, mode),
  unique (id, mode, assigned_to),
  -- Exact type-specific answer/config validation belongs in the server module.
  constraint challenges_type_config check ((case type
    when 'riddle' then jsonb_typeof(answer_data->'accepted') = 'array'
      and answer_data->'accepted' <> '[]'::jsonb
    when 'character_puzzle' then jsonb_typeof(answer_data->'target') = 'string'
      and length(btrim(answer_data->>'target')) > 0
    else false
  end) is true)
);
create unique index challenges_one_shared on public.challenges(daily_challenge_id) where mode = 'shared';
create unique index challenges_one_personal on public.challenges(daily_challenge_id, assigned_to) where mode = 'personal';
create index challenges_assigned_to_idx on public.challenges(assigned_to);

-- Submissions: One timed attempt session per player and challenge
create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete restrict,
  challenge_mode text not null,
  assigned_to uuid,
  user_id uuid not null references public.profiles(id) on delete restrict,
  started_at timestamptz not null default clock_timestamp(),
  submitted_at timestamptz,
  response text,
  correct boolean,
  feedback jsonb check (feedback is null or jsonb_typeof(feedback) = 'array'),
  guess_history jsonb not null default '[]'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  time_taken_ms bigint check (time_taken_ms >= 0),
  scoring_breakdown jsonb check (scoring_breakdown is null or jsonb_typeof(scoring_breakdown) = 'object'),
  -- Composite references enforce personal ownership even for server writes.
  foreign key (challenge_id, challenge_mode) references public.challenges(id, mode) on delete restrict,
  foreign key (challenge_id, challenge_mode, assigned_to)
    references public.challenges(id, mode, assigned_to) on delete restrict,
  constraint submissions_assignment check (
    (challenge_mode = 'shared' and assigned_to is null)
    or (challenge_mode = 'personal' and assigned_to is not null and assigned_to = user_id)
  ),
  constraint submissions_one_session unique (challenge_id, user_id),
  constraint submissions_id_user_unique unique (id, user_id),
  constraint submissions_guess_history check (jsonb_typeof(guess_history) = 'array'),
  constraint submissions_resolution check (
    (submitted_at is null and correct is null and time_taken_ms is null and scoring_breakdown is null)
    or (submitted_at is not null and correct is not null and time_taken_ms is not null and scoring_breakdown is not null)
  ),
  constraint submissions_resolution_time check (submitted_at >= started_at),
  constraint submissions_elapsed_time check (
    time_taken_ms = floor(extract(epoch from (submitted_at - started_at)) * 1000)
  ),
  constraint submissions_result_total check (
    submitted_at is null or (case when jsonb_typeof(scoring_breakdown->'total_points') = 'number' then
      (scoring_breakdown->>'total_points')::numeric between 0 and 2147483647
      and (scoring_breakdown->>'total_points')::numeric = trunc((scoring_breakdown->>'total_points')::numeric)
      and (correct or (scoring_breakdown->>'total_points')::numeric = 0)
    else false end)
  )
);
create index submissions_user_id_idx on public.submissions(user_id);

-- Point transactions: Append-only signed ledger entries
create table public.point_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  amount integer not null,
  kind text not null check (kind in ('opening_balance', 'challenge_result', 'manual_adjustment')),
  reason text not null check (length(btrim(reason)) > 0),
  submission_id uuid,
  created_by uuid references public.profiles(id) on delete restrict,
  operation_key text not null unique check (length(btrim(operation_key)) > 0),
  created_at timestamptz not null default now(),
  constraint point_transactions_source_owner foreign key (submission_id, user_id)
    references public.submissions(id, user_id) on delete restrict,
  constraint point_transactions_kind_fields check (
    (kind = 'opening_balance' and amount >= 0 and submission_id is null)
    or (kind = 'challenge_result' and amount >= 0 and submission_id is not null and created_by is null)
    or (kind = 'manual_adjustment' and amount <> 0 and created_by is not null)
  )
);
create unique index point_transactions_one_opening_balance
  on public.point_transactions(user_id) where kind = 'opening_balance';
create unique index point_transactions_one_result
  on public.point_transactions(submission_id) where kind = 'challenge_result';
create index point_transactions_user_id_idx on public.point_transactions(user_id);
create index point_transactions_source_owner_idx on public.point_transactions(submission_id, user_id);
create index point_transactions_created_by_idx on public.point_transactions(created_by);

-- Private helpers: Trigger functions kept outside the Data API
create schema if not exists riddle_private;
revoke all on schema riddle_private from public, anon, authenticated;

-- Invitation protection: Preserve intent and allow only one-way lifecycle changes.
create function riddle_private.protect_invitation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'Invitations must start pending' using errcode = '23514';
    end if;
  else
    if row(new.id, new.email, new.display_name, new.role, new.opening_amount, new.invited_by, new.created_at)
       is distinct from row(old.id, old.email, old.display_name, old.role, old.opening_amount, old.invited_by, old.created_at) then
      raise exception 'Invitation intent is immutable; cancel and reissue' using errcode = '23514';
    end if;
    if new.auth_user_id is distinct from old.auth_user_id
       and (old.auth_user_id is not null or old.status <> 'pending' or new.auth_user_id is null) then
      raise exception 'Invitation account may only be bound once while pending' using errcode = '23514';
    end if;
    if old.status <> 'pending' and row(new.status, new.accepted_at, new.cancelled_at)
       is distinct from row(old.status, old.accepted_at, old.cancelled_at) then
      raise exception 'Accepted and cancelled invitations are final' using errcode = '23514';
    end if;
  end if;
  -- Serialize creation/admin acceptance with inviter demotion. App locks profiles first.
  if tg_op = 'INSERT' or (new.role = 'admin' and new.status = 'accepted' and old.status = 'pending') then
    perform 1 from public.profiles where id = new.invited_by and role = 'admin' for update;
    if not found then
      raise exception 'Inviter must currently be an admin' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function riddle_private.protect_invitation() from public, anon, authenticated;
create trigger invitations_protect_intent
before insert or update on public.invitations
for each row execute function riddle_private.protect_invitation();

-- Admin demotion: Revoke outstanding admin invitations in the same transaction.
create function riddle_private.cancel_demoted_admin_invitations()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.role = 'admin' and new.role <> 'admin' then
    update public.invitations set status = 'cancelled', cancelled_at = clock_timestamp()
      where invited_by = new.id and role = 'admin' and status = 'pending';
  end if;
  return new;
end;
$$;
revoke all on function riddle_private.cancel_demoted_admin_invitations() from public, anon, authenticated;
create trigger profiles_cancel_admin_invitations
after update of role on public.profiles
for each row execute function riddle_private.cancel_demoted_admin_invitations();

-- Saved settings: V1 has no edit workflow; only schedule notification fields may change.
create function riddle_private.protect_puzzle_snapshot()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'daily_challenges' then
    if (to_jsonb(new) - array['notification_status', 'sent_at'])
       is distinct from (to_jsonb(old) - array['notification_status', 'sent_at']) then
      raise exception 'Saved schedule settings are immutable' using errcode = '23514';
    end if;
  elsif new is distinct from old then
    raise exception 'Saved puzzles are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function riddle_private.protect_puzzle_snapshot() from public, anon, authenticated;
create trigger challenges_protect_snapshot before update on public.challenges
for each row execute function riddle_private.protect_puzzle_snapshot();
create trigger daily_challenges_protect_settings before update on public.daily_challenges
for each row execute function riddle_private.protect_puzzle_snapshot();

-- Pre-play recovery: Serialize puzzle creation/deletion and Start through the day.
-- A no-op UPDATE also makes stale REPEATABLE READ snapshots fail serialization.
-- Shared by every trigger that must wait for the schedule row's write lock before proceeding.
create function riddle_private.lock_schedule(schedule_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  update public.daily_challenges set id = id where id = schedule_id;
  if not found then
    raise exception 'Puzzle schedule no longer exists' using errcode = '23503';
  end if;
end;
$$;
revoke all on function riddle_private.lock_schedule(uuid) from public, anon, authenticated;

create function riddle_private.lock_puzzle_schedule()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform riddle_private.lock_schedule(new.daily_challenge_id);
  return new;
end;
$$;
revoke all on function riddle_private.lock_puzzle_schedule() from public, anon, authenticated;
create trigger challenges_lock_schedule before insert on public.challenges
for each row execute function riddle_private.lock_puzzle_schedule();

create function riddle_private.protect_played_schedule()
returns trigger language plpgsql set search_path = '' as $$
declare schedule_id uuid;
begin
  if tg_table_name = 'challenges' then
    schedule_id := old.daily_challenge_id;
    perform riddle_private.lock_schedule(schedule_id);
  else
    -- DELETE already holds the schedule row's write lock.
    schedule_id := old.id;
  end if;
  if exists (select 1 from public.submissions s join public.challenges c on c.id = s.challenge_id
      where c.daily_challenge_id = schedule_id) then
    raise exception 'Cannot delete a schedule or its puzzles after any session starts' using errcode = '23514';
  end if;
  return old;
end;
$$;
revoke all on function riddle_private.protect_played_schedule() from public, anon, authenticated;
create trigger challenges_protect_played_day before delete on public.challenges
for each row execute function riddle_private.protect_played_schedule();
create trigger daily_challenges_protect_played_day before delete on public.daily_challenges
for each row execute function riddle_private.protect_played_schedule();

-- Retention guards: TRUNCATE does not invoke row-level DELETE triggers.
create function riddle_private.prevent_history_removal()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Stored history cannot be deleted or truncated' using errcode = '23514';
end;
$$;
revoke all on function riddle_private.prevent_history_removal() from public, anon, authenticated;
create trigger invitations_no_delete before delete on public.invitations
for each row execute function riddle_private.prevent_history_removal();
create trigger invitations_no_truncate before truncate on public.invitations
for each statement execute function riddle_private.prevent_history_removal();
create trigger submissions_no_delete before delete on public.submissions
for each row execute function riddle_private.prevent_history_removal();
create trigger submissions_no_truncate before truncate on public.submissions
for each statement execute function riddle_private.prevent_history_removal();
create trigger challenges_no_truncate before truncate on public.challenges
for each statement execute function riddle_private.prevent_history_removal();
create trigger daily_challenges_no_truncate before truncate on public.daily_challenges
for each statement execute function riddle_private.prevent_history_removal();
create trigger point_transactions_no_truncate before truncate on public.point_transactions
for each statement execute function riddle_private.prevent_history_removal();

-- Result entries: Only finalized sessions can earn nonnegative gameplay points.
create function riddle_private.validate_challenge_result()
returns trigger language plpgsql set search_path = '' as $$
declare result_correct boolean; result_breakdown jsonb;
begin
  if new.kind = 'challenge_result' then
    select correct, scoring_breakdown into result_correct, result_breakdown from public.submissions
      where id = new.submission_id and user_id = new.user_id and submitted_at is not null
      for share;
    if not found then
      raise exception 'Challenge results require a finalized submission' using errcode = '23514';
    end if;
    if new.amount::numeric is distinct from (result_breakdown->>'total_points')::numeric
       or (not result_correct and new.amount <> 0) then
      raise exception 'Award must match the saved total and be zero for an incorrect result' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function riddle_private.validate_challenge_result() from public, anon, authenticated;
create trigger point_transactions_validate_result before insert on public.point_transactions
for each row execute function riddle_private.validate_challenge_result();

create function riddle_private.prevent_point_history_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Point history is append-only; insert a compensating adjustment'
    using errcode = '23514';
end;
$$;
revoke all on function riddle_private.prevent_point_history_change() from public, anon, authenticated;

create trigger point_transactions_append_only
before update or delete on public.point_transactions
for each row execute function riddle_private.prevent_point_history_change();

-- Submission protection: Identity, start time, and finalized results are immutable
create function riddle_private.protect_submission_identity()
returns trigger language plpgsql set search_path = '' as $$
declare schedule_id uuid;
begin
  if tg_op = 'INSERT' then
    if new.submitted_at is not null or new.correct is not null or new.time_taken_ms is not null
       or new.scoring_breakdown is not null or new.attempts <> 0
       or new.guess_history <> '[]'::jsonb or new.response is not null or new.feedback is not null then
      raise exception 'New sessions must start unresolved and unplayed' using errcode = '23514';
    end if;
    select daily_challenge_id into schedule_id from public.challenges where id = new.challenge_id;
    perform riddle_private.lock_schedule(schedule_id);
    -- Capture the start only after waiting for the schedule lock; FKs recheck the puzzle.
    new.started_at := clock_timestamp();
    return new;
  end if;
  if row(new.id, new.user_id, new.challenge_id, new.challenge_mode, new.assigned_to, new.started_at)
     is distinct from row(old.id, old.user_id, old.challenge_id, old.challenge_mode, old.assigned_to, old.started_at) then
    raise exception 'Submission identity and start time are immutable' using errcode = '23514';
  end if;
  if old.submitted_at is not null and new is distinct from old then
    raise exception 'Finalized submissions are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function riddle_private.protect_submission_identity() from public, anon, authenticated;

create trigger submissions_protect_identity
before insert or update on public.submissions
for each row execute function riddle_private.protect_submission_identity();

-- Security: Enable RLS and limit table access to the authorized backend
alter table public.profiles enable row level security;
alter table public.invitations enable row level security;
alter table public.daily_challenges enable row level security;
alter table public.challenges enable row level security;
alter table public.submissions enable row level security;
alter table public.point_transactions enable row level security;

-- Reset inherited/default grants, including existing Supabase defaults.
revoke all on public.profiles, public.invitations, public.daily_challenges, public.challenges, public.submissions, public.point_transactions
  from public, anon, authenticated, service_role, riddle_app;
revoke create on schema public from public, anon, authenticated, riddle_app;
grant usage on schema public to service_role, riddle_app;
grant select, insert, update on public.profiles, public.invitations, public.daily_challenges, public.submissions to service_role, riddle_app;
grant select, insert on public.challenges, public.point_transactions to service_role, riddle_app;
grant delete on public.daily_challenges, public.challenges to service_role, riddle_app;
-- DELETE is guarded and limited to unplayed schedules/puzzles. No ownership, DDL, or TRUNCATE.
create policy backend_access on public.profiles to riddle_app using (true) with check (true);
create policy backend_access on public.invitations to riddle_app using (true) with check (true);
create policy backend_access on public.daily_challenges to riddle_app using (true) with check (true);
create policy backend_access on public.challenges to riddle_app using (true) with check (true);
create policy backend_access on public.submissions to riddle_app using (true) with check (true);
create policy backend_access on public.point_transactions to riddle_app using (true) with check (true);
-- No browser RLS policies: all game operations go through the authorized backend.

commit;
