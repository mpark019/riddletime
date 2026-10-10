import { createPuzzle, listPuzzles } from "@/server/puzzles/puzzles";
import { ok, apiError } from "@/server/http/api-response";

const noStore = { headers: { "Cache-Control": "private, no-store" } };

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const excluded = params.get("exclude_seen_by");
    const puzzles = await listPuzzles({
      type: params.get("type") ?? undefined,
      status: params.get("status") ?? undefined,
      used: params.get("used") ?? undefined,
      exclude_seen_by: excluded ? excluded.split(",") : undefined,
    });
    return ok({ puzzles }, noStore);
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const puzzle = await createPuzzle(() => request.json());
    return ok({ puzzle }, { status: 201, ...noStore });
  } catch (err) {
    return apiError(err);
  }
}
