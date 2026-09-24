begin;

alter table public.profiles
  add column name text check (name is null or length(btrim(name)) > 0),
  alter column display_name drop not null,
  add constraint profiles_player_display_name check (
    role <> 'player' or display_name is not null
  );

alter table public.invitations
  alter column display_name drop not null,
  add constraint invitations_player_display_name check (
    role <> 'player' or display_name is not null
  );

commit;
