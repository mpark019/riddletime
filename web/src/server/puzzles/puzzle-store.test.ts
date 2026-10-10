import { describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import { ConflictError } from "@/server/http/errors";
import { createAuthUser, insertPuzzle } from "@/server/test/fixtures";
import { resolvePersonalPuzzle, resolveSharedPuzzle } from "./puzzle-store";

async function createProfile(role: "admin" | "player") {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Store ', ($1::uuid)::text), $2)",
    [id, role],
  );
  return id;
}

async function createDay(adminId: string, mode: "shared" | "personal") {
  const offset = 5000 + Math.floor(Math.random() * 1_000_000);
  const { rows } = await pool.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
     values (current_date + $2::int, $3, array['riddle'], 'fixed', '{"easy":{}}'::jsonb, 'easy', $1)
     returning id`,
    [adminId, offset, mode],
  );
  return rows[0].id as string;
}

// Holds a transaction that has chosen the puzzle but not yet inserted its challenge, then
// starts a second chooser. Without a self-conflicting lock the second one passes the check.
async function secondChooserOutcome(
  choose: (client: import("pg").PoolClient, adminId: string, puzzleId: string, playerId: string) => Promise<unknown>,
  firstMode: "shared" | "personal",
) {
  const adminId = await createProfile("admin");
  const playerId = await createProfile("player");
  const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
  const dayId = await createDay(adminId, firstMode);
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await first.query("begin");
    await second.query("begin");
    await choose(first, adminId, puzzleId, playerId);

    const secondResult = choose(second, adminId, puzzleId, playerId).then(
      () => "passed" as const,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await first.query(
      `insert into challenges
         (daily_challenge_id, mode, assigned_to, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
       values ($1, $2, $3, 'riddle', $4, 'easy', 1, 60, '{"base_points":1}'::jsonb)`,
      [dayId, firstMode, firstMode === "personal" ? playerId : null, puzzleId],
    );
    await first.query("commit");
    return await secondResult;
  } finally {
    await second.query("rollback");
    first.release();
    second.release();
  }
}

describe("puzzle choice under concurrency", () => {
  it("makes a second shared chooser wait, then reject the puzzle the first one took (AC-8)", async () => {
    const outcome = await secondChooserOutcome(
      (client, adminId, puzzleId) =>
        resolveSharedPuzzle(client, adminId, { kind: "existing", puzzleId, type: "riddle" }, "easy"),
      "shared",
    );
    expect(outcome).toBeInstanceOf(ConflictError);
  });

  it("makes a second personal chooser wait, then reject a player who got it meanwhile (AC-8)", async () => {
    const outcome = await secondChooserOutcome(
      (client, adminId, puzzleId, playerId) =>
        resolvePersonalPuzzle(client, adminId, { kind: "existing", puzzleId, type: "riddle" }, "easy", [playerId]),
      "personal",
    );
    expect(outcome).toBeInstanceOf(ConflictError);
  });
});
