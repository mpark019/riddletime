import { describe, expect, it } from "vitest";
import { addMonths, formatUsDate, monthGrid, parseUsDate } from "./calendar";

describe("monthGrid", () => {
  it("starts on Sunday with leading days and stops after the week holding the last day", () => {
    const weeks = monthGrid(2026, 9);

    expect(weeks).toHaveLength(5);
    expect(weeks[0].map((day) => day.day)).toEqual([27, 28, 29, 30, 1, 2, 3]);
    expect(weeks[0][0]).toEqual({ iso: "2026-09-27", day: 27, inMonth: false });
    expect(weeks[4].map((day) => day.iso)).toEqual([
      "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31",
    ]);
  });

  it("fills trailing days from the next month to complete the last week", () => {
    const lastWeek = monthGrid(2026, 10).at(-1)!;

    expect(lastWeek.map((day) => day.iso)).toEqual([
      "2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05",
    ]);
    expect(lastWeek.map((day) => day.inMonth)).toEqual([true, true, false, false, false, false, false]);
  });

  it("handles a leap-year February", () => {
    expect(monthGrid(2028, 1).flat().filter((day) => day.inMonth)).toHaveLength(29);
  });
});

describe("addMonths", () => {
  it("wraps across year boundaries", () => {
    expect(addMonths(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(addMonths(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });
});

describe("US date text", () => {
  it("formats an ISO date as mm/dd/yyyy", () => {
    expect(formatUsDate("2026-10-07")).toBe("10/07/2026");
    expect(formatUsDate("")).toBe("");
  });

  it("parses typed dates with or without leading zeros", () => {
    expect(parseUsDate("10/07/2026")).toBe("2026-10-07");
    expect(parseUsDate(" 3/5/2027 ")).toBe("2027-03-05");
  });

  it("rejects impossible or malformed dates", () => {
    expect(parseUsDate("02/30/2026")).toBeNull();
    expect(parseUsDate("13/01/2026")).toBeNull();
    expect(parseUsDate("2026-10-07")).toBeNull();
    expect(parseUsDate("")).toBeNull();
  });
});

describe("shiftDay", () => {
  it("moves across month and year boundaries", async () => {
    const { shiftDay } = await import("./calendar");

    expect(shiftDay("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
  });
});
