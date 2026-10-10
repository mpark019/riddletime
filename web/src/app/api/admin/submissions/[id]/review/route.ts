import { gradeSubmission } from "@/server/challenges/image-submission";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";
import { ok, apiError } from "@/server/http/api-response";

// The id and body are validated by the service after it checks the caller's role.
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/admin/submissions/[id]/review">,
) {
  try {
    const { id } = await ctx.params;
    const graded = await gradeSubmission(id, () => request.json());
    if (!graded.alreadyReviewed) await announceLeaderboardChanged();
    return ok(graded, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
