import "server-only";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { requireAdmin, requireAdminRead, requireProfileRead, requireUser } from "@/server/identity/identity";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/http/errors";

const UUID = z.uuid();

export const manualAdjustmentInput = z.object({
  userId: UUID,
  amount: z
    .number()
    .int()
    .min(-2_147_483_648)
    .max(2_147_483_647)
    .refine((amount) => amount !== 0, "amount must not be zero"),
  reason: z.string().trim().min(1),
  operationKey: z.string().trim().min(1),
});
export type ManualAdjustmentInput = z.infer<typeof manualAdjustmentInput>;

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  rank: number;
  totalPoints: number;
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
       )
       select p.id as user_id, p.display_name, p.avatar_url,
              coalesce(b.total_points, 0)::bigint as total_points,
              rank() over (order by coalesce(b.total_points, 0) desc)::bigint as rank
       from profiles p
       left join balances b on b.user_id = p.id
       where p.role = 'player'
       order by coalesce(b.total_points, 0) desc, p.id asc`,
    );
    return rows.map((row) => ({
      userId: row.user_id as string,
      displayName: row.display_name as string,
      avatarUrl: row.avatar_url as string | null,
      rank: Number(row.rank),
      totalPoints: Number(row.total_points),
    }));
  });
}

export async function listPointTransactions(): Promise<PointTransaction[]> {
  return withTransaction(async (client) => {
    await requireAdminRead(client);
    const { rows } = await client.query(
      `select pt.id, pt.user_id, p.display_name, pt.amount, pt.kind, pt.reason,
              pt.submission_id, pt.created_by, pt.operation_key, pt.created_at
       from point_transactions pt
       join profiles p on p.id = pt.user_id
       order by pt.created_at desc, pt.id desc`,
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
    if (!actingProfile || actingProfile.role !== "admin") {
      throw new ForbiddenError("Admin role required");
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

    let entry = inserted[0] ? mapTransaction(inserted[0]) : null;
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
    return { entry, totalPoints: Number(balanceRows[0].total_points) };
  });
}

export async function deletePointTransaction(transactionId: string) {
  UUID.parse(transactionId);
  return withTransaction(async (client) => {
    await requireAdmin(client);
    const { rows } = await client.query(
      "delete from point_transactions where id = $1 returning id",
      [transactionId],
    );
    if (!rows[0]) throw new NotFoundError("Point transaction not found");
    return { id: rows[0].id as string };
  });
}
