import type { ReviewOutcome } from "@/lib/challenge-state";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_NOTE_LENGTH = 1000;
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

const ALLOWED_TYPES = new Set(IMAGE_ACCEPT.split(","));

export interface PickedFiles {
  accepted: File[];
  errors: string[];
}

// Mirrors the server rules so obvious mistakes are caught before an upload starts.
// Size is checked after resizing, so callers that resize first pass `checkSize: false` here.
export function pickImageFiles(
  files: readonly File[],
  existingCount: number,
  maxImages: number,
  options: { checkSize?: boolean } = {},
): PickedFiles {
  const checkSize = options.checkSize ?? true;
  const accepted: File[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (existingCount + accepted.length >= maxImages) {
      errors.push(`You can add up to ${maxImages} ${maxImages === 1 ? "image" : "images"}.`);
      break;
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      errors.push(`${file.name} is not a PNG, JPEG, WebP, or GIF image.`);
    } else if (file.size === 0) {
      errors.push(`${file.name} is empty.`);
    } else if (checkSize && file.size > MAX_IMAGE_BYTES) {
      errors.push(`${file.name} is larger than 5 MiB.`);
    } else {
      accepted.push(file);
    }
  }
  return { accepted, errors };
}

export type ResultVariant = "success" | "partial" | "fail";

export function resultVariant(correct: boolean, outcome: ReviewOutcome | null | undefined): ResultVariant {
  if (outcome === "partial") return "partial";
  if (outcome === "full" || (outcome === undefined && correct)) return "success";
  return "fail";
}

export function imageResultHeading(outcome: ReviewOutcome | null | undefined, correct: boolean): string {
  if (outcome === "full") return "Full points";
  if (outcome === "partial") return "Partial credit";
  if (outcome === "none") return "No points";
  return correct ? "Graded" : "Time ran out";
}
