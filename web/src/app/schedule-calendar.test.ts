import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ScheduledRiddle } from "@/server/schedules/schedules";
import { ScheduleCalendar } from "./schedule-calendar";

function day(activeDate: string, overrides: Partial<ScheduledRiddle>): ScheduledRiddle {
  return { id: activeDate, activeDate, mode: "personal", assignedCount: 1, timing: "upcoming", ...overrides } as ScheduledRiddle;
}

describe("ScheduleCalendar", () => {
  it("marks days with puzzles as full or partial coverage and leaves empty days unmarked", () => {
    const html = renderToStaticMarkup(createElement(ScheduleCalendar, {
      value: "2030-05-06",
      today: "2030-05-06",
      playerCount: 3,
      onSelect: () => undefined,
      days: [day("2030-05-07", { assignedCount: 3 }), day("2030-05-08", { assignedCount: 1 }), day("2030-05-09", { mode: "shared", assignedCount: 1 })],
    }));

    expect(html).toContain("May 2030");
    expect(html).toContain("Tuesday, May 7, 2030, puzzles assigned to everyone");
    expect(html).toContain("Wednesday, May 8, 2030, puzzles assigned to some players");
    expect(html).toContain("Thursday, May 9, 2030, puzzles assigned to everyone");
    expect(html).toContain("Friday, May 10, 2030, no puzzle");
    expect(html).toMatch(/aria-label="Monday, May 6, 2030[^"]*" aria-pressed="true"/);
  });
});
