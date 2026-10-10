begin;

-- Moves puzzle content out of challenges. There is no backfill, so refuse to run over existing data.
do $$
begin
  if exists (select 1 from public.challenges) then
    raise exception 'challenges already has rows; the puzzle bank migration does not move existing content'
      using errcode = '23514';
  end if;
end;
$$;

create table public.puzzles (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('riddle', 'character_puzzle')),
  name text check (name is null or length(btrim(name)) between 1 and 80),
  prompt text not null check (length(btrim(prompt)) > 0),
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  answer_data jsonb not null check (jsonb_typeof(answer_data) = 'object'),
  difficulty text not null check (length(btrim(difficulty)) > 0),
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, type),
  -- Exact type-specific answer/config validation belongs in the server module.
  constraint puzzles_type_answer check ((case type
    when 'riddle' then jsonb_typeof(answer_data->'accepted') = 'array'
      and answer_data->'accepted' <> '[]'::jsonb
    when 'character_puzzle' then jsonb_typeof(answer_data->'target') = 'string'
      and length(btrim(answer_data->>'target')) > 0
    else false
  end) is true)
);
create index puzzles_created_by_idx on public.puzzles(created_by);

alter table public.challenges drop constraint challenges_type_config;
alter table public.challenges drop column prompt, drop column config, drop column answer_data;
alter table public.challenges add column puzzle_id uuid not null;
alter table public.challenges add constraint challenges_puzzle_fk
  foreign key (puzzle_id, type) references public.puzzles(id, type) on delete restrict;
create index challenges_puzzle_id_idx on public.challenges(puzzle_id);

-- Content is frozen once any challenge references the puzzle; status and the display name stay editable.
create function riddle_private.protect_puzzle_content()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.challenges where puzzle_id = old.id) then
      raise exception 'A scheduled puzzle cannot be deleted' using errcode = '23514';
    end if;
    return old;
  end if;

  if new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'Puzzle identity is immutable' using errcode = '23514';
  end if;
  -- Account deletion hands a departing admin's puzzles to the acting admin.
  if current_user = 'postgres'
     and current_setting('riddle_private.member_delete', true) = 'on'
     and (to_jsonb(new) - 'created_by') is not distinct from (to_jsonb(old) - 'created_by') then
    return new;
  end if;
  if (to_jsonb(new) - 'status' - 'name') is distinct from (to_jsonb(old) - 'status' - 'name')
     and exists (select 1 from public.challenges where puzzle_id = old.id) then
    raise exception 'Scheduled puzzle content is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function riddle_private.protect_puzzle_content() from public, anon, authenticated;
create trigger puzzles_protect_content before update or delete on public.puzzles
for each row execute function riddle_private.protect_puzzle_content();
create trigger puzzles_no_truncate before truncate on public.puzzles
for each statement execute function riddle_private.prevent_history_removal();

-- FOR SHARE conflicts with a concurrent content edit, which the foreign key's key-share lock would not.
create function riddle_private.lock_challenge_puzzle()
returns trigger language plpgsql set search_path = '' as $$
declare puzzle_status text;
begin
  select status into puzzle_status from public.puzzles where id = new.puzzle_id for share;
  if puzzle_status = 'retired' then
    raise exception 'A retired puzzle cannot be scheduled' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function riddle_private.lock_challenge_puzzle() from public, anon, authenticated;
create trigger challenges_lock_puzzle before insert on public.challenges
for each row execute function riddle_private.lock_challenge_puzzle();

alter table public.puzzles enable row level security;
revoke all on public.puzzles from public, anon, authenticated, service_role, riddle_app;
grant select, insert, update, delete on public.puzzles to service_role, riddle_app;
create policy backend_access on public.puzzles to riddle_app using (true) with check (true);

create or replace function riddle_private.delete_member_data(target_id uuid, acting_admin_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare avatar text; target_role text; admin_count integer;
begin
  if target_id = acting_admin_id then
    raise exception 'You cannot delete your own account' using errcode = '23514';
  end if;

  select role into target_role from public.profiles where id = acting_admin_id for update;
  if not found or target_role <> 'admin' then
    raise exception 'Admin role required' using errcode = '42501';
  end if;

  select role, avatar_url into target_role, avatar from public.profiles where id = target_id for update;
  if not found then raise exception 'Account not found' using errcode = 'P0002'; end if;

  if target_role = 'admin' then
    select count(*)::integer into admin_count from public.profiles where role = 'admin';
    if admin_count < 2 then
      raise exception 'At least one admin account must remain' using errcode = '23514';
    end if;
  end if;

  perform set_config('riddle_private.member_delete', 'on', true);
  update public.daily_challenges set created_by = acting_admin_id where created_by = target_id;
  update public.puzzles set created_by = acting_admin_id where created_by = target_id;
  delete from public.point_transactions where user_id = target_id or created_by = target_id;
  delete from public.submissions where user_id = target_id;
  delete from public.challenges where assigned_to = target_id;
  delete from public.invitations where auth_user_id = target_id or invited_by = target_id;
  delete from public.profiles where id = target_id;
  return avatar;
end;
$$;

commit;
