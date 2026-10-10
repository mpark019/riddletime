// Runs in the browser so large phone photos fit under the upload limits before they are sent.
export const MAX_EDGE_PX = 2048;
export const SKIP_BELOW_BYTES = 1.5 * 1024 * 1024;
export const UPLOAD_TARGET_BYTES = 4 * 1024 * 1024;

// Tried in order until the encoded image fits UPLOAD_TARGET_BYTES.
const ATTEMPTS = [
  { edge: MAX_EDGE_PX, quality: 0.85 },
  { edge: MAX_EDGE_PX, quality: 0.7 },
  { edge: 1600, quality: 0.7 },
  { edge: 1280, quality: 0.6 },
] as const;

export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longEdge;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// GIFs are left alone because re-encoding would flatten an animation.
export function needsResize(image: { width: number; height: number; size: number; type: string }): boolean {
  if (image.type === "image/gif") return false;
  return Math.max(image.width, image.height) > MAX_EDGE_PX || image.size > SKIP_BELOW_BYTES;
}

export function resizedName(name: string): string {
  const stem = name.replace(/\.[^./\\]+$/, "");
  return `${stem || "image"}.jpg`;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  await image.decode();
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

function encode(decoded: Decoded, edge: number, quality: number): Promise<Blob | null> {
  const { width, height } = fitWithin(decoded.width, decoded.height, edge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  // JPEG has no transparency, so a transparent PNG would otherwise turn black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(decoded.source, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

// Returns the original file when it is small enough, cannot be decoded, or would not shrink.
export async function prepareImageForUpload(file: File): Promise<File> {
  if (file.type === "image/gif" || typeof document === "undefined") return file;
  let decoded: Decoded | null = null;
  try {
    decoded = await decode(file);
    if (!needsResize({ width: decoded.width, height: decoded.height, size: file.size, type: file.type })) return file;
    let best: Blob | null = null;
    for (const attempt of ATTEMPTS) {
      const blob = await encode(decoded, attempt.edge, attempt.quality);
      if (blob && (best === null || blob.size < best.size)) best = blob;
      if (blob && blob.size <= UPLOAD_TARGET_BYTES) break;
    }
    if (!best || (best.size >= file.size && file.size <= UPLOAD_TARGET_BYTES)) return file;
    return new File([best], resizedName(file.name), { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    return file;
  } finally {
    decoded?.release();
  }
}
