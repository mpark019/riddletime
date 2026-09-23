import { getTodayChallenge } from "@/server/challenges/challenges";
import { ok, apiError } from "@/server/http/api-response";

export async function GET() {
  try {
    const result = await getTodayChallenge();
    return ok(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
