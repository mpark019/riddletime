import { getDateAssignments } from "@/server/schedules/schedules";
import { ok, apiError } from "@/server/http/api-response";

export async function GET(request: Request) {
  try {
    const date = new URL(request.url).searchParams.get("date") ?? "";
    const result = await getDateAssignments(date);
    return ok(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
