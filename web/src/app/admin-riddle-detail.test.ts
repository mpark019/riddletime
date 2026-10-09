import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ScheduledRiddle, ScheduledRiddlePlayer } from "@/server/schedules/schedules";
import { RiddleDashboard } from "./admin-riddle-detail";

const schedule: ScheduledRiddle = {
  id: "s1",
  activeDate: "2026-10-08",
  mode: "shared",
  assignedCount: 1,
  timing: "today",
  type: "riddle",
  difficulty: "standard",
  prompt: "What has keys but no locks?",
  acceptedAnswers: ["piano"],
  timeLimitSeconds: 120,
  maxAttempts: 2,
  scoringPolicy: { base_points: 100, failure_penalty_points: 20, speed_bonuses: [{ under_ms: 30_000, points: 30 }] },
  startedCount: 2,
  finishedCount: 2,
};

function player(overrides: Partial<ScheduledRiddlePlayer>): ScheduledRiddlePlayer {
  return {
    userId: "u",
    displayName: "Pat",
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
    missed: false,
    ...overrides,
  };
}

const solver = player({
  userId: "a",
  displayName: "Sol",
  status: "completed",
  correct: true,
  attempts: 1,
  guesses: [{ response: "piano", correct: true }],
  timeTakenMs: 12_000,
  points: 130,
  breakdown: { basePoints: 100, speedBonusPoints: 30, penaltyPoints: 0 },
});
const failer = player({
  userId: "b",
  displayName: "Fay",
  status: "completed",
  correct: false,
  attempts: 2,
  guesses: [{ response: "drums", correct: false }, { response: "guitar", correct: false }],
  timeTakenMs: 40_000,
  points: -20,
  breakdown: { basePoints: 0, speedBonusPoints: 0, penaltyPoints: 20 },
});
const idle = player({ userId: "c", displayName: "Ida" });

function render(overrides: Partial<ScheduledRiddle> = {}, players = [solver, failer, idle]) {
  return renderToStaticMarkup(createElement(RiddleDashboard, {
    detail: { schedule: { ...schedule, ...overrides }, players },
    appTimezone: "UTC",
    deleting: false,
    onDelete: () => undefined,
  }));
}

describe("RiddleDashboard", () => {
  it("labels the puzzle type and difficulty", () => {
    expect(render()).toContain(">Riddle<");
    expect(render({ type: "character_puzzle" })).toContain(">Letter game<");
    expect(render()).toContain("standard");
  });

  it("shows summary tiles computed from the players", () => {
    const html = render();

    expect(html).toContain("Played");
    expect(html).toContain("of 3 players");
    expect(html).toContain("Solved");
    expect(html).toContain("Failed");
    expect(html).toContain("Avg time");
    expect(html).toContain("0:26");
    expect(html).toContain("Points given");
  });

  it("marks a missed riddle DNF in the same red as a failure", () => {
    const dnf = player({
      userId: "d", displayName: "Dee", status: "completed", correct: false, timeTakenMs: 0, points: -20,
      breakdown: { basePoints: 0, speedBonusPoints: 0, penaltyPoints: 20 }, missed: true,
    });

    const html = render({}, [dnf]);

    expect(html).toMatch(/text-\[#f00000\]">DNF</);
    expect(html).not.toContain(`text-[#f00000]">Failed<`);
  });

  it("lists the rules including each speed bonus tier", () => {
    const html = render();

    expect(html).toContain("Time limit");
    expect(html).toContain("2:00");
    expect(html).toContain("Under 30s");
    expect(html).toContain("+30");
    expect(html).toContain("-20");
  });

  it("omits the speed bonus line when the policy has none", () => {
    expect(render({ scoringPolicy: { base_points: 100 } })).not.toContain("Speed bonuses");
  });

  it("shows one table row per player with the points split and guesses", () => {
    const html = render();

    for (const header of ["Base", "Speed", "Penalty", "Total", "Tries", "Time"]) expect(html).toContain(`>${header}</th>`);
    expect(html).toContain("Sol");
    expect(html).toContain("+130");
    expect(html).toContain("drums");
    expect(html).toContain("guitar");
    expect(html).toContain("1/2");
    expect(html).toContain("2/2");
  });

  it("lists players who did not play as chips", () => {
    const html = render();

    expect(html).toContain("Did not play");
    expect(html).toContain("Ida");
  });

  it("shows an empty state when nobody has played", () => {
    expect(render({}, [idle])).toContain("Nobody has played this riddle yet.");
  });
});

describe("RiddleDashboard on a personal day", () => {
  it("shows each player's own maximum tries instead of a question mark", () => {
    const personal: ScheduledRiddle = { ...schedule, mode: "personal", type: null, difficulty: null, prompt: null, acceptedAnswers: [], timeLimitSeconds: null, maxAttempts: null };
    const html = renderToStaticMarkup(createElement(RiddleDashboard, {
      detail: {
        schedule: personal,
        players: [player({
          userId: "p", displayName: "Pat", status: "completed", correct: true, attempts: 2, timeTakenMs: 38_000,
          puzzle: { type: "riddle", difficulty: "easy", prompt: "test", acceptedAnswers: ["test"], maxAttempts: 3, timeLimitSeconds: 120 },
        })],
      },
      appTimezone: "UTC",
      deleting: false,
      onDelete: () => undefined,
    }));

    expect(html).toContain("2/3");
    expect(html).not.toContain("/?");
  });
});

describe("RiddleDashboard puzzle groups", () => {
  const personal: ScheduledRiddle = { ...schedule, mode: "personal", assignedCount: 3, type: null, difficulty: null, prompt: null, acceptedAnswers: [], timeLimitSeconds: null, maxAttempts: null };
  const puzzle = (type: string, answers: string[]) => ({ type, difficulty: "easy", prompt: "p", acceptedAnswers: answers, maxAttempts: 3, timeLimitSeconds: 120 });
  const html = renderToStaticMarkup(createElement(RiddleDashboard, {
    detail: {
      schedule: personal,
      players: [
        player({ userId: "1", displayName: "test1", status: "completed", correct: true, puzzle: puzzle("riddle", ["test"]) }),
        player({ userId: "2", displayName: "test2", status: "completed", correct: false, puzzle: puzzle("riddle", ["Test"]) }),
        player({ userId: "3", displayName: "test3", status: "completed", correct: true, puzzle: puzzle("character_puzzle", ["TESTTEST"]) }),
      ],
    },
    appTimezone: "UTC",
    deleting: false,
    onDelete: () => undefined,
  }));

  it("shows a bar grouping the same riddle by game type and answer, above the Played table", () => {
    expect(html).toContain("Riddle · test");
    expect(html).toContain("Letter game · TESTTEST");
    expect(html).toContain("2 players");
    expect(html).toContain("3 players");
    expect(html.indexOf('role="tablist"')).toBeLessThan(html.indexOf("Played <span"));
  });

  it("states how many players have a puzzle without calling it a personal day", () => {
    expect(html).toContain("3 players have an assigned puzzle.");
    expect(html).not.toContain("Personal day");
  });
});
