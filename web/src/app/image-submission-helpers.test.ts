import { describe, expect, it } from "vitest";
import { imageResultHeading, MAX_IMAGE_BYTES, pickImageFiles, resultVariant } from "./image-submission-helpers";

function file(name: string, type: string, size = 10) {
  return new File([new Uint8Array(size)], name, { type });
}

describe("pickImageFiles", () => {
  it("accepts allowed images and rejects other types", () => {
    const { accepted, errors } = pickImageFiles([file("a.png", "image/png"), file("b.svg", "image/svg+xml")], 0, 5);
    expect(accepted.map((f) => f.name)).toEqual(["a.png"]);
    expect(errors).toEqual(["b.svg is not a PNG, JPEG, WebP, or GIF image."]);
  });

  it("rejects empty and oversize files", () => {
    const { accepted, errors } = pickImageFiles(
      [file("e.png", "image/png", 0), file("big.png", "image/png", MAX_IMAGE_BYTES + 1)],
      0,
      5,
    );
    expect(accepted).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it("stops at the maximum counting images already added", () => {
    const { accepted, errors } = pickImageFiles(
      [file("a.png", "image/png"), file("b.png", "image/png"), file("c.png", "image/png")],
      1,
      2,
    );
    expect(accepted.map((f) => f.name)).toEqual(["a.png"]);
    expect(errors).toEqual(["You can add up to 2 images."]);
  });
});

describe("result presentation", () => {
  it("maps outcomes to a stamp variant", () => {
    expect(resultVariant(true, "full")).toBe("success");
    expect(resultVariant(true, "partial")).toBe("partial");
    expect(resultVariant(false, "none")).toBe("fail");
    expect(resultVariant(false, null)).toBe("fail");
  });

  it("names the outcome", () => {
    expect(imageResultHeading("full", true)).toBe("Full points");
    expect(imageResultHeading("partial", true)).toBe("Partial credit");
    expect(imageResultHeading("none", false)).toBe("No points");
    expect(imageResultHeading(null, false)).toBe("Time ran out");
  });
});

describe("pickImageFiles size checking", () => {
  const big = new File([new Uint8Array(6 * 1024 * 1024)], "big.jpg", { type: "image/jpeg" });

  it("rejects an oversized file by default", () => {
    expect(pickImageFiles([big], 0, 5).accepted).toHaveLength(0);
  });

  it("accepts it when the caller will resize first", () => {
    expect(pickImageFiles([big], 0, 5, { checkSize: false }).accepted).toEqual([big]);
  });
});

