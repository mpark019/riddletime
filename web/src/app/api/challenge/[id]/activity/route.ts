import { z } from "zod";
import { recordActivity } from "@/server/challenges/activity";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });
const bodySchema = z.object({ kind: z.enum(["away", "back", "typing", "copy", "paste"]) }).strict();

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/challenge/[id]/activity">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const { kind } = bodySchema.parse(await request.json());
    return ok(await recordActivity(id, kind), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
