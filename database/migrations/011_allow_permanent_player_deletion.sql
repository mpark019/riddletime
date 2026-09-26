begin;

-- The application invokes this only through a SECURITY DEFINER routine after
-- checking that the caller is an admin and the target is a player.
create or replace function riddle_private.prevent_history_removal()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'postgres'
     and current_setting('riddle_private.player_delete', true) = 'on' then
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
     and current_setting('riddle_private.player_delete', true) = 'on' then
    return old;
  end if;
  if tg_table_name = 'daily_challenges' then schedule_id := old.id; else schedule_id := old.daily_challenge_id; end if;
  if exists (select 1 from public.submissions s join public.challenges c on c.id = s.challenge_id where c.daily_challenge_id = schedule_id) then
    raise exception 'Cannot delete a schedule or its puzzles after any session starts' using errcode = '23514';
  end if;
  return old;
end;
$$;

create function riddle_private.delete_player_data(target_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare avatar text; target_role text;
begin
  select role, avatar_url into target_role, avatar from public.profiles where id = target_id for update;
  if not found then raise exception 'Player not found' using errcode = 'P0002'; end if;
  if target_role <> 'player' then raise exception 'Only player accounts may be deleted' using errcode = '23514'; end if;
  perform set_config('riddle_private.player_delete', 'on', true);
  delete from public.point_transactions where user_id = target_id or created_by = target_id;
  delete from public.submissions where user_id = target_id;
  delete from public.challenges where assigned_to = target_id;
  delete from public.invitations where auth_user_id = target_id;
  delete from public.profiles where id = target_id;
  return avatar;
end;
$$;
revoke all on function riddle_private.delete_player_data(uuid) from public, anon, authenticated;
grant execute on function riddle_private.delete_player_data(uuid) to riddle_app;

commit;
