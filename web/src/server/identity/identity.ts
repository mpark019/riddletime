import "server-only";
import type { PoolClient } from "pg";
import { pool } from "@/lib/db";
import { getVerifiedUser } from "@/lib/supabase/server";
import { ForbiddenError, UnauthorizedError } from "@/server/http/errors";

export type Role = "spectator" | "player" | "admin";

export interface Profile {
  id: string;
  name: string | null;
  displayName: string | null;
  role: Role;
}

export async function requireUser() {
  const user = await getVerifiedUser();
  if (!user) {
    throw new UnauthorizedError();
  }
  return user;
}

// Unlocked, no-throw lookup for rendering UI — requireProfile's lock is only needed before a guarded write.
export async function getCurrentProfile(): Promise<Profile | null> {
  const user = await getVerifiedUser();
  if (!user) return null;
  const { rows } = await pool.query(
    "select id, name, display_name, role from profiles where id = $1",
    [user.id],
  );
  const row = rows[0];
  return row
    ? { id: row.id, name: row.name, displayName: row.display_name, role: row.role }
    : null;
}

export async function requireProfile(client: PoolClient): Promise<Profile> {
  const user = await requireUser();
  const { rows } = await client.query(
    "select id, name, display_name, role from profiles where id = $1 for update",
    [user.id],
  );
  const row = rows[0];
  if (!row) {
    // A valid token alone grants nothing without a matching profile row.
    throw new ForbiddenError("No application profile for this account");
  }
  return { id: row.id, name: row.name, displayName: row.display_name, role: row.role };
}

// No row lock: reads don't need to serialize with role changes.
export async function requireProfileRead(client: PoolClient): Promise<Profile> {
  const user = await requireUser();
  const { rows } = await client.query(
    "select id, name, display_name, role from profiles where id = $1",
    [user.id],
  );
  const row = rows[0];
  if (!row) {
    throw new ForbiddenError("No application profile for this account");
  }
  return { id: row.id, name: row.name, displayName: row.display_name, role: row.role };
}

export async function requireAdmin(client: PoolClient): Promise<Profile> {
  const profile = await requireProfile(client);
  if (profile.role !== "admin") {
    throw new ForbiddenError("Admin role required");
  }
  return profile;
}

export async function requireAdminRead(client: PoolClient): Promise<Profile> {
  const profile = await requireProfileRead(client);
  if (profile.role !== "admin") {
    throw new ForbiddenError("Admin role required");
  }
  return profile;
}

export async function requirePlayer(client: PoolClient): Promise<Profile> {
  const profile = await requireProfile(client);
  if (profile.role !== "player") {
    throw new ForbiddenError("Player role required");
  }
  return profile;
}
