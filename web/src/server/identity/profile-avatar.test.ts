import { randomUUID } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser } from "@/server/test/fixtures";

const mocks = vi.hoisted(() => ({
  getVerifiedUser: vi.fn(),
  upload: vi.fn(),
  getPublicUrl: vi.fn(),
  remove: vi.fn(),
  from: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  announceLeaderboardChanged: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser: mocks.getVerifiedUser }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));
vi.mock("@/server/realtime/leaderboard", () => ({
  announceLeaderboardChanged: mocks.announceLeaderboardChanged,
}));

const {
  deleteOwnAvatar,
  MAX_AVATAR_BYTES,
  PROFILE_AVATAR_BUCKET,
  uploadOwnAvatar,
  validateAvatarFile,
} = await import("./profile-avatar");
const { DELETE, POST } = await import("@/app/api/profile/avatar/route");

const imageFixtures = {
  "image/png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  "image/webp": new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
  "image/gif": new TextEncoder().encode("GIF89a"),
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upload.mockResolvedValue({ data: { path: "uploaded" }, error: null });
  mocks.getPublicUrl.mockReturnValue({
    data: { publicUrl: "https://project.supabase.co/storage/v1/object/public/profile-avatars/new/avatar.png" },
  });
  mocks.remove.mockResolvedValue({ data: [], error: null });
  mocks.from.mockReturnValue({
    upload: mocks.upload,
    getPublicUrl: mocks.getPublicUrl,
    remove: mocks.remove,
  });
  mocks.createSupabaseAdminClient.mockReturnValue({ storage: { from: mocks.from } });
});

function imageFile(type: keyof typeof imageFixtures, name = "avatar") {
  return new File([imageFixtures[type]], name, { type });
}

async function createProfile(avatarUrl: string | null = null, role: "player" | "spectator" = "player") {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, avatar_url, role) values ($1, $2, $3, $4)",
    [id, `Player ${randomUUID()}`, avatarUrl, role],
  );
  return id;
}

describe("avatar file validation", () => {
  it.each(Object.keys(imageFixtures) as Array<keyof typeof imageFixtures>)(
    "accepts a signature-matched %s image",
    async (type) => {
      await expect(validateAvatarFile(imageFile(type))).resolves.toMatchObject({ contentType: type });
    },
  );

  it.each([
    ["missing file", null],
    ["empty file", new File([], "empty.png", { type: "image/png" })],
    ["oversized file", new File([new Uint8Array(MAX_AVATAR_BYTES + 1)], "large.png", { type: "image/png" })],
    ["unsupported MIME type", new File(["<svg/>"] , "avatar.svg", { type: "image/svg+xml" })],
    ["signature mismatch", new File([imageFixtures["image/jpeg"]], "avatar.png", { type: "image/png" })],
  ])("rejects %s", async (_label, file) => {
    await expect(validateAvatarFile(file)).rejects.toMatchObject({ status: 400 });
  });
});

