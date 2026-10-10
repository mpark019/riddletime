import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BankPuzzle } from "@/server/puzzles/puzzles";
import { PuzzleDetails, PuzzleTable } from "./admin-puzzle-bank";

function puzzle(status: BankPuzzle["status"], name: string): BankPuzzle {
  return {
    id: `id-${status}`,
    type: "riddle",
    name,
    prompt: "What has keys?",
    acceptedAnswers: ["piano"],
    maxImages: null,
    promptImageUrl: null,
    promptImagePath: null,
    difficulty: "medium",
    status,
    createdAt: "2030-05-06T00:00:00Z",
    createdBy: null,
    createdByName: "Pat Lee",
    timesUsed: 0,
    stats: {
      daysUsed: 0, assigned: 0, started: 0, finished: 0, solved: 0, missed: 0,
      solveRate: null, medianSolveSeconds: null, averageAttempts: null,
    },
    lastUsage: null,
  };
}

describe("PuzzleTable status pills (AC-9)", () => {
  it("labels draft, active, and retired puzzles", () => {
    const html = renderToStaticMarkup(createElement(PuzzleTable, {
      puzzles: [puzzle("draft", "Drafty"), puzzle("active", "Live"), puzzle("retired", "Gone")],
      total: 3, matching: 3, page: 1, pageCount: 1, onPage: () => undefined, onOpen: () => undefined,
    }));

    expect(html).toMatch(/max-sm:text-right[^>]*>Type</);
    expect(html).not.toContain(">Used<");
    expect(html).toContain(">Solve rate<");
    expect(html).toContain(">Draft<");
    expect(html).toContain(">Active<");
    expect(html).toContain(">Retired<");
  });
});

describe("puzzle author", () => {
  const noop = () => undefined;

  it("shows who made a puzzle in the bank table and the detail panel", () => {
    const table = renderToStaticMarkup(createElement(PuzzleTable, {
      puzzles: [puzzle("draft", "Drafty")], total: 1, matching: 1, page: 1, pageCount: 1,
      onPage: noop, onOpen: noop, showCreator: true,
    }));
    expect(table).toContain("Created by");
    expect(table).toContain("Pat Lee");

    const details = renderToStaticMarkup(createElement(PuzzleDetails, {
      puzzle: puzzle("draft", "Drafty"), busy: false, canManage: true,
      onEdit: noop, onStatus: noop, onRename: noop, onDelete: noop,
    }));
    expect(details).toContain("Created by:");
    expect(details).toContain("Pat Lee");
  });

  it("leaves the author column out of the scheduling picker and says Unknown when there is no name", () => {
    const picker = renderToStaticMarkup(createElement(PuzzleTable, {
      puzzles: [puzzle("active", "Live")], total: 1, matching: 1, page: 1, pageCount: 1,
      onPage: noop, onOpen: noop, hideStatus: true,
    }));
    expect(picker).not.toContain("Created by");

    const unnamed = renderToStaticMarkup(createElement(PuzzleDetails, {
      puzzle: { ...puzzle("draft", "Drafty"), createdByName: null }, busy: false, canManage: true,
      onEdit: noop, onStatus: noop, onRename: noop, onDelete: noop,
    }));
    expect(unnamed).toContain("Unknown");
  });
});

describe("PuzzleDetails controls by role (AC-9)", () => {
  const noop = () => undefined;
  const render = (status: BankPuzzle["status"], canManage: boolean) => renderToStaticMarkup(createElement(PuzzleDetails, {
    puzzle: puzzle(status, "Sample"), busy: false, canManage, onEdit: noop, onStatus: noop, onRename: noop, onDelete: noop,
  }));

  it("gives a spectator Edit and rename on a draft and nothing that changes status or deletes", () => {
    const html = render("draft", false);
    expect(html).toContain(">Edit<");
    expect(html).toContain("Save name");
    for (const hidden of ["Publish", "Retire", "Restore", "Move to draft", "Delete"]) expect(html).not.toContain(hidden);
  });

  it.each(["active", "retired"] as const)("gives a spectator no Edit or rename on a %s puzzle", (status) => {
    const html = render(status, false);
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain("Save name");
    expect(html).toContain("Only drafts can be edited");
  });

  it("keeps the admin controls for admins", () => {
    const html = render("draft", true);
    expect(html).toContain(">Edit<");
    expect(html).toContain("Publish");
    expect(html).toContain("Retire");
    expect(html).toContain("Delete");
  });
});
