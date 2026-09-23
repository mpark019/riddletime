-- Trusted manual puzzle fixture for today's shared riddle, in the shape
-- generation would otherwise produce. Run by hand, once per day, as the
-- database owner or a role with the same INSERT rights as riddle_app.
-- Requires an admin profile to already exist (see 001_bootstrap_admin.sql).

begin;

with admin_profile as (
  select id from public.profiles where role = 'admin' limit 1
), daily as (
  insert into public.daily_challenges
    (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
  select
    current_date,
    'shared',
    array['riddle'],
    'fixed',
    '{"standard": {"types": {"riddle": {"time_limit_seconds": 120, "max_attempts": 1}}}}'::jsonb,
    'standard',
    id
  from admin_profile
  returning id
)
insert into public.challenges
  (daily_challenge_id, mode, type, difficulty, prompt, config, answer_data, max_attempts, time_limit_seconds, scoring_policy)
select
  id,
  'shared',
  'riddle',
  'standard',
  'What has keys but no locks, space but no room, and you can enter but not go inside?',
  '{}'::jsonb,
  '{"accepted": ["a keyboard", "keyboard"]}'::jsonb,
  1,
  120,
  '{"base_points": 100, "speed_bonuses": []}'::jsonb
from daily;

commit;
