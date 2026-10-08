begin;

-- Keeps each sweep proportional to unfinished games rather than all history.
create index submissions_unresolved_idx on public.submissions(challenge_id) where submitted_at is null;

-- Mirrors the app's expiry path so abandoned games still receive their failure penalty.
create function riddle_private.finalize_expired_sessions(target_user uuid default null)
returns integer language plpgsql set search_path = '' as $$
declare
  candidate record;
  session record;
  penalty integer;
  limit_ms bigint;
  finalized integer := 0;
begin
  for candidate in
    select s.id from public.submissions s
      join public.challenges c on c.id = s.challenge_id
      where s.submitted_at is null
        and (target_user is null or s.user_id = target_user)
        and s.started_at + c.time_limit_seconds * interval '1 second' <= clock_timestamp()
      order by s.id
  loop
    begin
      -- A locked row belongs to an in-flight submit; the next run retries it.
      select s.id, s.user_id, c.time_limit_seconds, c.scoring_policy into session
        from public.submissions s
        join public.challenges c on c.id = s.challenge_id
        where s.id = candidate.id
          and s.submitted_at is null
          and s.started_at + c.time_limit_seconds * interval '1 second' <= clock_timestamp()
        for update of s skip locked;
      if not found then
        continue;
      end if;

      -- Malformed penalties count as zero, matching the app's lenient expiry path.
      penalty := case when jsonb_typeof(session.scoring_policy->'failure_penalty_points') = 'number' then
        case when (session.scoring_policy->>'failure_penalty_points')::numeric between 0 and 2147483647
               and (session.scoring_policy->>'failure_penalty_points')::numeric
                 = trunc((session.scoring_policy->>'failure_penalty_points')::numeric)
          then (session.scoring_policy->>'failure_penalty_points')::integer else 0 end
        else 0 end;
      limit_ms := session.time_limit_seconds::bigint * 1000;

      update public.submissions s
        set submitted_at = s.started_at + limit_ms * interval '1 millisecond',
            time_taken_ms = limit_ms,
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
  return finalized;
end;
$$;
revoke all on function riddle_private.finalize_expired_sessions(uuid) from public, anon, authenticated;

commit;
