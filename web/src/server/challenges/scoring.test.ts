import { describe, expect, it } from "vitest";
import { computeResult } from "./scoring";

describe("computeResult", () => {
  it("deducts the configured failure penalty for an incorrect result", () => {
    expect(computeResult(false, 100, [{ underMs: 30000, points: 20 }], 5000, 25)).toEqual({
      base_points: 0,
      speed_bonus_points: null,
      penalty_points: 25,
      total_points: -25,
      bonus_under_ms: null,
    });
  });

  it("keeps older policies penalty-free", () => {
    expect(computeResult(false, 100, [], 5000)).toEqual({
      base_points: 0,
      speed_bonus_points: null,
      penalty_points: 0,
      total_points: 0,
      bonus_under_ms: null,
    });
  });

  it("awards base points with no bonus when no tier applies", () => {
    expect(computeResult(true, 100, [{ underMs: 30000, points: 20 }], 30000)).toEqual({
      base_points: 100,
      speed_bonus_points: null,
      penalty_points: 0,
      total_points: 100,
      bonus_under_ms: null,
    });
  });

  it("applies a bonus strictly under its threshold", () => {
    expect(computeResult(true, 100, [{ underMs: 30000, points: 20 }], 29999)).toEqual({
      base_points: 100,
      speed_bonus_points: 20,
      penalty_points: 0,
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
      penalty_points: 0,
      total_points: 100,
      bonus_under_ms: null,
    });
  });
  describe("hint cost", () => {
    it("subtracts the hint cost from a correct result and records it", () => {
      expect(computeResult(true, 100, [{ underMs: 30000, points: 20 }], 5000, 0, 30)).toEqual({
        base_points: 100,
        speed_bonus_points: 20,
        penalty_points: 0,
        hint_cost_points: 30,
        total_points: 90,
        bonus_under_ms: 30000,
      });
    });

    it("clamps a correct result at zero when the hint costs more than it earned", () => {
      const result = computeResult(true, 100, [], 5000, 0, 150);
      expect(result.total_points).toBe(0);
      expect(result.hint_cost_points).toBe(150);
    });

    it("adds the hint cost to the failure penalty for an incorrect result", () => {
      expect(computeResult(false, 100, [], 5000, 25, 30)).toEqual({
        base_points: 0,
        speed_bonus_points: null,
        penalty_points: 25,
        hint_cost_points: 30,
        total_points: -55,
        bonus_under_ms: null,
      });
    });

    it("charges the hint on an incorrect result even without a failure penalty", () => {
      expect(computeResult(false, 100, [], 5000, 0, 30).total_points).toBe(-30);
    });

    it("keeps an incorrect total inside the database integer range", () => {
      expect(computeResult(false, 100, [], 5000, 2_147_483_647, 30).total_points).toBe(-2_147_483_647);
    });

    it("leaves the breakdown untouched when no hint was used", () => {
      expect(computeResult(true, 100, [], 5000, 0, 0)).not.toHaveProperty("hint_cost_points");
      expect(computeResult(false, 100, [], 5000, 25, 0)).not.toHaveProperty("hint_cost_points");
    });
  });
});
