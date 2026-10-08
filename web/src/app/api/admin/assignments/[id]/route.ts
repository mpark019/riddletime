import { z } from "zod";
import { removeAssignment } from "@/server/schedules/schedules";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/admin/assignments/[id]">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const result = await removeAssignment(id);
    if (result.removedResults > 0) await announceLeaderboardChanged();
    return ok(result);
  } catch (err) {
    return apiError(err);
  }
}
