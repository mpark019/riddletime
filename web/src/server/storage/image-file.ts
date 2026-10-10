import { BadRequestError } from "@/server/http/errors";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const formats = [
  { contentType: "image/png", extension: "png", matches: (bytes: Uint8Array) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { contentType: "image/jpeg", extension: "jpg", matches: (bytes: Uint8Array) => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  { contentType: "image/gif", extension: "gif", matches: (bytes: Uint8Array) => startsWith(bytes, [...new TextEncoder().encode("GIF87a")]) || startsWith(bytes, [...new TextEncoder().encode("GIF89a")]) },
  { contentType: "image/webp", extension: "webp", matches: (bytes: Uint8Array) => startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]) },
] as const;

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

export interface ValidatedImage {
  buffer: ArrayBuffer;
  contentType: string;
  extension: string;
}

// The declared MIME type and the file signature must agree; `label` names the file in error messages.
export async function readImageFile(rawFile: unknown, label: string): Promise<ValidatedImage> {
  if (!(rawFile instanceof File)) {
    throw new BadRequestError("Choose an image file");
  }
  if (rawFile.size === 0) {
    throw new BadRequestError(`${label} cannot be empty`);
  }
  if (rawFile.size > MAX_IMAGE_BYTES) {
    throw new BadRequestError(`${label} must be 5 MiB or smaller`);
  }

  const buffer = await rawFile.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const format = formats.find((candidate) => candidate.contentType === rawFile.type && candidate.matches(bytes));
  if (!format) {
    throw new BadRequestError(`${label} must be a PNG, JPEG, WebP, or GIF image`);
  }
  return { buffer, contentType: format.contentType, extension: format.extension };
}
