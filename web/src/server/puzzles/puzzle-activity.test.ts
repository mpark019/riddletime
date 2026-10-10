import { describe, expect, it } from "vitest";
import { summarizeRuleSets, type PlayOutcome, type PuzzlePlay, type PuzzleRules } from "./puzzle-activity";

const quick: PuzzleRules = { maxAttempts: 3, timeLimitSeconds: 60, basePoints: 100, failurePenaltyPoints: 20, speedBonuses: [] };
const relaxed: PuzzleRules = { maxAttempts: 6, timeLimitSeconds: null, basePoints: 100, failurePenaltyPoints: 20, speedBonuses: [] };

function play(rules: PuzzleRules, outcome: PlayOutcome, attempts: number | null = null, seconds: number | null = null): PuzzlePlay {
  return {
    playerId: crypto.randomUUID(), playerName: "p", date: "2026-10-10", outcome, attempts,
    timeTakenMs: seconds === null ? null : seconds * 1000, points: null, rules,
  };
}

describe("summarizeRuleSets", () => {
  it("reports each rule set on its own, with rates over finished games only", () => {
    const sets = summarizeRuleSets([
      play(quick, "solved", 1, 10),
      play(quick, "solved", 3, 30),
      play(quick, "failed", 3, 60),
      play(quick, "missed"),
      play(quick, "in_progress", 1),
      play(quick, "not_started"),
      play(relaxed, "failed", 6, 200),
    ]);

    expect(sets).toHaveLength(2);
    expect(sets[0]).toMatchObject({
      ...quick, daysUsed: 1, assigned: 6, started: 4, finished: 3, solved: 2, failed: 1, missed: 1,
      solveRate: 2 / 3, medianSolveSeconds: 20, averageAttempts: 7 / 3,
    });
    expect(sets[1]).toMatchObject({ ...relaxed, assigned: 1, finished: 1, solved: 0, solveRate: 0, medianSolveSeconds: null });
  });

  it("treats different speed bonuses as different rule sets", () => {
    const bonus: PuzzleRules = { ...quick, speedBonuses: [{ underMs: 30_000, points: 20 }] };
    expect(summarizeRuleSets([play(quick, "solved", 1, 10), play(bonus, "solved", 1, 10)])).toHaveLength(2);
  });

  it("returns nothing for a puzzle with no plays", () => {
    expect(summarizeRuleSets([])).toEqual([]);
  });

  it("keeps unfinished sets at a null rate", () => {
    const [set] = summarizeRuleSets([play(quick, "not_started"), play(quick, "did_not_play")]);
    expect(set).toMatchObject({ assigned: 2, started: 0, finished: 0, solveRate: null, averageAttempts: null });
  });
});
