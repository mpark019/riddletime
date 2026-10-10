-- Activity gains image_added and image_removed, written by the server when a draft image changes.
alter table public.submission_activity drop constraint submission_activity_kind_check;
alter table public.submission_activity add constraint submission_activity_kind_check
  check (kind in ('away', 'back', 'typing', 'copy', 'paste', 'image_added', 'image_removed'));
