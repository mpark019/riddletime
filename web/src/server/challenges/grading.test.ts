import { describe, expect, it } from "vitest";
import { gradeRiddle, normalizeAnswer } from "./grading";

describe("normalizeAnswer", () => {
  it("lowercases, trims, and strips punctuation", () => {
    expect(normalizeAnswer("  A Piano!  ")).toBe("a piano");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeAnswer("a   piano")).toBe("a piano");
  });
});

describe("gradeRiddle", () => {
  const accepted = ["piano", "a piano"];

  it("accepts an exact match after normalization", () => {
    expect(gradeRiddle("A Piano!", accepted)).toBe(true);
  });

  it("accepts a differently-punctuated equivalent answer", () => {
    expect(gradeRiddle("piano.", accepted)).toBe(true);
  });

  it("rejects a wrong answer", () => {
    expect(gradeRiddle("guitar", accepted)).toBe(false);
  });
});
