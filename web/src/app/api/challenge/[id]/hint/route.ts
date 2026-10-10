import { z } from "zod";
import { revealHint } from "@/server/challenges/challenges";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/challenge/[id]/hint">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const result = await revealHint(id);
    return ok(result);
  } catch (err) {
    return apiError(err);
  }
}
