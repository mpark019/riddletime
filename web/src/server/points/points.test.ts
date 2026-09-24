import { randomUUID } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({
  getVerifiedUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const {
  createManualAdjustment,
  deletePointTransaction,
  getLeaderboard,
  listPointTransactions,
} = await import("./points");
const { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } = await import("@/server/http/errors");
const { POST: postPointTransaction } = await import("@/app/api/admin/point-transactions/route");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

async function createProfile(role: "spectator" | "player" | "admin", displayName: string) {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, $2, $3)",
    [id, displayName, role],
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

describe("leaderboard", () => {
  it("requires an authenticated application member", async () => {
    getVerifiedUser.mockResolvedValue(null);
    await expect(getLeaderboard()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("returns current players only with shared ranks and stable tie ordering", async () => {
    const viewer = await createProfile("spectator", "Viewer");
    const alpha = await createProfile("player", "Alpha");
    const bravo = await createProfile("player", "Bravo");
    const hidden = await createProfile("admin", "Hidden Admin");
    await addPoints(alpha, 40, "alpha");
    await addPoints(bravo, 40, "bravo");
    await addPoints(hidden, 999, "hidden");
    getVerifiedUser.mockResolvedValue({ id: viewer });

    const result = await getLeaderboard();
    const tiedEntries = result.filter((entry) => entry.userId === alpha || entry.userId === bravo);

    expect(result.some((entry) => entry.userId === hidden)).toBe(false);
    expect(tiedEntries.map((entry) => entry.userId)).toEqual([alpha, bravo].sort());
    expect(tiedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: alpha, displayName: "Alpha", totalPoints: 40 }),
        expect.objectContaining({ userId: bravo, displayName: "Bravo", totalPoints: 40 }),
      ]),
    );
    expect(tiedEntries[0].rank).toBe(tiedEntries[1].rank);
  });
});

describe("manual point adjustments", () => {
  it("creates a signed adjustment and reports the resulting ledger balance", async () => {
    const admin = await createProfile("admin", "Admin");
    const player = await createProfile("player", "Player");
    getVerifiedUser.mockResolvedValue({ id: admin });

    const result = await createManualAdjustment({
      userId: player,
      amount: -15,
      reason: "Corrected duplicate award",
      operationKey: `adjust:${randomUUID()}`,
    });

    expect(result).toMatchObject({
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

  it("reuses a matching operation key but safely rejects a different payload", async () => {
    const admin = await createProfile("admin", "Admin");
    const player = await createProfile("player", "Player");
    getVerifiedUser.mockResolvedValue({ id: admin });
    const input = {
      userId: player,
      amount: 25,
      reason: "Bonus",
      operationKey: `adjust:${randomUUID()}`,
    };

    const first = await createManualAdjustment(input);
    const retry = await createManualAdjustment(input);
    expect(retry).toEqual(first);

    await expect(createManualAdjustment({ ...input, amount: 26 })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("rejects a non-player and unknown recipient", async () => {
    const admin = await createProfile("admin", "Admin");
    const spectator = await createProfile("spectator", "Spectator");
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
    const admin = await createProfile("admin", "Admin");
    const player = await createProfile("player", "Player");
    getVerifiedUser.mockResolvedValue({ id: admin });

    const result = await createManualAdjustment({
      userId: player,
      amount: 1,
      reason: "Manual correction",
      operationKey: `result:${randomUUID()}`,
    });
    expect(result.entry.operationKey).toMatch(/^manual:result:/);
  });

  it("limits listing, creation, and deletion to admins", async () => {
    const admin = await createProfile("admin", "Admin");
    const player = await createProfile("player", "Player");
    const spectator = await createProfile("spectator", "Spectator");
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
    await expect(deletePointTransaction(transactionId)).rejects.toBeInstanceOf(ForbiddenError);

    getVerifiedUser.mockResolvedValue({ id: spectator });
    await expect(listPointTransactions()).rejects.toBeInstanceOf(ForbiddenError);

    getVerifiedUser.mockResolvedValue({ id: admin });
    expect(await listPointTransactions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: transactionId })]),
    );
    await expect(deletePointTransaction(transactionId)).resolves.toEqual({ id: transactionId });
    const { rows } = await pool.query("select id from point_transactions where id = $1", [transactionId]);
    expect(rows).toEqual([]);
  });
});

describe("point-transaction HTTP contract", () => {
  it("accepts the documented snake_case body and returns snake_case fields", async () => {
    const admin = await createProfile("admin", "Admin");
    const player = await createProfile("player", "Player");
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
