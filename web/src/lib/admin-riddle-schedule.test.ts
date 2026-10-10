import { describe, expect, it } from "vitest";
import { buildBankScheduleRequest } from "./admin-riddle-schedule";

const rules = {
  activeDate: "2030-05-06",
  difficulty: "hard",
  timeLimitSeconds: "90",
  maxAttempts: "2",
  basePoints: "100",
  failurePenaltyPoints: "20",
  speedBonuses: [],
};
const puzzleId = "6f1c2d3e-0000-4000-8000-000000000001";

describe("buildBankScheduleRequest", () => {
  it("sends puzzle_id and no manual_puzzle for a shared riddle", () => {
    const request = buildBankScheduleRequest({ ...rules, kind: "riddle", puzzleId });
    expect(request).toMatchObject({
      active_date: "2030-05-06",
      mode: "shared",
      allowed_types: ["riddle"],
      selected_difficulty: "hard",
      puzzle_id: puzzleId,
    });
    expect(request).not.toHaveProperty("manual_puzzle");
    expect(request.difficulty_presets.hard.types).toHaveProperty("riddle");
  });

  it("builds the fixed request with speed bonuses and a failure penalty", () => {
    const request = buildBankScheduleRequest({
      ...rules,
      kind: "riddle",
      puzzleId,
      difficulty: "medium",
      timeLimitSeconds: "120",
      failurePenaltyPoints: "25",
      speedBonuses: [
        { underSeconds: "30", points: "20" },
        { underSeconds: "10", points: "50" },
      ],
    });
    expect(request.difficulty_presets.medium.types.riddle).toEqual({
      time_limit_seconds: 120,
      max_attempts: 2,
      generation_settings: {},
      config: {},
      scoring_policy: {
        base_points: 100,
        speed_bonuses: [
          { under_ms: 30_000, points: 20 },
          { under_ms: 10_000, points: 50 },
        ],
        failure_penalty_points: 25,
      },
    });
  });

  it("targets the selected players and the letter-game preset for personal letter games", () => {
    const request = buildBankScheduleRequest({
      ...rules, kind: "character_puzzle", puzzleId, playerIds: ["a", "b"], maxAttempts: "6",
    });
    expect(request).toMatchObject({ mode: "personal", player_ids: ["a", "b"], allowed_types: ["character_puzzle"] });
    expect(request.difficulty_presets.hard.types).toHaveProperty("character_puzzle");
  });

  it("requires a puzzle and at least one player when players are being chosen", () => {
    expect(() => buildBankScheduleRequest({ ...rules, kind: "riddle", puzzleId: "" })).toThrow("Choose a puzzle from the bank.");
    expect(() => buildBankScheduleRequest({ ...rules, kind: "riddle", puzzleId, playerIds: [] })).toThrow("Select at least one player.");
  });

  it.each(["standard", "", "EXTREME!"])("rejects the unsupported difficulty %j", (difficulty) => {
    expect(() => buildBankScheduleRequest({ ...rules, kind: "riddle", puzzleId, difficulty })).toThrow("Choose a difficulty.");
  });

  it.each([
    ["fractional attempts", { maxAttempts: "1.5" }],
    ["negative penalty", { failurePenaltyPoints: "-1" }],
    ["zero speed threshold", { speedBonuses: [{ underSeconds: "0", points: "10" }] }],
    ["speed threshold equal to the time limit", { speedBonuses: [{ underSeconds: "90", points: "10" }] }],
  ])("rejects %s before sending", (_label, override) => {
    expect(() => buildBankScheduleRequest({ ...rules, kind: "riddle", puzzleId, ...override })).toThrow();
  });

  it("applies the letter-game attempt limit", () => {
    expect(() => buildBankScheduleRequest({ ...rules, kind: "character_puzzle", puzzleId, maxAttempts: "101" })).toThrow();
    expect(() => buildBankScheduleRequest({ ...rules, kind: "character_puzzle", puzzleId, maxAttempts: "100" })).not.toThrow();
  });

  it("sends a null time limit and keeps speed tiers of any length", () => {
    const request = buildBankScheduleRequest({
      ...rules, kind: "riddle", puzzleId, timeLimitSeconds: null, speedBonuses: [{ underSeconds: "600", points: "10" }],
    });
    const settings = request.difficulty_presets.hard.types.riddle as {
      time_limit_seconds: number | null;
      scoring_policy: { speed_bonuses: unknown[] };
    };
    expect(settings.time_limit_seconds).toBeNull();
    expect(settings.scoring_policy.speed_bonuses).toEqual([{ under_ms: 600_000, points: 10 }]);
  });
});
