import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminRiddleScheduler } from "./admin-riddle-scheduler";

describe("AdminRiddleScheduler", () => {
  it("renders the timezone, manual puzzle fields, and failure penalty (AC-6)", () => {
    const html = renderToStaticMarkup(createElement(AdminRiddleScheduler, {
      appTimezone: "America/New_York",
      today: "2030-05-06",
    }));

    expect(html).toContain("Schedule a riddle");
    expect(html).toContain("America/New_York");
    expect(html).toContain("Riddle prompt");
    expect(html).toContain("Accepted answers");
    expect(html).toContain("Failure penalty");
    expect(html).toContain("deducted once only");
    expect(html).toContain('placeholder="mm/dd/yyyy"');
    expect(html).toContain('value="05/06/2030"');
    expect(html).toContain('aria-label="Choose date"');
  });
});
