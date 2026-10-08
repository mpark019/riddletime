import { listSchedules } from "@/server/schedules/schedules";
import { ok, apiError } from "@/server/http/api-response";

export async function GET() {
  try {
    const schedules = await listSchedules();
    return ok({ schedules }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
