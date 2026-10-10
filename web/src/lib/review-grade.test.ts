import { describe, expect, it } from "vitest";
import { buildReviewRequest, canGradePartial, parsePartialPoints } from "./review-grade";

describe("parsePartialPoints", () => {
  it("accepts whole numbers from 1 to base minus 1", () => {
    expect(parsePartialPoints("1", 100)).toBe(1);
    expect(parsePartialPoints(" 99 ", 100)).toBe(99);
  });

  it.each(["", "0", "100", "101", "1.5", "-3", "abc"])("rejects %j", (raw) => {
    expect(parsePartialPoints(raw, 100)).toBeNull();
  });

  it("is unavailable when base points are below 2", () => {
    expect(canGradePartial(1)).toBe(false);
    expect(parsePartialPoints("1", 1)).toBeNull();
    expect(canGradePartial(2)).toBe(true);
    expect(parsePartialPoints("1", 2)).toBe(1);
  });
});

describe("buildReviewRequest", () => {
  it("requires a choice", () => {
    expect(buildReviewRequest({ choice: null, partialPoints: "", comment: "" }, 10)).toBeNull();
  });

  it("builds full and none requests, trimming the comment and dropping blanks", () => {
    expect(buildReviewRequest({ choice: "full", partialPoints: "", comment: "  " }, 10)).toEqual({ outcome: "full" });
    expect(buildReviewRequest({ choice: "none", partialPoints: "", comment: " no " }, 10))
      .toEqual({ outcome: "none", comment: "no" });
  });

  it("requires a valid amount for partial", () => {
    expect(buildReviewRequest({ choice: "partial", partialPoints: "10", comment: "" }, 10)).toBeNull();
    expect(buildReviewRequest({ choice: "partial", partialPoints: "4", comment: "" }, 10))
      .toEqual({ outcome: "partial", points: 4 });
  });

  it("rejects a comment over 500 characters", () => {
    expect(buildReviewRequest({ choice: "full", partialPoints: "", comment: "x".repeat(501) }, 10)).toBeNull();
  });
});
