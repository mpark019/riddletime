import { z } from "zod";
import { submitImagesForReview } from "@/server/challenges/image-submission";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/challenge/[id]/submit-images">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const result = await submitImagesForReview(id);
    // An empty draft past its deadline is penalized by the same call, which changes the leaderboard.
    if (result.play.status === "completed") await announceLeaderboardChanged();
    return ok(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
