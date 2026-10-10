import { deletePuzzle, getPuzzle, updatePuzzle } from "@/server/puzzles/puzzles";
import { ok, apiError } from "@/server/http/api-response";

const noStore = { headers: { "Cache-Control": "private, no-store" } };

// The id and body are validated by the service after it checks the caller is an admin.
export async function GET(_request: Request, ctx: RouteContext<"/api/admin/puzzles/[id]">) {
  try {
    const { id } = await ctx.params;
    return ok({ puzzle: await getPuzzle(id) }, noStore);
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/admin/puzzles/[id]">) {
  try {
    const { id } = await ctx.params;
    return ok({ puzzle: await updatePuzzle(id, () => request.json()) }, noStore);
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/admin/puzzles/[id]">) {
  try {
    const { id } = await ctx.params;
    return ok(await deletePuzzle(id), noStore);
  } catch (err) {
    return apiError(err);
  }
}
