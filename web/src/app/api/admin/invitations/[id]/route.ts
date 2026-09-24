import { z } from "zod";
import { deleteInvitation } from "@/server/invitations/invitations";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/admin/invitations/[id]">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    const result = await deleteInvitation(id);
    return ok(result);
  } catch (err) {
    return apiError(err);
  }
}
