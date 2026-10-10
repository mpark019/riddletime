import { listPendingReviews } from "@/server/challenges/image-submission";
import { ok, apiError } from "@/server/http/api-response";

export async function GET() {
  try {
    return ok({ submissions: await listPendingReviews() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
