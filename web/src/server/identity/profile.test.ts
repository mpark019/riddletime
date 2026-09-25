import { randomUUID } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({
  getVerifiedUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { updateOwnProfile } = await import("./profile");
const { PATCH } = await import("@/app/api/profile/route");
const { ForbiddenError } = await import("@/server/http/errors");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

async function createProfile(role: "spectator" | "player" | "admin") {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, name, display_name, role) values ($1, $2, $3, $4)",
    [id, "Original name", `Display ${randomUUID()}`, role],
  );
  return id;
}

describe("self profile updates", () => {
  it.each(["spectator", "admin"] as const)(
    "allows a %s to edit name, display name, and avatar without changing another profile",
    async (role) => {
      const id = await createProfile(role);
      const otherId = await createProfile("spectator");
      getVerifiedUser.mockResolvedValue({ id });

      const result = await updateOwnProfile({
        name: "  Updated Name  ",
        displayName: "  Updated Display  ",
        avatarUrl: "https://images.example.test/avatar.png",
      });

      expect(result).toMatchObject({
        id,
        name: "Updated Name",
        displayName: "Updated Display",
        avatarUrl: "https://images.example.test/avatar.png",
        role,
      });
      const { rows } = await pool.query(
        "select name, display_name, avatar_url from profiles where id = any($1::uuid[]) order by id",
        [[id, otherId]],
      );
      expect(rows.find((row) => row.display_name === "Updated Display")).toMatchObject({
        name: "Updated Name",
        avatar_url: "https://images.example.test/avatar.png",
      });
      const other = await pool.query(
        "select name, avatar_url from profiles where id = $1",
        [otherId],
      );
      expect(other.rows[0]).toEqual({ name: "Original name", avatar_url: null });
      expect(rows).toHaveLength(2);
    },
  );

  it("allows a player to edit name and avatar while retaining their display name", async () => {
    const id = await createProfile("player");
    const before = await pool.query("select display_name from profiles where id = $1", [id]);
    getVerifiedUser.mockResolvedValue({ id });

    const result = await updateOwnProfile({
      name: null,
      avatarUrl: "https://images.example.test/player.webp",
    });

    expect(result).toMatchObject({
      id,
      name: null,
      displayName: before.rows[0].display_name,
      avatarUrl: "https://images.example.test/player.webp",
      role: "player",
    });
  });

  it("rejects a player-supplied display name without changing the profile", async () => {
    const id = await createProfile("player");
    getVerifiedUser.mockResolvedValue({ id });

    await expect(
      updateOwnProfile({ name: "Should not persist", displayName: "Player rename" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const { rows } = await pool.query("select name, display_name from profiles where id = $1", [id]);
    expect(rows[0].name).toBe("Original name");
    expect(rows[0].display_name).not.toBe("Player rename");
  });
});

describe("profile PATCH contract", () => {
  it("returns the updated caller profile as private, non-cacheable data", async () => {
    const id = await createProfile("spectator");
    getVerifiedUser.mockResolvedValue({ id });

    const response = await PATCH(new Request("http://localhost/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Route update" }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      id,
      displayName: "Route update",
      role: "spectator",
    });
  });

  it.each([
    { avatarUrl: "http://images.example.test/avatar.png" },
    { avatarUrl: "not a url" },
    { avatarUrl: "https:images.example.test/avatar.png" },
    { avatarUrl: "https://user:secret@images.example.test/avatar.png" },
    { role: "admin" },
    {},
  ])("rejects an invalid or privileged payload: %j", async (body) => {
    const id = await createProfile("spectator");
    getVerifiedUser.mockResolvedValue({ id });

    const response = await PATCH(new Request("http://localhost/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(400);
  });

  it("rejects an unauthenticated caller and an authenticated account without a profile", async () => {
    getVerifiedUser.mockResolvedValue(null);
    const request = () => new Request("http://localhost/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    expect((await PATCH(request())).status).toBe(401);

    getVerifiedUser.mockResolvedValue({ id: randomUUID() });
    expect((await PATCH(request())).status).toBe(403);
  });
});
