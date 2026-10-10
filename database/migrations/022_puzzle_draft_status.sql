-- Puzzles gain a draft status. Only active puzzles can be scheduled, and an active puzzle's content is frozen.
alter table public.puzzles drop constraint puzzles_status_check;
alter table public.puzzles add constraint puzzles_status_check
  check (status in ('draft', 'active', 'retired'));

create or replace function riddle_private.protect_puzzle_content()
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
  if (to_jsonb(new) - 'status' - 'name') is distinct from (to_jsonb(old) - 'status' - 'name') then
    if exists (select 1 from public.challenges where puzzle_id = old.id) then
      raise exception 'Scheduled puzzle content is immutable' using errcode = '23514';
    end if;
    -- Judged on the old status so an edit cannot ride along with the move out of active.
    if old.status = 'active' then
      raise exception 'Active puzzle content is immutable until it is moved to draft' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function riddle_private.lock_challenge_puzzle()
returns trigger language plpgsql set search_path = '' as $$
declare puzzle_status text;
begin
  select status into puzzle_status from public.puzzles where id = new.puzzle_id for share;
  if puzzle_status is distinct from 'active' then
    raise exception 'Only an active puzzle can be scheduled' using errcode = '23514';
  end if;
  return new;
end;
$$;
