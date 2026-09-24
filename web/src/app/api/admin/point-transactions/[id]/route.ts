import { apiError, ok } from "@/server/http/api-response";
import { deletePointTransaction } from "@/server/points/points";

export async function DELETE(
  _request: Request,
  { params }: RouteContext<"/api/admin/point-transactions/[id]">,
) {
  try {
    const { id } = await params;
    return ok(await deletePointTransaction(id));
  } catch (err) {
    return apiError(err);
  }
}
