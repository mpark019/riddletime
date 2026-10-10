import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BankPuzzle } from "@/server/puzzles/puzzles";
import { PuzzleTable } from "./admin-puzzle-bank";

function puzzle(status: BankPuzzle["status"], name: string): BankPuzzle {
  return {
    id: `id-${status}`,
    type: "riddle",
    name,
    prompt: "What has keys?",
    acceptedAnswers: ["piano"],
    difficulty: "medium",
    status,
    createdAt: "2030-05-06T00:00:00Z",
    timesUsed: 0,
    stats: {
      daysUsed: 0, assigned: 0, started: 0, finished: 0, solved: 0, missed: 0,
      solveRate: null, medianSolveSeconds: null, averageAttempts: null,
    },
  };
}

describe("PuzzleTable status pills (AC-9)", () => {
  it("labels draft, active, and retired puzzles", () => {
    const html = renderToStaticMarkup(createElement(PuzzleTable, {
      puzzles: [puzzle("draft", "Drafty"), puzzle("active", "Live"), puzzle("retired", "Gone")],
      total: 3, matching: 3, page: 1, pageCount: 1, onPage: () => undefined, onOpen: () => undefined,
    }));

    expect(html).toContain(">Draft<");
    expect(html).toContain(">Active<");
    expect(html).toContain(">Retired<");
  });
});
