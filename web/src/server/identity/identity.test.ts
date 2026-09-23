import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool, withTransaction } from "@/lib/db";
import { createAuthUser } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({
  getVerifiedUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const {
  requireUser,
  requireProfile,
  requireAdmin,
  requirePlayer,
} = await import("./identity");
const { UnauthorizedError, ForbiddenError } = await import("@/server/http/errors");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

describe("requireUser", () => {
  it("throws Unauthorized when there is no verified Supabase user", async () => {
    getVerifiedUser.mockResolvedValue(null);
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("returns the verified user otherwise", async () => {
    getVerifiedUser.mockResolvedValue({ id: "user-1" });
    await expect(requireUser()).resolves.toEqual({ id: "user-1" });
  });
});

describe("requireProfile", () => {
  it("throws Forbidden when the verified account has no profile row", async () => {
    getVerifiedUser.mockResolvedValue({ id: "00000000-0000-0000-0000-000000000000" });
    await withTransaction(async (client) => {
      await expect(requireProfile(client)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  it("returns the profile for an existing account", async () => {
    const authId = await createAuthUser();
    getVerifiedUser.mockResolvedValue({ id: authId });
    await withTransaction(async (client) => {
      await client.query(
        "insert into profiles (id, display_name, role) values ($1, 'Spec Tester', 'player')",
        [authId],
      );
      const profile = await requireProfile(client);
      expect(profile).toEqual({
        id: authId,
        displayName: "Spec Tester",
        role: "player",
      });
    });
  });

  it("locks the profile row so a concurrent write waits for it to release", async () => {
    const authId = await createAuthUser();
    getVerifiedUser.mockResolvedValue({ id: authId });
    await pool.query(
      "insert into profiles (id, display_name, role) values ($1, 'Racer', 'player')",
      [authId],
    );

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query("begin");
      await requireProfile(clientA);

      let concurrentWriteDone = false;
      const concurrentWrite = (async () => {
        await clientB.query("begin");
        await clientB.query("update profiles set role = 'admin' where id = $1", [authId]);
        await clientB.query("commit");
        concurrentWriteDone = true;
      })();

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(concurrentWriteDone).toBe(false);

      await clientA.query("commit");
      await concurrentWrite;
      expect(concurrentWriteDone).toBe(true);
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});

describe("requireAdmin / requirePlayer", () => {
  it("rejects a non-admin from requireAdmin", async () => {
    const authId = await createAuthUser();
    getVerifiedUser.mockResolvedValue({ id: authId });
    await withTransaction(async (client) => {
      await client.query(
        "insert into profiles (id, display_name, role) values ($1, 'Spec Tester', 'player')",
        [authId],
      );
      await expect(requireAdmin(client)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  it("rejects a non-player from requirePlayer", async () => {
    const authId = await createAuthUser();
    getVerifiedUser.mockResolvedValue({ id: authId });
    await withTransaction(async (client) => {
      await client.query(
        "insert into profiles (id, display_name, role) values ($1, 'Spec Tester', 'admin')",
        [authId],
      );
      await expect(requirePlayer(client)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });
});
