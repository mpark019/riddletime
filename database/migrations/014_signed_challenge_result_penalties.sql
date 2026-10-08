begin;

alter table public.submissions drop constraint submissions_result_total;
alter table public.submissions add constraint submissions_result_total check (
  submitted_at is null or (case when jsonb_typeof(scoring_breakdown->'total_points') = 'number' then
    (scoring_breakdown->>'total_points')::numeric between -2147483648 and 2147483647
    and (scoring_breakdown->>'total_points')::numeric = trunc((scoring_breakdown->>'total_points')::numeric)
    and (
      (correct and (scoring_breakdown->>'total_points')::numeric >= 0)
      or (not correct and (scoring_breakdown->>'total_points')::numeric <= 0)
    )
  else false end)
);

alter table public.point_transactions drop constraint point_transactions_kind_fields;
alter table public.point_transactions add constraint point_transactions_kind_fields check (
  (kind = 'initial_score' and amount >= 0 and submission_id is null)
  or (kind = 'challenge_result' and submission_id is not null and created_by is null)
  or (kind = 'manual_adjustment' and amount <> 0 and created_by is not null)
);

create or replace function riddle_private.validate_challenge_result()
returns trigger language plpgsql set search_path = '' as $$
declare result_correct boolean; result_breakdown jsonb;
begin
  if new.kind = 'challenge_result' then
    select correct, scoring_breakdown into result_correct, result_breakdown from public.submissions
      where id = new.submission_id and user_id = new.user_id and submitted_at is not null
      for share;
    if not found then
      raise exception 'Challenge results require a finalized submission' using errcode = '23514';
    end if;
    if new.amount::numeric is distinct from (result_breakdown->>'total_points')::numeric
       or (result_correct and new.amount < 0)
       or (not result_correct and new.amount > 0) then
      raise exception 'Result must match the saved total and correctness' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

commit;
