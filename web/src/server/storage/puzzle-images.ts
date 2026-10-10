import "server-only";
import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { AppError } from "@/server/http/errors";
import type { ValidatedImage } from "./image-file";

export const PUZZLE_IMAGE_BUCKET = "puzzle-images";
const SIGNED_URL_SECONDS = 3600;
const EXTENSIONS = "(?:png|jpg|webp|gif)";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function newPromptImagePath(adminId: string, extension: string) {
  return `prompts/${adminId}/${randomUUID()}.${extension}`;
}

export function newSubmissionImagePath(playerId: string, submissionId: string, extension: string) {
  return `submissions/${playerId}/${submissionId}/${randomUUID()}.${extension}`;
}

export function isPromptImagePath(path: unknown): path is string {
  return typeof path === "string" && new RegExp(`^prompts/${UUID}/${UUID}\\.${EXTENSIONS}$`).test(path);
}

// The object id a client may name; the full path is always rebuilt from the session.
export function submissionImageId(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isSubmissionImageId(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^${UUID}\\.${EXTENSIONS}$`).test(value);
}

function bucket() {
  return createSupabaseAdminClient().storage.from(PUZZLE_IMAGE_BUCKET);
}

export async function uploadPuzzleImage(path: string, image: ValidatedImage) {
  const { error } = await bucket().upload(path, image.buffer, {
    cacheControl: "600",
    contentType: image.contentType,
    upsert: false,
  });
  if (error) {
    console.warn("Puzzle image upload failed", { statusCode: error.statusCode });
    throw new AppError(502, "image_upload_failed", "Could not upload the image");
  }
}

// Cleanup is best effort: a failed removal must never undo or block the database change.
export async function removePuzzleImages(paths: string[]) {
  if (paths.length === 0) return;
  try {
    const { error } = await bucket().remove(paths);
    if (error) console.warn("Puzzle image cleanup failed", { statusCode: error.statusCode });
  } catch {
    console.warn("Puzzle image cleanup could not be sent");
  }
}

export async function signPuzzleImages(paths: string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (paths.length === 0) return urls;
  try {
    const { data, error } = await bucket().createSignedUrls(paths, SIGNED_URL_SECONDS);
    if (error) throw error;
    for (const entry of data ?? []) {
      if (entry.path && entry.signedUrl) urls.set(entry.path, entry.signedUrl);
    }
  } catch {
    console.warn("Puzzle image URLs could not be signed");
  }
  return urls;
}
