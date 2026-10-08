import { finalizeOverdueSessions, getTodayChallenge } from "@/server/challenges/challenges";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";
import { ok, apiError } from "@/server/http/api-response";

export async function GET() {
  try {
    if (await finalizeOverdueSessions() > 0) await announceLeaderboardChanged();
    const result = await getTodayChallenge();
    return ok(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
