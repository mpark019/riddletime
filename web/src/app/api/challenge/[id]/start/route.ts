import { z } from "zod";
import { startChallenge } from "@/server/challenges/challenges";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/challenge/[id]/start">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const result = await startChallenge(id);
    return ok(result);
  } catch (err) {
    return apiError(err);
  }
}
