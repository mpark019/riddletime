import "server-only";
import { randomUUID } from "crypto";
import { withTransaction } from "@/lib/db";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { AppError, ForbiddenError } from "@/server/http/errors";
import { MAX_IMAGE_BYTES, readImageFile } from "@/server/storage/image-file";
import { requireProfileRead } from "./identity";
import { clearOwnAvatarUrl, replaceOwnAvatarUrl } from "./profile";

export const PROFILE_AVATAR_BUCKET = "profile-avatars";
export const MAX_AVATAR_BYTES = MAX_IMAGE_BYTES;

export async function validateAvatarFile(rawFile: unknown) {
  return readImageFile(rawFile, "Profile picture");
}

function managedAvatarPath(avatarUrl: string | null, profileId: string) {
  if (!avatarUrl) return null;
  try {
    const marker = `/storage/v1/object/public/${PROFILE_AVATAR_BUCKET}/`;
    const pathname = new URL(avatarUrl).pathname;
    if (!pathname.startsWith(marker)) return null;
    const path = decodeURIComponent(pathname.slice(marker.length));
    const generatedPath = new RegExp(`^${profileId}/[0-9a-f-]+\\.(?:png|jpg|webp|gif)$`);
    return generatedPath.test(path) ? path : null;
  } catch {
    return null;
  }
}

async function removeAvatarObject(path: string) {
  try {
    const bucket = createSupabaseAdminClient().storage.from(PROFILE_AVATAR_BUCKET);
    const { error } = await bucket.remove([path]);
    if (error) console.warn("Profile avatar cleanup failed", { statusCode: error.statusCode });
  } catch {
    console.warn("Profile avatar cleanup could not be sent");
  }
}

export async function uploadOwnAvatar(rawFile: unknown) {
  const current = await withTransaction((client) => requireProfileRead(client));
  if (current.role === "spectator") throw new ForbiddenError("Spectators cannot edit their profile picture");
  const image = await validateAvatarFile(rawFile);
  const objectPath = `${current.id}/${randomUUID()}.${image.extension}`;
  const bucket = createSupabaseAdminClient().storage.from(PROFILE_AVATAR_BUCKET);
  const { error: uploadError } = await bucket.upload(objectPath, image.buffer, {
    cacheControl: "31536000",
    contentType: image.contentType,
    upsert: false,
  });
  if (uploadError) {
    console.warn("Profile avatar upload failed", { statusCode: uploadError.statusCode });
    throw new AppError(502, "avatar_upload_failed", "Could not upload profile picture");
  }

  const { data } = bucket.getPublicUrl(objectPath);
  let replacement;
  try {
    replacement = await replaceOwnAvatarUrl(data.publicUrl);
  } catch (err) {
    await removeAvatarObject(objectPath);
    throw err;
  }

  const previousPath = managedAvatarPath(replacement.previousAvatarUrl, current.id);
  if (previousPath && previousPath !== objectPath) await removeAvatarObject(previousPath);
  return replacement.profile;
}

export async function deleteOwnAvatar() {
  const replacement = await clearOwnAvatarUrl();
  const previousPath = managedAvatarPath(replacement.previousAvatarUrl, replacement.profile.id);
  if (previousPath) await removeAvatarObject(previousPath);
  return replacement.profile;
}
