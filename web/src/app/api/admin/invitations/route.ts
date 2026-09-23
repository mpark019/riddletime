import { createInvitation } from "@/server/invitations/invitations";
import { ok, apiError } from "@/server/http/api-response";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await createInvitation(body);
    return ok(result, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
