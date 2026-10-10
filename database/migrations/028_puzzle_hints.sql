begin;

alter table public.puzzles
  add column hint text,
  add column hint_cost_points integer,
  add constraint puzzles_hint_text check (hint is null or length(btrim(hint)) between 1 and 1000),
  add constraint puzzles_hint_cost check (hint_cost_points is null or hint_cost_points >= 0),
  add constraint puzzles_hint_pair check ((hint is null) = (hint_cost_points is null)),
  add constraint puzzles_hint_type check (hint is null or type in ('riddle', 'character_puzzle'));

-- The reveal time is the one fact the cost is charged from; finalized sessions stay immutable via the identity trigger.
alter table public.submissions
  add column hint_used_at timestamptz,
  add constraint submissions_hint_after_start check (hint_used_at is null or hint_used_at >= started_at);

-- Same as 025, except a revealed hint is charged on top of the failure penalty for a started session.
create or replace function riddle_private.finalize_expired_sessions(
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
  hint_cost integer;
  deduction integer;
  new_submission uuid;
  finalized integer := 0;
begin
  for candidate in
    select s.id from public.submissions s
      join public.challenges c on c.id = s.challenge_id
      join public.daily_challenges d on d.id = c.daily_challenge_id
      where s.submitted_at is null
        and s.review_submitted_at is null
        and (target_user is null or s.user_id = target_user)
        and riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, app_timezone) <= clock_timestamp()
      order by s.id
  loop
    begin
      -- A locked row belongs to an in-flight submit; the next run retries it.
      select s.id, s.user_id, s.started_at, s.image_paths, s.hint_used_at, c.type, c.scoring_policy, pz.hint_cost_points,
             riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, app_timezone) as deadline
        into session
        from public.submissions s
        join public.challenges c on c.id = s.challenge_id
        join public.daily_challenges d on d.id = c.daily_challenge_id
        join public.puzzles pz on pz.id = c.puzzle_id
        where s.id = candidate.id
          and s.submitted_at is null
          and s.review_submitted_at is null
          and riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, app_timezone) <= clock_timestamp()
        for update of s skip locked;
      if not found then
        continue;
      end if;

      deadline := greatest(session.deadline, session.started_at);

      if session.type = 'image_submission' and cardinality(session.image_paths) >= 1 then
        update public.submissions s
          set review_state = 'pending_review',
              review_submitted_at = deadline
          where s.id = session.id;
        continue;
      end if;

      elapsed_ms := floor(extract(epoch from (deadline - session.started_at)) * 1000)::bigint;
      penalty := riddle_private.failure_penalty(session.scoring_policy);
      hint_cost := case when session.hint_used_at is not null then coalesce(session.hint_cost_points, 0) else 0 end;
      deduction := least(penalty::bigint + hint_cost, 2147483647)::integer;

      update public.submissions s
        set submitted_at = s.started_at + elapsed_ms * interval '1 millisecond',
            time_taken_ms = elapsed_ms,
            correct = false,
            scoring_breakdown = jsonb_build_object(
              'base_points', 0,
              'speed_bonus_points', null,
              'penalty_points', penalty,
              'total_points', -deduction,
              'bonus_under_ms', null
            ) || case when hint_cost > 0 then jsonb_build_object('hint_cost_points', hint_cost) else '{}'::jsonb end
        where s.id = session.id;

      insert into public.point_transactions (user_id, amount, kind, reason, submission_id, operation_key)
        values (session.user_id, -deduction, 'challenge_result', 'Deadline expired', session.id, 'result:' || session.id);

      finalized := finalized + 1;
    exception when others then
      -- Isolate one bad row so it cannot block every other player's sweep.
      raise warning 'Could not finalize expired session %: %', candidate.id, sqlerrm;
    end;
  end loop;

  -- Shared puzzles reach only accounts that existed when the day ended.
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

commit;
