import { randomUUID } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser, insertPuzzle } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({
  getVerifiedUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

const {
  createManualAdjustment,
  createManualAdjustmentForAllPlayers,
  createManualAdjustmentForPlayers,
  deletePointTransaction,
  getLeaderboard,
  listPointTransactions,
} = await import("./points");
const { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } = await import("@/server/http/errors");
const { POST: postPointTransaction } = await import("@/app/api/admin/point-transactions/route");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

async function createProfile(role: "spectator" | "player" | "admin", displayName: string, name: string | null = null) {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, name, display_name, role) values ($1, $2, $3, $4)",
    [id, name, displayName, role],
  );
  return id;
}

async function addPoints(userId: string, amount: number, label: string) {
  const { rows } = await pool.query(
    `insert into point_transactions (user_id, amount, kind, reason, created_by, operation_key)
     values ($1, $2, 'manual_adjustment', $3, $4, $5)
     returning id`,
    [userId, amount, label, await createProfile("admin", `Writer ${label}`), `seed:${label}:${randomUUID()}`],
  );
  return rows[0].id as string;
}

async function ensureLeaderboardRiddle() {
  const { rows: existing } = await pool.query(
    `select c.id from challenges c join puzzles pz on pz.id = c.puzzle_id
     where pz.prompt = 'Leaderboard statistics fixture'`,
  );
  if (existing[0]) return existing[0].id as string;

  const admin = await createProfile("admin", "Leaderboard fixture admin");
  const { rows: dailyRows } = await pool.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
     values ('2099-01-01', 'shared', array['riddle'], 'fixed', $1::jsonb, 'standard', $2)
     returning id`,
    [JSON.stringify({ standard: {} }), admin],
  );
  const puzzleId = await insertPuzzle(pool, {
    createdBy: admin,
    prompt: "Leaderboard statistics fixture",
    answerData: { accepted: ["fixture"] },
  });
  const { rows } = await pool.query(
    `insert into challenges
       (daily_challenge_id, mode, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
     values ($1, 'shared', 'riddle', $2, 'standard', 1, 60, $3::jsonb)
     returning id`,
    [dailyRows[0].id, puzzleId, JSON.stringify({ base_points: 1, speed_bonuses: [] })],
  );
  return rows[0].id as string;
}

async function addFinalizedRiddleSubmission(userId: string, correct: boolean) {
  const challengeId = await ensureLeaderboardRiddle();
  await pool.query(
    "insert into submissions (challenge_id, challenge_mode, user_id) values ($1, 'shared', $2)",
    [challengeId, userId],
  );
  await pool.query(
    "update submissions set submitted_at = started_at, correct = $3, time_taken_ms = 0, scoring_breakdown = $4::jsonb where challenge_id = $1 and user_id = $2",
    [challengeId, userId, correct, JSON.stringify({ total_points: correct ? 1 : 0 })],
  );
}

describe("leaderboard", () => {
  it("requires an authenticated application member", async () => {
    getVerifiedUser.mockResolvedValue(null);
    await expect(getLeaderboard()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("returns current players only with shared ranks and display-name tie ordering", async () => {
    const viewer = await createProfile("spectator", "Viewer");
    const alpha = await createProfile("player", "Alpha", "Alexandra");
    const bravo = await createProfile("player", "Bravo", "Brandon");
    const hidden = await createProfile("admin", "Hidden Admin");
    await addPoints(alpha, 40, "alpha");
    await addPoints(bravo, 40, "bravo");
    await addPoints(hidden, 999, "hidden");
    await addFinalizedRiddleSubmission(alpha, true);
    await addFinalizedRiddleSubmission(bravo, false);
    getVerifiedUser.mockResolvedValue({ id: viewer });

    const result = await getLeaderboard();
    const tiedEntries = result.filter((entry) => entry.userId === alpha || entry.userId === bravo);

    expect(result.some((entry) => entry.userId === hidden)).toBe(false);
    expect(tiedEntries.map((entry) => entry.displayName)).toEqual(["Alpha", "Bravo"]);
    expect(tiedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: alpha, displayName: "Alpha", name: "Alexandra", totalPoints: 40, correctRiddles: 1, incorrectRiddles: 0 }),
        expect.objectContaining({ userId: bravo, displayName: "Bravo", name: "Brandon", totalPoints: 40, correctRiddles: 0, incorrectRiddles: 1 }),
      ]),
    );
    expect(tiedEntries[0].rank).toBe(tiedEntries[1].rank);
  });

  it("orders tied players alphabetically by display name instead of UUID", async () => {
    const viewer = await createProfile("spectator", "Tie viewer");
    const firstId = await createProfile("player", "Placeholder one");
    const secondId = await createProfile("player", "Placeholder two");
    const [lowerId, higherId] = [firstId, secondId].sort();
    await pool.query("update profiles set display_name = $2 where id = $1", [lowerId, "Zulu tie"]);
    await pool.query("update profiles set display_name = $2 where id = $1", [higherId, "Alpha tie"]);
    await addPoints(lowerId, 75, "zulu tie");
    await addPoints(higherId, 75, "alpha tie");
    getVerifiedUser.mockResolvedValue({ id: viewer });

    const tiedEntries = (await getLeaderboard()).filter((entry) => entry.userId === lowerId || entry.userId === higherId);

    expect(tiedEntries.map((entry) => entry.displayName)).toEqual(["Alpha tie", "Zulu tie"]);
    expect(tiedEntries[0].rank).toBe(tiedEntries[1].rank);
  });
});

describe("manual point adjustments", () => {
  it("creates a signed adjustment and reports the resulting ledger balance", async () => {
    const admin = await createProfile("admin", "Adjustment admin");
    const player = await createProfile("player", "Adjustment player");
    getVerifiedUser.mockResolvedValue({ id: admin });

    const result = await createManualAdjustment({
      userId: player,
      amount: -15,
      reason: "Corrected duplicate award",
      operationKey: `adjust:${randomUUID()}`,
    });

    expect(result).toMatchObject({
      created: true,
      totalPoints: -15,
      entry: {
        userId: player,
        amount: -15,
        kind: "manual_adjustment",
        reason: "Corrected duplicate award",
        createdBy: admin,
      },
    });
  });

  it("applies one retry-safe adjustment to every current player", async () => {
    const admin = await createProfile("admin", "Bulk admin");
    const firstPlayer = await createProfile("player", "Bulk first");
    const secondPlayer = await createProfile("player", "Bulk second");
    await createProfile("spectator", "Bulk spectator");
    getVerifiedUser.mockResolvedValue({ id: admin });
    const input = { amount: -10, reason: "Missed penalty", operationKey: `all:${randomUUID()}` };

    const first = await createManualAdjustmentForAllPlayers(input);
    const retry = await createManualAdjustmentForAllPlayers(input);
    const { rows } = await pool.query(
      "select user_id, amount, reason from point_transactions where operation_key like $1 order by user_id",
      [`manual:all:${input.operationKey}:%`],
    );

    expect(first).toMatchObject({ created: true });
    expect(first.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: firstPlayer, amount: -10 }),
      expect.objectContaining({ userId: secondPlayer, amount: -10 }),
    ]));
    expect(retry).toMatchObject({ created: false });
    expect(rows.filter((row) => row.user_id === firstPlayer || row.user_id === secondPlayer)).toEqual([
      { user_id: [firstPlayer, secondPlayer].sort()[0], amount: -10, reason: "Missed penalty" },
      { user_id: [firstPlayer, secondPlayer].sort()[1], amount: -10, reason: "Missed penalty" },
    ]);
  });

  it("applies one retry-safe adjustment to selected current players only", async () => {
    const admin = await createProfile("admin", "Selected admin");
    const firstPlayer = await createProfile("player", "Selected first");
    const secondPlayer = await createProfile("player", "Selected second");
    const untouchedPlayer = await createProfile("player", "Selected untouched");
    getVerifiedUser.mockResolvedValue({ id: admin });
    const input = { userIds: [secondPlayer, firstPlayer], amount: 5, reason: "Team bonus", operationKey: `selected:${randomUUID()}` };

    const first = await createManualAdjustmentForPlayers(input);
    const retry = await createManualAdjustmentForPlayers(input);
    const { rows } = await pool.query(
      "select user_id, amount from point_transactions where operation_key like $1 order by user_id",
      [`manual:many:${input.operationKey}:%`],
    );

    expect(first).toMatchObject({ created: true, entries: expect.arrayContaining([
      expect.objectContaining({ userId: firstPlayer, amount: 5 }),
      expect.objectContaining({ userId: secondPlayer, amount: 5 }),
    ]) });
    expect(retry).toMatchObject({ created: false });
    expect(rows).toEqual([
      { user_id: [firstPlayer, secondPlayer].sort()[0], amount: 5 },
      { user_id: [firstPlayer, secondPlayer].sort()[1], amount: 5 },
    ]);
    expect(rows.some((row) => row.user_id === untouchedPlayer)).toBe(false);
  });

  it("rejects a partly applied bulk key without adding rows", async () => {
    const admin = await createProfile("admin", "Partial admin");
    const firstPlayer = await createProfile("player", "Partial first");
    const secondPlayer = await createProfile("player", "Partial second");
    getVerifiedUser.mockResolvedValue({ id: admin });
    const input = { userIds: [firstPlayer, secondPlayer], amount: 7, reason: "Partial retry", operationKey: `partial:${randomUUID()}` };
    await pool.query(
      `insert into point_transactions (user_id, amount, kind, reason, created_by, operation_key)
       values ($1, 7, 'manual_adjustment', 'Partial retry', $2, $3)`,
      [firstPlayer, admin, `manual:many:${input.operationKey}:${firstPlayer}`],
    );

    await expect(createManualAdjustmentForPlayers(input)).rejects.toBeInstanceOf(ConflictError);

    const { rows } = await pool.query(
      "select user_id from point_transactions where operation_key like $1",
      [`manual:many:${input.operationKey}:%`],
    );
    expect(rows).toHaveLength(1);
  });

  it("reuses a matching operation key but safely rejects a different payload", async () => {
    const admin = await createProfile("admin", "Retry admin");
    const player = await createProfile("player", "Retry player");
    getVerifiedUser.mockResolvedValue({ id: admin });
    const input = {
      userId: player,
      amount: 25,
      reason: "Bonus",
      operationKey: `adjust:${randomUUID()}`,
    };

    const first = await createManualAdjustment(input);
    const retry = await createManualAdjustment(input);
    expect(first).toMatchObject({ created: true, entry: { id: retry.entry.id } });
    expect(retry).toMatchObject({ created: false, totalPoints: first.totalPoints, entry: { id: first.entry.id } });

    await expect(createManualAdjustment({ ...input, amount: 26 })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("rejects a non-player and unknown recipient", async () => {
    const admin = await createProfile("admin", "Rejection admin");
    const spectator = await createProfile("spectator", "Rejection spectator");
    getVerifiedUser.mockResolvedValue({ id: admin });
    const input = { amount: 1, reason: "Nope", operationKey: randomUUID() };

    await expect(createManualAdjustment({ ...input, userId: spectator })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(createManualAdjustment({ ...input, userId: randomUUID() })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("namespaces supplied keys so they cannot collide with challenge results", async () => {
    const admin = await createProfile("admin", "Namespace admin");
    const player = await createProfile("player", "Namespace player");
    getVerifiedUser.mockResolvedValue({ id: admin });

    const result = await createManualAdjustment({
      userId: player,
      amount: 1,
      reason: "Manual correction",
      operationKey: `result:${randomUUID()}`,
    });
    expect(result.entry.operationKey).toMatch(/^manual:result:/);
  });

  it("allows spectators to correct and undo points without viewing the audit log", async () => {
    const admin = await createProfile("admin", "Access admin");
    const player = await createProfile("player", "Access player");
    const spectator = await createProfile("spectator", "Access spectator");
    const transactionId = await addPoints(player, 10, "delete-me");
    getVerifiedUser.mockResolvedValue({ id: player });

    await expect(listPointTransactions()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createManualAdjustment({
        userId: player,
        amount: 1,
        reason: "Nope",
        operationKey: `adjust:${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createManualAdjustmentForAllPlayers({ amount: 1, reason: "Nope", operationKey: `all:${randomUUID()}` }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deletePointTransaction(transactionId)).rejects.toBeInstanceOf(ForbiddenError);

    getVerifiedUser.mockResolvedValue({ id: spectator });
    await expect(listPointTransactions()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createManualAdjustment({
        userId: player,
        amount: 1,
        reason: "Spectator correction to undo a mistake",
        operationKey: `adjust:${randomUUID()}`,
      }),
    ).resolves.toMatchObject({ entry: { createdBy: spectator, amount: 1 } });
    await expect(deletePointTransaction(transactionId)).rejects.toBeInstanceOf(NotFoundError);
    const { rows: ownRows } = await pool.query(
      "select id from point_transactions where created_by = $1",
      [spectator],
    );
    await expect(deletePointTransaction(ownRows[0].id)).resolves.toEqual({ id: ownRows[0].id });

    getVerifiedUser.mockResolvedValue({ id: admin });
    await expect(deletePointTransaction(transactionId)).resolves.toEqual({ id: transactionId });
    const adminTransactionId = await addPoints(player, 10, "admin-delete");
    await expect(deletePointTransaction(adminTransactionId)).resolves.toEqual({ id: adminTransactionId });
    const { rows } = await pool.query("select id from point_transactions where id = $1", [adminTransactionId]);
    expect(rows).toEqual([]);
  });
});

