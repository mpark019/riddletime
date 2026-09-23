-- Bootstraps the first admin profile. Run by hand, as the database owner
-- — never as an API endpoint or on first-login auto-promotion.
--
-- 1. Create the Supabase Auth account first (dashboard, or
--    `supabase.auth.admin.createUser`) and note its user id.
-- 2. Replace the id and name below and run this against that
--    environment's database as its owner.

begin;

insert into public.profiles (id, display_name, role)
values ('00000000-0000-0000-0000-000000000000', 'Replace Me', 'admin');

commit;
