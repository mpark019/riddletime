import { apiError, ok } from "@/server/http/api-response";
import { getLeaderboard } from "@/server/points/points";

export async function GET() {
  try {
    return ok(await getLeaderboard(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return apiError(err);
  }
}
