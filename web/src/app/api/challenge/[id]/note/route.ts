import { z } from "zod";
import { saveSubmissionNote } from "@/server/challenges/image-submission";
import { ok, apiError } from "@/server/http/api-response";

const paramsSchema = z.object({ id: z.uuid() });
const bodySchema = z.object({ note: z.string().max(5_000) }).strict();

export async function PUT(
  request: Request,
  ctx: RouteContext<"/api/challenge/[id]/note">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    return ok(
      await saveSubmissionNote(id, async () => bodySchema.parse(await request.json()).note),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return apiError(err);
  }
}
