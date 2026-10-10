import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser, insertPuzzle } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({ getVerifiedUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { getDateAssignments, getScheduleDetail, listSchedules, removeAssignment } = await import("./schedules");
const { getChallengeSession, getStaffPlayerStatuses, submitChallenge } = await import("@/server/challenges/challenges");
const { ForbiddenError, NotFoundError } = await import("@/server/http/errors");
const { POST } = await import("@/app/api/admin/generate-challenge/route");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

async function createProfile(role: "admin" | "spectator" | "player") {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Pers ', ($1::uuid)::text), $2)",
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

const scoring = { base_points: 100, speed_bonuses: [], failure_penalty_points: 20 };

function riddleBody(date: string, playerIds: string[], prompt = "What has keys but no locks?", answer = "piano") {
  return {
    active_date: date,
    mode: "personal",
    player_ids: playerIds,
    allowed_types: ["riddle"],
    difficulty_selection: "fixed",
    difficulty_presets: {
      easy: { types: { riddle: { time_limit_seconds: 90, max_attempts: 2, generation_settings: {}, config: {}, scoring_policy: scoring } } },
    },
    selected_difficulty: "easy",
    manual_puzzle: { type: "riddle", prompt, accepted_answers: [answer] },
  };
}

function letterBody(date: string, playerIds: string[]) {
  return {
    active_date: date,
    mode: "personal",
    player_ids: playerIds,
    allowed_types: ["character_puzzle"],
    difficulty_selection: "fixed",
    difficulty_presets: {
      hard: { types: { character_puzzle: { time_limit_seconds: 60, max_attempts: 6, generation_settings: {}, config: {}, scoring_policy: scoring } } },
    },
    selected_difficulty: "hard",
    manual_puzzle: { type: "character_puzzle", target: "crane7" },
  };
}

function post(body: unknown) {
  return POST(new Request("https://riddletime.example/api/admin/generate-challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function asUser(id: string) {
  getVerifiedUser.mockResolvedValue({ id });
}

async function puzzlesOn(date: string) {
  const { rows } = await pool.query(
    `select c.assigned_to, c.mode, c.type, c.difficulty, pz.prompt, c.time_limit_seconds, c.max_attempts
     from challenges c join daily_challenges d on d.id = c.daily_challenge_id
     join puzzles pz on pz.id = c.puzzle_id
     where d.active_date = $1::date order by c.created_at`,
    [date],
  );
  return rows;
}

describe("personal puzzle assignment", () => {
  it("creates a personal day with one puzzle per selected player and hides answers (AC-1, AC-6)", async () => {
    const admin = await createProfile("admin");
    const [a, b] = [await createProfile("player"), await createProfile("player")];
    const date = futureDate();
    await asUser(admin);

    const response = await post(riddleBody(date, [a, b]));
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(text).not.toContain("piano");
    const body = JSON.parse(text);
    expect(body).toMatchObject({ active_date: date, status: "ready", assigned_count: 2, skipped_count: 0 });
    const rows = await puzzlesOn(date);
    expect(rows.map((row) => row.assigned_to).sort()).toEqual([a, b].sort());
    expect(rows.every((row) => row.mode === "personal" && row.difficulty === "easy")).toBe(true);
    const { rows: days } = await pool.query("select mode from daily_challenges where active_date = $1::date", [date]);
    expect(days).toEqual([{ mode: "personal" }]);
  });

  it("skips players who already have a puzzle that day and assigns the rest (AC-2)", async () => {
    const admin = await createProfile("admin");
    const [a, b, c] = [await createProfile("player"), await createProfile("player"), await createProfile("player")];
    const date = futureDate();
    await asUser(admin);
    expect((await post(letterBody(date, [a]))).status).toBe(201);

    const response = await post(riddleBody(date, [a, b, c], "Shared one", "echo"));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ assigned_count: 2, skipped_count: 1, skipped_player_ids: [a] });
    const rows = await puzzlesOn(date);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.assigned_to === a)?.type).toBe("character_puzzle");
    expect(rows.find((row) => row.assigned_to === b)).toMatchObject({ type: "riddle", prompt: "Shared one" });
    const { rows: days } = await pool.query("select count(*)::int as n from daily_challenges where active_date = $1::date", [date]);
    expect(days[0].n).toBe(1);
  });

  it("returns 409 and writes nothing when every selected player is already assigned (AC-2)", async () => {
    const admin = await createProfile("admin");
    const a = await createProfile("player");
    const date = futureDate();
    await asUser(admin);
    await post(riddleBody(date, [a]));

    const response = await post(riddleBody(date, [a], "Second", "nope"));

    expect(response.status).toBe(409);
    expect(await puzzlesOn(date)).toHaveLength(1);
  });

  it("rejects a date that already has a native shared puzzle (AC-3)", async () => {
    const admin = await createProfile("admin");
    const a = await createProfile("player");
    const date = futureDate();
    await asUser(admin);
    const shared = { ...riddleBody(date, []), mode: "shared" } as Record<string, unknown>;
    delete shared.player_ids;
    expect((await post(shared)).status).toBe(201);

    const response = await post(riddleBody(date, [a]));

    expect(response.status).toBe(409);
    expect(await puzzlesOn(date)).toHaveLength(1);
  });

  it("rejects non-admins, past dates and bad player lists without writing (AC-4)", async () => {
    const admin = await createProfile("admin");
    const player = await createProfile("player");
    const spectator = await createProfile("spectator");
    const date = futureDate();

    await asUser(player);
    expect((await post(riddleBody(date, [player]))).status).toBe(403);

    await asUser(admin);
    expect((await post(riddleBody("2000-01-01", [player]))).status).toBe(400);
    expect((await post(riddleBody(date, []))).status).toBe(400);
    expect((await post(riddleBody(date, [player, player]))).status).toBe(400);
    expect((await post(riddleBody(date, [randomUUID()]))).status).toBe(400);
    expect((await post(riddleBody(date, [spectator]))).status).toBe(400);
    expect((await post(riddleBody(date, [admin]))).status).toBe(400);
    expect(await puzzlesOn(date)).toHaveLength(0);
    const { rows } = await pool.query("select 1 from daily_challenges where active_date = $1::date", [date]);
    expect(rows).toHaveLength(0);
  });

  it("lists personal days and shows each player's puzzle in the detail (AC-8)", async () => {
    const admin = await createProfile("admin");
    const [a, b] = [await createProfile("player"), await createProfile("player")];
    const date = futureDate();
    await asUser(admin);
    await post(riddleBody(date, [a], "Mine", "one"));
    await post(letterBody(date, [b]));

    const schedule = (await listSchedules()).find((entry) => entry.activeDate === date)!;
    expect(schedule).toMatchObject({ mode: "personal", assignedCount: 2, prompt: null });
    const detail = await getScheduleDetail(schedule.id);
    const mine = detail.players.find((player) => player.userId === a)!;
    const theirs = detail.players.find((player) => player.userId === b)!;
    const unassigned = detail.players.find((player) => player.userId !== a && player.userId !== b)!;
    expect(mine).toMatchObject({ status: "not_started", puzzle: { type: "riddle", prompt: "Mine", acceptedAnswers: ["one"], maxAttempts: 2, timeLimitSeconds: 90 } });
    expect(theirs.puzzle).toMatchObject({ maxAttempts: 6, timeLimitSeconds: 60 });
    expect(theirs.puzzle).toMatchObject({ type: "character_puzzle", difficulty: "hard" });
    expect(unassigned).toMatchObject({ status: "not_assigned", puzzle: null });
  });
});

describe("date assignments preview (AC-9)", () => {
  it("lists who already has a puzzle on a date, without answers", async () => {
    const admin = await createProfile("admin");
    const [a, b] = [await createProfile("player"), await createProfile("player")];
    const date = futureDate();
    await asUser(admin);
    expect(await getDateAssignments(date)).toEqual({ scheduleId: null, mode: null, assignments: [] });

    await post(riddleBody(date, [a], "Mine", "secret"));
    await post(letterBody(date, [b]));
    const result = await getDateAssignments(date);

    expect(result.mode).toBe("personal");
    expect(result.assignments).toHaveLength(2);
    expect(result.assignments.find((entry) => entry.playerId === a)).toMatchObject({
      playerId: a, type: "riddle", difficulty: "easy", prompt: "Mine", status: "not_started", correct: null, points: null,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("is admin-only", async () => {
    const player = await createProfile("player");
    await asUser(player);

    await expect(getDateAssignments(futureDate())).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("removing a single assignment (AC-10)", () => {
  async function dayWith(playerCount: number) {
    const admin = await createProfile("admin");
    const players = await Promise.all(Array.from({ length: playerCount }, () => createProfile("player")));
    const date = futureDate();
    await asUser(admin);
    await post(riddleBody(date, players));
    const roster = await getDateAssignments(date);
    const challengeOf = (playerId: string) => roster.assignments.find((entry) => entry.playerId === playerId)!.challengeId;
    return { admin, players, date, challengeOf };
  }

  it("removes one unplayed assignment and keeps the rest", async () => {
    const { players, date, challengeOf } = await dayWith(2);

    const result = await removeAssignment(challengeOf(players[0]));

    expect(result.scheduleRemoved).toBe(false);
    expect((await puzzlesOn(date)).map((row) => row.assigned_to)).toEqual([players[1]]);
  });

  it("removes the empty day with its last assignment", async () => {
    const { players, date, challengeOf } = await dayWith(1);

    expect((await removeAssignment(challengeOf(players[0]))).scheduleRemoved).toBe(true);
    const { rows } = await pool.query("select 1 from daily_challenges where active_date = $1::date", [date]);
    expect(rows).toHaveLength(0);
  });

  it("still removes an unplayed assignment after another player started the day", async () => {
    const { players, date, challengeOf } = await dayWith(2);
    await pool.query(
      "insert into submissions (challenge_id, challenge_mode, assigned_to, user_id) values ($1, 'personal', $2, $2)",
      [challengeOf(players[0]), players[0]],
    );

    await removeAssignment(challengeOf(players[1]));

    expect((await puzzlesOn(date)).map((row) => row.assigned_to)).toEqual([players[0]]);
  });

  it("deletes a played assignment with its game and the points it earned, leaving others untouched", async () => {
    const { admin, players, date, challengeOf } = await dayWith(2);
    const dailyId = (await getDateAssignments(date)).scheduleId!;
    for (const player of players) {
      await pool.query(
        "insert into submissions (challenge_id, challenge_mode, assigned_to, user_id) values ($1, 'personal', $2, $2)",
        [challengeOf(player), player],
      );
      await asUser(player);
      await submitChallenge(dailyId, "piano");
    }
    await asUser(admin);
    const pointsOf = async (id: string) => (await pool.query(
      "select coalesce(sum(amount), 0)::int as total from point_transactions where user_id = $1 and kind = 'challenge_result'",
      [id],
    )).rows[0].total as number;
    expect(await pointsOf(players[0])).toBe(100);

    const result = await removeAssignment(challengeOf(players[0]));

    expect(result).toMatchObject({ removedResults: 1, scheduleRemoved: false });
    expect(await pointsOf(players[0])).toBe(0);
    expect(await pointsOf(players[1])).toBe(100);
    const { rows: gone } = await pool.query("select 1 from submissions where user_id = $1", [players[0]]);
    expect(gone).toHaveLength(0);
    expect((await puzzlesOn(date)).map((row) => row.assigned_to)).toEqual([players[1]]);
  });

  it("refuses a shared puzzle, an unknown id and non-admins", async () => {
    const { players, challengeOf } = await dayWith(1);
    await expect(removeAssignment(randomUUID())).rejects.toBeInstanceOf(NotFoundError);

    const sharedDate = futureDate();
    const shared = { ...riddleBody(sharedDate, []), mode: "shared" } as Record<string, unknown>;
    delete shared.player_ids;
    await post(shared);
    const sharedRoster = await getDateAssignments(sharedDate);
    expect(sharedRoster).toMatchObject({ mode: "shared", assignments: [{ playerId: null, status: "not_started" }] });
    await expect(removeAssignment(sharedRoster.assignments[0].challengeId)).rejects.toThrow("Only personal");

    await asUser(players[0]);
    await expect(removeAssignment(challengeOf(players[0]))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reports play status and points in the roster", async () => {
    const { admin, players, date, challengeOf } = await dayWith(2);
    await pool.query(
      "insert into submissions (challenge_id, challenge_mode, assigned_to, user_id) values ($1, 'personal', $2, $2)",
      [challengeOf(players[0]), players[0]],
    );
    const dailyId = (await getDateAssignments(date)).scheduleId!;
    await asUser(players[0]);
    await submitChallenge(dailyId, "piano");
    await asUser(admin);

    const roster = await getDateAssignments(date);

    expect(roster.assignments.find((entry) => entry.playerId === players[0])).toMatchObject({ status: "completed", correct: true, points: 100 });
    expect(roster.assignments.find((entry) => entry.playerId === players[1])).toMatchObject({ status: "not_started" });
  });
});

describe("staff per-player statuses (AC-11)", () => {
  it("reports each player's play state without prompts or answers", async () => {
    const admin = await createProfile("admin");
    const [a, b, c] = [await createProfile("player"), await createProfile("player"), await createProfile("player")];
    const date = futureDate();
    await asUser(admin);
    await post(riddleBody(date, [a, b], "Only for A and B", "topsecret"));
    const dailyId = (await getDateAssignments(date)).scheduleId!;
    const challengeOf = async (playerId: string) =>
      (await getDateAssignments(date)).assignments.find((entry) => entry.playerId === playerId)!.challengeId;
    await pool.query(
      "insert into submissions (challenge_id, challenge_mode, assigned_to, user_id) values ($1, 'personal', $2, $2)",
      [await challengeOf(a), a],
    );
    await asUser(a);
    await submitChallenge(dailyId, "topsecret");
    const client = await pool.connect();
    try {
      const statuses = await getStaffPlayerStatuses(client, dailyId);
      expect(statuses.every((entry) => entry.play === null)).toBe(true);
      const withPlay = await getStaffPlayerStatuses(client, dailyId, true);
      expect(withPlay.find((entry) => entry.userId === a)?.play).toMatchObject({ status: "completed", prompt: "Only for A and B" });
      expect(withPlay.find((entry) => entry.userId === b)?.play).toMatchObject({ status: "not_started", available: true });
      expect(withPlay.find((entry) => entry.userId === c)?.play).toBeNull();
      const byId = (id: string) => statuses.find((entry) => entry.userId === id)!;

      expect(byId(a)).toMatchObject({ status: "solved", attempts: 1, points: 100, puzzle: { type: "riddle", difficulty: "easy", maxAttempts: 2 } });
      expect(byId(b)).toMatchObject({ status: "not_started", attempts: 0, points: null });
      expect(byId(c)).toMatchObject({ status: "no_riddle", puzzle: null });
      expect(JSON.stringify(statuses)).not.toMatch(/topsecret|Only for A/);
    } finally {
      client.release();
    }
  });
});

describe("player runtime on a personal day (AC-5)", () => {
  async function pastPersonalDay() {
    const admin = await createProfile("admin");
    const [a, b, none] = [await createProfile("player"), await createProfile("player"), await createProfile("player")];
    const daysAgo = 2000 + Math.floor(Math.random() * 1_000_000);
    const { rows: day } = await pool.query(
      `insert into daily_challenges
         (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, created_by)
       values (current_date + $1::int, 'personal', array['riddle'], 'random_player', $2::jsonb, $3)
       returning id`,
      [daysAgo, JSON.stringify({ easy: { types: { riddle: {} } } }), admin],
    );
    const dailyId = day[0].id as string;
    async function assign(playerId: string, prompt: string, answer: string) {
      const puzzleId = await insertPuzzle(pool, { createdBy: admin, prompt, answerData: { accepted: [answer] } });
      const { rows } = await pool.query(
        `insert into challenges
           (daily_challenge_id, mode, assigned_to, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
         values ($1, 'personal', $2, 'riddle', $3, 'easy', 1, 120, $4::jsonb) returning id`,
        [dailyId, playerId, puzzleId, JSON.stringify(scoring)],
      );
      await pool.query(
        "insert into submissions (challenge_id, challenge_mode, assigned_to, user_id) values ($1, 'personal', $2, $2)",
        [rows[0].id, playerId],
      );
    }
    await assign(a, "Riddle for A", "alpha");
    await assign(b, "Riddle for B", "bravo");
    return { dailyId, a, b, none };
  }

  it("serves each player only their own puzzle", async () => {
    const { dailyId, a, b } = await pastPersonalDay();

    await asUser(a);
    const forA = await getChallengeSession(dailyId);
    await asUser(b);
    const forB = await getChallengeSession(dailyId);

    expect(forA.play).toMatchObject({ status: "in_progress", prompt: "Riddle for A" });
    expect(forB.play).toMatchObject({ prompt: "Riddle for B" });
  });

  it("does not expose a puzzle to an unassigned player", async () => {
    const { dailyId, none } = await pastPersonalDay();
    await asUser(none);

    await expect(getChallengeSession(dailyId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(submitChallenge(dailyId, "alpha")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("grades a submission against the caller's own answer", async () => {
    const { dailyId, a, b } = await pastPersonalDay();

    await asUser(b);
    const wrong = await submitChallenge(dailyId, "alpha");
    expect(wrong.correct).toBe(false);

    await asUser(a);
    const right = await submitChallenge(dailyId, "alpha");
    expect(right.correct).toBe(true);
  });
});
