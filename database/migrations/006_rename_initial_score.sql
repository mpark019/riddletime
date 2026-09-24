begin;

alter table public.invitations rename column opening_amount to initial_score;
alter table public.invitations rename constraint invitations_opening_amount to invitations_initial_score;

drop trigger point_transactions_no_update on public.point_transactions;
alter table public.point_transactions drop constraint point_transactions_kind_check;
alter table public.point_transactions drop constraint point_transactions_kind_fields;

update public.point_transactions
set kind = 'initial_score',
    reason = case when reason = 'Opening balance' then 'Initial score' else reason end,
    operation_key = case
      when operation_key = 'opening:' || user_id then 'initial:' || user_id
      else operation_key
    end
where kind = 'opening_balance';

alter table public.point_transactions add constraint point_transactions_kind_check check (
  kind in ('initial_score', 'challenge_result', 'manual_adjustment')
);
alter table public.point_transactions add constraint point_transactions_kind_fields check (
  (kind = 'initial_score' and amount >= 0 and submission_id is null)
  or (kind = 'challenge_result' and amount >= 0 and submission_id is not null and created_by is null)
  or (kind = 'manual_adjustment' and amount <> 0 and created_by is not null)
);

alter index public.point_transactions_one_opening_balance rename to point_transactions_one_initial_score;

create trigger point_transactions_no_update
before update on public.point_transactions
for each row execute function riddle_private.prevent_point_history_change();

commit;
