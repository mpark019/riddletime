begin;

-- An image session may resolve only through review, or as an empty draft that took the penalty.
create or replace function riddle_private.protect_submission_review()
returns trigger language plpgsql set search_path = '' as $$
declare challenge_type text;
begin
  if tg_op = 'INSERT' then
    if new.image_paths <> '{}' or new.note is not null or new.review_state is not null then
      raise exception 'New sessions start without images or review state' using errcode = '23514';
    end if;
    return new;
  end if;

  select type into challenge_type from public.challenges where id = new.challenge_id;

  if cardinality(new.image_paths) > 0 or new.note is not null or new.review_state is not null then
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

  if challenge_type = 'image_submission' and old.submitted_at is null and new.submitted_at is not null
     and new.review_state is distinct from 'reviewed'
     and not (cardinality(new.image_paths) = 0 and new.correct is false) then
    raise exception 'An image submission resolves through review' using errcode = '23514';
  end if;

  if new.image_paths <> '{}' and exists (
    select 1 from unnest(new.image_paths) as p
    where p not like 'submissions/' || new.user_id || '/' || new.id || '/%'
  ) then
    raise exception 'Image paths must belong to the session' using errcode = '23514';
  end if;

  if new.review_state is distinct from old.review_state then
    if old.review_state is null and new.review_state = 'pending_review' then
      return new;
    end if;
    if old.review_state = 'pending_review' and new.review_state = 'reviewed' then
      if new.submitted_at is distinct from old.review_submitted_at then
        raise exception 'A review resolves at the time the player submitted' using errcode = '23514';
      end if;
      if not exists (select 1 from public.profiles where id = new.reviewed_by and role = 'admin') then
        raise exception 'Only an admin can review a submission' using errcode = '42501';
      end if;
      return new;
    end if;
    raise exception 'Invalid review state change' using errcode = '23514';
  end if;
  return new;
end;
$$;

commit;
