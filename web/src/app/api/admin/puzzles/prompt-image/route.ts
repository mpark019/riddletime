import { discardPromptImage, uploadPromptImage } from "@/server/puzzles/puzzles";
import { ok, apiError } from "@/server/http/api-response";
import { requireUser } from "@/server/identity/identity";
import { BadRequestError } from "@/server/http/errors";
import { MAX_IMAGE_BYTES } from "@/server/storage/image-file";

const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + 1024 * 1024;

export async function POST(request: Request) {
  try {
    await requireUser();
    const contentLength = Number(request.headers.get("content-length"));
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > MAX_MULTIPART_BYTES) {
      throw new BadRequestError("Prompt image must be 5 MiB or smaller");
    }
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      throw new BadRequestError("Malformed prompt image upload");
    }
    return ok(await uploadPromptImage(formData.get("file")), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return apiError(err);
  }
}

// The body is read after the service checks the caller's role.
export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { path?: unknown };
    return ok(await discardPromptImage(body.path), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
