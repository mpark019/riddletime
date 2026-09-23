import { Pool } from "pg";
import { randomUUID } from "crypto";
import { env } from "@/lib/env";

// Owner-level pool: riddle_app has no privilege to write auth.users.
const adminPool = env.TEST_ADMIN_DATABASE_URL
  ? new Pool({ connectionString: env.TEST_ADMIN_DATABASE_URL })
  : null;

export function requireTestAdminPool() {
  if (!adminPool) {
    throw new Error(
      "TEST_ADMIN_DATABASE_URL is not set; see web/.env.test.example",
    );
  }
  return adminPool;
}

export async function createAuthUser(email?: string): Promise<string> {
  const id = randomUUID();
  await requireTestAdminPool().query(
    "insert into auth.users (id, email) values ($1, $2)",
    [id, email ?? `${id}@example.test`],
  );
  return id;
}
