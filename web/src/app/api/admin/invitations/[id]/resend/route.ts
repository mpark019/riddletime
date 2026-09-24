import { z } from "zod";
import { resendInvitation } from "@/server/invitations/invitations";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/admin/invitations/[id]/resend">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const result = await resendInvitation(id);
    return ok(result);
  } catch (err) {
    return apiError(err);
  }
}
