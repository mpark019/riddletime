import { describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser, insertPuzzle, requireTestAdminPool } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({ getVerifiedUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { loadTodayChallenge, submitChallenge } = await import("./challenges");
const { getDateAssignments, getScheduleDetail } = await import("@/server/schedules/schedules");

type Fixture = {
  dailyId: string;
  challengeId: string;
  activeDate: string;
};

let dayCounter = 0;

function nextOffset(direction: "past" | "future") {
  dayCounter += 1;
  const base = (direction === "past" ? 700_000 : 100_000) + Math.floor(Math.random() * 200_000) + dayCounter;
  return direction === "past" ? -base : base;
}

async function createAdmin() {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Admin ', ($1::uuid)::text), 'admin')",
    [id],
  );
  return id;
}

async function createPlayer(createdDaysFromToday = 0) {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Player ', ($1::uuid)::text), 'player')",
    [id],
  );
  if (createdDaysFromToday !== 0) {
    await withTriggersOff((admin) =>
      admin.query("update profiles set created_at = now() + ($2 * interval '1 day') where id = $1", [
        id,
        createdDaysFromToday,
      ]),
    );
  }
  return id;
}

async function withTriggersOff(run: (admin: import("pg").PoolClient) => Promise<unknown>) {
  const admin = await requireTestAdminPool().connect();
  try {
    await admin.query("begin");
    await admin.query("set local session_replication_role = replica");
    await run(admin);
    await admin.query("commit");
  } catch (err) {
    await admin.query("rollback");
    throw err;
  } finally {
    admin.release();
  }
}

