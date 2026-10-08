import { after } from "next/server";
import { apiError, ok } from "@/server/http/api-response";
import {
  createManualAdjustment,
  createManualAdjustmentForAllPlayers,
  createManualAdjustmentForPlayers,
  allPlayersManualAdjustmentInput,
  playersManualAdjustmentInput,
  listPointTransactions,
  manualAdjustmentInput,
  type PointTransaction,
} from "@/server/points/points";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";
import { z } from "zod";

const adjustmentFields = {
  amount: z.number(),
  reason: z.string().optional(),
  operation_key: z.string(),
};
const requestSchema = z.union([
  z.object({ user_id: z.uuid(), ...adjustmentFields }),
  z.object({ scope: z.literal("all_players"), ...adjustmentFields }),
  z.object({ user_ids: z.array(z.uuid()).min(1), ...adjustmentFields }),
]);

function transactionResponse(transaction: PointTransaction) {
  return {
    id: transaction.id,
    user_id: transaction.userId,
    display_name: transaction.displayName,
    amount: transaction.amount,
    kind: transaction.kind,
    reason: transaction.reason,
    submission_id: transaction.submissionId,
    created_by: transaction.createdBy,
    operation_key:
      transaction.kind === "manual_adjustment"
        ? transaction.operationKey.replace(/^manual:/, "")
        : transaction.operationKey,
    created_at: transaction.createdAt,
  };
}

const pageQuerySchema = z.object({
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
  query: z.string().optional(),
});

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const page = pageQuerySchema.parse({
      limit: params.get("limit") ?? undefined,
      offset: params.get("offset") ?? undefined,
      query: params.get("q") ?? undefined,
    });
    return ok((await listPointTransactions(page)).map(transactionResponse), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    if ("scope" in body) {
      const input = allPlayersManualAdjustmentInput.parse({
        amount: body.amount,
        reason: body.reason,
        operationKey: body.operation_key,
      });
      const result = await createManualAdjustmentForAllPlayers(input);
      if (result.created) after(announceLeaderboardChanged);
      return ok(
        { entries: result.entries.map(transactionResponse), created: result.created },
        { status: 201 },
      );
    }
    if ("user_ids" in body) {
      const input = playersManualAdjustmentInput.parse({ userIds: body.user_ids, amount: body.amount, reason: body.reason, operationKey: body.operation_key });
      const result = await createManualAdjustmentForPlayers(input);
      if (result.created) after(announceLeaderboardChanged);
      return ok({ entries: result.entries.map(transactionResponse), created: result.created }, { status: 201 });
    }
    const input = manualAdjustmentInput.parse({
      userId: body.user_id,
      amount: body.amount,
      reason: body.reason,
      operationKey: body.operation_key,
    });
    const result = await createManualAdjustment(input);
    if (result.created) after(announceLeaderboardChanged);
    return ok(
      { entry: transactionResponse(result.entry), total_points: result.totalPoints },
      { status: 201 },
    );
  } catch (err) {
    return apiError(err);
  }
}
