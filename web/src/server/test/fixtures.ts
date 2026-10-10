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

interface PuzzleFixture {
  createdBy: string;
  type?: "riddle" | "character_puzzle";
  prompt?: string;
  config?: object;
  answerData?: object;
  difficulty?: string;
  status?: "active" | "retired";
}

// Accepts a Pool or PoolClient so a test can create the puzzle inside its own transaction.
export async function insertPuzzle(
  db: { query: Pool["query"] },
  fixture: PuzzleFixture,
): Promise<string> {
  const type = fixture.type ?? "riddle";
  const { rows } = await db.query(
    `insert into puzzles (type, prompt, config, answer_data, difficulty, status, created_by)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
     returning id`,
    [
      type,
      fixture.prompt ?? (type === "riddle" ? "What has keys but no locks?" : "Letter game"),
      JSON.stringify(fixture.config ?? (type === "riddle" ? {} : { target_length: 4, character_set: "ABCD" })),
      JSON.stringify(fixture.answerData ?? (type === "riddle" ? { accepted: ["piano"] } : { target: "ABCD" })),
      fixture.difficulty ?? "standard",
      fixture.status ?? "active",
      fixture.createdBy,
    ],
  );
  return rows[0].id as string;
}
