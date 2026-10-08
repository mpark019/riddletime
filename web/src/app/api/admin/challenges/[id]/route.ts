import { z } from "zod";
import { deleteSchedule, getScheduleDetail } from "@/server/schedules/schedules";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/admin/challenges/[id]">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const detail = await getScheduleDetail(id);
    return ok(detail, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/admin/challenges/[id]">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const result = await deleteSchedule(id);
    if (result.removedResults > 0) await announceLeaderboardChanged();
    return ok(result);
  } catch (err) {
    return apiError(err);
  }
}
