begin;

-- Hosts without pg_cron (such as the disposable test database) finalize only when the player loads or submits.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule(
      'finalize-expired-riddle-sessions',
      '* * * * *',
      'select riddle_private.finalize_expired_sessions()'
    );
    -- pg_cron keeps one log row per run forever unless purged.
    perform cron.schedule(
      'purge-cron-run-details',
      '17 3 * * *',
      $purge$delete from cron.job_run_details where end_time < now() - interval '7 days'$purge$
    );
  else
    raise notice 'pg_cron is unavailable; expired sessions are not swept on a schedule';
  end if;
end;
$$;

commit;
