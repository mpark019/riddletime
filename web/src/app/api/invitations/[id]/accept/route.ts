import { z } from "zod";
import { acceptInvitation } from "@/server/invitations/invitations";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/invitations/[id]/accept">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const body = (await request.text()) || "{}";
    const result = await acceptInvitation(id, JSON.parse(body));
    return ok(result);
  } catch (err) {
    return apiError(err);
  }
}
