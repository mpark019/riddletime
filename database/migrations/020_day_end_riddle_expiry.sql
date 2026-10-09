begin;

-- A riddle's day ends at local midnight in the app timezone.
create function riddle_private.day_end(active_date date, app_timezone text)
returns timestamptz language sql immutable set search_path = '' as $$
  select ((active_date + 1)::timestamp at time zone app_timezone)
$$;
revoke all on function riddle_private.day_end(date, text) from public, anon, authenticated;
grant execute on function riddle_private.day_end(date, text) to riddle_app;

-- The earlier of the time limit and day end; a null limit leaves only day end.
create function riddle_private.session_deadline(started_at timestamptz, time_limit_seconds integer, active_date date, app_timezone text)
returns timestamptz language sql immutable set search_path = '' as $$
  select least(started_at + time_limit_seconds * interval '1 second', riddle_private.day_end(active_date, app_timezone))
$$;
revoke all on function riddle_private.session_deadline(timestamptz, integer, date, text) from public, anon, authenticated;
grant execute on function riddle_private.session_deadline(timestamptz, integer, date, text) to riddle_app;

-- Malformed penalties count as zero, matching the app's lenient expiry path.
create function riddle_private.failure_penalty(policy jsonb)
returns integer language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(policy->'failure_penalty_points') = 'number'
               and (policy->>'failure_penalty_points')::numeric between 0 and 2147483647
               and (policy->>'failure_penalty_points')::numeric = trunc((policy->>'failure_penalty_points')::numeric)
         then (policy->>'failure_penalty_points')::integer else 0 end
$$;
revoke all on function riddle_private.failure_penalty(jsonb) from public, anon, authenticated;
grant execute on function riddle_private.failure_penalty(jsonb) to riddle_app;

drop function riddle_private.finalize_expired_sessions(uuid);

-- Resolves started games at the earlier of their time limit and the end of their day, and
-- penalizes players who never started a riddle whose day has ended.
create function riddle_private.finalize_expired_sessions(
  target_user uuid default null,
  app_timezone text default current_setting('timezone')
)
returns integer language plpgsql set search_path = '' as $$
declare
  candidate record;
  session record;
  deadline timestamptz;
  elapsed_ms bigint;
  penalty integer;
  new_submission uuid;
  finalized integer := 0;
begin
  for candidate in
    select s.id from public.submissions s
      join public.challenges c on c.id = s.challenge_id
      join public.daily_challenges d on d.id = c.daily_challenge_id
      where s.submitted_at is null
        and (target_user is null or s.user_id = target_user)
        and riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, app_timezone) <= clock_timestamp()
      order by s.id
  loop
    begin
      -- A locked row belongs to an in-flight submit; the next run retries it.
      select s.id, s.user_id, s.started_at, c.scoring_policy,
             riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, app_timezone) as deadline
        into session
        from public.submissions s
        join public.challenges c on c.id = s.challenge_id
        join public.daily_challenges d on d.id = c.daily_challenge_id
        where s.id = candidate.id
          and s.submitted_at is null
          and riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, app_timezone) <= clock_timestamp()
        for update of s skip locked;
      if not found then
        continue;
      end if;

      deadline := greatest(session.deadline, session.started_at);
      elapsed_ms := floor(extract(epoch from (deadline - session.started_at)) * 1000)::bigint;
      penalty := riddle_private.failure_penalty(session.scoring_policy);

      update public.submissions s
        set submitted_at = s.started_at + elapsed_ms * interval '1 millisecond',
            time_taken_ms = elapsed_ms,
            correct = false,
            scoring_breakdown = jsonb_build_object(
              'base_points', 0,
              'speed_bonus_points', null,
              'penalty_points', penalty,
              'total_points', -penalty,
              'bonus_under_ms', null
            )
        where s.id = session.id;

      insert into public.point_transactions (user_id, amount, kind, reason, submission_id, operation_key)
        values (session.user_id, -penalty, 'challenge_result', 'Deadline expired', session.id, 'result:' || session.id);

      finalized := finalized + 1;
    exception when others then
      -- Isolate one bad row so it cannot block every other player's sweep.
      raise warning 'Could not finalize expired session %: %', candidate.id, sqlerrm;
    end;
  end loop;

  -- Shared riddles reach only accounts that existed when the day ended.
  for candidate in
    select c.id as challenge_id, c.mode, c.assigned_to, c.scoring_policy, p.id as user_id
      from public.challenges c
      join public.daily_challenges d on d.id = c.daily_challenge_id
      join public.profiles p on p.role = 'player'
        and (c.assigned_to = p.id
             or (c.mode = 'shared' and p.created_at < riddle_private.day_end(d.active_date, app_timezone)))
      where riddle_private.day_end(d.active_date, app_timezone) <= clock_timestamp()
        and (target_user is null or p.id = target_user)
        and not exists (select 1 from public.submissions s where s.challenge_id = c.id and s.user_id = p.id)
      order by c.id, p.id
  loop
    begin
      new_submission := null;
      -- A player who started at the last moment already owns a row; leave it to the first loop.
      insert into public.submissions (challenge_id, challenge_mode, assigned_to, user_id)
        values (candidate.challenge_id, candidate.mode, candidate.assigned_to, candidate.user_id)
        on conflict (challenge_id, user_id) do nothing
        returning id into new_submission;
      if new_submission is null then
        continue;
      end if;

      penalty := riddle_private.failure_penalty(candidate.scoring_policy);

      update public.submissions s
        set submitted_at = s.started_at,
            time_taken_ms = 0,
            correct = false,
            scoring_breakdown = jsonb_build_object(
              'base_points', 0,
              'speed_bonus_points', null,
              'penalty_points', penalty,
              'total_points', -penalty,
              'bonus_under_ms', null,
              'missed', true
            )
        where s.id = new_submission;

      insert into public.point_transactions (user_id, amount, kind, reason, submission_id, operation_key)
        values (candidate.user_id, -penalty, 'challenge_result', 'Missed riddle', new_submission, 'result:' || new_submission);

      finalized := finalized + 1;
    exception when others then
      raise warning 'Could not penalize missed riddle % for %: %', candidate.challenge_id, candidate.user_id, sqlerrm;
    end;
  end loop;

  return finalized;
end;
$$;
revoke all on function riddle_private.finalize_expired_sessions(uuid, text) from public, anon, authenticated;
grant execute on function riddle_private.finalize_expired_sessions(uuid, text) to riddle_app;

commit;
