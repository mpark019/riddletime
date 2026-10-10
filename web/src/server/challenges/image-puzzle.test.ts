import { describe, expect, it } from "vitest";
import {
  computeReviewResult,
  imageConfigSchema,
  noteSchema,
  reviewInputSchema,
} from "./image-puzzle";

describe("computeReviewResult", () => {
  it("awards flat base points for full", () => {
    const { correct, breakdown } = computeReviewResult({ outcome: "full", comment: null }, 100, 20);
    expect(correct).toBe(true);
    expect(breakdown).toMatchObject({ total_points: 100, base_points: 100, penalty_points: 0, outcome: "full" });
    expect(breakdown.speed_bonus_points).toBeNull();
  });

  it("applies the failure penalty for none", () => {
    const { correct, breakdown } = computeReviewResult({ outcome: "none", comment: null }, 100, 20);
    expect(correct).toBe(false);
    expect(breakdown).toMatchObject({ total_points: -20, base_points: 0, penalty_points: 20, outcome: "none" });
  });

  it("scores none as zero when there is no penalty", () => {
    expect(computeReviewResult({ outcome: "none", comment: null }, 100, 0).breakdown.total_points).toBe(0);
  });

  it.each([1, 50, 99])("awards a partial of %i", (points) => {
    const { correct, breakdown } = computeReviewResult({ outcome: "partial", points, comment: null }, 100, 20);
    expect(correct).toBe(true);
    expect(breakdown).toMatchObject({ total_points: points, outcome: "partial", penalty_points: 0 });
  });

  it.each([100, 101])("rejects a partial of %i at or above full", (points) => {
    expect(() => computeReviewResult({ outcome: "partial", points, comment: null }, 100, 20))
      .toThrow(/between 1 and 99/);
  });

  it.each([0, 1])("rejects any partial when base points are %i", (base) => {
    expect(() => computeReviewResult({ outcome: "partial", points: 1, comment: null }, base, 5))
      .toThrow(/at least 2/);
  });
});

describe("reviewInputSchema", () => {
  it("trims comments and stores blank as null", () => {
    expect(reviewInputSchema.parse({ outcome: "full", comment: "  nice  " }).comment).toBe("nice");
    expect(reviewInputSchema.parse({ outcome: "none", comment: "   " }).comment).toBeNull();
    expect(reviewInputSchema.parse({ outcome: "none" }).comment).toBeNull();
  });

  it("rejects comments over 500 characters", () => {
    expect(() => reviewInputSchema.parse({ outcome: "full", comment: "x".repeat(501) })).toThrow();
  });

  it("rejects non-integer, zero, or missing partial points and unknown fields", () => {
    expect(() => reviewInputSchema.parse({ outcome: "partial", points: 1.5 })).toThrow();
    expect(() => reviewInputSchema.parse({ outcome: "partial", points: 0 })).toThrow();
    expect(() => reviewInputSchema.parse({ outcome: "partial" })).toThrow();
    expect(() => reviewInputSchema.parse({ outcome: "full", points: 5 })).toThrow();
  });
});

describe("image config and note", () => {
  it("bounds max_images from 1 to 10", () => {
    expect(imageConfigSchema.safeParse({ max_images: 5 }).success).toBe(true);
    expect(imageConfigSchema.safeParse({ max_images: 0 }).success).toBe(false);
    expect(imageConfigSchema.safeParse({ max_images: 11 }).success).toBe(false);
  });

  it("trims notes and caps them at 1000 characters", () => {
    expect(noteSchema.parse("  hi ")).toBe("hi");
    expect(noteSchema.parse("   ")).toBeNull();
    expect(noteSchema.safeParse("x".repeat(1001)).success).toBe(false);
  });
});
