import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser, insertPuzzle } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({ getVerifiedUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { POST } = await import("@/app/api/admin/generate-challenge/route");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

async function createProfile(role: "admin" | "player", displayName?: string) {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, $2, $3)",
    [id, displayName ?? `Bank ${id}`, role],
  );
  return id;
}

function futureDate() {
  const year = 2100 + Math.floor(Math.random() * 1800);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const scoring = { base_points: 100, speed_bonuses: [], failure_penalty_points: 20 };

function riddlePresets() {
  return {
    easy: {
      types: {
        riddle: { time_limit_seconds: 90, max_attempts: 2, generation_settings: {}, config: {}, scoring_policy: scoring },
      },
    },
  };
}

function sharedBody(date: string, puzzle: object) {
  return {
    active_date: date,
    mode: "shared",
    allowed_types: ["riddle"],
    difficulty_selection: "fixed",
    difficulty_presets: riddlePresets(),
    selected_difficulty: "easy",
    ...puzzle,
  };
}

function personalBody(date: string, playerIds: string[], puzzle: object) {
  return {
    active_date: date,
    mode: "personal",
    player_ids: playerIds,
    allowed_types: ["riddle"],
    difficulty_selection: "fixed",
    difficulty_presets: riddlePresets(),
    selected_difficulty: "easy",
    ...puzzle,
  };
}

function post(body: unknown) {
  return POST(new Request("https://riddletime.example/api/admin/generate-challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function asNewAdmin() {
  const adminId = await createProfile("admin");
  getVerifiedUser.mockResolvedValue({ id: adminId });
  return adminId;
}

async function challengesOn(date: string) {
  const { rows } = await pool.query(
    `select c.puzzle_id, c.assigned_to, c.mode, c.max_attempts, c.time_limit_seconds, c.difficulty
     from challenges c join daily_challenges d on d.id = c.daily_challenge_id
     where d.active_date = $1::date order by c.created_at`,
    [date],
  );
  return rows;
}

describe("scheduling from the puzzle bank", () => {
  it("schedules a shared day from an existing puzzle without creating another (AC-5)", async () => {
    const adminId = await asNewAdmin();
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId, prompt: "Banked riddle" });
    const date = futureDate();

    const response = await post(sharedBody(date, { puzzle_id: puzzleId }));

    expect(response.status).toBe(201);
    expect(await challengesOn(date)).toEqual([{
      puzzle_id: puzzleId,
      assigned_to: null,
      mode: "shared",
      max_attempts: 2,
      time_limit_seconds: 90,
      difficulty: "easy",
    }]);
    const { rows } = await pool.query("select id from puzzles where created_by = $1", [adminId]);
    expect(rows).toEqual([{ id: puzzleId }]);
  });

  it("points every selected player's challenge at the same puzzle (AC-6)", async () => {
    const adminId = await asNewAdmin();
    const players = [await createProfile("player"), await createProfile("player"), await createProfile("player")];
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    const date = futureDate();

    const response = await post(personalBody(date, players, { puzzle_id: puzzleId }));

    expect(response.status).toBe(201);
    const rows = await challengesOn(date);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.puzzle_id))).toEqual(new Set([puzzleId]));
    expect(rows.map((row) => row.assigned_to).sort()).toEqual([...players].sort());
  });

  it("creates a bank puzzle and its challenge together from manual_puzzle (AC-7)", async () => {
    await asNewAdmin();
    const date = futureDate();
    const prompt = `Manual ${randomUUID()}`;

    const response = await post(sharedBody(date, {
      manual_puzzle: { type: "riddle", prompt: `  ${prompt}  `, accepted_answers: ["piano"] },
    }));

    expect(response.status).toBe(201);
    const [challenge] = await challengesOn(date);
    const { rows } = await pool.query("select prompt, status, difficulty from puzzles where id = $1", [challenge.puzzle_id]);
    expect(rows).toEqual([{ prompt, status: "active", difficulty: "easy" }]);
  });

  it("rejects a request that supplies both or neither of puzzle_id and manual_puzzle (AC-7)", async () => {
    const adminId = await asNewAdmin();
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    const manual = { type: "riddle", prompt: "Both", accepted_answers: ["x"] };
    const dateBoth = futureDate();
    const dateNeither = futureDate();

    expect((await post(sharedBody(dateBoth, { puzzle_id: puzzleId, manual_puzzle: manual }))).status).toBe(400);
    expect((await post(sharedBody(dateNeither, {}))).status).toBe(400);
    expect(await challengesOn(dateBoth)).toEqual([]);
    expect(await challengesOn(dateNeither)).toEqual([]);
  });

  it("rejects a retired, unknown, or wrong-type puzzle and persists nothing (AC-9)", async () => {
    const adminId = await asNewAdmin();
    const retired = await insertPuzzle(pool, { createdBy: adminId, status: "retired" });
    const letter = await insertPuzzle(pool, { createdBy: adminId, type: "character_puzzle" });
    const cases = [retired, letter, randomUUID()];

    for (const puzzleId of cases) {
      const date = futureDate();
      const response = await post(sharedBody(date, { puzzle_id: puzzleId }));
      expect(response.status).toBe(400);
      expect(await challengesOn(date)).toEqual([]);
      const { rowCount } = await pool.query("select 1 from daily_challenges where active_date = $1::date", [date]);
      expect(rowCount).toBe(0);
    }
  });

  it("blocks giving a player a puzzle they already had, naming them, and persists nothing (AC-8)", async () => {
    const adminId = await asNewAdmin();
    const seen = await createProfile("player", `Seen ${randomUUID()}`);
    const fresh = await createProfile("player");
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    const first = futureDate();
    const second = futureDate();
    expect((await post(personalBody(first, [seen], { puzzle_id: puzzleId }))).status).toBe(201);

    const response = await post(personalBody(second, [seen, fresh], { puzzle_id: puzzleId }));

    expect(response.status).toBe(409);
    const { rows } = await pool.query("select display_name from profiles where id = $1", [seen]);
    expect(JSON.stringify(await response.json())).toContain(rows[0].display_name);
    expect(await challengesOn(second)).toEqual([]);
  });

  it("blocks reusing a puzzle on a shared day that every player already saw (AC-8)", async () => {
    const adminId = await asNewAdmin();
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    expect((await post(sharedBody(futureDate(), { puzzle_id: puzzleId }))).status).toBe(201);

    const again = futureDate();
    expect((await post(sharedBody(again, { puzzle_id: puzzleId }))).status).toBe(409);
    const player = await createProfile("player");
    const personal = futureDate();
    expect((await post(personalBody(personal, [player], { puzzle_id: puzzleId }))).status).toBe(409);
    expect(await challengesOn(again)).toEqual([]);
    expect(await challengesOn(personal)).toEqual([]);
  });
});
