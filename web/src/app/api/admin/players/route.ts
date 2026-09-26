import { createPlayerAccount, listPlayerAccounts } from "@/server/players/players";
import { apiError, ok } from "@/server/http/api-response";

export async function POST(request: Request) {
  try {
    return ok(await createPlayerAccount(await request.json()), { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}

export async function GET() {
  try { return ok(await listPlayerAccounts()); } catch (err) { return apiError(err); }
}
