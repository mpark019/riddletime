import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminRiddleScheduler } from "./admin-riddle-scheduler";

describe("AdminRiddleScheduler", () => {
  it("renders the timezone, manual puzzle fields, and failure penalty (AC-6)", () => {
    const html = renderToStaticMarkup(createElement(AdminRiddleScheduler, {
      appTimezone: "America/New_York",
      today: "2030-05-06",
      players: [],
    }));

    expect(html).toContain("Schedule a riddle");
    expect(html).toContain("Calendar");
    expect(html).toContain("All days");
    expect(html).toContain("America/New_York");
    expect(html).toContain("Riddle prompt");
    expect(html).toContain("Accepted answers");
    expect(html).toContain("Failure penalty");
    expect(html).toContain("deducted once only");
    expect(html).toContain("May 2030");
    expect(html).toContain('aria-label="Previous month"');
    expect(html).toContain("05/06/2030");
  });

  it("offers both puzzle types with the riddle fields selected first", () => {
    const html = renderToStaticMarkup(createElement(AdminRiddleScheduler, {
      appTimezone: "UTC",
      today: "2030-05-06",
      players: [],
    }));

    expect(html).toContain('aria-label="Puzzle type"');
    expect(html).toContain("Letter game");
    expect(html).not.toContain("Allowed characters");
  });
});

describe("AdminRiddleScheduler player targeting", () => {
  it("offers a searchable multi-select player picker with no mode toggle (AC-7)", () => {
    const html = renderToStaticMarkup(createElement(AdminRiddleScheduler, {
      appTimezone: "America/New_York",
      today: "2030-05-06",
      players: [
        { userId: "p1", displayName: "ada", name: "Ada L", totalPoints: 10 },
        { userId: "p2", displayName: "bob", totalPoints: 5 },
      ] as never,
    }));

    expect(html).not.toContain("Personal");
    expect(html).not.toContain("Shared");
    expect(html).toContain("Search players");
    expect(html).toContain("Select all (2)");
    expect(html).toContain("ada");
    expect(html).toContain("bob");
    expect(html).toContain("Nobody selected yet.");
  });
});
