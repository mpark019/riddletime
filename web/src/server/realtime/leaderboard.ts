import "server-only";
import { env } from "@/lib/env";
import { LEADERBOARD_CHANGED_EVENT, LEADERBOARD_REALTIME_TOPIC } from "@/lib/realtime/leaderboard";

export { LEADERBOARD_CHANGED_EVENT, LEADERBOARD_REALTIME_TOPIC };

// This notification intentionally carries no ledger or submission data. Receivers reload the
// existing authorized API data instead of learning about another player's answer or adjustment.
export async function announceLeaderboardChanged(): Promise<void> {
  const baseUrl = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "");
  const endpoint = `${baseUrl}/realtime/v1/api/broadcast/${encodeURIComponent(LEADERBOARD_REALTIME_TOPIC)}/events/${LEADERBOARD_CHANGED_EVENT}?private=true`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(1_500),
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: "{}",
    });
    if (!response.ok) {
      console.warn("Realtime leaderboard broadcast failed", { status: response.status });
    }
  } catch {
    // Realtime is an enhancement. The durable write has already committed and must still succeed.
    console.warn("Realtime leaderboard broadcast could not be sent");
  }
}