describe("point-transaction HTTP contract", () => {
  it.each([
    ["omitted", {}],
    ["blank", { reason: "   " }],
  ])("rejects a %s reason and writes nothing", async (label, reasonField) => {
    const admin = await createProfile("admin", `Required reason admin ${label}`);
    const player = await createProfile("player", `Required reason player ${label}`);
    getVerifiedUser.mockResolvedValue({ id: admin });
    const operationKey = randomUUID();

    const response = await postPointTransaction(
      new Request("http://localhost/api/admin/point-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: player,
          amount: 5,
          operation_key: operationKey,
          ...reasonField,
        }),
      }),
    );

    expect(response.status).toBe(400);
    const { rows } = await pool.query("select 1 from point_transactions where user_id = $1 and kind = 'manual_adjustment'", [player]);
    expect(rows).toEqual([]);
  });

  it("accepts the documented snake_case body and returns snake_case fields", async () => {
    const admin = await createProfile("admin", "HTTP shape admin");
    const player = await createProfile("player", "HTTP shape player");
    getVerifiedUser.mockResolvedValue({ id: admin });

    const operationKey = randomUUID();
    const response = await postPointTransaction(
      new Request("http://localhost/api/admin/point-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: player,
          amount: 5,
          reason: "Documented API",
          operation_key: operationKey,
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      total_points: 5,
      entry: { user_id: player, operation_key: operationKey },
    });
  });
});

