-- Minimal local stand-ins for what Supabase provisions on a real project,
-- just enough for 001_initial_schema.sql to apply against plain Postgres 17.

create role anon noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role authenticated noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role service_role noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);
