import { z } from "zod";
import { uploadSubmissionImage } from "@/server/challenges/image-submission";
import { ok, apiError } from "@/server/http/api-response";
import { requireUser } from "@/server/identity/identity";
import { BadRequestError } from "@/server/http/errors";
import { MAX_IMAGE_BYTES } from "@/server/storage/image-file";

const paramsSchema = z.object({ id: z.uuid() });
const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + 1024 * 1024;
const noStore = { headers: { "Cache-Control": "private, no-store" } };

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/challenge/[id]/images">,
) {
  try {
    const { id } = paramsSchema.parse(await ctx.params);
    await requireUser();
    const contentLength = Number(request.headers.get("content-length"));
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > MAX_MULTIPART_BYTES) {
      throw new BadRequestError("Image must be 5 MiB or smaller");
    }
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      throw new BadRequestError("Malformed image upload");
    }
    return ok(await uploadSubmissionImage(id, formData.get("file")), { ...noStore, status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
