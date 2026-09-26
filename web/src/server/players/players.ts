import "server-only";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { parsePlayerUsername, playerUsernameEmail } from "@/lib/player-username";
import { requireAdmin } from "@/server/identity/identity";
import { ConflictError, NotFoundError } from "@/server/http/errors";

export const createPlayerAccountInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  displayName: z.string().trim().min(1),
  password: z.string().min(12, "Password must be at least 12 characters."),
  initialScore: z.number().int().nonnegative(),
});
export type CreatePlayerAccountInput = z.infer<typeof createPlayerAccountInput>;

export interface PlayerAccountAuthAdmin {
  createUser(input: { email: string; password: string }): Promise<{ id: string }>;
  deleteUser(id: string): Promise<void>;
}

export interface PlayerAccount {
  id: string;
  name: string | null;
  displayName: string;
  avatarUrl: string | null;
}

export const updatePlayerAccountInput = z.object({
  displayName: z.string().trim().min(1).optional(),
  password: z.string().min(12, "Password must be at least 12 characters.").optional(),
}).refine((input) => input.displayName !== undefined || input.password !== undefined, {
  message: "Provide a display name or password.",
});

function defaultAuthAdmin(): PlayerAccountAuthAdmin {
  const admin = createSupabaseAdminClient();
  return {
    async createUser({ email, password }) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error || !data.user) {
        throw new Error(`Supabase player creation failed: ${error?.message ?? "missing user"}`);
      }
      return { id: data.user.id };
    },
    async deleteUser(id) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw new Error(`Supabase player cleanup failed: ${error.message}`);
    },
  };
}

async function updateAuthUser(id: string, input: { displayName?: string; password?: string }) {
  if (!input.displayName && !input.password) return;
  const { error } = await createSupabaseAdminClient().auth.admin.updateUserById(id, {
    ...(input.displayName ? { email: playerUsernameEmail(input.displayName), email_confirm: true } : {}),
    ...(input.password ? { password: input.password } : {}),
  });
  if (error) throw new Error(`Supabase player update failed: ${error.message}`);
}

export async function listPlayerAccounts(): Promise<PlayerAccount[]> {
  return withTransaction(async (client) => {
    await requireAdmin(client);
    const { rows } = await client.query(
      "select id, name, display_name, avatar_url from profiles where role = 'player' order by lower(display_name)",
    );
    return rows.map((row) => ({ id: row.id, name: row.name, displayName: row.display_name, avatarUrl: row.avatar_url }));
  });
}

export async function updatePlayerAccount(id: string, rawInput: unknown) {
  const input = updatePlayerAccountInput.parse(rawInput);
  const displayName = input.displayName ? parsePlayerUsername(input.displayName) : undefined;
  await withTransaction(async (client) => {
    await requireAdmin(client);
    const { rows } = await client.query("select id from profiles where id = $1 and role = 'player'", [id]);
    if (!rows[0]) throw new NotFoundError("Player not found");
    if (displayName) {
      const { rows: duplicate } = await client.query("select id from profiles where role = 'player' and lower(display_name) = $1 and id <> $2", [displayName, id]);
      if (duplicate[0]) throw new ConflictError("That player display name is already in use");
    }
  });
  await updateAuthUser(id, { displayName, password: input.password });
  return withTransaction(async (client) => {
    await requireAdmin(client);
    const { rows } = await client.query(
      "update profiles set display_name = coalesce($2, display_name) where id = $1 and role = 'player' returning id, name, display_name, avatar_url",
      [id, input.displayName?.trim() ?? null],
    );
    if (!rows[0]) throw new NotFoundError("Player not found");
    return { id: rows[0].id, name: rows[0].name, displayName: rows[0].display_name, avatarUrl: rows[0].avatar_url };
  });
}

export async function deletePlayerAccount(id: string) {
  const avatarUrl = await withTransaction(async (client) => {
    await requireAdmin(client);
    const { rows } = await client.query("select riddle_private.delete_player_data($1) as avatar_url", [id]);
    if (!rows[0]) throw new NotFoundError("Player not found");
    return rows[0].avatar_url as string | null;
  });
  const { error } = await createSupabaseAdminClient().auth.admin.deleteUser(id);
  if (error) throw new Error(`Supabase player deletion failed: ${error.message}`);
  return { id, avatarUrl };
}

function isConstraintViolation(err: unknown): err is { code: string } {
  return typeof err === "object" && err !== null && "code" in err
    && ((err as { code: unknown }).code === "23505" || (err as { code: unknown }).code === "23514");
}

// Auth has no transaction with Postgres. Recheck authorization inside the
// database transaction and compensate for a failed profile write.
export async function createPlayerAccount(
  input: CreatePlayerAccountInput,
  deps: { authAdmin?: PlayerAccountAuthAdmin } = {},
) {
  const parsed = createPlayerAccountInput.parse(input);
  const loginName = parsePlayerUsername(parsed.displayName);

  await withTransaction(async (client) => {
    await requireAdmin(client);
    const { rows } = await client.query(
      "select id from profiles where role = 'player' and lower(display_name) = $1",
      [loginName],
    );
    if (rows[0]) throw new ConflictError("That player display name is already in use");
  });
  const authAdmin = deps.authAdmin ?? defaultAuthAdmin();
  const authUser = await authAdmin.createUser({
    email: playerUsernameEmail(loginName),
    password: parsed.password,
  });

  try {
    await withTransaction(async (client) => {
      await requireAdmin(client);
      await client.query(
        "insert into profiles (id, name, display_name, role) values ($1, $2, $3, 'player')",
        [authUser.id, parsed.name ?? null, parsed.displayName],
      );
      await client.query(
        `insert into point_transactions (user_id, amount, kind, reason, operation_key)
         values ($1, $2, 'initial_score', 'Initial score', $3)`,
        [authUser.id, parsed.initialScore, `initial:${authUser.id}`],
      );
    });
  } catch (err) {
    try {
      await authAdmin.deleteUser(authUser.id);
    } catch (cleanupError) {
      console.error("Failed to clean up player Auth account after profile creation failure:", cleanupError);
    }
    if (isConstraintViolation(err)) {
      throw new ConflictError("That player display name is already in use");
    }
    throw err;
  }

  return { id: authUser.id, displayName: parsed.displayName };
}
