begin;

drop trigger point_transactions_append_only on public.point_transactions;

create trigger point_transactions_no_update
before update on public.point_transactions
for each row execute function riddle_private.prevent_point_history_change();

grant delete on public.point_transactions to service_role, riddle_app;

commit;
