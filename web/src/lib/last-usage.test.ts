import { describe, expect, it } from "vitest";
import { describeLastUsage, rulesFromLastUsage, type LastUsage } from "./last-usage";

const usage: LastUsage = {
  activeDate: "2026-10-03",
  timeLimitSeconds: 240,
  maxAttempts: 3,
  basePoints: 10,
  failurePenaltyPoints: 15,
  speedBonuses: [{ underMs: 30_000, points: 20 }, { underMs: 60_000, points: 10 }],
};

describe("rulesFromLastUsage", () => {
  it("turns a stored assignment into form values", () => {
    expect(rulesFromLastUsage(usage)).toEqual({
      timeLimitSeconds: "240",
      noTimeLimit: false,
      maxAttempts: "3",
      basePoints: "10",
      failurePenaltyPoints: "15",
      speedBonuses: [{ underSeconds: "30", points: "20" }, { underSeconds: "60", points: "10" }],
    });
  });

  it("marks an untimed assignment as having no time limit", () => {
    expect(rulesFromLastUsage({ ...usage, timeLimitSeconds: null })).toMatchObject({ noTimeLimit: true });
  });
});

describe("describeLastUsage", () => {
  it("summarizes the rules on one line", () => {
    expect(describeLastUsage(usage)).toBe("4m, 3 tries, +10 / -15, 2 speed tiers");
  });

  it("handles no limit, one try and no speed tiers", () => {
    expect(describeLastUsage({ ...usage, timeLimitSeconds: null, maxAttempts: 1, speedBonuses: [] }))
      .toBe("no time limit, 1 try, +10 / -15");
  });

  it("shows seconds that are not whole minutes", () => {
    expect(describeLastUsage({ ...usage, timeLimitSeconds: 90, speedBonuses: [] })).toBe("1m 30s, 3 tries, +10 / -15");
  });
});
