import "server-only";
import { withTransaction } from "@/lib/db";
import { requirePlayer } from "@/server/identity/identity";
import { NotFoundError } from "@/server/http/errors";

export type ActivityKind = "away" | "back" | "typing" | "copy" | "paste";

export const MAX_ACTIVITY_EVENTS = 300;

export async function recordActivity(
  dailyChallengeId: string,
  kind: ActivityKind,
): Promise<{ recorded: boolean }> {
  return withTransaction(async (client) => {
    const player = await requirePlayer(client);

    // The row lock serializes this with submit, the expiry sweep, and concurrent activity requests.
    const { rows } = await client.query(
      `select s.id,
              (s.submitted_at is not null or s.review_submitted_at is not null) as finalized,
              coalesce(riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, current_setting('timezone')) <= clock_timestamp(), false) as expired
       from daily_challenges d
       join challenges c on c.daily_challenge_id = d.id and (c.mode = 'shared' or c.assigned_to = $2)
       join submissions s on s.challenge_id = c.id and s.user_id = $2
       where d.id = $1
       for update of s`,
      [dailyChallengeId, player.id],
    );
    const session = rows[0];
    if (!session) throw new NotFoundError("No saved session for that challenge");
    if (session.finalized || session.expired) return { recorded: false };

    const { rows: stateRows } = await client.query(
      `select count(*)::int as total,
              (select a.kind from submission_activity a
                where a.submission_id = $1 and a.kind in ('away', 'back')
                order by a.at desc, a.id desc limit 1) as last_presence
       from submission_activity where submission_id = $1`,
      [session.id],
    );
    const { total, last_presence: lastPresence } = stateRows[0];
    if (total >= MAX_ACTIVITY_EVENTS) return { recorded: false };
    if (kind === "away" && lastPresence === "away") return { recorded: false };
    if (kind === "back" && lastPresence !== "away") return { recorded: false };

    await client.query(
      "insert into submission_activity (submission_id, kind) values ($1, $2)",
      [session.id, kind],
    );
    return { recorded: true };
  });
}
