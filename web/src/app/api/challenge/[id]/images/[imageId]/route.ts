import { z } from "zod";
import { removeSubmissionImage } from "@/server/challenges/image-submission";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid(), imageId: z.string().min(1).max(100) });

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/challenge/[id]/images/[imageId]">,
) {
  try {
    const { id, imageId } = paramsSchema.parse(await ctx.params);
    return ok(await removeSubmissionImage(id, imageId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
