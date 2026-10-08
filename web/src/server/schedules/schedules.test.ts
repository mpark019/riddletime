import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser, requireTestAdminPool } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({ getVerifiedUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const {
  createManualSharedRiddle,
  createManualSharedRiddleInput,
  deleteSchedule,
  getScheduleDetail,
  isDuplicateDateViolation,
  listSchedules,
} = await import("./schedules");
const { submitChallenge } = await import("@/server/challenges/challenges");
const { ConflictError, ForbiddenError, NotFoundError } = await import("@/server/http/errors");
const { POST } = await import("@/app/api/admin/generate-challenge/route");
const { GET: listRoute } = await import("@/app/api/admin/challenges/route");
const { GET: detailRoute } = await import("@/app/api/admin/challenges/[id]/route");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

async function createProfile(role: "admin" | "spectator" | "player") {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Scheduler ', ($1::uuid)::text), $2)",
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

function validInput(activeDate = futureDate()) {
  return {
    active_date: activeDate,
    mode: "shared",
    allowed_types: ["riddle"],
    difficulty_selection: "fixed",
    difficulty_presets: {
      standard: {
        types: {
          riddle: {
            time_limit_seconds: 120,
            max_attempts: 2,
            generation_settings: {},
            config: {},
            scoring_policy: {
              base_points: 100,
              speed_bonuses: [
                { under_ms: 30_000, points: 20 },
                { under_ms: 10_000, points: 50 },
              ],
              failure_penalty_points: 25,
            },
          },
        },
      },
    },
    selected_difficulty: "standard",
    manual_puzzle: {
      type: "riddle",
      prompt: "  What has keys but no locks?  ",
      accepted_answers: [" Piano ", "a piano"],
    },
  };
}

function postRequest(body: unknown) {
  return new Request("https://riddletime.example/api/admin/generate-challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("manual shared-riddle scheduling", () => {
  it("atomically saves the schedule and resolved puzzle snapshot (AC-1, AC-7)", async () => {
    const adminId = await createProfile("admin");
    const input = validInput();
    getVerifiedUser.mockResolvedValue({ id: adminId });

    const response = await POST(postRequest(input));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      schedule_id: expect.any(String),
      active_date: input.active_date,
      status: "ready",
    });
    expect(JSON.stringify(body)).not.toContain("accepted");

    const { rows } = await pool.query(
      `select d.active_date::text, d.mode, d.allowed_types, d.difficulty_selection,
              d.difficulty_presets, d.selected_difficulty, d.created_by,
              c.type, c.difficulty, c.prompt, c.config, c.answer_data,
              c.max_attempts, c.time_limit_seconds, c.scoring_policy
       from daily_challenges d
       join challenges c on c.daily_challenge_id = d.id
       where d.id = $1`,
      [body.schedule_id],
    );
    expect(rows).toEqual([{
      active_date: input.active_date,
      mode: "shared",
      allowed_types: ["riddle"],
      difficulty_selection: "fixed",
      difficulty_presets: input.difficulty_presets,
      selected_difficulty: "standard",
      created_by: adminId,
      type: "riddle",
      difficulty: "standard",
      prompt: "What has keys but no locks?",
      config: {},
      answer_data: { accepted: ["Piano", "a piano"] },
      max_attempts: 2,
      time_limit_seconds: 120,
      scoring_policy: {
        base_points: 100,
        speed_bonuses: [
          { under_ms: 30_000, points: 20 },
          { under_ms: 10_000, points: 50 },
        ],
        failure_penalty_points: 25,
      },
    }]);
  });

  it.each(["spectator", "player"] as const)(
    "rejects a %s before writing a schedule (AC-2)",
    async (role) => {
      const userId = await createProfile(role);
      const input = validInput();
      getVerifiedUser.mockResolvedValue({ id: userId });

      await expect(createManualSharedRiddle(input)).rejects.toBeInstanceOf(ForbiddenError);
      const { rows } = await pool.query(
        "select count(*)::int as count from daily_challenges where active_date = $1::date",
        [input.active_date],
      );
      expect(rows[0].count).toBe(0);
    },
  );

  it("returns 401 for an unauthenticated API caller (AC-2)", async () => {
    const input = validInput();
    getVerifiedUser.mockResolvedValue(null);

    const response = await POST(postRequest(input));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
    const { rows } = await pool.query(
      "select count(*)::int as count from daily_challenges where active_date = $1::date",
      [input.active_date],
    );
    expect(rows[0].count).toBe(0);
  });

  it("checks the admin role before reporting validation details", async () => {
    const playerId = await createProfile("player");
    getVerifiedUser.mockResolvedValue({ id: playerId });

    const response = await POST(postRequest({ mode: "personal" }));

    expect(response.status).toBe(403);
  });

  it("rejects a past date using the transaction timezone (AC-3)", async () => {
    const adminId = await createProfile("admin");
    const input = validInput("1900-01-01");
    getVerifiedUser.mockResolvedValue({ id: adminId });

    await expect(createManualSharedRiddle(input)).rejects.toThrow("past");
    const { rows } = await pool.query(
      "select count(*)::int as count from daily_challenges where active_date = $1::date",
      [input.active_date],
    );
    expect(rows[0].count).toBe(0);
  });

  it("returns a safe conflict for a duplicate date and creates no second puzzle (AC-4)", async () => {
    const adminId = await createProfile("admin");
    const input = validInput();
    getVerifiedUser.mockResolvedValue({ id: adminId });
    const first = await createManualSharedRiddle(input);

    await expect(createManualSharedRiddle(input)).rejects.toBeInstanceOf(ConflictError);
    const duplicateResponse = await POST(postRequest(input));
    expect(duplicateResponse.status).toBe(409);
    expect(await duplicateResponse.json()).toMatchObject({
      code: "conflict",
      error: "A riddle is already scheduled for that date",
    });
    const { rows } = await pool.query(
      "select count(*)::int as count from challenges where daily_challenge_id = $1",
      [first.scheduleId],
    );
    expect(rows[0].count).toBe(1);
  });

  it("maps a concurrent unique-index race to one safe conflict (AC-4)", async () => {
    const firstAdminId = await createProfile("admin");
    const secondAdminId = await createProfile("admin");
    const input = validInput();
    const advisoryLockKey = 471_029_337;
    const adminPool = requireTestAdminPool();
    const blocker = await adminPool.connect();
    let first: Promise<Awaited<ReturnType<typeof createManualSharedRiddle>>> | undefined;
    let second: Promise<Awaited<ReturnType<typeof createManualSharedRiddle>>> | undefined;

    try {
      await blocker.query("select pg_advisory_lock($1)", [advisoryLockKey]);
      await adminPool.query(
        `create function riddle_private.test_block_schedule_insert()
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
      await adminPool.query(
        `create trigger aa_test_block_schedule_insert
         before insert on public.daily_challenges
         for each row when (new.active_date = '${input.active_date}'::date)
         execute function riddle_private.test_block_schedule_insert()`,
      );
      getVerifiedUser
        .mockResolvedValueOnce({ id: firstAdminId })
        .mockResolvedValueOnce({ id: secondAdminId });

      first = createManualSharedRiddle(input);
      await vi.waitFor(async () => {
        const { rows } = await adminPool.query(
          "select count(*)::int as count from pg_stat_activity where wait_event = 'advisory'",
        );
        expect(rows[0].count).toBeGreaterThanOrEqual(1);
      });
      second = createManualSharedRiddle(input);
      await vi.waitFor(async () => {
        const { rows } = await adminPool.query(
          "select count(*)::int as count from pg_stat_activity where wait_event = 'advisory'",
        );
        expect(rows[0].count).toBeGreaterThanOrEqual(2);
      });

      await blocker.query("select pg_advisory_unlock($1)", [advisoryLockKey]);
      const outcomes = await Promise.allSettled([first, second]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(ConflictError) });

      const { rows } = await pool.query(
        `select count(distinct d.id)::int as schedules, count(c.id)::int as puzzles
         from daily_challenges d
         left join challenges c on c.daily_challenge_id = d.id
         where d.active_date = $1::date`,
        [input.active_date],
      );
      expect(rows[0]).toEqual({ schedules: 1, puzzles: 1 });
    } finally {
      await blocker.query("select pg_advisory_unlock($1)", [advisoryLockKey]).catch(() => undefined);
      blocker.release();
      await Promise.allSettled([first, second].filter(Boolean));
      await adminPool.query("drop trigger if exists aa_test_block_schedule_insert on public.daily_challenges");
      await adminPool.query("drop function if exists riddle_private.test_block_schedule_insert()");
    }
  }, 10_000);
});

describe("isDuplicateDateViolation", () => {
  it("matches only the schedule date unique constraint", () => {
    expect(isDuplicateDateViolation({ code: "23505", constraint: "daily_challenges_active_date_key" })).toBe(true);
    expect(isDuplicateDateViolation({ code: "23505", constraint: "challenges_one_shared" })).toBe(false);
    expect(isDuplicateDateViolation({ code: "23514", constraint: "daily_challenges_active_date_key" })).toBe(false);
    expect(isDuplicateDateViolation(null)).toBe(false);
  });
});

describe("manual shared-riddle request validation", () => {
  it.each([
    ["personal mode", (input: ReturnType<typeof validInput>) => { (input as { mode: string }).mode = "personal"; }],
    ["unsupported type", (input: ReturnType<typeof validInput>) => { (input.allowed_types as string[]) = ["character_puzzle"]; }],
    ["random difficulty", (input: ReturnType<typeof validInput>) => { (input as { difficulty_selection: string }).difficulty_selection = "random_daily"; }],
    ["unknown selected preset", (input: ReturnType<typeof validInput>) => { input.selected_difficulty = "missing"; }],
    ["zero attempts", (input: ReturnType<typeof validInput>) => { input.difficulty_presets.standard.types.riddle.max_attempts = 0; }],
    ["duplicate speed thresholds", (input: ReturnType<typeof validInput>) => { input.difficulty_presets.standard.types.riddle.scoring_policy.speed_bonuses[1].under_ms = 30_000; }],
    ["speed threshold after the deadline", (input: ReturnType<typeof validInput>) => { input.difficulty_presets.standard.types.riddle.scoring_policy.speed_bonuses[0].under_ms = 120_001; }],
    ["speed threshold equal to the time limit", (input: ReturnType<typeof validInput>) => { input.difficulty_presets.standard.types.riddle.scoring_policy.speed_bonuses[0].under_ms = 120_000; }],
    ["reward integer overflow", (input: ReturnType<typeof validInput>) => { input.difficulty_presets.standard.types.riddle.scoring_policy.base_points = 2_147_483_647; }],
    ["negative penalty", (input: ReturnType<typeof validInput>) => { input.difficulty_presets.standard.types.riddle.scoring_policy.failure_penalty_points = -1; }],
    ["blank prompt", (input: ReturnType<typeof validInput>) => { input.manual_puzzle.prompt = "   "; }],
    ["unusable accepted answer", (input: ReturnType<typeof validInput>) => { input.manual_puzzle.accepted_answers = ["!!!"]; }],
  ])("rejects %s before persistence (AC-5)", (_label, mutate) => {
    const input = validInput();
    mutate(input);
    expect(() => createManualSharedRiddleInput.parse(input)).toThrow();
  });
});

describe("admin riddle list and delete", () => {
  async function scheduleRiddle(adminId: string, maxAttempts = 1) {
    const input = validInput();
    input.difficulty_presets.standard.types.riddle.max_attempts = maxAttempts;
    getVerifiedUser.mockResolvedValue({ id: adminId });
    const created = await createManualSharedRiddle(input);
    return { scheduleId: created.scheduleId, input };
  }

  async function playToResult(scheduleId: string, playerId: string, response: string) {
    const { rows } = await pool.query(
      "select id from challenges where daily_challenge_id = $1",
      [scheduleId],
    );
    await pool.query(
      "insert into submissions (challenge_id, challenge_mode, user_id) values ($1, 'shared', $2)",
      [rows[0].id, playerId],
    );
    getVerifiedUser.mockResolvedValue({ id: playerId });
    return submitChallenge(scheduleId, response, randomUUID());
  }

  async function ledger(playerId: string) {
    const { rows } = await pool.query(
      "select kind, amount from point_transactions where user_id = $1 order by amount",
      [playerId],
    );
    return rows;
  }

  it("lists scheduled riddles with their puzzle, scoring, and play counts (AC-1)", async () => {
    const adminId = await createProfile("admin");
    const { scheduleId, input } = await scheduleRiddle(adminId);
    await playToResult(scheduleId, await createProfile("player"), "piano");
    await pool.query(
      `insert into submissions (challenge_id, challenge_mode, user_id)
       select c.id, 'shared', $2 from challenges c where c.daily_challenge_id = $1`,
      [scheduleId, await createProfile("player")],
    );
    getVerifiedUser.mockResolvedValue({ id: adminId });

    const schedules = await listSchedules();

    expect(schedules.find((schedule) => schedule.id === scheduleId)).toEqual({
      id: scheduleId,
      activeDate: input.active_date,
      mode: "shared",
      assignedCount: 1,
      timing: "upcoming",
      type: "riddle",
      difficulty: "standard",
      prompt: "What has keys but no locks?",
      acceptedAnswers: ["Piano", "a piano"],
      timeLimitSeconds: 120,
      maxAttempts: 1,
      scoringPolicy: input.difficulty_presets.standard.types.riddle.scoring_policy,
      startedCount: 2,
      finishedCount: 1,
    });
  });

  it("lists newer dates first", async () => {
    const adminId = await createProfile("admin");
    const first = await scheduleRiddle(adminId);
    const second = await scheduleRiddle(adminId);
    getVerifiedUser.mockResolvedValue({ id: adminId });

    const ids = (await listSchedules()).map((schedule) => schedule.id);

    const [newer, older] = first.input.active_date > second.input.active_date ? [first, second] : [second, first];
    expect(ids.indexOf(newer.scheduleId)).toBeLessThan(ids.indexOf(older.scheduleId));
  });

  it("rejects listing for a non-admin over the API (AC-1)", async () => {
    getVerifiedUser.mockResolvedValue({ id: await createProfile("player") });

    const response = await listRoute();

    expect(response.status).toBe(403);
  });

  it("deletes an unplayed riddle so its date can be scheduled again (AC-2)", async () => {
    const adminId = await createProfile("admin");
    const { scheduleId, input } = await scheduleRiddle(adminId);
    getVerifiedUser.mockResolvedValue({ id: adminId });

    expect(await deleteSchedule(scheduleId)).toEqual({ id: scheduleId, removedResults: 0 });

    const { rows } = await pool.query(
      "select count(*)::int as count from challenges where daily_challenge_id = $1",
      [scheduleId],
    );
    expect(rows[0].count).toBe(0);
    getVerifiedUser.mockResolvedValue({ id: adminId });
    await expect(createManualSharedRiddle(input)).resolves.toMatchObject({ status: "ready" });
  });

  it("deletes a played riddle and reverses only its points (AC-3)", async () => {
    const adminId = await createProfile("admin");
    const { scheduleId } = await scheduleRiddle(adminId);
    const winner = await createProfile("player");
    const loser = await createProfile("player");
    await playToResult(scheduleId, winner, "piano");
    await playToResult(scheduleId, loser, "guitar");
    await pool.query(
      `insert into point_transactions (user_id, amount, kind, reason, created_by, operation_key)
       values ($1, 7, 'manual_adjustment', 'Unrelated bonus', $2, $3)`,
      [winner, adminId, `unrelated:${winner}`],
    );
    expect(await ledger(loser)).toEqual([{ kind: "challenge_result", amount: -25 }]);
    getVerifiedUser.mockResolvedValue({ id: adminId });

    expect(await deleteSchedule(scheduleId)).toEqual({ id: scheduleId, removedResults: 2 });

    expect(await ledger(winner)).toEqual([{ kind: "manual_adjustment", amount: 7 }]);
    expect(await ledger(loser)).toEqual([]);
    const { rows } = await pool.query(
      "select count(*)::int as count from submissions where user_id = any($1::uuid[])",
      [[winner, loser]],
    );
    expect(rows[0].count).toBe(0);
  });

  it("deletes a riddle with a game still in progress (AC-3)", async () => {
    const adminId = await createProfile("admin");
    const { scheduleId } = await scheduleRiddle(adminId);
    await pool.query(
      `insert into submissions (challenge_id, challenge_mode, user_id)
       select c.id, 'shared', $2 from challenges c where c.daily_challenge_id = $1`,
      [scheduleId, await createProfile("player")],
    );
    getVerifiedUser.mockResolvedValue({ id: adminId });

    await expect(deleteSchedule(scheduleId)).resolves.toEqual({ id: scheduleId, removedResults: 0 });
  });

  it.each(["spectator", "player"] as const)("rejects deletion by a %s (AC-4)", async (role) => {
    const { scheduleId } = await scheduleRiddle(await createProfile("admin"));
    getVerifiedUser.mockResolvedValue({ id: await createProfile(role) });

    await expect(deleteSchedule(scheduleId)).rejects.toBeInstanceOf(ForbiddenError);

    const { rows } = await pool.query("select count(*)::int as count from daily_challenges where id = $1", [scheduleId]);
    expect(rows[0].count).toBe(1);
  });

  it("returns not found for an unknown riddle (AC-4)", async () => {
    getVerifiedUser.mockResolvedValue({ id: await createProfile("admin") });

    await expect(deleteSchedule(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps the app role from bypassing history protection directly (AC-5)", async () => {
    const adminId = await createProfile("admin");
    const { scheduleId } = await scheduleRiddle(adminId);
    await playToResult(scheduleId, await createProfile("player"), "piano");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local riddle_private.schedule_delete = 'on'");
      await expect(client.query(
        `delete from submissions s using challenges c
         where c.id = s.challenge_id and c.daily_challenge_id = $1`,
        [scheduleId],
      )).rejects.toThrow();
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  describe("schedule detail", () => {
    async function createNamedPlayer(displayName: string) {
      const id = await createAuthUser();
      await pool.query(
        "insert into profiles (id, display_name, role) values ($1, $2, 'player')",
        [id, displayName],
      );
      return id;
    }

    it("shows who played with answers, points, and times, and who did not (AC-6)", async () => {
      const adminId = await createProfile("admin");
      const { scheduleId } = await scheduleRiddle(adminId, 2);
      const solver = await createNamedPlayer("Detail solver");
      const failer = await createNamedPlayer("Detail failer");
      const idle = await createNamedPlayer("Detail idle");
      const walker = await createNamedPlayer("Detail walker");
      await playToResult(scheduleId, solver, "piano");
      await playToResult(scheduleId, failer, "guitar");
      getVerifiedUser.mockResolvedValue({ id: failer });
      await submitChallenge(scheduleId, "drums", randomUUID());
      await pool.query(
        `insert into submissions (challenge_id, challenge_mode, user_id)
         select c.id, 'shared', $2 from challenges c where c.daily_challenge_id = $1`,
        [scheduleId, walker],
      );
      getVerifiedUser.mockResolvedValue({ id: adminId });

      const detail = await getScheduleDetail(scheduleId);

      expect(detail.schedule.id).toBe(scheduleId);
      const byId = new Map(detail.players.map((player) => [player.userId, player]));
      expect(byId.get(solver)).toMatchObject({
        displayName: "Detail solver",
        status: "completed",
        correct: true,
        attempts: 1,
        guesses: [{ response: "piano", correct: true }],
      });
      expect(byId.get(solver)?.points).toBeGreaterThanOrEqual(100);
      expect(byId.get(solver)?.breakdown).toEqual({
        basePoints: expect.any(Number),
        speedBonusPoints: expect.any(Number),
        penaltyPoints: 0,
      });
      expect(byId.get(failer)?.breakdown).toEqual({ basePoints: 0, speedBonusPoints: 0, penaltyPoints: 25 });
      expect(byId.get(walker)?.breakdown).toBeNull();
      expect(byId.get(idle)?.breakdown).toBeNull();
      expect(byId.get(solver)?.submittedAt).toEqual(expect.any(String));
      expect(byId.get(solver)?.timeTakenMs).toEqual(expect.any(Number));
      expect(byId.get(failer)).toMatchObject({
        status: "completed",
        correct: false,
        attempts: 2,
        guesses: [{ response: "guitar", correct: false }, { response: "drums", correct: false }],
        points: -25,
      });
      expect(byId.get(walker)).toMatchObject({
        status: "in_progress",
        correct: null,
        attempts: 0,
        guesses: [],
        points: null,
        submittedAt: null,
      });
      expect(byId.get(idle)).toMatchObject({
        status: "not_started",
        guesses: [],
        points: null,
        startedAt: null,
      });
      const order = detail.players.map((player) => player.userId);
      expect(order.indexOf(solver)).toBeLessThan(order.indexOf(idle));
      expect(order.indexOf(walker)).toBeLessThan(order.indexOf(idle));
    });

    it("excludes admins and spectators from the not-played list (AC-6)", async () => {
      const adminId = await createProfile("admin");
      const spectatorId = await createProfile("spectator");
      const { scheduleId } = await scheduleRiddle(adminId);
      getVerifiedUser.mockResolvedValue({ id: adminId });

      const detail = await getScheduleDetail(scheduleId);

      const ids = detail.players.map((player) => player.userId);
      expect(ids).not.toContain(adminId);
      expect(ids).not.toContain(spectatorId);
    });

    it("marks an overdue unfinished game as expired (AC-6)", async () => {
      const adminId = await createProfile("admin");
      const { scheduleId } = await scheduleRiddle(adminId);
      const player = await createNamedPlayer("Detail overdue");
      const { rows } = await pool.query(
        `insert into submissions (challenge_id, challenge_mode, user_id)
         select c.id, 'shared', $2 from challenges c where c.daily_challenge_id = $1 returning id`,
        [scheduleId, player],
      );
      const admin = requireTestAdminPool();
      await admin.query("begin");
      await admin.query("set local session_replication_role = replica");
      await admin.query(
        "update submissions set started_at = started_at - interval '10 minutes' where id = $1",
        [rows[0].id],
      );
      await admin.query("commit");
      getVerifiedUser.mockResolvedValue({ id: adminId });

      const detail = await getScheduleDetail(scheduleId);

      expect(detail.players.find((entry) => entry.userId === player)?.status).toBe("expired");
    });

    it("rejects a non-admin and returns not found for an unknown riddle (AC-6)", async () => {
      const { scheduleId } = await scheduleRiddle(await createProfile("admin"));
      getVerifiedUser.mockResolvedValue({ id: await createProfile("player") });
      await expect(getScheduleDetail(scheduleId)).rejects.toBeInstanceOf(ForbiddenError);

      getVerifiedUser.mockResolvedValue({ id: await createProfile("admin") });
      await expect(getScheduleDetail(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    });

    it("serves the detail over the API for an admin only (AC-6)", async () => {
      const adminId = await createProfile("admin");
      const { scheduleId } = await scheduleRiddle(adminId);
      const context = { params: Promise.resolve({ id: scheduleId }) };
      const request = new Request(`https://riddletime.example/api/admin/challenges/${scheduleId}`);

      getVerifiedUser.mockResolvedValue({ id: adminId });
      const allowed = await detailRoute(request, context);
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ schedule: { id: scheduleId }, players: expect.any(Array) });

      getVerifiedUser.mockResolvedValue({ id: await createProfile("player") });
      expect((await detailRoute(request, context)).status).toBe(403);
    });
  });
});