async function createRiddle(options: {
  mode: "shared" | "personal";
  dayOffset: number;
  activeDate?: string;
  timeLimitSeconds: number | null;
  penalty?: number;
  assignedTo?: string;
}): Promise<Fixture> {
  const adminId = await createAdmin();
  const { rows: dailyRows } = await pool.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
     values (coalesce($5::date, current_date + $3::int), $4, array['riddle'], 'fixed', $1::jsonb, 'standard', $2)
     returning id, active_date::text`,
    [
      JSON.stringify({
        standard: { types: { riddle: { time_limit_seconds: options.timeLimitSeconds, max_attempts: 1 } } },
      }),
      adminId,
      options.dayOffset,
      options.mode,
      options.activeDate ?? null,
    ],
  );
  const puzzleId = await insertPuzzle(pool, {
    createdBy: adminId,
    prompt: "Day-end fixture",
    answerData: { accepted: ["piano"] },
  });
  const { rows: challengeRows } = await pool.query(
    `insert into challenges
       (daily_challenge_id, mode, assigned_to, type, puzzle_id, difficulty,
        max_attempts, time_limit_seconds, scoring_policy)
     values ($1, $2, $3, 'riddle', $4, 'standard', 1, $5, $6::jsonb)
     returning id`,
    [
      dailyRows[0].id,
      options.mode,
      options.assignedTo ?? null,
      puzzleId,
      options.timeLimitSeconds,
      JSON.stringify({ base_points: 100, speed_bonuses: [], failure_penalty_points: options.penalty ?? 25 }),
    ],
  );
  return { dailyId: dailyRows[0].id, challengeId: challengeRows[0].id, activeDate: dailyRows[0].active_date };
}

async function startSession(fixture: Fixture, playerId: string, mode: "shared" | "personal") {
  const { rows } = await pool.query(
    `insert into submissions (challenge_id, challenge_mode, assigned_to, user_id)
     values ($1, $2, $3, $4) returning id`,
    [fixture.challengeId, mode, mode === "personal" ? playerId : null, playerId],
  );
  return rows[0].id as string;
}

async function setStart(submissionId: string, startedAtSql: string, params: unknown[] = []) {
  await withTriggersOff((admin) =>
    admin.query(`update submissions set started_at = ${startedAtSql} where id = $1`, [submissionId, ...params]),
  );
}

async function sweep(playerId: string | null, timezone?: string) {
  const { rows } = await requireTestAdminPool().query(
    timezone === undefined
      ? "select riddle_private.finalize_expired_sessions($1) as finalized"
      : "select riddle_private.finalize_expired_sessions($1, $2) as finalized",
    timezone === undefined ? [playerId] : [playerId, timezone],
  );
  return rows[0].finalized as number;
}

async function entriesFor(challengeId: string, playerId: string) {
  const { rows } = await pool.query(
    `select pt.amount, pt.kind, pt.reason
     from point_transactions pt join submissions s on s.id = pt.submission_id
     where s.challenge_id = $1 and s.user_id = $2`,
    [challengeId, playerId],
  );
  return rows;
}

describe("day-end riddle expiry", () => {
  it("penalizes a player who never started a personal riddle once its day ends (AC-1)", async () => {
    const playerId = await createPlayer();
    const riddle = await createRiddle({
      mode: "personal", dayOffset: nextOffset("past"), timeLimitSeconds: null, assignedTo: playerId,
    });

    expect(await sweep(playerId)).toBe(1);

    expect(await entriesFor(riddle.challengeId, playerId)).toEqual([
      { amount: -25, kind: "challenge_result", reason: "Missed riddle" },
    ]);
    const { rows } = await pool.query(
      "select correct, time_taken_ms, scoring_breakdown from submissions where challenge_id = $1 and user_id = $2",
      [riddle.challengeId, playerId],
    );
    expect(rows[0]).toMatchObject({
      correct: false,
      time_taken_ms: "0",
      scoring_breakdown: { base_points: 0, penalty_points: 25, total_points: -25, missed: true },
    });
  });

  it("flags only never-started riddles as missed in the admin views", async () => {
    const missedPlayer = await createPlayer();
    const startedPlayer = await createPlayer();
    // The roster lookup only accepts four-digit years, which the usual far-past offsets can exceed.
    const dayOffset = -(10_000 + Math.floor(Math.random() * 200_000));
    const missed = await createRiddle({ mode: "personal", dayOffset, timeLimitSeconds: null, assignedTo: missedPlayer });
    const { rows } = await pool.query(
      `insert into challenges
         (daily_challenge_id, mode, assigned_to, type, puzzle_id, difficulty,
          max_attempts, time_limit_seconds, scoring_policy)
       select daily_challenge_id, mode, $2, type, puzzle_id, difficulty,
              max_attempts, time_limit_seconds, scoring_policy
       from challenges where id = $1
       returning id`,
      [missed.challengeId, startedPlayer],
    );
    const started = { ...missed, challengeId: rows[0].id as string };
    const submissionId = await startSession(started, startedPlayer, "personal");
    await setStart(submissionId, "($2::date + time '10:00')::timestamptz", [missed.activeDate]);
    await sweep(missedPlayer);
    await sweep(startedPlayer);
    getVerifiedUser.mockResolvedValue({ id: await createAdmin() });

    const detail = await getScheduleDetail(missed.dailyId);
    const roster = await getDateAssignments(missed.activeDate);

    const missedFlag = (id: string) => detail.players.find((player) => player.userId === id)?.missed;
    expect(missedFlag(missedPlayer)).toBe(true);
    expect(missedFlag(startedPlayer)).toBe(false);
    const rosterFlag = (id: string) => roster.assignments.find((entry) => entry.playerId === id)?.missed;
    expect(rosterFlag(missedPlayer)).toBe(true);
    expect(rosterFlag(startedPlayer)).toBe(false);
  });

  it("penalizes every existing player of a shared riddle but not later accounts (AC-2)", async () => {
    const dayOffset = nextOffset("past");
    const earlyPlayer = await createPlayer(dayOffset - 1);
    const latePlayer = await createPlayer(0);
    const riddle = await createRiddle({ mode: "shared", dayOffset, timeLimitSeconds: 60 });

    await sweep(earlyPlayer);
    await sweep(latePlayer);

    expect(await entriesFor(riddle.challengeId, earlyPlayer)).toHaveLength(1);
    expect(await entriesFor(riddle.challengeId, latePlayer)).toHaveLength(0);
  });

  it("leaves unstarted players alone while the day has not ended (AC-3)", async () => {
    const playerId = await createPlayer();
    const riddle = await createRiddle({
      mode: "personal", dayOffset: nextOffset("future"), timeLimitSeconds: null, assignedTo: playerId,
    });

    expect(await sweep(playerId)).toBe(0);

    expect(await entriesFor(riddle.challengeId, playerId)).toEqual([]);
  });

  it("finalizes a started no-limit riddle when its day ends (AC-4)", async () => {
    const playerId = await createPlayer();
    const dayOffset = nextOffset("past");
    const riddle = await createRiddle({
      mode: "personal", dayOffset, timeLimitSeconds: null, assignedTo: playerId,
    });
    const submissionId = await startSession(riddle, playerId, "personal");
    await setStart(submissionId, "($2::date + time '10:00')::timestamptz", [riddle.activeDate]);

    expect(await sweep(playerId)).toBe(1);

    const { rows } = await pool.query(
      "select correct, time_taken_ms from submissions where id = $1",
      [submissionId],
    );
    expect(rows[0]).toEqual({ correct: false, time_taken_ms: String(14 * 3600 * 1000) });
    expect(await entriesFor(riddle.challengeId, playerId)).toMatchObject([{ amount: -25 }]);
  });

  it("caps a timed riddle at day end when the limit would run past it (AC-5)", async () => {
    const playerId = await createPlayer();
    const riddle = await createRiddle({
      mode: "personal", dayOffset: nextOffset("past"), timeLimitSeconds: 600, assignedTo: playerId,
    });
    const submissionId = await startSession(riddle, playerId, "personal");
    await setStart(submissionId, "($2::date + 1)::timestamptz - interval '30 seconds'", [riddle.activeDate]);

    expect(await sweep(playerId)).toBe(1);

    const { rows } = await pool.query("select time_taken_ms from submissions where id = $1", [submissionId]);
    expect(rows[0].time_taken_ms).toBe("30000");
  });

  it("is idempotent and never double-penalizes (AC-6)", async () => {
    const playerId = await createPlayer();
    const riddle = await createRiddle({
      mode: "personal", dayOffset: nextOffset("past"), timeLimitSeconds: null, assignedTo: playerId,
    });

    expect(await sweep(playerId)).toBe(1);
    expect(await sweep(playerId)).toBe(0);

    expect(await entriesFor(riddle.challengeId, playerId)).toHaveLength(1);
  });

  it("penalizes a missed riddle during the player's own riddle load (AC-7)", async () => {
    const playerId = await createPlayer();
    const riddle = await createRiddle({
      mode: "personal", dayOffset: nextOffset("past"), timeLimitSeconds: null, assignedTo: playerId,
    });
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const loaded = await loadTodayChallenge();

    expect(loaded.finalized).toBeGreaterThanOrEqual(1);
    expect(await entriesFor(riddle.challengeId, playerId)).toHaveLength(1);
  });

  it("returns the stored expired result on submit after day end (AC-8)", async () => {
    const playerId = await createPlayer();
    const riddle = await createRiddle({
      mode: "personal", dayOffset: nextOffset("past"), timeLimitSeconds: null, assignedTo: playerId,
    });
    const submissionId = await startSession(riddle, playerId, "personal");
    await setStart(submissionId, "($2::date + time '10:00')::timestamptz", [riddle.activeDate]);
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const result = await submitChallenge(riddle.dailyId, "piano");

    expect(result).toMatchObject({ correct: false, finalized: true, expired: true });
    expect(await entriesFor(riddle.challengeId, playerId)).toMatchObject([{ amount: -25 }]);
  });

  it("never overwrites a session that already started (AC-9)", async () => {
    const playerId = await createPlayer();
    const riddle = await createRiddle({
      mode: "personal", dayOffset: nextOffset("past"), timeLimitSeconds: null, assignedTo: playerId,
    });
    const submissionId = await startSession(riddle, playerId, "personal");
    await pool.query("update submissions set attempts = 1, response = 'guitar', guess_history = '[{\"response\":\"guitar\"}]'::jsonb where id = $1", [submissionId]);

    await sweep(playerId);

    const { rows } = await pool.query("select response, attempts from submissions where id = $1", [submissionId]);
    expect(rows[0]).toEqual({ response: "guitar", attempts: 1 });
    expect(await entriesFor(riddle.challengeId, playerId)).toHaveLength(1);
  });

  describe("in America/New_York", () => {
    const zone = "America/New_York";

    async function dayEnd(activeDate: string) {
      const { rows } = await pool.query(
        "select to_char(riddle_private.day_end($1::date, $2) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI') as utc",
        [activeDate, zone],
      );
      return rows[0].utc as string;
    }

    it("ends the day at New York midnight, including across daylight saving changes", async () => {
      expect(await dayEnd("2025-07-01")).toBe("2025-07-02T04:00");
      expect(await dayEnd("2025-01-15")).toBe("2025-01-16T05:00");
      expect(await dayEnd("2025-03-09")).toBe("2025-03-10T04:00");
      expect(await dayEnd("2025-11-02")).toBe("2025-11-03T05:00");
    });

    it("caps a no-limit game at New York midnight rather than UTC midnight", async () => {
      const playerId = await createPlayer();
      const riddle = await createRiddle({
        mode: "personal", dayOffset: 0, activeDate: "2024-07-04", timeLimitSeconds: null, assignedTo: playerId,
      });
      const submissionId = await startSession(riddle, playerId, "personal");
      await setStart(submissionId, "'2024-07-04 23:30'::timestamp at time zone 'America/New_York'");

      expect(await sweep(playerId, zone)).toBe(1);

      const { rows } = await pool.query("select time_taken_ms from submissions where id = $1", [submissionId]);
      expect(rows[0].time_taken_ms).toBe(String(30 * 60 * 1000));
    });

    it("measures the last day of daylight saving time as 25 hours", async () => {
      const playerId = await createPlayer();
      const riddle = await createRiddle({
        mode: "personal", dayOffset: 0, activeDate: "2024-11-03", timeLimitSeconds: null, assignedTo: playerId,
      });
      const submissionId = await startSession(riddle, playerId, "personal");
      await setStart(submissionId, "'2024-11-03 00:00'::timestamp at time zone 'America/New_York'");

      expect(await sweep(playerId, zone)).toBe(1);

      const { rows } = await pool.query("select time_taken_ms from submissions where id = $1", [submissionId]);
      expect(rows[0].time_taken_ms).toBe(String(25 * 3600 * 1000));
    });

    it("caps a timed game at midnight on the spring-forward day", async () => {
      const playerId = await createPlayer();
      const riddle = await createRiddle({
        mode: "personal", dayOffset: 0, activeDate: "2024-03-10", timeLimitSeconds: 600, assignedTo: playerId,
      });
      const submissionId = await startSession(riddle, playerId, "personal");
      await setStart(submissionId, "'2024-03-10 23:55'::timestamp at time zone 'America/New_York'");

      expect(await sweep(playerId, zone)).toBe(1);

      const { rows } = await pool.query("select time_taken_ms from submissions where id = $1", [submissionId]);
      expect(rows[0].time_taken_ms).toBe(String(5 * 60 * 1000));
    });
  });
});
