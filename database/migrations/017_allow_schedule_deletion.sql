begin;

-- Owner-only bypasses: the app role can set these settings but is never 'postgres'.
create or replace function riddle_private.prevent_history_removal()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'postgres'
     and (current_setting('riddle_private.member_delete', true) = 'on'
       or current_setting('riddle_private.schedule_delete', true) = 'on') then
    return old;
  end if;
  raise exception 'Stored history cannot be deleted or truncated' using errcode = '23514';
end;
$$;

create or replace function riddle_private.protect_played_schedule()
returns trigger language plpgsql set search_path = '' as $$
declare schedule_id uuid;
begin
  if current_user = 'postgres'
     and current_setting('riddle_private.schedule_delete', true) = 'on' then
    return old;
  end if;
  if tg_table_name = 'challenges' then
    schedule_id := old.daily_challenge_id;
    perform riddle_private.lock_schedule(schedule_id);
  else
    schedule_id := old.id;
  end if;
  if exists (select 1 from public.submissions s join public.challenges c on c.id = s.challenge_id
      where c.daily_challenge_id = schedule_id) then
    raise exception 'Cannot delete a schedule or its puzzles after any session starts' using errcode = '23514';
  end if;
  return old;
end;
$$;

-- Removes a riddle as if it never existed, including every point its games earned or deducted.
create function riddle_private.delete_schedule(target_schedule uuid, acting_admin_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare actor_role text; removed_results integer;
begin
  select role into actor_role from public.profiles where id = acting_admin_id for share;
  if not found or actor_role <> 'admin' then
    raise exception 'Admin role required' using errcode = '42501';
  end if;

  -- Holding the schedule row blocks Start, which locks it before inserting a session.
  perform 1 from public.daily_challenges where id = target_schedule for update;
  if not found then
    raise exception 'Schedule not found' using errcode = 'P0002';
  end if;

  -- Wait out in-flight submits and sweeps so no result lands between the two deletes below.
  perform 1 from public.submissions s
    join public.challenges c on c.id = s.challenge_id
    where c.daily_challenge_id = target_schedule
    order by s.id
    for update of s;

  perform set_config('riddle_private.schedule_delete', 'on', true);
  delete from public.point_transactions p
    using public.submissions s, public.challenges c
    where p.submission_id = s.id and s.challenge_id = c.id and c.daily_challenge_id = target_schedule;
  get diagnostics removed_results = row_count;
  delete from public.submissions s
    using public.challenges c
    where s.challenge_id = c.id and c.daily_challenge_id = target_schedule;
  delete from public.challenges where daily_challenge_id = target_schedule;
  delete from public.daily_challenges where id = target_schedule;
  perform set_config('riddle_private.schedule_delete', 'off', true);
  return removed_results;
end;
$$;
revoke all on function riddle_private.delete_schedule(uuid, uuid) from public, anon, authenticated;
grant execute on function riddle_private.delete_schedule(uuid, uuid) to riddle_app;

commit;
