import { apiError, ok } from "@/server/http/api-response";
import {
  createManualSharedRiddle,
  createSharedCharacterPuzzle,
  isCharacterScheduleRequest,
} from "@/server/schedules/schedules";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = isCharacterScheduleRequest(body)
      ? await createSharedCharacterPuzzle(body)
      : await createManualSharedRiddle(body);
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
