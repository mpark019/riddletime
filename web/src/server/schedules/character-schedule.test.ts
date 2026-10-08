import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({ getVerifiedUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { createSharedCharacterPuzzle, getScheduleDetail, listSchedules } = await import("./schedules");
const { ConflictError, ForbiddenError } = await import("@/server/http/errors");
const { POST } = await import("@/app/api/admin/generate-challenge/route");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

async function createProfile(role: "admin" | "spectator" | "player") {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Char ', ($1::uuid)::text), $2)",
    [id, role],
  );
  return id;
}

function futureDate() {
  const year = 2100 + Math.floor(Math.random() * 1800);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const FULL_SET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function validInput(overrides: { target?: string; maxAttempts?: number; config?: object } = {}) {
  return {
    active_date: futureDate(),
    mode: "shared",
    allowed_types: ["character_puzzle"],
    difficulty_selection: "fixed",
    difficulty_presets: {
      standard: {
        types: {
          character_puzzle: {
            time_limit_seconds: 120,
            max_attempts: overrides.maxAttempts ?? 6,
            generation_settings: {},
            config: overrides.config ?? {},
            scoring_policy: {
              base_points: 100,
              speed_bonuses: [{ under_ms: 30_000, points: 20 }],
              failure_penalty_points: 20,
            },
          },
        },
      },
    },
    selected_difficulty: "standard",
    manual_puzzle: { type: "character_puzzle", target: overrides.target ?? "crane7" },
  };
}

function postRequest(body: unknown) {
  return new Request("https://riddletime.example/api/admin/generate-challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function countSchedules(date: string) {
  const { rows } = await pool.query(
    "select count(*)::int as count from daily_challenges where active_date = $1::date",
    [date],
  );
  return rows[0].count as number;
}

describe("shared character puzzle scheduling", () => {
  it("stores the admin's word, uppercased, with the fixed alphabet and derived length (AC-1)", async () => {
    const adminId = await createProfile("admin");
    const input = validInput({ target: "  crane7 " });
    getVerifiedUser.mockResolvedValue({ id: adminId });

    const response = await POST(postRequest(input));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(JSON.stringify(body)).not.toContain("CRANE7");
    const { rows } = await pool.query(
      `select d.allowed_types, c.type, c.prompt, c.config, c.answer_data,
              c.max_attempts, c.time_limit_seconds, c.scoring_policy
       from daily_challenges d join challenges c on c.daily_challenge_id = d.id
       where d.id = $1`,
      [body.schedule_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      allowed_types: ["character_puzzle"],
      type: "character_puzzle",
      config: { target_length: 6, character_set: FULL_SET },
      answer_data: { target: "CRANE7" },
      max_attempts: 6,
      time_limit_seconds: 120,
    });
    expect(rows[0].prompt).toBe("Letter game");
    expect(rows[0].scoring_policy.failure_penalty_points).toBe(20);
  });

  it("supports a 50-character answer and a single character (AC-1)", async () => {
    const adminId = await createProfile("admin");
    getVerifiedUser.mockResolvedValue({ id: adminId });
    const long = "A1".repeat(25);
    const first = await createSharedCharacterPuzzle(validInput({ target: long }));
    const second = await createSharedCharacterPuzzle(validInput({ target: "z" }));
    const { rows } = await pool.query(
      "select answer_data->>'target' as target, (config->>'target_length')::int as length from challenges where daily_challenge_id = any($1)",
      [[first.scheduleId, second.scheduleId]],
    );
    expect(rows.map((row) => [row.target, row.length]).sort()).toEqual([[long, 50], ["Z", 1]]);
  });

  it("checks the admin role before validating the body (AC-1)", async () => {
    const playerId = await createProfile("player");
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const response = await POST(postRequest({ allowed_types: ["character_puzzle"] }));

    expect(response.status).toBe(403);
  });

  it.each(["spectator", "player"] as const)("rejects a %s without writing (AC-1)", async (role) => {
    const userId = await createProfile(role);
    const input = validInput();
    getVerifiedUser.mockResolvedValue({ id: userId });

    await expect(createSharedCharacterPuzzle(input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await countSchedules(input.active_date)).toBe(0);
  });

  it.each([
    ["an empty answer", "   "],
    ["a space inside", "AB CD"],
    ["punctuation", "AB-CD"],
    ["an accented letter", "CAFÉ"],
    ["more than 50 characters", "A".repeat(51)],
  ])("rejects %s and persists nothing (AC-2)", async (_name, target) => {
    const adminId = await createProfile("admin");
    const input = validInput({ target });
    getVerifiedUser.mockResolvedValue({ id: adminId });

    await expect(createSharedCharacterPuzzle(input)).rejects.toThrow();
    expect(await countSchedules(input.active_date)).toBe(0);
  });

  it("rejects a missing answer and any preset config (AC-2)", async () => {
    const adminId = await createProfile("admin");
    getVerifiedUser.mockResolvedValue({ id: adminId });
    const missing = validInput() as Record<string, unknown>;
    delete missing.manual_puzzle;
    await expect(createSharedCharacterPuzzle(missing)).rejects.toThrow();
    const withConfig = validInput({ config: { target_length: 6, character_set: "AB" } });
    await expect(createSharedCharacterPuzzle(withConfig)).rejects.toThrow();
    expect(await countSchedules(validInput().active_date)).toBe(0);
  });

  it("rejects an attempt count above the resource budget (AC-2)", async () => {
    const adminId = await createProfile("admin");
    const input = validInput({ maxAttempts: 101 });
    getVerifiedUser.mockResolvedValue({ id: adminId });

    await expect(createSharedCharacterPuzzle(input)).rejects.toThrow();
    expect(await countSchedules(input.active_date)).toBe(0);
  });

  it("requires explicit tries, with no riddle-style default (AC-2)", async () => {
    const adminId = await createProfile("admin");
    const input = validInput();
    delete (input.difficulty_presets.standard.types.character_puzzle as { max_attempts?: number }).max_attempts;
    getVerifiedUser.mockResolvedValue({ id: adminId });

    await expect(createSharedCharacterPuzzle(input)).rejects.toThrow();
    expect(await countSchedules(input.active_date)).toBe(0);
  });

  it("rejects a riddle puzzle payload and mixed types (AC-2)", async () => {
    const adminId = await createProfile("admin");
    getVerifiedUser.mockResolvedValue({ id: adminId });
    const withRiddle = {
      ...validInput(),
      manual_puzzle: { type: "riddle", prompt: "x", accepted_answers: ["y"] },
    };
    await expect(createSharedCharacterPuzzle(withRiddle)).rejects.toThrow();
    const mixed = { ...validInput(), allowed_types: ["character_puzzle", "riddle"] };
    await expect(createSharedCharacterPuzzle(mixed)).rejects.toThrow();
  });

  it("returns a conflict for a duplicate date and keeps one puzzle (AC-1)", async () => {
    const adminId = await createProfile("admin");
    const input = validInput();
    getVerifiedUser.mockResolvedValue({ id: adminId });
    await createSharedCharacterPuzzle(input);

    await expect(createSharedCharacterPuzzle(input)).rejects.toBeInstanceOf(ConflictError);
    const { rows } = await pool.query(
      `select count(*)::int as count from challenges c
       join daily_challenges d on d.id = c.daily_challenge_id where d.active_date = $1::date`,
      [input.active_date],
    );
    expect(rows[0].count).toBe(1);
  });

  it("shows the admin the target in list and detail views (AC-10)", async () => {
    const adminId = await createProfile("admin");
    const input = validInput();
    getVerifiedUser.mockResolvedValue({ id: adminId });
    const result = await createSharedCharacterPuzzle(input);

    const listed = (await listSchedules()).find((entry) => entry.id === result.scheduleId);
    const detail = await getScheduleDetail(result.scheduleId);

    expect(listed?.type).toBe("character_puzzle");
    expect(listed?.acceptedAnswers).toEqual(["CRANE7"]);
    expect(detail.schedule.acceptedAnswers).toEqual(listed?.acceptedAnswers);
  });
});
