begin;

alter table public.puzzles drop constraint puzzles_type_check;
alter table public.puzzles add constraint puzzles_type_check
  check (type in ('riddle', 'character_puzzle', 'image_submission'));

-- An image puzzle may leave the prompt text blank when it carries a prompt image instead.
alter table public.puzzles drop constraint puzzles_prompt_check;
alter table public.puzzles add constraint puzzles_prompt_check check (
  length(btrim(prompt)) > 0
  or (type = 'image_submission' and jsonb_typeof(config->'prompt_image_path') = 'string')
);

alter table public.puzzles drop constraint puzzles_type_answer;
alter table public.puzzles add constraint puzzles_type_answer check ((case type
  when 'riddle' then jsonb_typeof(answer_data->'accepted') = 'array'
    and answer_data->'accepted' <> '[]'::jsonb
  when 'character_puzzle' then jsonb_typeof(answer_data->'target') = 'string'
    and length(btrim(answer_data->>'target')) > 0
  when 'image_submission' then answer_data = '{}'::jsonb
  else false
end) is true);

alter table public.challenges drop constraint challenges_type_check;
alter table public.challenges add constraint challenges_type_check
  check (type in ('riddle', 'character_puzzle', 'image_submission'));

alter table public.daily_challenges drop constraint daily_challenges_allowed_types_check;
alter table public.daily_challenges add constraint daily_challenges_allowed_types_check check (
  cardinality(allowed_types) > 0 and array_ndims(allowed_types) = 1
  and array_position(allowed_types, null) is null
  and allowed_types <@ array['riddle', 'character_puzzle', 'image_submission']::text[]
);

-- Draft images and the note live on the session; a submitted session waits for review without
-- resolving, so every sweep and staff view that keys on submitted_at keeps treating it as open.
-- reviewed_by is deliberately not a foreign key: removing a grading admin must not touch results.
alter table public.submissions
  add column image_paths text[] not null default '{}',
  add column note text,
  add column review_state text,
  add column review_submitted_at timestamptz,
  add column reviewed_by uuid,
  add column reviewed_at timestamptz,
  add column review_comment text;

alter table public.submissions add constraint submissions_review_shape check (
  array_ndims(image_paths) is not distinct from 1 or cardinality(image_paths) = 0
);
alter table public.submissions add constraint submissions_review_limits check (
  cardinality(image_paths) <= 10
  and array_position(image_paths, null) is null
  and (note is null or length(note) <= 1000)
  and (review_comment is null or length(review_comment) <= 500)
);
alter table public.submissions add constraint submissions_review_lifecycle check (
  (review_state is null and review_submitted_at is null and reviewed_by is null
    and reviewed_at is null and review_comment is null)
  or (review_state = 'pending_review' and review_submitted_at is not null
    and cardinality(image_paths) >= 1 and submitted_at is null
    and reviewed_by is null and reviewed_at is null and review_comment is null)
  or (review_state = 'reviewed' and review_submitted_at is not null
    and cardinality(image_paths) >= 1 and submitted_at is not null
    and reviewed_by is not null and reviewed_at is not null)
);

create function riddle_private.protect_submission_review()
returns trigger language plpgsql set search_path = '' as $$
declare challenge_type text;
begin
  if tg_op = 'INSERT' then
    if new.image_paths <> '{}' or new.note is not null or new.review_state is not null then
      raise exception 'New sessions start without images or review state' using errcode = '23514';
    end if;
    return new;
  end if;

  if cardinality(new.image_paths) > 0 or new.note is not null or new.review_state is not null then
    select type into challenge_type from public.challenges where id = new.challenge_id;
    if challenge_type is distinct from 'image_submission' then
      raise exception 'Only image submissions carry images, notes, or reviews' using errcode = '23514';
    end if;
  end if;

  if old.review_submitted_at is not null then
    if new.image_paths is distinct from old.image_paths
       or new.note is distinct from old.note
       or new.review_submitted_at is distinct from old.review_submitted_at then
      raise exception 'A submitted image session is locked' using errcode = '23514';
    end if;
  end if;

  if new.review_state is distinct from old.review_state then
    if old.review_state is null and new.review_state = 'pending_review' then
      return new;
    end if;
    if old.review_state = 'pending_review' and new.review_state = 'reviewed' then
      if new.submitted_at is distinct from old.review_submitted_at then
        raise exception 'A review resolves at the time the player submitted' using errcode = '23514';
      end if;
      return new;
    end if;
    raise exception 'Invalid review state change' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function riddle_private.protect_submission_review() from public, anon, authenticated;
grant execute on function riddle_private.protect_submission_review() to service_role, riddle_app;

create trigger submissions_protect_review
before insert or update on public.submissions
for each row execute function riddle_private.protect_submission_review();

-- Private bucket: prompt images and submitted images are served only through signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'puzzle-images',
  'puzzle-images',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- A session already submitted for review is left alone; a draft with images at its deadline is
-- submitted for review instead of penalized.
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
      select s.id, s.user_id, s.started_at, s.image_paths, c.type, c.scoring_policy,
             riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, app_timezone) as deadline
        into session
        from public.submissions s
        join public.challenges c on c.id = s.challenge_id
        join public.daily_challenges d on d.id = c.daily_challenge_id
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
