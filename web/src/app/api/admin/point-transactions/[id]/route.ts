import { apiError, ok } from "@/server/http/api-response";
import { deletePointTransaction } from "@/server/points/points";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";

export async function DELETE(
  _request: Request,
  { params }: RouteContext<"/api/admin/point-transactions/[id]">,
) {
  try {
    const { id } = await params;
    const result = await deletePointTransaction(id);
    await announceLeaderboardChanged();
    return ok(result);
  } catch (err) {
    return apiError(err);
  }
}
