import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { requireAdminRead, requirePointsManager, requireProfileRead, requireUser } from "@/server/identity/identity";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/http/errors";

const UUID = z.uuid();

const manualAdjustmentFields = {
  amount: z
    .number()
    .int()
    .min(-2_147_483_648)
    .max(2_147_483_647)
    .refine((amount) => amount !== 0, "amount must not be zero"),
  reason: z.string().trim().min(1, "reason is required").max(500),
  operationKey: z.string().trim().min(1).max(200),
};

export const manualAdjustmentInput = z.object({
  userId: UUID,
  ...manualAdjustmentFields,
});
export type ManualAdjustmentInput = z.infer<typeof manualAdjustmentInput>;

export const allPlayersManualAdjustmentInput = z.object(manualAdjustmentFields);
export type AllPlayersManualAdjustmentInput = z.infer<typeof allPlayersManualAdjustmentInput>;
export const playersManualAdjustmentInput = z.object({ userIds: z.array(UUID).min(1), ...manualAdjustmentFields });
export type PlayersManualAdjustmentInput = z.infer<typeof playersManualAdjustmentInput>;

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  name: string | null;
  avatarUrl: string | null;
  rank: number;
  totalPoints: number;
  correctRiddles: number;
  incorrectRiddles: number;
}

export interface PointTransaction {
  id: string;
  userId: string;
  displayName: string | null;
  amount: number;
  kind: "initial_score" | "challenge_result" | "manual_adjustment";
  reason: string;
  submissionId: string | null;
  createdBy: string | null;
  createdByName: string | null;
  operationKey: string;
  createdAt: Date;
}

function mapTransaction(row: Record<string, unknown>): PointTransaction {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    displayName: row.display_name as string | null,
    amount: Number(row.amount),
    kind: row.kind as PointTransaction["kind"],
    reason: row.reason as string,
    submissionId: row.submission_id as string | null,
    createdBy: row.created_by as string | null,
    createdByName: (row.created_by_name as string | null | undefined) ?? null,
    operationKey: row.operation_key as string,
    createdAt: row.created_at as Date,
  };
}

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  return withTransaction(async (client) => {
    await requireProfileRead(client);
    const { rows } = await client.query(
      `with balances as (
         select user_id, sum(amount)::bigint as total_points
         from point_transactions
         group by user_id
       ),
       riddle_results as (
         select s.user_id,
                count(*) filter (where s.correct and coalesce(s.scoring_breakdown->>'outcome', '') <> 'partial')::bigint as correct_riddles,
                count(*) filter (where not s.correct)::bigint as incorrect_riddles
         from submissions s
         join challenges c on c.id = s.challenge_id
         where c.type in ('riddle', 'image_submission') and s.submitted_at is not null
         group by s.user_id
       )
       select p.id as user_id, p.display_name, p.name, p.avatar_url,
              coalesce(b.total_points, 0)::bigint as total_points,
              coalesce(r.correct_riddles, 0)::bigint as correct_riddles,
              coalesce(r.incorrect_riddles, 0)::bigint as incorrect_riddles,
              rank() over (order by coalesce(b.total_points, 0) desc)::bigint as rank
       from profiles p
       left join balances b on b.user_id = p.id
       left join riddle_results r on r.user_id = p.id
       where p.role = 'player'
       order by coalesce(b.total_points, 0) desc, lower(p.display_name) asc, p.id asc`,
    );
    return rows.map((row) => ({
      userId: row.user_id as string,
      displayName: row.display_name as string,
      name: row.name as string | null,
      avatarUrl: row.avatar_url as string | null,
      rank: Number(row.rank),
      totalPoints: Number(row.total_points),
      correctRiddles: Number(row.correct_riddles),
      incorrectRiddles: Number(row.incorrect_riddles),
    }));
  });
}

export const pointTransactionPage = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  query: z.string().trim().max(100).optional(),
});
export type PointTransactionPage = z.infer<typeof pointTransactionPage>;

export async function listPointTransactions(page: PointTransactionPage = {}): Promise<PointTransaction[]> {
  const { limit, offset, query } = pointTransactionPage.parse(page);
  const namePattern = query ? `%${query.replace(/[\\%_]/g, "\\$&")}%` : null;
  return withTransaction(async (client) => {
    await requireAdminRead(client);
    const { rows } = await client.query(
      `select pt.id, pt.user_id, p.display_name, pt.amount, pt.kind, pt.reason,
              pt.submission_id, pt.created_by, actor.display_name as created_by_name,
              pt.operation_key, pt.created_at
       from point_transactions pt
       join profiles p on p.id = pt.user_id
       left join profiles actor on actor.id = pt.created_by
       where $3::text is null or p.display_name ilike $3 or p.name ilike $3
       order by pt.created_at desc, pt.id desc
       limit $1 offset $2`,
      [limit ?? null, offset ?? 0, namePattern],
    );
    return rows.map(mapTransaction);
  });
}

