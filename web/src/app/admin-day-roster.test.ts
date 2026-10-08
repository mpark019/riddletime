import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LeaderboardEntry } from "@/server/points/points";
import type { DateAssignment, DateRoster } from "@/server/schedules/schedules";
import { AdminDayRoster } from "./admin-day-roster";

const players = [
  { userId: "a", displayName: "ada", name: "Ada L", totalPoints: 40 },
  { userId: "b", displayName: "bob", name: null, totalPoints: 7 },
  { userId: "c", displayName: "cy", name: null, totalPoints: 0 },
] as LeaderboardEntry[];

function assignment(overrides: Partial<DateAssignment>): DateAssignment {
  return {
    playerId: "a", challengeId: "c1", type: "riddle", difficulty: "easy", prompt: "What has keys?",
    status: "not_started", correct: null, points: null, ...overrides,
  };
}

function render(roster: DateRoster | null, extra: { loadError?: boolean } = {}) {
  return renderToStaticMarkup(createElement(AdminDayRoster, {
    players, roster, loadError: extra.loadError ?? false, removingId: null, onRemove: () => undefined,
  }));
}

describe("AdminDayRoster (AC-8)", () => {
  it("shows each assigned player's puzzle, status, result and total, and lists the rest", () => {
    const html = render({
      scheduleId: "s", mode: "personal",
      assignments: [
        assignment({ playerId: "a", status: "completed", correct: true, points: 100 }),
        assignment({ playerId: "b", challengeId: "c2", type: "character_puzzle", difficulty: "hard", prompt: "Letter game" }),
      ],
    });

    expect(html).toContain("Riddle · easy");
    expect(html).toContain("Letter game · hard");
    expect(html).toContain("Solved (+100)");
    expect(html).toContain("Not started");
    expect(html).toContain("Ada L");
    expect(html).toContain(">40<");
    expect(html).toContain("cy");
    expect(html).toContain("No riddle");
  });

  it("offers a scoped Delete on every assigned player, played or not (AC-10)", () => {
    const html = render({
      scheduleId: "s", mode: "personal",
      assignments: [assignment({ playerId: "a", status: "completed", correct: false, points: -20 }), assignment({ playerId: "b", challengeId: "c2" })],
    });

    expect(html).toContain("Delete puzzle for ada");
    expect(html).toContain("Delete puzzle for bob");
    expect(html).not.toContain("Delete puzzle for cy");
  });

  it("explains a native shared day, an empty day and a load failure", () => {
    expect(render({ scheduleId: "s", mode: "shared", assignments: [assignment({ playerId: null })] })).toContain("Everyone has the shared puzzle");
    const empty = render({ scheduleId: null, mode: null, assignments: [] });
    expect(empty).toContain("ada");
    expect(empty.match(/No riddle/g)?.length).toBeGreaterThanOrEqual(3);
    expect(render(null, { loadError: true })).toContain("Could not load this day");
    expect(render(null)).toContain("Loading this day");
  });
});

describe("summarizeRoster", () => {
  it("counts progress for assigned players and leaves the rest as no puzzle", async () => {
    const { summarizeRoster } = await import("./admin-day-roster");

    expect(summarizeRoster(players, {
      scheduleId: "s", mode: "personal",
      assignments: [
        assignment({ playerId: "a", status: "completed", correct: true }),
        assignment({ playerId: "b", challengeId: "c2", status: "in_progress" }),
      ],
    })).toEqual({ assigned: 2, notStarted: 0, inProgress: 1, solved: 1, failed: 0, noPuzzle: 1 });
  });
});
