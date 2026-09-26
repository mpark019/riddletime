begin;

-- A player's public display name is also their login username. Keep the
-- identifier case-insensitively unique without restricting spectator/admin
-- display names.
create unique index profiles_one_player_display_name
  on public.profiles(lower(display_name))
  where role = 'player';

commit;