export async function createManualAdjustment(input: ManualAdjustmentInput) {
  const parsed = manualAdjustmentInput.parse(input);
  const actor = await requireUser();

  return withTransaction(async (client) => {
    // Lock both profiles deterministically before authorizing either one, so a
    // role change cannot race this adjustment.
    const { rows: profiles } = await client.query(
      `select id, role from profiles where id = any($1::uuid[]) order by id for update`,
      [[actor.id, parsed.userId]],
    );
    const actingProfile = profiles.find((profile) => profile.id === actor.id);
    if (!actingProfile || (actingProfile.role !== "admin" && actingProfile.role !== "spectator")) {
      throw new ForbiddenError("Admin or spectator role required");
    }
    const recipient = profiles.find((profile) => profile.id === parsed.userId);
    if (!recipient) throw new NotFoundError("Player not found");
    if (recipient.role !== "player") {
      throw new ConflictError("Point adjustments require a current player");
    }

    const databaseOperationKey = `manual:${parsed.operationKey}`;
    const { rows: inserted } = await client.query(
      `insert into point_transactions
         (user_id, amount, kind, reason, created_by, operation_key)
       values ($1, $2, 'manual_adjustment', $3, $4, $5)
       on conflict (operation_key) do nothing
       returning id, user_id, null::text as display_name, amount, kind, reason,
                 submission_id, created_by, operation_key, created_at`,
      [parsed.userId, parsed.amount, parsed.reason, actor.id, databaseOperationKey],
    );

    const created = Boolean(inserted[0]);
    let entry = created ? mapTransaction(inserted[0]) : null;
    if (!entry) {
      const { rows: existingRows } = await client.query(
        `select id, user_id, null::text as display_name, amount, kind, reason,
                submission_id, created_by, operation_key, created_at
         from point_transactions where operation_key = $1`,
        [databaseOperationKey],
      );
      const existing = existingRows[0];
      if (!existing) throw new ConflictError("Point adjustment conflicts with an existing operation");
      if (
        existing.user_id !== parsed.userId ||
        Number(existing.amount) !== parsed.amount ||
        existing.kind !== "manual_adjustment" ||
        existing.reason !== parsed.reason ||
        existing.created_by !== actor.id
      ) {
        throw new ConflictError("Operation key was already used for a different adjustment");
      }
      entry = mapTransaction(existing);
    }

    const { rows: balanceRows } = await client.query(
      "select coalesce(sum(amount), 0)::bigint as total_points from point_transactions where user_id = $1",
      [parsed.userId],
    );
    return { entry, totalPoints: Number(balanceRows[0].total_points), created };
  });
}

