-- Firing a trigger needs EXECUTE on its function and USAGE on its schema
-- for the invoking role, not just the function owner. 001 never granted
-- either, which blocked every write to every trigger-guarded table.

begin;

grant usage on schema riddle_private to service_role, riddle_app;

grant execute on function riddle_private.protect_invitation() to service_role, riddle_app;
grant execute on function riddle_private.cancel_demoted_admin_invitations() to service_role, riddle_app;
grant execute on function riddle_private.protect_puzzle_snapshot() to service_role, riddle_app;
grant execute on function riddle_private.lock_schedule(uuid) to service_role, riddle_app;
grant execute on function riddle_private.lock_puzzle_schedule() to service_role, riddle_app;
grant execute on function riddle_private.protect_played_schedule() to service_role, riddle_app;
grant execute on function riddle_private.prevent_history_removal() to service_role, riddle_app;
grant execute on function riddle_private.validate_challenge_result() to service_role, riddle_app;
grant execute on function riddle_private.prevent_point_history_change() to service_role, riddle_app;
grant execute on function riddle_private.protect_submission_identity() to service_role, riddle_app;

alter default privileges in schema riddle_private
  grant execute on functions to service_role, riddle_app;

commit;
