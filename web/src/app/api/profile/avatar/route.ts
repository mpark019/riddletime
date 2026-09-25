import { apiError, ok } from "@/server/http/api-response";
import { BadRequestError } from "@/server/http/errors";
import { deleteOwnAvatar, MAX_AVATAR_BYTES, uploadOwnAvatar } from "@/server/identity/profile-avatar";
import { announceLeaderboardChanged } from "@/server/realtime/leaderboard";

const MAX_MULTIPART_BYTES = MAX_AVATAR_BYTES + 1024 * 1024;

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
      throw new BadRequestError("Profile picture must be 5 MiB or smaller");
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      throw new BadRequestError("Malformed profile picture upload");
    }
    const profile = await uploadOwnAvatar(formData.get("file"));
    if (profile.role === "player") await announceLeaderboardChanged();
    return ok(profile, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE() {
  try {
    const profile = await deleteOwnAvatar();
    if (profile.role === "player") await announceLeaderboardChanged();
    return ok(profile, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
