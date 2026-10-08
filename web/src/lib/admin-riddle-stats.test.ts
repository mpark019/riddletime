import { describe, expect, it } from "vitest";
import type { ScheduledRiddlePlayer } from "@/server/schedules/schedules";
import { summarizePlayers } from "./admin-riddle-stats";

function player(overrides: Partial<ScheduledRiddlePlayer>): ScheduledRiddlePlayer {
  return {
    userId: "u",
    displayName: "P",
    status: "not_started",
    puzzle: null,
    correct: null,
    attempts: 0,
    guesses: [],
    startedAt: null,
    submittedAt: null,
    timeTakenMs: null,
    points: null,
    breakdown: null,
    ...overrides,
  };
}

describe("summarizePlayers", () => {
  it("returns zeros and no average for an empty roster", () => {
    expect(summarizePlayers([])).toEqual({
      total: 0, played: 0, solved: 0, failed: 0, inProgress: 0, averageTimeMs: null, pointsGiven: 0,
    });
  });

  it("counts played, solved, failed, and in-progress players", () => {
    const stats = summarizePlayers([
      player({ status: "completed", correct: true, timeTakenMs: 10_000, points: 120 }),
      player({ status: "completed", correct: false, timeTakenMs: 30_000, points: -20 }),
      player({ status: "in_progress" }),
      player({ status: "expired" }),
      player({ status: "not_started" }),
    ]);

    expect(stats).toMatchObject({ total: 5, played: 4, solved: 1, failed: 1, inProgress: 2 });
  });

  it("averages time and sums points over finished players only", () => {
    const stats = summarizePlayers([
      player({ status: "completed", correct: true, timeTakenMs: 10_000, points: 120 }),
      player({ status: "completed", correct: false, timeTakenMs: 30_000, points: -20 }),
      player({ status: "in_progress", points: null }),
    ]);

    expect(stats.averageTimeMs).toBe(20_000);
    expect(stats.pointsGiven).toBe(100);
  });
});

describe("summarizePlayers with unassigned players", () => {
  it("leaves players without a puzzle out of the totals", () => {
    const stats = summarizePlayers([
      player({ status: "not_assigned" }),
      player({ status: "not_started" }),
      player({ status: "completed", correct: true, timeTakenMs: 1000 }),
    ]);

    expect(stats).toMatchObject({ total: 2, played: 1, solved: 1 });
  });
});
