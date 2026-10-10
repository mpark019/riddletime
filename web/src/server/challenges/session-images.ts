import "server-only";
import type { PoolClient } from "pg";

// Used by deletion paths: collects the stored objects so they can be removed after the rows go.
export async function loadSessionImagePaths(
  client: PoolClient,
  scope: { scheduleId?: string; challengeId?: string; userId?: string },
): Promise<string[]> {
  if (!scope.scheduleId && !scope.challengeId && !scope.userId) {
    throw new Error("A session image lookup needs a scope");
  }
  const { rows } = await client.query(
    `select coalesce(array_agg(p), '{}') as paths
     from submissions s
     join challenges c on c.id = s.challenge_id,
     lateral unnest(s.image_paths) as p
     where ($1::uuid is null or c.daily_challenge_id = $1)
       and ($2::uuid is null or s.challenge_id = $2)
       and ($3::uuid is null or s.user_id = $3)`,
    [scope.scheduleId ?? null, scope.challengeId ?? null, scope.userId ?? null],
  );
  return rows[0].paths as string[];
}
