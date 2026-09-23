import "server-only";
import type { PoolClient } from "pg";
import { getVerifiedUser } from "@/lib/supabase/server";
import { ForbiddenError, UnauthorizedError } from "@/server/http/errors";

export type Role = "spectator" | "player" | "admin";

export interface Profile {
  id: string;
  displayName: string;
  role: Role;
}

export async function requireUser() {
  const user = await getVerifiedUser();
  if (!user) {
    throw new UnauthorizedError();
  }
  return user;
}

export async function requireProfile(client: PoolClient): Promise<Profile> {
  const user = await requireUser();
  const { rows } = await client.query(
    "select id, display_name, role from profiles where id = $1 for update",
    [user.id],
  );
  const row = rows[0];
  if (!row) {
    // A valid token alone grants nothing without a matching profile row.
    throw new ForbiddenError("No application profile for this account");
  }
  return { id: row.id, displayName: row.display_name, role: row.role };
}

export async function requireAdmin(client: PoolClient): Promise<Profile> {
  const profile = await requireProfile(client);
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
