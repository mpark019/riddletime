import { z } from "zod";
import { getChallengeSession } from "@/server/challenges/challenges";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/challenge/[id]">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const result = await getChallengeSession(id);
    return ok(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
