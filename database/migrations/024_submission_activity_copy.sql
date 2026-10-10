-- Activity gains copy (text taken from the riddle prompt) and paste (into the answer box) events.
alter table public.submission_activity drop constraint submission_activity_kind_check;
alter table public.submission_activity add constraint submission_activity_kind_check
  check (kind in ('away', 'back', 'typing', 'copy', 'paste'));
