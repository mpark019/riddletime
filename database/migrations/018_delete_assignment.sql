begin;

-- Removes one player's personal puzzle as if it never existed, including their game and the points it
-- earned or deducted. The day is removed too once its last puzzle is gone.
create function riddle_private.delete_assignment(target_challenge uuid, acting_admin_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor_role text; schedule_id uuid; puzzle_mode text; removed_results integer; schedule_removed boolean := false;
begin
  select role into actor_role from public.profiles where id = acting_admin_id for share;
  if not found or actor_role <> 'admin' then
    raise exception 'Admin role required' using errcode = '42501';
  end if;

  select daily_challenge_id, mode into schedule_id, puzzle_mode from public.challenges where id = target_challenge;
  if not found then
    raise exception 'Assignment not found' using errcode = 'P0002';
  end if;
  if puzzle_mode <> 'personal' then
    raise exception 'Only personal assignments can be removed' using errcode = '22023';
  end if;

  -- Holding the schedule row blocks Start, which locks it before inserting a session.
  perform 1 from public.daily_challenges where id = schedule_id for update;
  perform 1 from public.submissions where challenge_id = target_challenge order by id for update;

  perform set_config('riddle_private.schedule_delete', 'on', true);
  delete from public.point_transactions p
    using public.submissions s
    where p.submission_id = s.id and s.challenge_id = target_challenge;
  get diagnostics removed_results = row_count;
  delete from public.submissions where challenge_id = target_challenge;
  delete from public.challenges where id = target_challenge;
  if not exists (select 1 from public.challenges where daily_challenge_id = schedule_id) then
    delete from public.daily_challenges where id = schedule_id;
    schedule_removed := true;
  end if;
  perform set_config('riddle_private.schedule_delete', 'off', true);
  return jsonb_build_object('removed_results', removed_results, 'schedule_removed', schedule_removed);
end;
$$;
revoke all on function riddle_private.delete_assignment(uuid, uuid) from public, anon, authenticated;
grant execute on function riddle_private.delete_assignment(uuid, uuid) to riddle_app;

commit;
