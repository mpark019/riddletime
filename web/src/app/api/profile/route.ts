import { apiError, ok } from "@/server/http/api-response";
import { updateOwnProfile } from "@/server/identity/profile";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";

export async function PATCH(request: Request) {
  try {
    const profile = await updateOwnProfile(await request.json());
    if (profile.role === "player") await announceLeaderboardChanged();
    return ok(profile, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
