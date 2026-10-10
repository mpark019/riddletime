import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser, insertPuzzle, requireTestAdminPool } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({ getVerifiedUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { getChallengeSession, submitChallenge } = await import("./challenges");
const { BadRequestError } = await import("@/server/http/errors");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

const CONFIG = { target_length: 5, character_set: "ABCD123" };

async function createProfile(role: "admin" | "player") {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Char ', ($1::uuid)::text), $2)",
    [id, role],
  );
  return id;
}

async function createStartedCharacterGame(options: {
  target?: string;
  maxAttempts?: number;
  failurePenalty?: number;
} = {}) {
  const { target = "AB1CD", maxAttempts = 3, failurePenalty = 20 } = options;
  const adminId = await createProfile("admin");
  const daysAgo = 1000 + Math.floor(Math.random() * 1_000_000);
  const { rows: dailyRows } = await pool.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
     values (current_date + $3::int, 'shared', array['character_puzzle'], 'fixed', $1::jsonb, 'standard', $2)
     returning id`,
    [
      JSON.stringify({
        standard: { types: { character_puzzle: { time_limit_seconds: 120, max_attempts: maxAttempts } } },
      }),
      adminId,
      daysAgo,
    ],
  );
  const puzzleId = await insertPuzzle(pool, {
    createdBy: adminId,
    type: "character_puzzle",
    prompt: "Guess the code",
    config: CONFIG,
    answerData: { target },
  });
  const { rows: challengeRows } = await pool.query(
    `insert into challenges
       (daily_challenge_id, mode, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
     values ($1, 'shared', 'character_puzzle', $2, 'standard', $3, 120, $4::jsonb)
     returning id`,
    [
      dailyRows[0].id,
      puzzleId,
      maxAttempts,
      JSON.stringify({
        base_points: 100,
        speed_bonuses: [],
        failure_penalty_points: failurePenalty,
      }),
    ],
  );
  const playerId = await createProfile("player");
  const { rows: submissionRows } = await pool.query(
    `insert into submissions (challenge_id, challenge_mode, user_id)
     values ($1, 'shared', $2) returning id`,
    [challengeRows[0].id, playerId],
  );
  getVerifiedUser.mockResolvedValue({ id: playerId });
  return { dailyId: dailyRows[0].id as string, playerId, submissionId: submissionRows[0].id as string };
}

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
  } catch (error) {
    await admin.query("rollback");
    throw error;
  }
}

async function resultTransactions(submissionId: string) {
  const { rows } = await pool.query(
    "select amount from point_transactions where submission_id = $1 and kind = 'challenge_result'",
    [submissionId],
  );
  return rows.map((row) => row.amount as number);
}

describe("character puzzle guesses", () => {
  it.each([
    ["too short", "AB1"],
    ["too long", "AB1CDA"],
    ["a character outside the set", "AB1CZ"],
    ["punctuation", "AB-CD"],
  ])("rejects a guess that is %s without consuming a try (AC-4)", async (_name, guess) => {
    const { dailyId, submissionId } = await createStartedCharacterGame();

    await expect(submitChallenge(dailyId, guess)).rejects.toBeInstanceOf(BadRequestError);

    const { rows } = await pool.query(
      "select attempts, guess_history, feedback from submissions where id = $1",
      [submissionId],
    );
    expect(rows[0]).toEqual({ attempts: 0, guess_history: [], feedback: null });
  });

  it("stores feedback for an incorrect guess and awards nothing yet (AC-5)", async () => {
    const { dailyId, submissionId } = await createStartedCharacterGame();

    const result = await submitChallenge(dailyId, " ab2cc ", randomUUID());

    expect(result.finalized).toBe(false);
    const expected = ["correct", "correct", "absent", "correct", "absent"];
    const { rows } = await pool.query(
      "select attempts, response, feedback, guess_history from submissions where id = $1",
      [submissionId],
    );
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].response).toBe("AB2CC");
    expect(rows[0].feedback).toEqual(expected);
    expect(rows[0].guess_history).toEqual([
      expect.objectContaining({ response: "AB2CC", correct: false, feedback: expected }),
    ]);
    expect(result.play).toMatchObject({ status: "in_progress", attempts: 1, feedback: expected });
    expect(await resultTransactions(submissionId)).toEqual([]);
  });

  it("finalizes a correct guess with the normal reward (AC-6)", async () => {
    const { dailyId, submissionId } = await createStartedCharacterGame();

    const result = await submitChallenge(dailyId, "ab1cd", randomUUID());

    expect(result).toMatchObject({ finalized: true, correct: true });
    expect(result.scoringBreakdown).toMatchObject({ total_points: 100, penalty_points: 0 });
    expect(await resultTransactions(submissionId)).toEqual([100]);
  });

  it("applies the penalty once when the last try is wrong (AC-6)", async () => {
    const { dailyId, submissionId } = await createStartedCharacterGame({ maxAttempts: 2 });

    await submitChallenge(dailyId, "AAAAA", randomUUID());
    expect(await resultTransactions(submissionId)).toEqual([]);
    const last = await submitChallenge(dailyId, "BBBBB", randomUUID());

    expect(last).toMatchObject({ finalized: true, correct: false });
    expect(await resultTransactions(submissionId)).toEqual([-20]);
  });

  it("applies the penalty once on expiry without grading (AC-6)", async () => {
    const { dailyId, submissionId } = await createStartedCharacterGame();
    await backdateSubmissionStart(submissionId, 300);

    const result = await submitChallenge(dailyId, "AB1CD", randomUUID());

    expect(result).toMatchObject({ finalized: true, correct: false, expired: true });
    expect(await resultTransactions(submissionId)).toEqual([-20]);
  });

  it("does not consume a second try for a retried operation key (AC-7)", async () => {
    const { dailyId, submissionId } = await createStartedCharacterGame();
    const operationKey = randomUUID();

    await submitChallenge(dailyId, "AAAAA", operationKey);
    const retry = await submitChallenge(dailyId, " aaaaa", operationKey);

    expect(retry).toMatchObject({ duplicateOperation: true });
    const { rows } = await pool.query("select attempts from submissions where id = $1", [submissionId]);
    expect(rows[0].attempts).toBe(1);
  });

  it("rejects an operation key reused for a different guess (AC-7)", async () => {
    const { dailyId } = await createStartedCharacterGame();
    const operationKey = randomUUID();

    await submitChallenge(dailyId, "AAAAA", operationKey);

    await expect(submitChallenge(dailyId, "BBBBB", operationKey)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("returns a finalized result unchanged on retry (AC-7)", async () => {
    const { dailyId, submissionId } = await createStartedCharacterGame();
    await submitChallenge(dailyId, "AB1CD", randomUUID());

    const again = await submitChallenge(dailyId, "AAAAA", randomUUID());

    expect(again).toMatchObject({ alreadyFinalized: true, correct: true });
    expect(await resultTransactions(submissionId)).toEqual([100]);
  });

  it("rejects a repeated guess without consuming a try (AC-4)", async () => {
    const { dailyId, submissionId } = await createStartedCharacterGame();
    await submitChallenge(dailyId, "AAAAA", randomUUID());

    await expect(submitChallenge(dailyId, "aaaaa", randomUUID())).rejects.toBeInstanceOf(BadRequestError);

    const { rows } = await pool.query("select attempts from submissions where id = $1", [submissionId]);
    expect(rows[0].attempts).toBe(1);
  });
});

describe("character puzzle player state", () => {
  it("exposes config but never the target, while playing or after failure (AC-8)", async () => {
    const { dailyId } = await createStartedCharacterGame({ target: "AB1CD", maxAttempts: 1 });

    const playing = await getChallengeSession(dailyId);
    expect(playing.play).toMatchObject({ type: "character_puzzle", config: CONFIG });
    expect(JSON.stringify(playing)).not.toContain("AB1CD");

    const failed = await submitChallenge(dailyId, "BBBBB", randomUUID());
    expect(failed.finalized).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("AB1CD");
    expect(JSON.stringify(await getChallengeSession(dailyId))).not.toContain("AB1CD");
  });

  it("restores colored history after a reload (AC-9)", async () => {
    const { dailyId } = await createStartedCharacterGame();
    await submitChallenge(dailyId, "BA1DC", randomUUID());

    const { play } = await getChallengeSession(dailyId);

    expect(play).toMatchObject({
      status: "in_progress",
      attempts: 1,
      guessHistory: [
        expect.objectContaining({
          response: "BA1DC",
          feedback: ["present", "present", "correct", "present", "present"],
        }),
      ],
    });
  });
});
