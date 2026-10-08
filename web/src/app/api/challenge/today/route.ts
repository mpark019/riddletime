import { loadTodayChallenge } from "@/server/challenges/challenges";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";
import { ok, apiError } from "@/server/http/api-response";

export async function GET() {
  try {
    const { result, finalized } = await loadTodayChallenge();
    if (finalized > 0) await announceLeaderboardChanged();
    return ok(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
