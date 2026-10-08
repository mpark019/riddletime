import { apiError, ok } from "@/server/http/api-response";
import {
  assignPersonalCharacterPuzzle,
  assignPersonalRiddle,
  createManualSharedRiddle,
  createSharedCharacterPuzzle,
  isCharacterScheduleRequest,
  isPersonalScheduleRequest,
} from "@/server/schedules/schedules";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (isPersonalScheduleRequest(body)) {
      const result = isCharacterScheduleRequest(body)
        ? await assignPersonalCharacterPuzzle(body)
        : await assignPersonalRiddle(body);
      return ok(
        {
          schedule_id: result.scheduleId,
          active_date: result.activeDate,
          status: result.status,
          assigned_count: result.assignedPlayerIds.length,
          skipped_count: result.skippedPlayerIds.length,
          skipped_player_ids: result.skippedPlayerIds,
        },
        { status: 201 },
      );
    }
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
