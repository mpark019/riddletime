import { describe, expect, it } from "vitest";
import type { ScheduledRiddlePlayer } from "@/server/schedules/schedules";
import { groupPlayersByPuzzle } from "./admin-riddle-groups";

function player(userId: string, type: string, answers: string[] | null): ScheduledRiddlePlayer {
  return {
    userId, displayName: userId, status: answers ? "not_started" : "not_assigned", correct: null, attempts: 0, guesses: [],
    startedAt: null, submittedAt: null, timeTakenMs: null, points: null, breakdown: null, missed: false,
    puzzle: answers ? { type, difficulty: "easy", prompt: "p", acceptedAnswers: answers, maxAttempts: 1, timeLimitSeconds: 60 } : null,
  };
}

describe("groupPlayersByPuzzle", () => {
  it("groups players by game type and answer value, ignoring case and order, largest group first", () => {
    const groups = groupPlayersByPuzzle([
      player("a", "riddle", ["Piano", "a piano"]),
      player("b", "character_puzzle", ["TESTTEST"]),
      player("c", "riddle", ["a piano", "piano"]),
      player("d", "riddle", ["echo"]),
      player("e", "riddle", null),
    ]);

    expect(groups.map((group) => group.players.map((p) => p.userId))).toEqual([["a", "c"], ["b"], ["d"]]);
    expect(groups[0]).toMatchObject({ type: "riddle", answers: ["Piano", "a piano"] });
  });

  it("keeps the same answer under different game types apart", () => {
    expect(groupPlayersByPuzzle([player("a", "riddle", ["x"]), player("b", "character_puzzle", ["x"])])).toHaveLength(2);
  });
});
