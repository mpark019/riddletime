begin;

-- Account deletion is authorized by the application and executed through this
-- narrowly scoped owner routine. It may remove member-owned history, but it
-- preserves shared schedules by transferring their ownership to the acting admin.
create or replace function riddle_private.prevent_history_removal()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'postgres'
     and current_setting('riddle_private.member_delete', true) = 'on' then
    return old;
  end if;
  raise exception 'Stored history cannot be deleted or truncated' using errcode = '23514';
end;
$$;

create or replace function riddle_private.protect_puzzle_snapshot()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'daily_challenges' then
    if current_user = 'postgres'
       and current_setting('riddle_private.member_delete', true) = 'on'
       and (to_jsonb(new) - array['notification_status', 'sent_at', 'created_by'])
         is not distinct from (to_jsonb(old) - array['notification_status', 'sent_at', 'created_by']) then
      return new;
    end if;
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

drop function if exists riddle_private.delete_player_data(uuid);

create function riddle_private.delete_member_data(target_id uuid, acting_admin_id uuid)
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
  delete from public.point_transactions where user_id = target_id or created_by = target_id;
  delete from public.submissions where user_id = target_id;
  delete from public.challenges where assigned_to = target_id;
  delete from public.invitations where auth_user_id = target_id or invited_by = target_id;
  delete from public.profiles where id = target_id;
  return avatar;
end;
$$;
revoke all on function riddle_private.delete_member_data(uuid, uuid) from public, anon, authenticated;
grant execute on function riddle_private.delete_member_data(uuid, uuid) to riddle_app;

commit;
