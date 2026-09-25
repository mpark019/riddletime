import "server-only";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { BadRequestError, ForbiddenError } from "@/server/http/errors";
import { requireProfile, type Profile } from "./identity";

const optionalProfileText = z.string().trim().min(1).max(100).nullable().optional();
const optionalAvatarUrl = z.string().trim().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return value.startsWith("https://")
      && !/\s/.test(value)
      && url.protocol === "https:"
      && url.hostname.length > 0
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}, "Avatar URL must be a valid HTTPS URL").nullable().optional();

export const profileUpdateInput = z.object({
  name: optionalProfileText,
  displayName: optionalProfileText,
  avatarUrl: optionalAvatarUrl,
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one profile field is required",
});

function profileFromRow(row: Record<string, unknown>): Profile {
  return {
    id: row.id as string,
    name: row.name as string | null,
    displayName: row.display_name as string | null,
    avatarUrl: row.avatar_url as string | null,
    role: row.role as Profile["role"],
  };
}

export async function updateOwnProfile(rawInput: unknown): Promise<Profile> {
  const input = profileUpdateInput.parse(rawInput);

  return withTransaction(async (client) => {
    const current = await requireProfile(client);
    if (current.role === "player" && "displayName" in input) {
      throw new ForbiddenError("Players cannot change their display name");
    }

    const assignments: string[] = [];
    const values: Array<string | null> = [current.id];
    const addAssignment = (column: string, value: string | null) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if ("name" in input) addAssignment("name", input.name ?? null);
    if ("displayName" in input) addAssignment("display_name", input.displayName ?? null);
    if ("avatarUrl" in input) addAssignment("avatar_url", input.avatarUrl ?? null);

    const { rows } = await client.query(
      `update profiles
       set ${assignments.join(", ")}
       where id = $1
       returning id, name, display_name, avatar_url, role`,
      values,
    );
    const updated = rows[0];
    return profileFromRow(updated);
  });
}

export async function replaceOwnAvatarUrl(rawAvatarUrl: unknown) {
  const { avatarUrl } = profileUpdateInput.parse({ avatarUrl: rawAvatarUrl });
  if (!avatarUrl) throw new BadRequestError("Avatar URL is required");

  return withTransaction(async (client) => {
    const current = await requireProfile(client);
    const { rows } = await client.query(
      `update profiles set avatar_url = $2 where id = $1
       returning id, name, display_name, avatar_url, role`,
      [current.id, avatarUrl],
    );
    return { profile: profileFromRow(rows[0]), previousAvatarUrl: current.avatarUrl };
  });
}

export async function clearOwnAvatarUrl() {
  return withTransaction(async (client) => {
    const current = await requireProfile(client);
    const { rows } = await client.query(
      `update profiles set avatar_url = null where id = $1
       returning id, name, display_name, avatar_url, role`,
      [current.id],
    );
    return { profile: profileFromRow(rows[0]), previousAvatarUrl: current.avatarUrl };
  });
}
