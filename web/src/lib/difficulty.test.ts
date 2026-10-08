import { describe, expect, it } from "vitest";
import { DIFFICULTIES, difficultyColor, isDifficulty } from "./difficulty";

describe("difficulty", () => {
  it("offers exactly easy, medium, hard and extreme, each with its own color", () => {
    expect(DIFFICULTIES).toEqual(["easy", "medium", "hard", "extreme"]);
    expect(new Set(DIFFICULTIES.map((name) => difficultyColor(name))).size).toBe(4);
  });

  it("has no color for legacy or missing names", () => {
    expect(isDifficulty("standard")).toBe(false);
    expect(difficultyColor("standard")).toBeUndefined();
    expect(difficultyColor(null)).toBeUndefined();
  });

  it("matches case-insensitively for display", () => {
    expect(difficultyColor("HARD")).toBe(difficultyColor("hard"));
  });
});
