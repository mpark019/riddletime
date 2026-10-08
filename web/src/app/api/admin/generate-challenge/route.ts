import { apiError, ok } from "@/server/http/api-response";
import { createManualSharedRiddle } from "@/server/schedules/schedules";

export async function POST(request: Request) {
  try {
    const result = await createManualSharedRiddle(await request.json());
    return ok(
      {
        schedule_id: result.scheduleId,
        active_date: result.activeDate,
        status: result.status,
      },
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}
