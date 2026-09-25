import { readFile } from "fs/promises";
import { describe, expect, it } from "vitest";
import { requireTestAdminPool } from "@/server/test/fixtures";

describe("profile avatar bucket migration", () => {
  it("creates a public, image-only bucket with a 5 MiB object limit", async () => {
    const migration = await readFile(
      new URL("../../../../database/migrations/009_profile_avatar_bucket.sql", import.meta.url),
      "utf8",
    );
    const migrationBody = migration
      .replace(/^begin;\s*/i, "")
      .replace(/\s*commit;\s*$/i, "");
    const client = await requireTestAdminPool().connect();

    try {
      await client.query("begin");
      await client.query("create schema storage");
      await client.query(`create table storage.buckets (
        id text primary key,
        name text not null unique,
        public boolean not null default false,
        file_size_limit bigint,
        allowed_mime_types text[]
      )`);
      await client.query(migrationBody);

      const { rows } = await client.query(
        "select id, name, public, file_size_limit, allowed_mime_types from storage.buckets",
      );
      expect(rows).toEqual([{
        id: "profile-avatars",
        name: "profile-avatars",
        public: true,
        file_size_limit: "5242880",
        allowed_mime_types: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      }]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
