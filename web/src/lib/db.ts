import "server-only";
import { Pool, type PoolClient } from "pg";
import { env } from "@/lib/env";

// Postgres error codes worth retrying the whole transaction for.
const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_DETECTED = "40P01";
const RETRYABLE_CODES = new Set([SERIALIZATION_FAILURE, DEADLOCK_DETECTED]);
const MAX_RETRIES = 3;

export const pool = new Pool({ connectionString: env.DATABASE_URL });

// Inside `fn`, only use positional `client.query(text, values)` — a named
// prepared statement (`{ name, text, values }`) can silently misbehave under
// Supabase's transaction-mode pooler when reused on a different connection.
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const client = await pool.connect();
    let releaseAsBroken = false;
    try {
      await client.query("begin");
      await client.query("select set_config('timezone', $1, true)", [env.APP_TIMEZONE]);
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      try {
        await client.query("rollback");
      } catch (rollbackErr) {
        // The connection may still be mid-transaction and unsafe to reuse;
        // let the pool discard it instead of returning it to circulation.
        releaseAsBroken = true;
        console.error("Rollback failed:", rollbackErr);
      }
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE_CODES.has(code) && attempt < MAX_RETRIES) {
        continue;
      }
      throw err;
    } finally {
      client.release(releaseAsBroken);
    }
  }
}
