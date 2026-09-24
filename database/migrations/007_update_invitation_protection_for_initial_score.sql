begin;

create or replace function riddle_private.protect_invitation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'Invitations must start pending' using errcode = '23514';
    end if;
  else
    if row(new.id, new.email, new.display_name, new.role, new.initial_score, new.invited_by, new.created_at)
       is distinct from row(old.id, old.email, old.display_name, old.role, old.initial_score, old.invited_by, old.created_at) then
      raise exception 'Invitation intent is immutable; cancel and reissue' using errcode = '23514';
    end if;
    if new.auth_user_id is distinct from old.auth_user_id
       and (old.auth_user_id is not null or old.status <> 'pending' or new.auth_user_id is null) then
      raise exception 'Invitation account may only be bound once while pending' using errcode = '23514';
    end if;
    if old.status <> 'pending' and row(new.status, new.accepted_at, new.cancelled_at)
       is distinct from row(old.status, old.accepted_at, old.cancelled_at) then
      raise exception 'Accepted and cancelled invitations are final' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'INSERT' or (new.role = 'admin' and new.status = 'accepted' and old.status = 'pending') then
    perform 1 from public.profiles where id = new.invited_by and role = 'admin' for update;
    if not found then
      raise exception 'Inviter must currently be an admin' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

commit;
