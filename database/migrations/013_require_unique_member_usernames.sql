begin;

-- display_name is the username for every account. Replace the former
-- player-only constraint with one case-insensitive invariant for all roles.
drop index if exists public.profiles_one_player_display_name;
drop index if exists public.profiles_one_player_login_name;
create unique index profiles_one_display_name
  on public.profiles(lower(display_name))
  where display_name is not null;

commit;
