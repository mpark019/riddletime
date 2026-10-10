import { describe, expect, it } from "vitest";
import {
  buildBankScheduleRequest,
  buildCharacterScheduleRequest,
  buildManualRiddleScheduleRequest,
} from "./admin-riddle-schedule";

describe("buildManualRiddleScheduleRequest", () => {
  it.each(["standard", "", "EXTREME!"])("rejects the unsupported difficulty %j", (difficulty) => {
    expect(() => buildManualRiddleScheduleRequest({
      activeDate: "2030-05-06",
      difficulty,
      prompt: "What has keys?",
      acceptedAnswers: "piano",
      timeLimitSeconds: "120",
      maxAttempts: "1",
      basePoints: "100",
      failurePenaltyPoints: "0",
      speedBonuses: [],
    })).toThrow("Choose a difficulty.");
  });

  it("builds the fixed shared-riddle request with speed and failure penalties", () => {
    expect(buildManualRiddleScheduleRequest({
      activeDate: "2030-05-06",
      difficulty: "medium",
      prompt: " What has keys? ",
      acceptedAnswers: "piano\n a piano \n\n",
      timeLimitSeconds: "120",
      maxAttempts: "2",
      basePoints: "100",
      failurePenaltyPoints: "25",
      speedBonuses: [
        { underSeconds: "30", points: "20" },
        { underSeconds: "10", points: "50" },
      ],
    })).toEqual({
      active_date: "2030-05-06",
      mode: "shared",
      allowed_types: ["riddle"],
      difficulty_selection: "fixed",
      difficulty_presets: {
        medium: {
          types: {
            riddle: {
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
            },
          },
        },
      },
      selected_difficulty: "medium",
      manual_puzzle: {
        type: "riddle",
        prompt: "What has keys?",
        accepted_answers: ["piano", "a piano"],
      },
    });
  });

  it.each([
    ["blank answers", { acceptedAnswers: "  \n " }],
    ["fractional attempts", { maxAttempts: "1.5" }],
    ["negative penalty", { failurePenaltyPoints: "-1" }],
    ["zero speed threshold", { speedBonuses: [{ underSeconds: "0", points: "10" }] }],
    ["speed threshold equal to the time limit", { speedBonuses: [{ underSeconds: "120", points: "10" }] }],
  ])("rejects %s before sending", (_label, override) => {
    expect(() => buildManualRiddleScheduleRequest({
      activeDate: "2030-05-06",
      difficulty: "medium",
      prompt: "A riddle",
      acceptedAnswers: "answer",
      timeLimitSeconds: "120",
      maxAttempts: "1",
      basePoints: "100",
      failurePenaltyPoints: "20",
      speedBonuses: [],
      ...override,
    })).toThrow();
  });
});

describe("buildCharacterScheduleRequest", () => {
  const form = {
    activeDate: "2030-05-06",
    difficulty: "medium",
    timeLimitSeconds: "180",
    maxAttempts: "6",
    basePoints: "100",
    failurePenaltyPoints: "20",
    speedBonuses: [{ underSeconds: "30", points: "20" }],
    targetWord: " crane7 ",
  };

  it("builds a fixed shared character request carrying the admin's answer", () => {
    expect(buildCharacterScheduleRequest(form)).toEqual({
      active_date: "2030-05-06",
      mode: "shared",
      allowed_types: ["character_puzzle"],
      difficulty_selection: "fixed",
      difficulty_presets: {
        medium: {
          types: {
            character_puzzle: {
              time_limit_seconds: 180,
              max_attempts: 6,
              generation_settings: {},
              config: {},
              scoring_policy: {
                base_points: 100,
                speed_bonuses: [{ under_ms: 30_000, points: 20 }],
                failure_penalty_points: 20,
              },
            },
          },
        },
      },
      selected_difficulty: "medium",
      manual_puzzle: { type: "character_puzzle", target: "CRANE7" },
    });
  });

  it.each([
    ["an empty answer", { targetWord: "   " }],
    ["a space inside", { targetWord: "AB CD" }],
    ["punctuation", { targetWord: "AB-CD" }],
    ["more than 50 characters", { targetWord: "A".repeat(51) }],
    ["attempts above 100", { maxAttempts: "101" }],
    ["a speed tier at the time limit", { speedBonuses: [{ underSeconds: "180", points: "5" }] }],
  ])("rejects %s before sending", (_label, override) => {
    expect(() => buildCharacterScheduleRequest({ ...form, ...override })).toThrow();
  });

  it("accepts exactly 50 characters", () => {
    expect(() => buildCharacterScheduleRequest({ ...form, targetWord: "A1".repeat(25) })).not.toThrow();
  });
});

describe("player targeting", () => {
  const form = {
    activeDate: "2030-05-06",
    difficulty: "easy",
    timeLimitSeconds: "60",
    maxAttempts: "1",
    basePoints: "10",
    failurePenaltyPoints: "0",
    speedBonuses: [],
  };

  it("builds a personal request carrying the selected player ids", () => {
    const riddle = buildManualRiddleScheduleRequest({ ...form, prompt: "Q", acceptedAnswers: "a", playerIds: ["p1", "p2"] });
    const letters = buildCharacterScheduleRequest({ ...form, targetWord: "crane", playerIds: ["p1"] });

    expect(riddle).toMatchObject({ mode: "personal", player_ids: ["p1", "p2"] });
    expect(letters).toMatchObject({ mode: "personal", player_ids: ["p1"] });
  });

  it("requires at least one selected player when targeting", () => {
    expect(() => buildManualRiddleScheduleRequest({ ...form, prompt: "Q", acceptedAnswers: "a", playerIds: [] }))
      .toThrow("Select at least one player.");
    expect(() => buildCharacterScheduleRequest({ ...form, targetWord: "crane", playerIds: [] }))
      .toThrow("Select at least one player.");
  });
});

describe("no time limit", () => {
  const form = {
    activeDate: "2030-05-06",
    difficulty: "medium",
    prompt: "A riddle",
    acceptedAnswers: "answer",
    timeLimitSeconds: null,
    maxAttempts: "1",
    basePoints: "100",
    failurePenaltyPoints: "20",
    speedBonuses: [{ underSeconds: "600", points: "10" }],
  };

  it("sends a null time limit and keeps speed tiers of any length", () => {
    const request = buildManualRiddleScheduleRequest(form);
    const settings = request.difficulty_presets.medium.types.riddle;
    expect(settings.time_limit_seconds).toBeNull();
    expect(settings.scoring_policy.speed_bonuses).toEqual([{ under_ms: 600_000, points: 10 }]);
  });
});

describe("buildBankScheduleRequest", () => {
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

  it("applies the same character attempt limit as writing a new letter game", () => {
    expect(() => buildBankScheduleRequest({ ...rules, kind: "character_puzzle", puzzleId, maxAttempts: "101" })).toThrow();
  });
});
