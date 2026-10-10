import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser, insertPuzzle, requireTestAdminPool } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({ getVerifiedUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { getChallengeSession, revealHint, submitChallenge } = await import("./challenges");
const { BadRequestError, ConflictError, NotFoundError } = await import("@/server/http/errors");
const { POST: hintRoute } = await import("@/app/api/challenge/[id]/hint/route");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

const HINT_TEXT = "Think about a musical instrument";

async function createProfile(role: "admin" | "player") {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat($2::text, ' ', ($1::uuid)::text), $2)",
    [id, role],
  );
  return id;
}

interface FixtureOptions {
  hint?: { text: string; cost: number } | null;
  penalty?: number;
  maxAttempts?: number;
  direction?: "past" | "future";
}

// Far-away dates keep these rows clear of the shared "today" fixture other suites use.
async function createFixture(options: FixtureOptions = {}) {
  const adminId = await createProfile("admin");
  const playerId = await createProfile("player");
  const offset = (options.direction === "past" ? -1 : 1) * (700_000 + Math.floor(Math.random() * 200_000));
  const { rows: dailyRows } = await pool.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
     values (current_date + $3::int, 'shared', array['riddle'], 'fixed', $1::jsonb, 'standard', $2)
     returning id`,
    [
      JSON.stringify({ standard: { types: { riddle: { time_limit_seconds: 600, max_attempts: options.maxAttempts ?? 1 } } } }),
      adminId,
      offset,
    ],
  );
  const hint = options.hint === undefined ? { text: HINT_TEXT, cost: 30 } : options.hint;
  const puzzleId = await insertPuzzle(pool, {
    createdBy: adminId,
    prompt: "What has keys but no locks?",
    answerData: { accepted: ["piano"] },
    ...(hint ? { hint: { text: hint.text, costPoints: hint.cost } } : {}),
  });
  const { rows: challengeRows } = await pool.query(
    `insert into challenges
       (daily_challenge_id, mode, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
     values ($1, 'shared', 'riddle', $2, 'standard', $3, 600, $4::jsonb)
     returning id`,
    [
      dailyRows[0].id,
      puzzleId,
      options.maxAttempts ?? 1,
      JSON.stringify({ base_points: 100, speed_bonuses: [], failure_penalty_points: options.penalty ?? 25 }),
    ],
  );
  const { rows: submissionRows } = await pool.query(
    "insert into submissions (challenge_id, challenge_mode, user_id) values ($1, 'shared', $2) returning id",
    [challengeRows[0].id, playerId],
  );
  getVerifiedUser.mockResolvedValue({ id: playerId });
  return {
    dailyId: dailyRows[0].id as string,
    challengeId: challengeRows[0].id as string,
    submissionId: submissionRows[0].id as string,
    playerId,
  };
}

async function resultFor(submissionId: string) {
  const { rows } = await pool.query(
    `select s.correct, s.scoring_breakdown, s.hint_used_at,
            (select sum(amount)::int from point_transactions where submission_id = s.id) as points
     from submissions s where s.id = $1`,
    [submissionId],
  );
  return rows[0];
}

describe("puzzle hints", () => {
  it("shows the cost before reveal and never the hint text (AC-3)", async () => {
    const { dailyId } = await createFixture();

    const { play } = await getChallengeSession(dailyId);

    expect(play).toMatchObject({ hint: { costPoints: 30, revealed: false } });
    expect(JSON.stringify(play)).not.toContain(HINT_TEXT);
  });

  it("reveals the hint once and does not charge twice (AC-2)", async () => {
    const { dailyId, submissionId } = await createFixture();

    const first = await revealHint(dailyId);
    const stamped = (await resultFor(submissionId)).hint_used_at;
    const second = await revealHint(dailyId);

    expect(first.play).toMatchObject({ hint: { costPoints: 30, revealed: true, text: HINT_TEXT } });
    expect(second.play).toMatchObject({ hint: { revealed: true, text: HINT_TEXT } });
    expect((await resultFor(submissionId)).hint_used_at).toEqual(stamped);
  });

  it("subtracts the cost from a correct answer (AC-4)", async () => {
    const { dailyId, submissionId } = await createFixture();
    await revealHint(dailyId);

    await submitChallenge(dailyId, "piano");

    expect(await resultFor(submissionId)).toMatchObject({
      correct: true,
      points: 70,
      scoring_breakdown: { base_points: 100, hint_cost_points: 30, total_points: 70 },
    });
  });

  it("clamps a correct answer at zero when the hint costs more than it earns (AC-4)", async () => {
    const { dailyId, submissionId } = await createFixture({ hint: { text: HINT_TEXT, cost: 150 } });
    await revealHint(dailyId);

    await submitChallenge(dailyId, "piano");

    expect(await resultFor(submissionId)).toMatchObject({
      correct: true,
      points: 0,
      scoring_breakdown: { hint_cost_points: 150, total_points: 0 },
    });
  });

  it("adds the cost to the failure penalty on a wrong final answer (AC-5)", async () => {
    const { dailyId, submissionId } = await createFixture({ penalty: 25 });
    await revealHint(dailyId);

    await submitChallenge(dailyId, "guitar");

    expect(await resultFor(submissionId)).toMatchObject({
      correct: false,
      points: -55,
      scoring_breakdown: { penalty_points: 25, hint_cost_points: 30, total_points: -55 },
    });
  });

  it("charges the hint when the deadline sweep finalizes the session (AC-5)", async () => {
    const { submissionId, playerId } = await createFixture({ penalty: 25, direction: "past" });
    await pool.query("update submissions set hint_used_at = now() where id = $1", [submissionId]);

    await requireTestAdminPool().query("select riddle_private.finalize_expired_sessions($1)", [playerId]);

    expect(await resultFor(submissionId)).toMatchObject({
      correct: false,
      points: -55,
      scoring_breakdown: { penalty_points: 25, hint_cost_points: 30, total_points: -55 },
    });
  });

  it("does not charge an unrevealed hint in the sweep (AC-6)", async () => {
    const { submissionId, playerId } = await createFixture({ penalty: 25, direction: "past" });

    await requireTestAdminPool().query("select riddle_private.finalize_expired_sessions($1)", [playerId]);

    const result = await resultFor(submissionId);
    expect(result.points).toBe(-25);
    expect(result.scoring_breakdown).not.toHaveProperty("hint_cost_points");
  });

  it("leaves results unchanged for a puzzle without a hint (AC-6)", async () => {
    const { dailyId, submissionId } = await createFixture({ hint: null });

    const { play } = await getChallengeSession(dailyId);
    await submitChallenge(dailyId, "piano");

    expect(play).not.toHaveProperty("hint");
    const result = await resultFor(submissionId);
    expect(result.points).toBe(100);
    expect(result.scoring_breakdown).not.toHaveProperty("hint_cost_points");
  });

  it("rejects a hint request once the session is finalized (AC-7)", async () => {
    const { dailyId, submissionId } = await createFixture();
    await submitChallenge(dailyId, "piano");

    await expect(revealHint(dailyId)).rejects.toBeInstanceOf(ConflictError);
    expect((await resultFor(submissionId)).hint_used_at).toBeNull();
  });

  it("rejects a hint request for a puzzle that has none", async () => {
    const { dailyId } = await createFixture({ hint: null });

    await expect(revealHint(dailyId)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("requires a started session", async () => {
    const { dailyId } = await createFixture();
    const other = await createProfile("player");
    getVerifiedUser.mockResolvedValue({ id: other });

    await expect(revealHint(dailyId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("serves the reveal through the route and refuses non-players (AC-2)", async () => {
    const { dailyId } = await createFixture();
    const ctx = { params: Promise.resolve({ id: dailyId }) } as never;

    const response = await hintRoute(new Request("http://localhost/api/challenge/hint", { method: "POST" }), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ play: { hint: { revealed: true, text: HINT_TEXT } } });

    getVerifiedUser.mockResolvedValue({ id: await createProfile("admin") });
    const refused = await hintRoute(new Request("http://localhost/api/challenge/hint", { method: "POST" }), ctx);
    expect(refused.status).toBe(403);
  });
});
