import "server-only";
import { randomUUID } from "crypto";
import { withTransaction } from "@/lib/db";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { AppError, BadRequestError, ForbiddenError } from "@/server/http/errors";
import { requireProfileRead } from "./identity";
import { clearOwnAvatarUrl, replaceOwnAvatarUrl } from "./profile";

export const PROFILE_AVATAR_BUCKET = "profile-avatars";
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const formats = [
  { contentType: "image/png", extension: "png", matches: (bytes: Uint8Array) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { contentType: "image/jpeg", extension: "jpg", matches: (bytes: Uint8Array) => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  { contentType: "image/gif", extension: "gif", matches: (bytes: Uint8Array) => startsWith(bytes, [...new TextEncoder().encode("GIF87a")]) || startsWith(bytes, [...new TextEncoder().encode("GIF89a")]) },
  { contentType: "image/webp", extension: "webp", matches: (bytes: Uint8Array) => startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]) },
] as const;

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

export async function validateAvatarFile(rawFile: unknown) {
  if (!(rawFile instanceof File)) {
    throw new BadRequestError("Choose an image file");
  }
  if (rawFile.size === 0) {
    throw new BadRequestError("Profile picture cannot be empty");
  }
  if (rawFile.size > MAX_AVATAR_BYTES) {
    throw new BadRequestError("Profile picture must be 5 MiB or smaller");
  }

  const buffer = await rawFile.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const format = formats.find((candidate) => candidate.contentType === rawFile.type && candidate.matches(bytes));
  if (!format) {
    throw new BadRequestError("Profile picture must be a PNG, JPEG, WebP, or GIF image");
  }
  return { buffer, contentType: format.contentType, extension: format.extension };
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
