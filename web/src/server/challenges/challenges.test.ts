import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser, requireTestAdminPool } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({
  getVerifiedUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { getTodayChallenge, startChallenge, submitChallenge } = await import(
  "./challenges"
);
const { NotFoundError } = await import("@/server/http/errors");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

// daily_challenges allows only one row per active_date, so every test here
// shares this one seeded "today" schedule instead of creating its own.
async function ensureTodaysSharedRiddle() {
  const adminId = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, 'Admin', 'admin')",
    [adminId],
  );

  const { rows: existingDaily } = await pool.query(
    "select id from daily_challenges where active_date = current_date and mode = 'shared'",
  );
  const dailyId =
    existingDaily[0]?.id ??
    (
      await pool.query(
        `insert into daily_challenges
           (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
         values (current_date, 'shared', array['riddle'], 'fixed', $1::jsonb, 'standard', $2)
         returning id`,
        [
          JSON.stringify({
            standard: { types: { riddle: { time_limit_seconds: 120, max_attempts: 1 } } },
          }),
          adminId,
        ],
      )
    ).rows[0].id;

  const { rows: existingChallenge } = await pool.query(
    "select id, prompt from challenges where daily_challenge_id = $1 and mode = 'shared'",
    [dailyId],
  );
  if (existingChallenge[0]) {
    return { dailyId, challengeId: existingChallenge[0].id, prompt: existingChallenge[0].prompt };
  }

  const prompt = "What has keys but no locks?";
  const { rows } = await pool.query(
    `insert into challenges
       (daily_challenge_id, mode, type, difficulty, prompt, config, answer_data, max_attempts, time_limit_seconds, scoring_policy)
     values ($1, 'shared', 'riddle', 'standard', $2, '{}'::jsonb, $3::jsonb, 1, 120, $4::jsonb)
     returning id`,
    [
      dailyId,
      prompt,
      JSON.stringify({ accepted: ["piano", "a piano"] }),
      JSON.stringify({ base_points: 100, speed_bonuses: [] }),
    ],
  );
  return { dailyId, challengeId: rows[0].id, prompt };
}

async function createPlayer() {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, 'Player', 'player')",
    [id],
  );
  return id;
}

// submissions_protect_identity blocks changing started_at through any normal
// write, by design. Simulating "time has already passed" for a deadline test
// needs the owner connection to bypass triggers for this one update only.
async function backdateSubmissionStart(submissionId: string, secondsAgo: number) {
  const admin = requireTestAdminPool();
  await admin.query("begin");
  try {
    await admin.query("set local session_replication_role = replica");
    await admin.query(
      "update submissions set started_at = started_at - ($2 * interval '1 second') where id = $1",
      [submissionId, secondsAgo],
    );
    await admin.query("commit");
  } catch (err) {
    await admin.query("rollback");
    throw err;
  }
}

