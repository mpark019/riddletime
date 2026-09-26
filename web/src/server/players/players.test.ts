import { randomUUID } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({ getVerifiedUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { createPlayerAccount } = await import("./players");

async function makeAdmin() {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, 'Admin', 'admin')",
    [id],
  );
  return id;
}

function authAdmin(id: string = randomUUID()) {
  return {
    createUser: vi.fn(async () => ({ id })),
    deleteUser: vi.fn(async () => undefined),
  };
}

function uniqueUsername(label: string) {
  return `${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

beforeEach(() => getVerifiedUser.mockReset());

describe("createPlayerAccount", () => {
  it("creates a player profile and initial score from a display-name login", async () => {
    const adminId = await makeAdmin();
    const playerId = await createAuthUser();
    const auth = authAdmin(playerId);
    const displayName = `Riddle_${uniqueUsername("one")}`;
    const loginName = displayName.toLowerCase();
    getVerifiedUser.mockResolvedValue({ id: adminId });

    const result = await createPlayerAccount(
      { name: "Kang Smith", displayName, password: "correct-horse-battery", initialScore: 25 },
      { authAdmin: auth },
    );

    expect(auth.createUser).toHaveBeenCalledWith({
      email: `${loginName}@players.riddletime.invalid`,
      password: "correct-horse-battery",
    });
    expect(result).toEqual({ id: playerId, displayName });
    const { rows: profiles } = await pool.query(
      "select name, display_name, role from profiles where id = $1",
      [playerId],
    );
    expect(profiles).toEqual([{ name: "Kang Smith", display_name: displayName, role: "player" }]);
    const { rows: points } = await pool.query(
      "select amount, kind, operation_key from point_transactions where user_id = $1",
      [playerId],
    );
    expect(points).toEqual([{ amount: 25, kind: "initial_score", operation_key: `initial:${playerId}` }]);
  });

  it("rejects an invalid login name before calling the Auth provider", async () => {
    const auth = authAdmin();
    await expect(
      createPlayerAccount(
        { displayName: "two words", password: "correct-horse-battery", initialScore: 0 },
        { authAdmin: auth },
      ),
    ).rejects.toThrow();
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it("requires an admin before creating an Auth account", async () => {
    const auth = authAdmin();
    getVerifiedUser.mockResolvedValue({ id: await createAuthUser() });
    await expect(
      createPlayerAccount(
        { displayName: "Riddle_Two", password: "correct-horse-battery", initialScore: 0 },
        { authAdmin: auth },
      ),
    ).rejects.toThrow("No application profile");
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it("rejects an existing player login before calling the Auth provider", async () => {
    const adminId = await makeAdmin();
    const existingPlayerId = await createAuthUser();
    const displayName = uniqueUsername("taken");
    await pool.query(
      "insert into profiles (id, display_name, role) values ($1, $2, 'player')",
      [existingPlayerId, displayName],
    );
    const auth = authAdmin();
    getVerifiedUser.mockResolvedValue({ id: adminId });

    await expect(
      createPlayerAccount(
        { displayName: displayName.toUpperCase(), password: "correct-horse-battery", initialScore: 0 },
        { authAdmin: auth },
      ),
    ).rejects.toThrow("already in use");
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it("deletes the Auth account when the profile transaction fails", async () => {
    const adminId = await makeAdmin();
    const failedPlayerId = randomUUID();
    const auth = authAdmin(failedPlayerId);
    getVerifiedUser.mockResolvedValue({ id: adminId });

    await expect(
      createPlayerAccount(
        { displayName: uniqueUsername("cleanup"), password: "correct-horse-battery", initialScore: 0 },
        { authAdmin: auth },
      ),
    ).rejects.toThrow();
    expect(auth.deleteUser).toHaveBeenCalledWith(expect.any(String));
    const { rows } = await pool.query("select count(*)::int as count from profiles where id = $1", [failedPlayerId]);
    expect(rows[0].count).toBe(0);
  });
});
