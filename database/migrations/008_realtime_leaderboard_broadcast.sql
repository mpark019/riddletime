-- The app sends only an event name on this private channel; clients reload protected API data.
create policy "authenticated users receive leaderboard refreshes"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and realtime.topic() = 'riddletime:leaderboard'
);
