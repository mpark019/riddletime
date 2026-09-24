import { apiError, ok } from "@/server/http/api-response";
import {
  createManualAdjustment,
  listPointTransactions,
  manualAdjustmentInput,
  type PointTransaction,
} from "@/server/points/points";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";
import { z } from "zod";

const requestSchema = z.object({
  user_id: z.uuid(),
  amount: z.number(),
  reason: z.string().optional(),
  operation_key: z.string(),
});

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

export async function GET() {
  try {
    return ok((await listPointTransactions()).map(transactionResponse), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const input = manualAdjustmentInput.parse({
      userId: body.user_id,
      amount: body.amount,
      reason: body.reason,
      operationKey: body.operation_key,
    });
    const result = await createManualAdjustment(input);
    if (result.created) await announceLeaderboardChanged();
    return ok(
      { entry: transactionResponse(result.entry), total_points: result.totalPoints },
      { status: 201 },
    );
  } catch (err) {
    return apiError(err);
  }
}
