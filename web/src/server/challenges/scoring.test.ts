import { describe, expect, it } from "vitest";
import { computeResult } from "./scoring";

describe("computeResult", () => {
  it("awards zero for an incorrect result", () => {
    expect(computeResult(false, 100, [{ underMs: 30000, points: 20 }], 5000)).toEqual({
      base_points: 0,
      speed_bonus_points: null,
      total_points: 0,
      bonus_under_ms: null,
    });
  });

  it("awards base points with no bonus when no tier applies", () => {
    expect(computeResult(true, 100, [{ underMs: 30000, points: 20 }], 30000)).toEqual({
      base_points: 100,
      speed_bonus_points: null,
      total_points: 100,
      bonus_under_ms: null,
    });
  });

  it("applies a bonus strictly under its threshold", () => {
    expect(computeResult(true, 100, [{ underMs: 30000, points: 20 }], 29999)).toEqual({
      base_points: 100,
      speed_bonus_points: 20,
      total_points: 120,
      bonus_under_ms: 30000,
    });
  });

  it("does not stack bonuses; picks the highest applicable one", () => {
    const bonuses = [
      { underMs: 30000, points: 20 },
      { underMs: 10000, points: 50 },
    ];
    expect(computeResult(true, 100, bonuses, 5000).total_points).toBe(150);
  });

  it("handles a basic riddle with no configured bonuses", () => {
    expect(computeResult(true, 100, [], 5000)).toEqual({
      base_points: 100,
      speed_bonus_points: null,
      total_points: 100,
      bonus_under_ms: null,
    });
  });
});