describe("start -> submit -> stored score", () => {
  it("starts idempotently, grades a correct answer, and stores the score", async () => {
    const { dailyId, prompt } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const started = await startChallenge(dailyId);
    expect(started.prompt).toBe(prompt);

    const startedAgain = await startChallenge(dailyId);
    expect(startedAgain.submissionId).toBe(started.submissionId);

    const result = await submitChallenge(dailyId, "A Piano!");
    expect(result.correct).toBe(true);
    expect(result.finalized).toBe(true);
    expect(result.scoringBreakdown).toMatchObject({ total_points: 100 });

    const { rows } = await pool.query(
      "select amount, kind from point_transactions where user_id = $1",
      [playerId],
    );
    expect(rows).toEqual([{ amount: 100, kind: "challenge_result" }]);

    const repeat = await submitChallenge(dailyId, "guitar");
    expect(repeat.alreadyFinalized).toBe(true);
    expect(repeat.correct).toBe(true);

    const { rows: afterRepeat } = await pool.query(
      "select count(*)::int as count from point_transactions where user_id = $1",
      [playerId],
    );
    expect(afterRepeat[0].count).toBe(1);
  });

  it("grades an incorrect answer as a zero-point stored result", async () => {
    const { dailyId } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    await startChallenge(dailyId);
    const result = await submitChallenge(dailyId, "guitar");
    expect(result.correct).toBe(false);
    expect(result.finalized).toBe(true);
    expect(result.scoringBreakdown).toMatchObject({ total_points: 0 });

    const { rows } = await pool.query(
      "select amount from point_transactions where user_id = $1",
      [playerId],
    );
    expect(rows).toEqual([{ amount: 0 }]);
  });

  it("rejects Submit before Start", async () => {
    const { dailyId } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    await expect(submitChallenge(dailyId, "piano")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("finalizes an expired session with zero points instead of grading the guess (AC-1)", async () => {
    const { dailyId } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const started = await startChallenge(dailyId);
    await backdateSubmissionStart(started.submissionId, started.timeLimitSeconds + 5);

    const result = await submitChallenge(dailyId, "a piano");
    expect(result.correct).toBe(false);
    expect(result.finalized).toBe(true);
    expect(result.scoringBreakdown).toMatchObject({ total_points: 0 });

    const { rows } = await pool.query(
      `select time_taken_ms, submitted_at, started_at
       from submissions where id = $1`,
      [started.submissionId],
    );
    expect(Number(rows[0].time_taken_ms)).toBe(started.timeLimitSeconds * 1000);
    expect(rows[0].submitted_at.getTime() - rows[0].started_at.getTime()).toBe(
      started.timeLimitSeconds * 1000,
    );
  });

  it("retrying an expired session returns the stored zero-point result without a second award (AC-2)", async () => {
    const { dailyId } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const started = await startChallenge(dailyId);
    await backdateSubmissionStart(started.submissionId, started.timeLimitSeconds + 5);
    await submitChallenge(dailyId, "a piano");

    const retry = await submitChallenge(dailyId, "a piano");
    expect(retry.alreadyFinalized).toBe(true);
    expect(retry.correct).toBe(false);

    const { rows } = await pool.query(
      "select count(*)::int as count, coalesce(sum(amount), 0)::int as total from point_transactions where user_id = $1",
      [playerId],
    );
    expect(rows[0]).toEqual({ count: 1, total: 0 });
  });
});

describe("getTodayChallenge access", () => {
  it("returns the minimal schedule shape for an admin (AC-1)", async () => {
    const { dailyId } = await ensureTodaysSharedRiddle();
    const adminId = await createAuthUser();
    await pool.query(
      "insert into profiles (id, display_name, role) values ($1, 'Admin Viewer', 'admin')",
      [adminId],
    );
    getVerifiedUser.mockResolvedValue({ id: adminId });

    const result = await getTodayChallenge();
    expect(result).toEqual({
      schedule: { id: dailyId, mode: "shared", allowedTypes: ["riddle"] },
    });
  });

  it("returns the minimal schedule shape for a spectator (AC-2)", async () => {
    const { dailyId } = await ensureTodaysSharedRiddle();
    const spectatorId = await createAuthUser();
    await pool.query(
      "insert into profiles (id, display_name, role) values ($1, 'Spectator Viewer', 'spectator')",
      [spectatorId],
    );
    getVerifiedUser.mockResolvedValue({ id: spectatorId });

    const result = await getTodayChallenge();
    expect(result).toEqual({
      schedule: { id: dailyId, mode: "shared", allowedTypes: ["riddle"] },
    });
  });

  it("still rejects an unauthenticated caller (AC-3)", async () => {
    getVerifiedUser.mockResolvedValue(null);
    await expect(getTodayChallenge()).rejects.toBeTruthy();
  });
});

describe("stored puzzle shape validation", () => {
  // submitChallenge doesn't filter by active_date, so a non-today schedule
  // is a safe way to set up a malformed fixture without colliding with the
  // real "today" shared puzzle other tests in this file depend on.
  async function makeMalformedSharedChallenge(answerData: unknown, scoringPolicy: unknown) {
    // A large random past offset, not a fixed date, so reruns against the
    // same persistent test database never collide on active_date.
    const daysAgo = 1000 + Math.floor(Math.random() * 1_000_000);
    const adminId = await createAuthUser();
    await pool.query(
      "insert into profiles (id, display_name, role) values ($1, 'Admin', 'admin')",
      [adminId],
    );
    const { rows: dailyRows } = await pool.query(
      `insert into daily_challenges
         (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
       values (current_date - $3::int, 'shared', array['riddle'], 'fixed', $1::jsonb, 'standard', $2)
       returning id`,
      [
        JSON.stringify({ standard: { types: { riddle: { time_limit_seconds: 120, max_attempts: 1 } } } }),
        adminId,
        daysAgo,
      ],
    );
    const dailyId = dailyRows[0].id;
    const { rows: challengeRows } = await pool.query(
      `insert into challenges
         (daily_challenge_id, mode, type, difficulty, prompt, config, answer_data, max_attempts, time_limit_seconds, scoring_policy)
       values ($1, 'shared', 'riddle', 'standard', 'malformed fixture', '{}'::jsonb, $2::jsonb, 1, 120, $3::jsonb)
       returning id`,
      [dailyId, JSON.stringify(answerData), JSON.stringify(scoringPolicy)],
    );
    const challengeId = challengeRows[0].id;

    const playerId = await createAuthUser();
    await pool.query(
      "insert into profiles (id, display_name, role) values ($1, 'Player', 'player')",
      [playerId],
    );
    const { rows: submissionRows } = await pool.query(
      `insert into submissions (challenge_id, challenge_mode, user_id)
       values ($1, 'shared', $2) returning id`,
      [challengeId, playerId],
    );
    return { dailyId, playerId, submissionId: submissionRows[0].id };
  }

  it("fails predictably, not with an unhandled TypeError, on a non-string accepted answer (AC-1)", async () => {
    const { dailyId, playerId } = await makeMalformedSharedChallenge(
      { accepted: [123] },
      { base_points: 100, speed_bonuses: [] },
    );
    getVerifiedUser.mockResolvedValue({ id: playerId });

    await expect(submitChallenge(dailyId, "anything")).rejects.not.toBeInstanceOf(
      TypeError,
    );
  });

  it("fails predictably on a non-numeric base_points (AC-2)", async () => {
    const { dailyId, playerId } = await makeMalformedSharedChallenge(
      { accepted: ["piano"] },
      { base_points: "one hundred", speed_bonuses: [] },
    );
    getVerifiedUser.mockResolvedValue({ id: playerId });

    await expect(submitChallenge(dailyId, "piano")).rejects.toBeTruthy();
  });

  it("finalizes an expired session with zero points even with malformed puzzle data", async () => {
    const { dailyId, playerId, submissionId } = await makeMalformedSharedChallenge(
      { accepted: [123] },
      { base_points: "not a number" },
    );
    getVerifiedUser.mockResolvedValue({ id: playerId });
    await backdateSubmissionStart(submissionId, 200);

    const result = await submitChallenge(dailyId, "anything");
    expect(result.correct).toBe(false);
    expect(result.finalized).toBe(true);
    expect(result.scoringBreakdown).toMatchObject({ total_points: 0 });
  });

  it("returns the stored result for an already-finalized session even with malformed puzzle data", async () => {
    const { dailyId, playerId, submissionId } = await makeMalformedSharedChallenge(
      { accepted: [123] },
      { base_points: "not a number" },
    );
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const admin = requireTestAdminPool();
    await admin.query("begin");
    await admin.query("set local session_replication_role = replica");
    await admin.query(
      `update submissions s
       set submitted_at = now_at.t,
           time_taken_ms = floor(extract(epoch from (now_at.t - s.started_at)) * 1000),
           correct = true,
           scoring_breakdown = '{"total_points": 50}'::jsonb
       from (select clock_timestamp() as t) now_at
       where s.id = $1`,
      [submissionId],
    );
    await admin.query("commit");

    const result = await submitChallenge(dailyId, "anything");
    expect(result.alreadyFinalized).toBe(true);
    expect(result.correct).toBe(true);
    expect(result.scoringBreakdown).toMatchObject({ total_points: 50 });
  });
});
