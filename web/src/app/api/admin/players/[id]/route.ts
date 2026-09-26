import { deletePlayerAccount, updatePlayerAccount } from "@/server/players/players";
import { apiError, ok } from "@/server/http/api-response";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return ok(await updatePlayerAccount((await params).id, await request.json())); } catch (err) { return apiError(err); }
}
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return ok(await deletePlayerAccount((await params).id)); } catch (err) { return apiError(err); }
}
