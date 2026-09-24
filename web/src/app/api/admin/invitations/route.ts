import { createInvitation, listPendingInvitations } from "@/server/invitations/invitations";
import { ok, apiError } from "@/server/http/api-response";

export async function GET() {
  try {
    const result = await listPendingInvitations();
    return ok(result);
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await createInvitation(body);
    return ok(result, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
