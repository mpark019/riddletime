import { z } from "zod";
import { submitChallenge } from "@/server/challenges/challenges";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });
const bodySchema = z.union([
  z.object({ response: z.string().trim().min(1), operationKey: z.uuid() }).strict(),
  z.object({ finalizeExpired: z.literal(true) }).strict(),
]);

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/challenge/[id]/submit">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const body = bodySchema.parse(await request.json());
    const result = "response" in body
      ? await submitChallenge(id, body.response, body.operationKey)
      : await submitChallenge(id, null);
    if (result.finalized && !result.alreadyFinalized) await announceLeaderboardChanged();
    return ok(result);
  } catch (err) {
    return apiError(err);
  }
}
