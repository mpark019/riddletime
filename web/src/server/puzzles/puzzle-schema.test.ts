import { readFile } from "fs/promises";
import { describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser, insertPuzzle, requireTestAdminPool } from "@/server/test/fixtures";

async function createAdmin() {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Admin ', ($1::uuid)::text), 'admin')",
    [id],
  );
  return id;
}

async function createSharedDay(adminId: string) {
  const offset = 3000 + Math.floor(Math.random() * 1_000_000);
  const { rows } = await pool.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
     values (current_date + $2::int, 'shared', array['riddle'], 'fixed', '{"standard":{}}'::jsonb, 'standard', $1)
     returning id`,
    [adminId, offset],
  );
  return rows[0].id as string;
}

function scheduleChallenge(dailyId: string, puzzleId: string, type = "riddle") {
  return pool.query(
    `insert into challenges
       (daily_challenge_id, mode, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
     values ($1, 'shared', $3, $2, 'standard', 1, 120, '{"base_points":100}'::jsonb)
     returning id`,
    [dailyId, puzzleId, type],
  );
}

describe("puzzles table", () => {
  it("rejects a riddle without accepted answers and a letter puzzle without a target (AC-2)", async () => {
    const adminId = await createAdmin();
    await expect(insertPuzzle(pool, { createdBy: adminId, answerData: { accepted: [] } })).rejects.toThrow();
    await expect(
      insertPuzzle(pool, { createdBy: adminId, type: "character_puzzle", answerData: { accepted: ["x"] } }),
    ).rejects.toThrow();
  });

  it("lets an unused puzzle's content be edited and the row deleted (AC-4)", async () => {
    const adminId = await createAdmin();
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    await pool.query("update puzzles set prompt = 'Edited' where id = $1", [puzzleId]);
    const { rows } = await pool.query("select prompt from puzzles where id = $1", [puzzleId]);
    expect(rows[0].prompt).toBe("Edited");
    await pool.query("delete from puzzles where id = $1", [puzzleId]);
    const { rowCount } = await pool.query("select 1 from puzzles where id = $1", [puzzleId]);
    expect(rowCount).toBe(0);
  });

  it("freezes content and blocks deletion once a challenge references it, but allows status changes (AC-4)", async () => {
    const adminId = await createAdmin();
    const dailyId = await createSharedDay(adminId);
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    await scheduleChallenge(dailyId, puzzleId);

    await expect(pool.query("update puzzles set prompt = 'Changed' where id = $1", [puzzleId])).rejects.toThrow(/immutable/i);
    await expect(
      pool.query(`update puzzles set answer_data = '{"accepted":["x"]}'::jsonb where id = $1`, [puzzleId]),
    ).rejects.toThrow(/immutable/i);
    await expect(pool.query("delete from puzzles where id = $1", [puzzleId])).rejects.toThrow();

    await pool.query("update puzzles set status = 'retired' where id = $1", [puzzleId]);
    const { rows } = await pool.query("select status, prompt from puzzles where id = $1", [puzzleId]);
    expect(rows[0]).toEqual({ status: "retired", prompt: "What has keys but no locks?" });
  });

  it("lets a scheduled puzzle be renamed and un-named, and rejects blank or oversized names", async () => {
    const adminId = await createAdmin();
    const dailyId = await createSharedDay(adminId);
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    await scheduleChallenge(dailyId, puzzleId);

    await pool.query("update puzzles set name = 'Piano riddle' where id = $1", [puzzleId]);
    await pool.query("update puzzles set name = null where id = $1", [puzzleId]);
    await expect(pool.query("update puzzles set name = '   ' where id = $1", [puzzleId])).rejects.toThrow();
    await expect(pool.query("update puzzles set name = $2 where id = $1", [puzzleId, "x".repeat(81)])).rejects.toThrow();
    await expect(
      pool.query("update puzzles set name = 'Renamed', prompt = 'Changed' where id = $1", [puzzleId]),
    ).rejects.toThrow(/immutable/i);
  });

  it("requires a challenge's type to match its puzzle's type (AC-1)", async () => {
    const adminId = await createAdmin();
    const dailyId = await createSharedDay(adminId);
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    await expect(scheduleChallenge(dailyId, puzzleId, "character_puzzle")).rejects.toThrow();
  });

  it("refuses to schedule a retired puzzle (AC-9)", async () => {
    const adminId = await createAdmin();
    const dailyId = await createSharedDay(adminId);
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId, status: "retired" });
    await expect(scheduleChallenge(dailyId, puzzleId)).rejects.toThrow(/retired/i);
  });

  it("makes a concurrent edit and schedule serialize so a challenge never sees changed content (AC-11)", async () => {
    const adminId = await createAdmin();
    const dailyId = await createSharedDay(adminId);
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });

    const scheduler = await pool.connect();
    const editor = await pool.connect();
    try {
      await scheduler.query("begin");
      await scheduler.query(
        `insert into challenges
           (daily_challenge_id, mode, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
         values ($1, 'shared', 'riddle', $2, 'standard', 1, 120, '{"base_points":100}'::jsonb)`,
        [dailyId, puzzleId],
      );
      // The edit must wait for the scheduling transaction, then fail because the puzzle is now referenced.
      const edit = editor.query("update puzzles set prompt = 'Raced edit' where id = $1", [puzzleId]);
      edit.catch(() => undefined);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const { rowCount } = await pool.query(
          "select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like 'update puzzles set prompt = %Raced edit%'",
        );
        if (rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await scheduler.query("commit");
      await expect(edit).rejects.toThrow(/immutable/i);
    } finally {
      scheduler.release();
      editor.release();
    }
    const { rows } = await pool.query("select prompt from puzzles where id = $1", [puzzleId]);
    expect(rows[0].prompt).toBe("What has keys but no locks?");
  });

  it("does not store content on challenges any more (AC-1)", async () => {
    const { rows } = await pool.query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'challenges'
         and column_name in ('prompt', 'config', 'answer_data')`,
    );
    expect(rows).toEqual([]);
  });

  it("hands a deleted admin's puzzles, including scheduled ones, to the acting admin (AC-12)", async () => {
    const departing = await createAdmin();
    const acting = await createAdmin();
    const dailyId = await createSharedDay(acting);
    const scheduled = await insertPuzzle(pool, { createdBy: departing });
    const unused = await insertPuzzle(pool, { createdBy: departing });
    await scheduleChallenge(dailyId, scheduled);

    await pool.query("select riddle_private.delete_member_data($1, $2)", [departing, acting]);

    const { rows } = await pool.query(
      "select id, created_by from puzzles where id = any($1::uuid[])",
      [[scheduled, unused]],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.created_by === acting)).toBe(true);
  });

  it("aborts the migration instead of discarding content when challenges already has rows (AC-1)", async () => {
    const adminId = await createAdmin();
    await scheduleChallenge(await createSharedDay(adminId), await insertPuzzle(pool, { createdBy: adminId }));
    const migration = await readFile(
      new URL("../../../../database/migrations/021_puzzle_bank.sql", import.meta.url),
      "utf8",
    );
    const body = migration.replace(/^begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
    const client = await requireTestAdminPool().connect();
    try {
      await client.query("begin");
      await expect(client.query(body)).rejects.toThrow(/challenges already has rows/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
