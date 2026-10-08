import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import {
  persistPendingSubmission,
  restorePendingSubmission,
  type PendingRiddleSubmission,
  type PendingSubmissionStorage,
} from "@/lib/challenge-state";
import { createAuthUser, requireTestAdminPool } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({
  getVerifiedUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { finalizeOverdueSessions, getChallengeSession, getTodayChallenge, startChallenge, submitChallenge } = await import(
  "./challenges"
);
const { BadRequestError, ForbiddenError, NotFoundError } = await import("@/server/http/errors");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

// daily_challenges allows only one row per active_date, so every test here
// shares this one seeded "today" schedule instead of creating its own.
async function ensureTodaysSharedRiddle() {
  const adminId = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Admin ', ($1::uuid)::text), 'admin')",
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
    "insert into profiles (id, display_name, role) values ($1, concat('Player ', ($1::uuid)::text), 'player')",
    [id],
  );
  return id;
}

async function createStartedPastRiddle(maxAttempts: number, failurePenaltyPoints?: number) {
  const daysAgo = 1000 + Math.floor(Math.random() * 1_000_000);
  const adminId = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Admin ', ($1::uuid)::text), 'admin')",
    [adminId],
  );
  const { rows: dailyRows } = await pool.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
     values (current_date - $3::int, 'shared', array['riddle'], 'fixed', $1::jsonb, 'standard', $2)
     returning id`,
    [
      JSON.stringify({ standard: { types: { riddle: { time_limit_seconds: 120, max_attempts: maxAttempts } } } }),
      adminId,
      daysAgo,
    ],
  );
  const { rows: challengeRows } = await pool.query(
    `insert into challenges
       (daily_challenge_id, mode, type, difficulty, prompt, config, answer_data, max_attempts, time_limit_seconds, scoring_policy)
     values ($1, 'shared', 'riddle', 'standard', 'Two-try fixture', '{}'::jsonb, $2::jsonb, $3, 120, $4::jsonb)
     returning id`,
    [
      dailyRows[0].id,
      JSON.stringify({ accepted: ["piano"] }),
      maxAttempts,
      JSON.stringify({
        base_points: 100,
        speed_bonuses: [],
        ...(failurePenaltyPoints === undefined
          ? {}
          : { failure_penalty_points: failurePenaltyPoints }),
      }),
    ],
  );
  const playerId = await createPlayer();
  const { rows: submissionRows } = await pool.query(
    `insert into submissions (challenge_id, challenge_mode, user_id)
     values ($1, 'shared', $2) returning id`,
    [challengeRows[0].id, playerId],
  );
  return {
    dailyId: dailyRows[0].id,
    playerId,
    submissionId: submissionRows[0].id,
  };
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
  it("deduplicates a retry that follows a recovery read before the original submission commits", async () => {
    const { dailyId, playerId, submissionId } = await createStartedPastRiddle(3);
    const operationKey = "88fd76a3-a596-4b3c-9a42-bfcf0eb194c3";
    const advisoryLockKey = 840_172_619;
    const admin = requireTestAdminPool();
    const blocker = await admin.connect();
    const stored = new Map<string, string>();
    const browserSessionStorage: PendingSubmissionStorage = {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    };
    const pending: PendingRiddleSubmission = {
      dailyChallengeId: dailyId,
      submissionId,
      response: "guitar",
      operationKey,
    };
    let firstSubmission: Promise<Awaited<ReturnType<typeof submitChallenge>>> | undefined;
    let retrySubmission: Promise<Awaited<ReturnType<typeof submitChallenge>>> | undefined;
    getVerifiedUser.mockResolvedValue({ id: playerId });

    try {
      await blocker.query("select pg_advisory_lock($1)", [advisoryLockKey]);
      await admin.query(
        `create function riddle_private.test_block_submission_update()
         returns trigger
         language plpgsql
         set search_path = ''
         as $$
         begin
           perform pg_advisory_xact_lock(${advisoryLockKey});
           return new;
         end
         $$`,
      );
      await admin.query(
        `create trigger aa_test_block_submission_update
         before update on public.submissions
         for each row when (old.id = '${submissionId}'::uuid)
         execute function riddle_private.test_block_submission_update()`,
      );

      persistPendingSubmission(browserSessionStorage, playerId, pending);
      firstSubmission = submitChallenge(dailyId, pending.response, pending.operationKey);
      await vi.waitFor(async () => {
        const { rows } = await admin.query(
          "select count(*)::int as count from pg_stat_activity where wait_event = 'advisory'",
        );
        expect(rows[0].count).toBeGreaterThan(0);
      });

      const recoveredBeforeCommit = await getChallengeSession(dailyId);
      expect(recoveredBeforeCommit.play).toMatchObject({
        status: "in_progress",
        attempts: 0,
        guessHistory: [],
      });

      // Simulate unmount/reload by discarding component memory and restoring
      // only from player/session-scoped browser storage.
      const remountedPending = restorePendingSubmission(
        browserSessionStorage,
        playerId,
        dailyId,
        submissionId,
      );
      expect(remountedPending).toEqual(pending);
      retrySubmission = submitChallenge(
        dailyId,
        remountedPending!.response,
        remountedPending!.operationKey,
      );
      await blocker.query("select pg_advisory_unlock($1)", [advisoryLockKey]);

      const [first, retry] = await Promise.all([firstSubmission, retrySubmission]);
      expect(first.play).toMatchObject({ status: "in_progress", attempts: 1 });
      expect(retry.play).toMatchObject({
        status: "in_progress",
        attempts: 1,
        guessHistory: [{ response: "guitar", correct: false, operationKey }],
      });

      const { rows } = await pool.query(
        "select attempts, guess_history from submissions where id = $1",
        [submissionId],
      );
      expect(rows[0]).toEqual({
        attempts: 1,
        guess_history: [{ response: "guitar", correct: false, operationKey }],
      });
    } finally {
      await blocker.query("select pg_advisory_unlock($1)", [advisoryLockKey]).catch(() => undefined);
      blocker.release();
      await Promise.allSettled([firstSubmission, retrySubmission].filter(Boolean));
      await admin.query("drop trigger if exists aa_test_block_submission_update on public.submissions");
      await admin.query("drop function if exists riddle_private.test_block_submission_update()");
    }
  }, 10_000);

  it("starts idempotently, grades a correct answer, and stores the score", async () => {
    const { dailyId, prompt } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const started = await startChallenge(dailyId);
    expect(started.prompt).toBe(prompt);
    expect(started).toMatchObject({
      status: "in_progress",
      serverTime: expect.any(String),
      deadline: expect.any(String),
      attempts: 0,
      guessHistory: [],
      scoringPolicy: { base_points: 100, speed_bonuses: [] },
    });

    const startedAgain = await startChallenge(dailyId);
    expect(startedAgain.submissionId).toBe(started.submissionId);

    const result = await submitChallenge(dailyId, "A Piano!");
    expect(result.correct).toBe(true);
    expect(result.finalized).toBe(true);
    expect(result.scoringBreakdown).toMatchObject({ total_points: 100 });

    const { rows } = await pool.query(
      "select amount, kind from point_transactions where user_id = $1 and kind = 'challenge_result'",
      [playerId],
    );
    expect(rows).toEqual([{ amount: 100, kind: "challenge_result" }]);

    const repeat = await submitChallenge(dailyId, "guitar");
    expect(repeat.alreadyFinalized).toBe(true);
    expect(repeat.correct).toBe(true);

    const { rows: afterRepeat } = await pool.query(
      "select count(*)::int as count from point_transactions where user_id = $1 and kind = 'challenge_result'",
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

  it("deducts the configured penalty when the final answer is incorrect (AC-1)", async () => {
    const { dailyId, playerId, submissionId } = await createStartedPastRiddle(1, 20);
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const result = await submitChallenge(dailyId, "guitar");

    expect(result).toMatchObject({
      correct: false,
      finalized: true,
      scoringBreakdown: {
        base_points: 0,
        speed_bonus_points: null,
        penalty_points: 20,
        total_points: -20,
        bonus_under_ms: null,
      },
      play: {
        status: "completed",
        result: { scoringBreakdown: { penalty_points: 20, total_points: -20 } },
      },
    });
    const { rows } = await pool.query(
      "select amount, kind from point_transactions where submission_id = $1",
      [submissionId],
    );
    expect(rows).toEqual([{ amount: -20, kind: "challenge_result" }]);
  });

  it("does not penalize a recoverable wrong answer and awards a later correct answer (AC-3)", async () => {
    const { dailyId, playerId, submissionId } = await createStartedPastRiddle(2, 20);
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const first = await submitChallenge(dailyId, "guitar");
    expect(first).toMatchObject({
      finalized: false,
      attemptsRemaining: 1,
      play: { scoringPolicy: { failure_penalty_points: 20 } },
    });
    const beforeFinal = await pool.query(
      "select amount from point_transactions where submission_id = $1",
      [submissionId],
    );
    expect(beforeFinal.rows).toEqual([]);

    const result = await submitChallenge(dailyId, "piano");
    expect(result).toMatchObject({
      correct: true,
      finalized: true,
      scoringBreakdown: { penalty_points: 0, total_points: 100 },
    });
    const { rows } = await pool.query(
      "select amount from point_transactions where submission_id = $1",
      [submissionId],
    );
    expect(rows).toEqual([{ amount: 100 }]);
  });

  it("rejects a guess that matches an earlier one without using a try", async () => {
    const { dailyId, playerId, submissionId } = await createStartedPastRiddle(3);
    getVerifiedUser.mockResolvedValue({ id: playerId });
    await submitChallenge(dailyId, "bye", randomUUID());

    await expect(submitChallenge(dailyId, "  BYE! ", randomUUID())).rejects.toThrow("already tried");
    await expect(submitChallenge(dailyId, "bye", randomUUID())).rejects.toBeInstanceOf(BadRequestError);

    const { rows } = await pool.query("select attempts, jsonb_array_length(guess_history) as guesses from submissions where id = $1", [submissionId]);
    expect(rows[0]).toEqual({ attempts: 1, guesses: 1 });
    const next = await submitChallenge(dailyId, "yo", randomUUID());
    expect(next).toMatchObject({ finalized: false, attemptsRemaining: 1 });
  });

  it("still treats a retry of the same operation as a duplicate, not a repeat guess", async () => {
    const { dailyId, playerId } = await createStartedPastRiddle(3);
    getVerifiedUser.mockResolvedValue({ id: playerId });
    const operationKey = randomUUID();
    await submitChallenge(dailyId, "bye", operationKey);

    const retry = await submitChallenge(dailyId, "bye", operationKey);

    expect(retry).toMatchObject({ duplicateOperation: true });
  });

  it("rejects Submit before Start", async () => {
    const { dailyId } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    await expect(submitChallenge(dailyId, "piano")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("stores an incorrect guess and keeps a multi-attempt session active (AC-3)", async () => {
    const { dailyId, playerId, submissionId } = await createStartedPastRiddle(2);
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const result = await submitChallenge(dailyId, "guitar");

    expect(result).toMatchObject({
      correct: false,
      finalized: false,
      attemptsRemaining: 1,
      play: {
        status: "in_progress",
        attempts: 1,
        attemptsRemaining: 1,
        guessHistory: [{ response: "guitar", correct: false }],
      },
    });
    const { rows } = await pool.query(
      "select attempts, guess_history, submitted_at from submissions where id = $1",
      [submissionId],
    );
    expect(rows[0]).toMatchObject({
      attempts: 1,
      guess_history: [{ response: "guitar", correct: false }],
      submitted_at: null,
    });
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

  it("finalizes an expired session without requiring or recording a guess", async () => {
    const { dailyId } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const started = await startChallenge(dailyId);
    await backdateSubmissionStart(started.submissionId, started.timeLimitSeconds + 5);

    const result = await submitChallenge(dailyId, null);

    expect(result).toMatchObject({
      correct: false,
      finalized: true,
      expired: true,
      play: {
        status: "completed",
        attempts: 0,
        guessHistory: [],
        result: { correct: false, scoringBreakdown: { total_points: 0 } },
      },
    });
    const { rows } = await pool.query(
      "select response, attempts, guess_history from submissions where id = $1",
      [started.submissionId],
    );
    expect(rows[0]).toEqual({ response: null, attempts: 0, guess_history: [] });
  });

  it("deducts the configured penalty when the deadline expires (AC-2)", async () => {
    const { dailyId, playerId, submissionId } = await createStartedPastRiddle(2, 15);
    getVerifiedUser.mockResolvedValue({ id: playerId });
    await backdateSubmissionStart(submissionId, 125);

    const result = await submitChallenge(dailyId, null);

    expect(result).toMatchObject({
      correct: false,
      finalized: true,
      expired: true,
      scoringBreakdown: { penalty_points: 15, total_points: -15 },
    });
    const { rows } = await pool.query(
      "select amount, reason from point_transactions where submission_id = $1",
      [submissionId],
    );
    expect(rows).toEqual([{ amount: -15, reason: "Deadline expired" }]);
  });

  it("rejects answerless finalization before the deadline", async () => {
    const { dailyId } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });
    await startChallenge(dailyId);

    await expect(submitChallenge(dailyId, null)).rejects.toBeInstanceOf(BadRequestError);
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

  it("returns a stored failed result without deducting the penalty twice (AC-4)", async () => {
    const { dailyId, playerId, submissionId } = await createStartedPastRiddle(1, 30);
    getVerifiedUser.mockResolvedValue({ id: playerId });
    await submitChallenge(dailyId, "guitar");

    const retry = await submitChallenge(dailyId, "guitar");

    expect(retry).toMatchObject({
      alreadyFinalized: true,
      scoringBreakdown: { penalty_points: 30, total_points: -30 },
    });
    const { rows } = await pool.query(
      `select count(*)::int as count, sum(amount)::int as total
       from point_transactions where submission_id = $1`,
      [submissionId],
    );
    expect(rows[0]).toEqual({ count: 1, total: -30 });
  });

  it("rejects a signed result that differs from the saved failure breakdown (AC-7)", async () => {
    const { dailyId, playerId, submissionId } = await createStartedPastRiddle(1, 20);
    getVerifiedUser.mockResolvedValue({ id: playerId });
    await submitChallenge(dailyId, "guitar");
    await pool.query("delete from point_transactions where submission_id = $1", [submissionId]);

    await expect(pool.query(
      `insert into point_transactions
         (user_id, amount, kind, reason, submission_id, operation_key)
       values ($1, -19, 'challenge_result', 'Mismatched penalty', $2, $3)`,
      [playerId, submissionId, `mismatch:${submissionId}`],
    )).rejects.toThrow();
  });
});

describe("getTodayChallenge access", () => {
  async function createStaff(role: "admin" | "spectator") {
    const id = await createAuthUser();
    await pool.query(
      "insert into profiles (id, display_name, role) values ($1, concat($2::text, ' Viewer ', ($1::uuid)::text), $2)",
      [id, role],
    );
    return id;
  }

  it.each(["admin", "spectator"] as const)("returns a read-only preview for a %s (AC-1, AC-2)", async (role) => {
    const { dailyId, prompt } = await ensureTodaysSharedRiddle();
    getVerifiedUser.mockResolvedValue({ id: await createStaff(role) });

    const result = await getTodayChallenge();

    expect(result).toEqual({
      schedule: { id: dailyId, mode: "shared", allowedTypes: ["riddle"] },
      preview: {
        type: "riddle",
        difficulty: "standard",
        prompt,
        timeLimitSeconds: 120,
        maxAttempts: 1,
        scoringPolicy: { base_points: 100 },
        speedBonuses: [],
      },
    });
  });

  it.each(["admin", "spectator"] as const)("never exposes answers or creates a submission for a %s (AC-3)", async (role) => {
    const { challengeId } = await ensureTodaysSharedRiddle();
    const staffId = await createStaff(role);
    getVerifiedUser.mockResolvedValue({ id: staffId });

    const result = await getTodayChallenge();

    expect(JSON.stringify(result)).not.toContain("piano");
    expect(JSON.stringify(result)).not.toContain("accepted");
    const { rows } = await pool.query("select 1 from submissions where user_id = $1 and challenge_id = $2", [staffId, challengeId]);
    expect(rows).toHaveLength(0);
  });

  it("does not add a preview to a player's response (AC-4)", async () => {
    await ensureTodaysSharedRiddle();
    getVerifiedUser.mockResolvedValue({ id: await createPlayer() });

    const result = await getTodayChallenge();

    expect(result).not.toHaveProperty("preview");
  });

  it("still rejects an unauthenticated caller (AC-3)", async () => {
    getVerifiedUser.mockResolvedValue(null);
    await expect(getTodayChallenge()).rejects.toBeTruthy();
  });

  it("returns an unstarted player state without revealing the prompt or creating a submission (AC-1, AC-7)", async () => {
    const { dailyId, challengeId } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const result = await getTodayChallenge();

    expect(result).toEqual({
      schedule: { id: dailyId, mode: "shared", allowedTypes: ["riddle"] },
      play: {
        status: "not_started",
        available: true,
        difficulty: "standard",
        scoringPolicy: expect.objectContaining({ base_points: expect.any(Number) }),
      },
    });
    expect(JSON.stringify(result)).not.toContain("accepted");
    expect(JSON.stringify(result)).not.toContain("What has keys");

    const { rows } = await pool.query(
      "select count(*)::int as count from submissions where challenge_id = $1 and user_id = $2",
      [challengeId, playerId],
    );
    expect(rows[0].count).toBe(0);
  });

  it("restores the current player's in-progress session without resetting it (AC-4, AC-7)", async () => {
    const { dailyId, challengeId, prompt } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });
    const started = await startChallenge(dailyId);

    const result = await getTodayChallenge();

    expect(result).toMatchObject({
      schedule: { id: dailyId, mode: "shared", allowedTypes: ["riddle"] },
      play: {
        status: "in_progress",
        submissionId: started.submissionId,
        challengeId,
        type: "riddle",
        difficulty: "standard",
        prompt,
        startedAt: expect.any(String),
        deadline: expect.any(String),
        serverTime: expect.any(String),
        timeLimitSeconds: 120,
        maxAttempts: 1,
        attempts: 0,
        attemptsRemaining: 1,
        guessHistory: [],
        feedback: null,
        scoringPolicy: { base_points: 100, speed_bonuses: [] },
      },
    });
    expect(result.play?.status).toBe("in_progress");
    if (!result.play || result.play.status !== "in_progress") {
      throw new Error("Expected an in-progress restored session");
    }
    expect(new Date(result.play.deadline).getTime()).toBe(
      new Date(result.play.startedAt).getTime() + 120_000,
    );
    expect(JSON.stringify(result)).not.toContain("accepted");

    const restored = await getTodayChallenge();
    expect(restored.play).toMatchObject({
      status: "in_progress",
      submissionId: result.play.submissionId,
      startedAt: result.play.startedAt,
      deadline: result.play.deadline,
      attempts: 0,
      guessHistory: [],
    });
  });

  it("restores an unresolved previous-day session ahead of today's schedule", async () => {
    await ensureTodaysSharedRiddle();
    const { dailyId, playerId, submissionId } = await createStartedPastRiddle(2);
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const result = await getTodayChallenge();

    expect(result).toMatchObject({
      schedule: { id: dailyId },
      play: {
        status: "in_progress",
        submissionId,
        attemptsRemaining: 2,
      },
    });
  });

  it("reads a completed previous-day session by its schedule id", async () => {
    const { dailyId, playerId } = await createStartedPastRiddle(2);
    getVerifiedUser.mockResolvedValue({ id: playerId });
    await submitChallenge(dailyId, "piano");

    const result = await getChallengeSession(dailyId);

    expect(result).toMatchObject({
      schedule: { id: dailyId },
      play: {
        status: "completed",
        result: { correct: true, scoringBreakdown: { total_points: 100 } },
      },
    });
  });

  it("does not expose a schedule session to a player who never started it", async () => {
    const { dailyId } = await createStartedPastRiddle(2);
    const otherPlayerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: otherPlayerId });

    await expect(getChallengeSession(dailyId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("restores a completed session and its stored result (AC-5, AC-7)", async () => {
    const { dailyId } = await ensureTodaysSharedRiddle();
    const playerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: playerId });
    await startChallenge(dailyId);
    await submitChallenge(dailyId, "piano");

    const result = await getTodayChallenge();

    expect(result).toMatchObject({
      play: {
        status: "completed",
        attempts: 1,
        attemptsRemaining: 0,
        guessHistory: [{ response: "piano", correct: true }],
        result: {
          correct: true,
          timeTakenMs: expect.any(Number),
          scoringBreakdown: { total_points: 100 },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("accepted");
  });

  it("does not expose one player's active session to another player (AC-7)", async () => {
    const { dailyId, prompt } = await ensureTodaysSharedRiddle();
    const firstPlayerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: firstPlayerId });
    const firstSession = await startChallenge(dailyId);

    const secondPlayerId = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: secondPlayerId });
    const result = await getTodayChallenge();

    expect(result).toMatchObject({
      play: { status: "not_started", available: true },
    });
    expect(JSON.stringify(result)).not.toContain(firstSession.submissionId);
    expect(JSON.stringify(result)).not.toContain(prompt);
  });

  it.each(["admin", "spectator"] as const)(
    "rejects Start and Submit for a %s account (AC-6)",
    async (role) => {
      const { dailyId } = await ensureTodaysSharedRiddle();
      const userId = await createAuthUser();
      await pool.query(
        "insert into profiles (id, display_name, role) values ($1, concat('Non-player ', ($1::uuid)::text), $2)",
        [userId, role],
      );
      getVerifiedUser.mockResolvedValue({ id: userId });

      await expect(startChallenge(dailyId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(submitChallenge(dailyId, "piano")).rejects.toBeInstanceOf(ForbiddenError);
    },
  );
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
      "insert into profiles (id, display_name, role) values ($1, concat('Admin ', ($1::uuid)::text), 'admin')",
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
      "insert into profiles (id, display_name, role) values ($1, concat('Player ', ($1::uuid)::text), 'player')",
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

describe("finalize_expired_sessions sweep", () => {
  async function sweep(playerId: string): Promise<number> {
    const { rows } = await requireTestAdminPool().query(
      "select riddle_private.finalize_expired_sessions($1) as finalized",
      [playerId],
    );
    return rows[0].finalized;
  }

  async function resultEntries(submissionId: string) {
    const { rows } = await pool.query(
      "select amount, kind, reason, operation_key from point_transactions where submission_id = $1",
      [submissionId],
    );
    return rows;
  }

  it("finalizes an abandoned overdue session with its failure penalty (AC-1)", async () => {
    const { playerId, submissionId } = await createStartedPastRiddle(2, 25);
    await backdateSubmissionStart(submissionId, 125);

    expect(await sweep(playerId)).toBe(1);

    const { rows } = await pool.query(
      `select correct, time_taken_ms, scoring_breakdown,
              submitted_at = started_at + interval '120 seconds' as at_deadline
       from submissions where id = $1`,
      [submissionId],
    );
    expect(rows[0]).toEqual({
      correct: false,
      time_taken_ms: "120000",
      at_deadline: true,
      scoring_breakdown: {
        base_points: 0,
        speed_bonus_points: null,
        penalty_points: 25,
        total_points: -25,
        bonus_under_ms: null,
      },
    });
    expect(await resultEntries(submissionId)).toEqual([{
      amount: -25,
      kind: "challenge_result",
      reason: "Deadline expired",
      operation_key: `result:${submissionId}`,
    }]);
  });

  it("leaves sessions before their deadline unresolved (AC-2)", async () => {
    const { playerId, submissionId } = await createStartedPastRiddle(1, 25);
    await backdateSubmissionStart(submissionId, 60);

    expect(await sweep(playerId)).toBe(0);

    const { rows } = await pool.query("select submitted_at from submissions where id = $1", [submissionId]);
    expect(rows[0].submitted_at).toBeNull();
    expect(await resultEntries(submissionId)).toEqual([]);
  });

  it("does nothing on a repeated run or for an already finalized session (AC-2)", async () => {
    const { playerId, submissionId } = await createStartedPastRiddle(1, 25);
    await backdateSubmissionStart(submissionId, 125);

    expect(await sweep(playerId)).toBe(1);
    expect(await sweep(playerId)).toBe(0);

    expect(await resultEntries(submissionId)).toHaveLength(1);
  });

  it("applies no penalty when the policy has none (AC-3)", async () => {
    const { playerId, submissionId } = await createStartedPastRiddle(1);
    await backdateSubmissionStart(submissionId, 125);

    expect(await sweep(playerId)).toBe(1);

    expect(await resultEntries(submissionId)).toMatchObject([{ amount: 0 }]);
  });

  it("applies no penalty when the stored policy is malformed (AC-3)", async () => {
    const { playerId, submissionId } = await createStartedPastRiddle(1, 25);
    const admin = await requireTestAdminPool().connect();
    try {
      await admin.query("begin");
      await admin.query("set local session_replication_role = replica");
      await admin.query(
        `update challenges c set scoring_policy = '{"base_points": 100, "failure_penalty_points": "lots"}'::jsonb
         from submissions s where s.id = $1 and c.id = s.challenge_id`,
        [submissionId],
      );
      await admin.query("commit");
    } finally {
      admin.release();
    }
    await backdateSubmissionStart(submissionId, 125);

    expect(await sweep(playerId)).toBe(1);

    expect(await resultEntries(submissionId)).toMatchObject([{ amount: 0 }]);
  });

  it("skips a session locked by an in-flight submit (AC-4)", async () => {
    const { playerId, submissionId } = await createStartedPastRiddle(1, 25);
    await backdateSubmissionStart(submissionId, 125);
    const submitter = await pool.connect();
    try {
      await submitter.query("begin");
      await submitter.query("select id from submissions where id = $1 for update", [submissionId]);

      expect(await sweep(playerId)).toBe(0);
    } finally {
      await submitter.query("rollback");
      submitter.release();
    }

    expect(await sweep(playerId)).toBe(1);
  });

  it("returns the swept result to a later submit without a second entry (AC-5)", async () => {
    const { dailyId, playerId, submissionId } = await createStartedPastRiddle(1, 25);
    await backdateSubmissionStart(submissionId, 125);
    await sweep(playerId);
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const result = await submitChallenge(dailyId, null);

    expect(result).toMatchObject({
      alreadyFinalized: true,
      correct: false,
      scoringBreakdown: { penalty_points: 25, total_points: -25 },
    });
    expect(await resultEntries(submissionId)).toHaveLength(1);
  });
});

describe("finalizeOverdueSessions on riddle load", () => {
  it("finalizes the loading player's overdue game so today's riddle is shown instead", async () => {
    const { playerId, submissionId } = await createStartedPastRiddle(1, 25);
    await backdateSubmissionStart(submissionId, 125);
    await ensureTodaysSharedRiddle();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    expect(await finalizeOverdueSessions()).toBe(1);

    const today = await getTodayChallenge();
    expect(today.play?.status).toBe("not_started");
    const { rows } = await pool.query(
      "select amount from point_transactions where submission_id = $1",
      [submissionId],
    );
    expect(rows).toEqual([{ amount: -25 }]);
  });

  it("does not finalize another player's overdue game", async () => {
    const { submissionId } = await createStartedPastRiddle(1, 25);
    await backdateSubmissionStart(submissionId, 125);
    const otherPlayer = await createPlayer();
    getVerifiedUser.mockResolvedValue({ id: otherPlayer });

    expect(await finalizeOverdueSessions()).toBe(0);

    const { rows } = await pool.query("select submitted_at from submissions where id = $1", [submissionId]);
    expect(rows[0].submitted_at).toBeNull();
  });

  it("does nothing for a non-player account", async () => {
    const adminId = await createAuthUser();
    await pool.query(
      "insert into profiles (id, display_name, role) values ($1, concat('Admin ', ($1::uuid)::text), 'admin')",
      [adminId],
    );
    getVerifiedUser.mockResolvedValue({ id: adminId });

    expect(await finalizeOverdueSessions()).toBe(0);
  });
});
