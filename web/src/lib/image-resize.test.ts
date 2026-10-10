import { describe, expect, it } from "vitest";
import { MAX_EDGE_PX, SKIP_BELOW_BYTES, fitWithin, needsResize, resizedName } from "./image-resize";

describe("fitWithin", () => {
  it("keeps an image already inside the limit", () => {
    expect(fitWithin(1600, 1200, MAX_EDGE_PX)).toEqual({ width: 1600, height: 1200 });
  });

  it("scales the long edge down and keeps the aspect ratio", () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
  });

  it("never returns a zero dimension", () => {
    expect(fitWithin(100000, 10, 2048).height).toBeGreaterThanOrEqual(1);
  });
});

describe("needsResize", () => {
  const small = { width: 1000, height: 800, size: 200_000, type: "image/jpeg" };

  it("leaves a small image alone", () => {
    expect(needsResize(small)).toBe(false);
  });

  it("resizes by dimensions or by file size", () => {
    expect(needsResize({ ...small, width: MAX_EDGE_PX + 1 })).toBe(true);
    expect(needsResize({ ...small, size: SKIP_BELOW_BYTES + 1 })).toBe(true);
  });

  it("never touches a GIF, so animations survive", () => {
    expect(needsResize({ width: 5000, height: 5000, size: 9_000_000, type: "image/gif" })).toBe(false);
  });
});

describe("resizedName", () => {
  it("swaps the extension for jpg", () => {
    expect(resizedName("IMG_0042.HEIC")).toBe("IMG_0042.jpg");
    expect(resizedName("my.photo.png")).toBe("my.photo.jpg");
    expect(resizedName("noext")).toBe("noext.jpg");
    expect(resizedName(".png")).toBe("image.jpg");
  });
});
