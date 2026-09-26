import { createMemberAccount, listMemberAccounts } from "@/server/players/players";
import { apiError, ok } from "@/server/http/api-response";

export async function POST(request: Request) {
  try {
    return ok(await createMemberAccount(await request.json()), { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}

export async function GET(request: Request) {
  try { return ok(await listMemberAccounts(new URL(request.url).searchParams.get("role"))); } catch (err) { return apiError(err); }
}