describe("avatar storage", () => {
  it("uploads to a generated caller-owned path, persists the URL, and removes the prior managed object", async () => {
    const id = await createProfile();
    const previousPath = `${id}/${randomUUID()}.png`;
    await pool.query("update profiles set avatar_url = $2 where id = $1", [
      id,
      `https://project.supabase.co/storage/v1/object/public/${PROFILE_AVATAR_BUCKET}/${previousPath}`,
    ]);
    mocks.getVerifiedUser.mockResolvedValue({ id });

    const result = await uploadOwnAvatar(imageFile("image/png", "../../unsafe-name.png"));

    expect(mocks.from).toHaveBeenCalledWith(PROFILE_AVATAR_BUCKET);
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${id}/[0-9a-f-]+\\.png$`)),
      expect.any(ArrayBuffer),
      { cacheControl: "31536000", contentType: "image/png", upsert: false },
    );
    expect(result.avatarUrl).toBe("https://project.supabase.co/storage/v1/object/public/profile-avatars/new/avatar.png");
    const { rows } = await pool.query("select avatar_url from profiles where id = $1", [id]);
    expect(rows[0].avatar_url).toBe(result.avatarUrl);
    expect(mocks.remove).toHaveBeenCalledWith([previousPath]);
  });

  it("does not change the profile when Storage rejects the upload", async () => {
    const id = await createProfile();
    mocks.getVerifiedUser.mockResolvedValue({ id });
    mocks.upload.mockResolvedValue({ data: null, error: { message: "provider detail", statusCode: 500 } });

    await expect(uploadOwnAvatar(imageFile("image/jpeg"))).rejects.toMatchObject({
      status: 502,
      message: "Could not upload profile picture",
    });
    const { rows } = await pool.query("select avatar_url from profiles where id = $1", [id]);
    expect(rows[0].avatar_url).toBeNull();
  });

  it("does not delete an old URL that is not an app-generated caller object", async () => {
    const id = await createProfile();
    await pool.query("update profiles set avatar_url = $2 where id = $1", [
      id,
      `https://project.supabase.co/storage/v1/object/public/${PROFILE_AVATAR_BUCKET}/${id}/../other.png`,
    ]);
    mocks.getVerifiedUser.mockResolvedValue({ id });

    await uploadOwnAvatar(imageFile("image/png"));

    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("cleans up the latest committed avatar when another replacement wins during upload", async () => {
    const id = await createProfile();
    const concurrentPath = `${id}/${randomUUID()}.jpg`;
    const concurrentUrl = `https://project.supabase.co/storage/v1/object/public/${PROFILE_AVATAR_BUCKET}/${concurrentPath}`;
    mocks.getVerifiedUser.mockResolvedValue({ id });
    mocks.upload.mockImplementation(async () => {
      await pool.query("update profiles set avatar_url = $2 where id = $1", [id, concurrentUrl]);
      return { data: { path: "uploaded" }, error: null };
    });

    await uploadOwnAvatar(imageFile("image/png"));

    expect(mocks.remove).toHaveBeenCalledWith([concurrentPath]);
  });

  it("removes the new object when persisting its public URL fails", async () => {
    const id = await createProfile();
    mocks.getVerifiedUser.mockResolvedValue({ id });
    mocks.getPublicUrl.mockReturnValue({ data: { publicUrl: "http://insecure.example/avatar.png" } });

    await expect(uploadOwnAvatar(imageFile("image/png"))).rejects.toBeDefined();
    const uploadedPath = mocks.upload.mock.calls[0][0];
    expect(mocks.remove).toHaveBeenCalledWith([uploadedPath]);
  });

  it("rejects an unauthenticated upload before calling Storage", async () => {
    mocks.getVerifiedUser.mockResolvedValue(null);

    await expect(uploadOwnAvatar(imageFile("image/png"))).rejects.toMatchObject({ status: 401 });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("clears the caller avatar and removes its managed object", async () => {
    const id = await createProfile();
    const previousPath = `${id}/${randomUUID()}.webp`;
    await pool.query("update profiles set avatar_url = $2 where id = $1", [
      id,
      `https://project.supabase.co/storage/v1/object/public/${PROFILE_AVATAR_BUCKET}/${previousPath}`,
    ]);
    mocks.getVerifiedUser.mockResolvedValue({ id });

    const result = await deleteOwnAvatar();

    expect(result.avatarUrl).toBeNull();
    expect(mocks.remove).toHaveBeenCalledWith([previousPath]);
    const { rows } = await pool.query("select avatar_url from profiles where id = $1", [id]);
    expect(rows[0].avatar_url).toBeNull();
  });

  it("clears an external avatar URL without sending an unsafe Storage delete", async () => {
    const id = await createProfile("https://images.example/avatar.png");
    mocks.getVerifiedUser.mockResolvedValue({ id });

    const result = await deleteOwnAvatar();

    expect(result.avatarUrl).toBeNull();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe("profile avatar HTTP contract", () => {
  it("accepts multipart image data and returns private, non-cacheable profile data", async () => {
    const id = await createProfile();
    mocks.getVerifiedUser.mockResolvedValue({ id });
    const formData = new FormData();
    formData.set("file", imageFile("image/webp"));

    const response = await POST(new Request("http://localhost/api/profile/avatar", {
      method: "POST",
      body: formData,
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ id, role: "player" });
  });

  it("rejects a spectator profile-picture upload before writing to Storage", async () => {
    const id = await createProfile(null, "spectator");
    mocks.getVerifiedUser.mockResolvedValue({ id });
    const formData = new FormData();
    formData.set("file", imageFile("image/webp"));

    const response = await POST(new Request("http://localhost/api/profile/avatar", {
      method: "POST",
      body: formData,
    }));

    expect(response.status).toBe(403);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("rejects oversized multipart bodies before parsing them", async () => {
    const response = await POST(new Request("http://localhost/api/profile/avatar", {
      method: "POST",
      headers: { "content-length": String(MAX_AVATAR_BYTES + 1024 * 1024 + 1) },
      body: "not parsed",
    }));

    expect(response.status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("rejects malformed multipart data", async () => {
    const response = await POST(new Request("http://localhost/api/profile/avatar", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=missing" },
      body: "not multipart",
    }));

    expect(response.status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("deletes the authenticated caller's avatar with private response caching", async () => {
    const id = await createProfile("https://images.example/avatar.png");
    mocks.getVerifiedUser.mockResolvedValue({ id });

    const response = await DELETE();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ id, avatarUrl: null });
  });

  it("rejects a spectator profile-picture deletion", async () => {
    const id = await createProfile("https://images.example/avatar.png", "spectator");
    mocks.getVerifiedUser.mockResolvedValue({ id });

    const response = await DELETE();

    expect(response.status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated avatar deletion", async () => {
    mocks.getVerifiedUser.mockResolvedValue(null);

    const response = await DELETE();

    expect(response.status).toBe(401);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