// Skips rows whose operation key already exists, so a retry inserts only what is missing.
async function insertAdjustments(
  client: PoolClient,
  userIds: string[],
  amount: number,
  reason: string,
  actorId: string,
  operationPrefix: string,
): Promise<PointTransaction[]> {
  const { rows } = await client.query(
    `insert into point_transactions
       (user_id, amount, kind, reason, created_by, operation_key)
     select u, $2, 'manual_adjustment', $3, $4, $5::text || u::text
     from unnest($1::uuid[]) as u
     on conflict (operation_key) do nothing
     returning id, user_id, null::text as display_name, amount, kind, reason,
               submission_id, created_by, operation_key, created_at`,
    [userIds, amount, reason, actorId, operationPrefix],
  );
  return rows.map(mapTransaction).sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

export async function createManualAdjustmentForAllPlayers(input: AllPlayersManualAdjustmentInput) {
  const parsed = allPlayersManualAdjustmentInput.parse(input);
  const actor = await requireUser();

  return withTransaction(async (client) => {
    const { rows: actorRows } = await client.query(
      "select id, role from profiles where id = $1 for update",
      [actor.id],
    );
    const actingProfile = actorRows[0];
    if (!actingProfile || (actingProfile.role !== "admin" && actingProfile.role !== "spectator")) {
      throw new ForbiddenError("Admin or spectator role required");
    }

    const operationPrefix = `manual:all:${parsed.operationKey}:`;
    const findExisting = () => client.query(
      `select id, user_id, null::text as display_name, amount, kind, reason,
              submission_id, created_by, operation_key, created_at
       from point_transactions
       where left(operation_key, char_length($1)) = $1
       order by user_id`,
      [operationPrefix],
    );
    const existingRows = (await findExisting()).rows;
    if (existingRows.length > 0) {
      const entries = existingRows.map(mapTransaction);
      if (entries.some((entry) => entry.amount !== parsed.amount || entry.reason !== parsed.reason || entry.createdBy !== actor.id || entry.kind !== "manual_adjustment")) {
        throw new ConflictError("Operation key was already used for a different adjustment");
      }
      return { entries, created: false };
    }

    const { rows: playerRows } = await client.query(
      "select id from profiles where role = 'player' order by id for update",
    );
    if (playerRows.length === 0) throw new ConflictError("Point adjustments require at least one current player");

    const entries = await insertAdjustments(
      client,
      playerRows.map((player) => player.id as string),
      parsed.amount,
      parsed.reason,
      actor.id,
      operationPrefix,
    );
    if (entries.length === playerRows.length) return { entries, created: true };

    const retriedEntries = (await findExisting()).rows.map(mapTransaction);
    if (
      retriedEntries.length !== playerRows.length ||
      retriedEntries.some((entry) => entry.amount !== parsed.amount || entry.reason !== parsed.reason || entry.createdBy !== actor.id || entry.kind !== "manual_adjustment")
    ) {
      throw new ConflictError("Operation key was already used for a different adjustment");
    }
    return { entries: retriedEntries, created: false };
  });
}

export async function createManualAdjustmentForPlayers(input: PlayersManualAdjustmentInput) {
  const parsed = playersManualAdjustmentInput.parse(input);
  const actor = await requireUser();
  const userIds = [...new Set(parsed.userIds)].sort();

  return withTransaction(async (client) => {
    const { rows: actorRows } = await client.query("select id, role from profiles where id = $1 for update", [actor.id]);
    const actingProfile = actorRows[0];
    if (!actingProfile || (actingProfile.role !== "admin" && actingProfile.role !== "spectator")) throw new ForbiddenError("Admin or spectator role required");

    const operationPrefix = `manual:many:${parsed.operationKey}:`;
    const findExisting = () => client.query(
      `select id, user_id, null::text as display_name, amount, kind, reason,
              submission_id, created_by, operation_key, created_at
       from point_transactions where left(operation_key, char_length($1)) = $1 order by user_id`,
      [operationPrefix],
    );
    const existing = (await findExisting()).rows.map(mapTransaction);
    if (existing.length > 0) {
      if (existing.length !== userIds.length || existing.some((entry, index) => entry.userId !== userIds[index] || entry.amount !== parsed.amount || entry.reason !== parsed.reason || entry.createdBy !== actor.id || entry.kind !== "manual_adjustment")) throw new ConflictError("Operation key was already used for a different adjustment");
      return { entries: existing, created: false };
    }

    const { rows: recipients } = await client.query("select id, role from profiles where id = any($1::uuid[]) order by id for update", [userIds]);
    if (recipients.length !== userIds.length || recipients.some((recipient) => recipient.role !== "player")) throw new ConflictError("Point adjustments require current players");
    const entries = await insertAdjustments(
      client,
      recipients.map((recipient) => recipient.id as string),
      parsed.amount,
      parsed.reason,
      actor.id,
      operationPrefix,
    );
    if (entries.length === recipients.length) return { entries, created: true };
    const retried = (await findExisting()).rows.map(mapTransaction);
    if (retried.length !== userIds.length || retried.some((entry, index) => entry.userId !== userIds[index] || entry.amount !== parsed.amount || entry.reason !== parsed.reason || entry.createdBy !== actor.id || entry.kind !== "manual_adjustment")) throw new ConflictError("Operation key was already used for a different adjustment");
    return { entries: retried, created: false };
  });
}

export async function deletePointTransaction(transactionId: string) {
  UUID.parse(transactionId);
  return withTransaction(async (client) => {
    const actor = await requirePointsManager(client);
    const { rows } = actor.role === "admin"
      ? await client.query("delete from point_transactions where id = $1 returning id", [transactionId])
      : await client.query(
        "delete from point_transactions where id = $1 and kind = 'manual_adjustment' and created_by = $2 returning id",
        [transactionId, actor.id],
      );
    if (!rows[0]) throw new NotFoundError("Point transaction not found");
    return { id: rows[0].id as string };
  });
}
