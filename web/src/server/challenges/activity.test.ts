import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser, insertPuzzle, requireTestAdminPool } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({ getVerifiedUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { recordActivity, MAX_ACTIVITY_EVENTS } = await import("./activity");
const { submitChallenge } = await import("./challenges");
const { getScheduleDetail, deleteSchedule } = await import("@/server/schedules/schedules");
const { ForbiddenError, NotFoundError } = await import("@/server/http/errors");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

async function createProfile(role: "player" | "admin" | "spectator") {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat($3::text, ' ', ($1::uuid)::text), $2)",
    [id, role, role],
  );
  return id;
}

async function createSession({ maxAttempts = 1, timeLimitSeconds = 120 } = {}) {
  const daysAhead = 2000 + Math.floor(Math.random() * 1_000_000);
  const adminId = await createProfile("admin");
  const { rows: dailyRows } = await pool.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
     values (current_date + $3::int, 'shared', array['riddle'], 'fixed', $1::jsonb, 'standard', $2)
     returning id`,
    [
      JSON.stringify({ standard: { types: { riddle: { time_limit_seconds: timeLimitSeconds, max_attempts: maxAttempts } } } }),
      adminId,
      daysAhead,
    ],
  );
  const puzzleId = await insertPuzzle(pool, { createdBy: adminId, answerData: { accepted: ["piano"] } });
  const { rows: challengeRows } = await pool.query(
    `insert into challenges
       (daily_challenge_id, mode, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
     values ($1, 'shared', 'riddle', $2, 'standard', $3, $4, $5::jsonb)
     returning id`,
    [dailyRows[0].id, puzzleId, maxAttempts, timeLimitSeconds, JSON.stringify({ base_points: 100, speed_bonuses: [] })],
  );
  const playerId = await createProfile("player");
  const { rows: submissionRows } = await pool.query(
    `insert into submissions (challenge_id, challenge_mode, user_id) values ($1, 'shared', $2) returning id`,
    [challengeRows[0].id, playerId],
  );
  return { dailyId: dailyRows[0].id as string, playerId, submissionId: submissionRows[0].id as string, adminId };
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
  } catch (err) {
    await admin.query("rollback");
    throw err;
  }
}

async function storedKinds(submissionId: string) {
  const { rows } = await pool.query(
    "select kind from submission_activity where submission_id = $1 order by at, id",
    [submissionId],
  );
  return rows.map((row) => row.kind as string);
}

describe("recordActivity", () => {
  it("stores an event stamped by the database clock for an in-progress session (AC-1)", async () => {
    const { dailyId, playerId, submissionId } = await createSession();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const result = await recordActivity(dailyId, "typing");

    expect(result).toEqual({ recorded: true });
    const { rows } = await pool.query(
      "select kind, at <= clock_timestamp() and at > clock_timestamp() - interval '1 minute' as fresh from submission_activity where submission_id = $1",
      [submissionId],
    );
    expect(rows).toEqual([{ kind: "typing", fresh: true }]);
  });

  it("stores a copy event for an in-progress session (AC-14)", async () => {
    const { dailyId, playerId, submissionId } = await createSession();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    expect(await recordActivity(dailyId, "copy")).toEqual({ recorded: true });
    expect(await recordActivity(dailyId, "copy")).toEqual({ recorded: true });

    expect(await storedKinds(submissionId)).toEqual(["copy", "copy"]);
  });

  it("stores a paste event (AC-15)", async () => {
    const { dailyId, playerId, submissionId } = await createSession();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    expect(await recordActivity(dailyId, "paste")).toEqual({ recorded: true });

    expect(await storedKinds(submissionId)).toEqual(["paste"]);
  });

  it("does not treat copy as an absence marker (AC-14)", async () => {
    const { dailyId, playerId, submissionId } = await createSession();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    await recordActivity(dailyId, "away");
    await recordActivity(dailyId, "copy");

    expect(await recordActivity(dailyId, "back")).toEqual({ recorded: true });
    expect(await storedKinds(submissionId)).toEqual(["away", "copy", "back"]);
  });

  it("ignores a repeated away and a back with no open absence (AC-2)", async () => {
    const { dailyId, playerId, submissionId } = await createSession();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    expect(await recordActivity(dailyId, "back")).toEqual({ recorded: false });
    expect(await recordActivity(dailyId, "away")).toEqual({ recorded: true });
    expect(await recordActivity(dailyId, "away")).toEqual({ recorded: false });
    expect(await recordActivity(dailyId, "back")).toEqual({ recorded: true });
    expect(await recordActivity(dailyId, "back")).toEqual({ recorded: false });

    expect(await storedKinds(submissionId)).toEqual(["away", "back"]);
  });

  it("stores at most one event for concurrent away requests (AC-2)", async () => {
    const { dailyId, playerId, submissionId } = await createSession();
    getVerifiedUser.mockResolvedValue({ id: playerId });

    await Promise.all(Array.from({ length: 5 }, () => recordActivity(dailyId, "away")));

    expect(await storedKinds(submissionId)).toEqual(["away"]);
  });

  it("stores nothing once the session is finalized (AC-3)", async () => {
    const { dailyId, playerId, submissionId } = await createSession();
    getVerifiedUser.mockResolvedValue({ id: playerId });
    await submitChallenge(dailyId, "guitar");

    expect(await recordActivity(dailyId, "away")).toEqual({ recorded: false });
    expect(await storedKinds(submissionId)).toEqual([]);
  });

  it("stores nothing once the deadline has passed (AC-3)", async () => {
    const { dailyId, playerId, submissionId } = await createSession({ timeLimitSeconds: 60 });
    await backdateSubmissionStart(submissionId, 120);
    getVerifiedUser.mockResolvedValue({ id: playerId });

    expect(await recordActivity(dailyId, "typing")).toEqual({ recorded: false });
    expect(await storedKinds(submissionId)).toEqual([]);
  });

  it("stops storing at the per-session cap (AC-4)", async () => {
    const { dailyId, playerId, submissionId } = await createSession();
    await pool.query(
      `insert into submission_activity (submission_id, kind)
       select $1, 'typing' from generate_series(1, $2::int)`,
      [submissionId, MAX_ACTIVITY_EVENTS],
    );
    getVerifiedUser.mockResolvedValue({ id: playerId });

    expect(await recordActivity(dailyId, "typing")).toEqual({ recorded: false });
    const { rows } = await pool.query(
      "select count(*)::int as count from submission_activity where submission_id = $1",
      [submissionId],
    );
    expect(rows[0].count).toBe(MAX_ACTIVITY_EVENTS);
  });

  it("rejects admins and spectators, and a player with no session (AC-5)", async () => {
    const { dailyId } = await createSession();
    getVerifiedUser.mockResolvedValue({ id: await createProfile("admin") });
    await expect(recordActivity(dailyId, "away")).rejects.toBeInstanceOf(ForbiddenError);

    getVerifiedUser.mockResolvedValue({ id: await createProfile("spectator") });
    await expect(recordActivity(dailyId, "away")).rejects.toBeInstanceOf(ForbiddenError);

    getVerifiedUser.mockResolvedValue({ id: await createProfile("player") });
    await expect(recordActivity(dailyId, "away")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("only writes to the caller's own session (AC-5)", async () => {
    const mine = await createSession();
    const theirs = await createSession();
    getVerifiedUser.mockResolvedValue({ id: mine.playerId });

    await expect(recordActivity(theirs.dailyId, "away")).rejects.toBeInstanceOf(NotFoundError);
    expect(await storedKinds(theirs.submissionId)).toEqual([]);
  });
});

async function insertActivityAt(submissionId: string, kind: string, secondsAfterStart: number) {
  await pool.query(
    `insert into submission_activity (submission_id, kind, at)
     select $1, $2, s.started_at + ($3 * interval '1 second') from submissions s where s.id = $1`,
    [submissionId, kind, secondsAfterStart],
  );
}

describe("admin schedule detail timeline", () => {
  it("returns an ordered timeline with absences, typing and guesses (AC-7)", async () => {
    const { dailyId, adminId, submissionId, playerId } = await createSession({ maxAttempts: 2 });
    await backdateSubmissionStart(submissionId, 60);
    await insertActivityAt(submissionId, "typing", 3);
    await insertActivityAt(submissionId, "away", 7);
    await insertActivityAt(submissionId, "back", 15);
    await pool.query(
      `update submissions set attempts = 1, response = 'guitar',
         guess_history = '[{"response":"guitar","correct":false,"offsetMs":21000}]'::jsonb
       where id = $1`,
      [submissionId],
    );
    getVerifiedUser.mockResolvedValue({ id: adminId });

    const detail = await getScheduleDetail(dailyId);
    const player = detail.players.find((entry) => entry.userId === playerId)!;

    expect(player.timeline).toEqual([
      { kind: "typing", offsetMs: 3_000 },
      { kind: "away", offsetMs: 7_000, durationMs: 8_000, returned: true },
      { kind: "guess", offsetMs: 21_000, response: "guitar", correct: false },
    ]);
  });

  it("runs an unreturned absence to the session end (AC-7)", async () => {
    const { dailyId, adminId, submissionId, playerId } = await createSession();
    await backdateSubmissionStart(submissionId, 100);
    await insertActivityAt(submissionId, "away", 10);
    await pool.query(
      `update submissions set submitted_at = started_at + interval '40 seconds', time_taken_ms = 40000,
         correct = false, response = 'x', attempts = 1,
         guess_history = '[{"response":"x","correct":false}]'::jsonb,
         scoring_breakdown = '{"base_points":0,"speed_bonus_points":0,"penalty_points":0,"total_points":0}'::jsonb
       where id = $1`,
      [submissionId],
    );
    getVerifiedUser.mockResolvedValue({ id: adminId });

    const player = (await getScheduleDetail(dailyId)).players.find((entry) => entry.userId === playerId)!;

    expect(player.timeline).toEqual([
      { kind: "away", offsetMs: 10_000, durationMs: 30_000, returned: false },
      { kind: "guess", offsetMs: null, response: "x", correct: false },
    ]);
  });

  it("is not available to players or spectators (AC-13)", async () => {
    const { dailyId, playerId } = await createSession();

    getVerifiedUser.mockResolvedValue({ id: playerId });
    await expect(getScheduleDetail(dailyId)).rejects.toBeInstanceOf(ForbiddenError);

    getVerifiedUser.mockResolvedValue({ id: await createProfile("spectator") });
    await expect(getScheduleDetail(dailyId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("gives players an empty timeline when they have no session", async () => {
    const { dailyId, adminId } = await createSession();
    const idle = await createProfile("player");
    getVerifiedUser.mockResolvedValue({ id: adminId });

    const detail = await getScheduleDetail(dailyId);

    expect(detail.players.find((entry) => entry.userId === idle)?.timeline).toEqual([]);
  });
});

describe("cleanup with activity present (AC-12)", () => {
  it("deleting a schedule removes its activity", async () => {
    const { dailyId, adminId, submissionId } = await createSession();
    await insertActivityAt(submissionId, "away", 1);
    getVerifiedUser.mockResolvedValue({ id: adminId });

    await deleteSchedule(dailyId);

    const { rows } = await pool.query("select 1 from submission_activity where submission_id = $1", [submissionId]);
    expect(rows).toEqual([]);
  });

  it("deleting a member account removes their activity", async () => {
    const { adminId, playerId, submissionId } = await createSession();
    await insertActivityAt(submissionId, "typing", 1);

    await pool.query("select riddle_private.delete_member_data($1, $2)", [playerId, adminId]);

    const { rows } = await pool.query("select 1 from submission_activity where submission_id = $1", [submissionId]);
    expect(rows).toEqual([]);
  });

  it("removing a personal assignment removes its activity", async () => {
    const adminId = await createProfile("admin");
    const playerId = await createProfile("player");
    const { rows: dailyRows } = await pool.query(
      `insert into daily_challenges
         (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
       values (current_date + $2::int, 'personal', array['riddle'], 'fixed', $3::jsonb, 'standard', $1)
       returning id`,
      [
        adminId,
        3000 + Math.floor(Math.random() * 1_000_000),
        JSON.stringify({ standard: { types: { riddle: { time_limit_seconds: 120, max_attempts: 1 } } } }),
      ],
    );
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    const { rows: challengeRows } = await pool.query(
      `insert into challenges
         (daily_challenge_id, mode, assigned_to, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
       values ($1, 'personal', $2, 'riddle', $3, 'standard', 1, 120, $4::jsonb)
       returning id`,
      [dailyRows[0].id, playerId, puzzleId, JSON.stringify({ base_points: 100, speed_bonuses: [] })],
    );
    const { rows: submissionRows } = await pool.query(
      `insert into submissions (challenge_id, challenge_mode, assigned_to, user_id)
       values ($1, 'personal', $2, $2) returning id`,
      [challengeRows[0].id, playerId],
    );
    await insertActivityAt(submissionRows[0].id, "away", 1);

    await pool.query("select riddle_private.delete_assignment($1, $2)", [challengeRows[0].id, adminId]);

    const { rows } = await pool.query("select 1 from submission_activity where submission_id = $1", [submissionRows[0].id]);
    expect(rows).toEqual([]);
  });
});

describe("guess offsets", () => {
  it("stores the database elapsed time on a non-final guess and on the finalizing guess (AC-6)", async () => {
    const { dailyId, playerId, submissionId } = await createSession({ maxAttempts: 2 });
    await backdateSubmissionStart(submissionId, 30);
    getVerifiedUser.mockResolvedValue({ id: playerId });

    await submitChallenge(dailyId, "guitar");
    await submitChallenge(dailyId, "piano");

    const { rows } = await pool.query("select guess_history from submissions where id = $1", [submissionId]);
    const history = rows[0].guess_history as Array<{ response: string; offsetMs: number }>;
    expect(history.map((guess) => guess.response)).toEqual(["guitar", "piano"]);
    for (const guess of history) {
      expect(guess.offsetMs).toBeGreaterThanOrEqual(30_000);
      expect(guess.offsetMs).toBeLessThan(40_000);
    }
    expect(history[1].offsetMs).toBeGreaterThanOrEqual(history[0].offsetMs);
  });

  it("stores the deadline as the offset for a guess that arrives after expiry (AC-6)", async () => {
    const { dailyId, playerId, submissionId } = await createSession({ timeLimitSeconds: 60 });
    await backdateSubmissionStart(submissionId, 120);
    getVerifiedUser.mockResolvedValue({ id: playerId });

    await submitChallenge(dailyId, "piano");

    const { rows } = await pool.query("select guess_history from submissions where id = $1", [submissionId]);
    expect(rows[0].guess_history).toMatchObject([{ response: "piano", correct: false, offsetMs: 60_000 }]);
  });

  it("does not expose offsets or activity in the player's own state (AC-13)", async () => {
    const { dailyId, playerId } = await createSession({ maxAttempts: 2 });
    getVerifiedUser.mockResolvedValue({ id: playerId });
    await recordActivity(dailyId, "typing");

    const result = await submitChallenge(dailyId, "guitar");

    expect(JSON.stringify(result.play)).not.toContain("offsetMs");
    expect(JSON.stringify(result.play)).not.toContain("submission_activity");
  });
});