describe("audit trail pagination", () => {
  beforeEach(() => {
    getVerifiedUser.mockReset();
  });

  it("returns the requested slice of the newest-first ledger", async () => {
    const admin = await createProfile("admin", "Pager admin");
    const player = await createProfile("player", "Pager player");
    for (const label of ["page-a", "page-b", "page-c"]) await addPoints(player, 1, label);
    getVerifiedUser.mockResolvedValue({ id: admin });

    // Filter to this player so entries written by tests in parallel files cannot shift the window.
    const all = await listPointTransactions({ query: "Pager player" });
    const page = await listPointTransactions({ query: "Pager player", limit: 2, offset: 1 });

    expect(page.map((entry) => entry.id)).toEqual(all.slice(1, 3).map((entry) => entry.id));
  });

  it("names the actor on manual adjustments and leaves system entries unattributed", async () => {
    const admin = await createProfile("admin", "Actor admin");
    const player = await createProfile("player", "Actor player");
    await pool.query(
      "insert into point_transactions (user_id, amount, kind, reason, operation_key) values ($1, 2, 'initial_score', 'actor-system', $2)",
      [player, `initial:${randomUUID()}`],
    );
    getVerifiedUser.mockResolvedValue({ id: admin });
    await createManualAdjustment({ userId: player, amount: 3, reason: "Actor check", operationKey: randomUUID() });

    const entries = await listPointTransactions({ query: "Actor player" });

    expect(entries.find((entry) => entry.reason === "Actor check")).toMatchObject({ createdBy: admin, createdByName: "Actor admin" });
    expect(entries.find((entry) => entry.reason === "actor-system")).toMatchObject({ createdBy: null, createdByName: null });
  });

  it("filters entries by a case-insensitive match on display name or name", async () => {
    const admin = await createProfile("admin", "Search admin");
    const target = await createProfile("player", "Zzfinder Alpha", "Quentin Vale");
    const other = await createProfile("player", "Zzother Beta");
    await addPoints(target, 3, "search-target");
    await addPoints(other, 4, "search-other");
    getVerifiedUser.mockResolvedValue({ id: admin });

    const byDisplayName = await listPointTransactions({ query: "zzFINDER" });
    const byName = await listPointTransactions({ query: "quentin v" });
    const literal = await listPointTransactions({ query: "zz%" });

    expect(byDisplayName.map((entry) => entry.userId)).toEqual([target]);
    expect(byName.map((entry) => entry.userId)).toEqual([target]);
    expect(literal).toEqual([]);
  });

  it("rejects out-of-range or fractional paging values", async () => {
    const admin = await createProfile("admin", "Pager validator");
    getVerifiedUser.mockResolvedValue({ id: admin });

    await expect(listPointTransactions({ limit: 0 })).rejects.toThrow();
    await expect(listPointTransactions({ limit: 101 })).rejects.toThrow();
    await expect(listPointTransactions({ limit: 1.5 })).rejects.toThrow();
    await expect(listPointTransactions({ offset: -1 })).rejects.toThrow();
  });
});
