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
  type?: "riddle" | "character_puzzle" | "image_submission";
  prompt?: string;
  config?: object;
  answerData?: object;
  difficulty?: string;
  status?: "draft" | "active" | "retired";
  hint?: { text: string; costPoints: number };
}

// Accepts a Pool or PoolClient so a test can create the puzzle inside its own transaction.
export async function insertPuzzle(
  db: { query: Pool["query"] },
  fixture: PuzzleFixture,
): Promise<string> {
  const type = fixture.type ?? "riddle";
  const { rows } = await db.query(
    `insert into puzzles (type, prompt, config, answer_data, difficulty, status, created_by, hint, hint_cost_points)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9)
     returning id`,
    [
      type,
      fixture.prompt ?? (type === "riddle" ? "What has keys but no locks?" : type === "image_submission" ? "Draw a house" : "Letter game"),
      JSON.stringify(fixture.config ?? (type === "riddle" ? {} : type === "image_submission" ? { max_images: 2 } : { target_length: 4, character_set: "ABCD" })),
      JSON.stringify(fixture.answerData ?? (type === "riddle" ? { accepted: ["piano"] } : type === "image_submission" ? {} : { target: "ABCD" })),
      fixture.difficulty ?? "standard",
      fixture.status ?? "active",
      fixture.createdBy,
      fixture.hint?.text ?? null,
      fixture.hint?.costPoints ?? null,
    ],
  );
  return rows[0].id as string;
}

interface ManualPuzzleShape {
  type?: unknown;
  prompt?: unknown;
  accepted_answers?: unknown;
  target?: unknown;
}

// Schedule requests reference bank puzzles only; tests that describe a puzzle inline get it banked here first.
export async function withBankPuzzle<T extends object>(
  db: { query: Pool["query"] },
  body: T,
): Promise<Omit<T, "manual_puzzle"> & { puzzle_id?: string }> {
  const { manual_puzzle: manual, ...rest } = body as T & { manual_puzzle?: ManualPuzzleShape };
  if (!manual || typeof manual !== "object") return rest as never;

  const authorId = await createAuthUser();
  await db.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Author ', ($1::uuid)::text), 'admin')",
    [authorId],
  );
  const isRiddle = manual.type === "riddle";
  const target = String(manual.target).trim().toUpperCase();
  const accepted = Array.isArray(manual.accepted_answers)
    ? manual.accepted_answers.map((answer) => String(answer).trim())
    : [];
  const fixture: PuzzleFixture = {
    createdBy: authorId,
    type: isRiddle ? "riddle" : "character_puzzle",
    prompt: isRiddle ? String(manual.prompt).trim() : "Letter game",
    answerData: isRiddle ? { accepted } : { target },
    config: isRiddle ? {} : { target_length: target.length, character_set: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
    status: "active",
  };
  return { ...rest, puzzle_id: await insertPuzzle(db, fixture) } as never;
}
