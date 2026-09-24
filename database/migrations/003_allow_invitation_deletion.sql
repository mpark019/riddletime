-- Unlike submissions and point_transactions, an invitation carries no
-- score/leaderboard value once resolved, so an admin may delete one outright
-- to free its Supabase auth user instead of only ever cancelling in place.

begin;

drop trigger invitations_no_delete on public.invitations;

grant delete on public.invitations to service_role, riddle_app;

commit;
