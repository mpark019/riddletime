import { describe, expect, it } from "vitest";
import {
  buildCharacterScheduleRequest,
  buildManualRiddleScheduleRequest,
} from "./admin-riddle-schedule";

describe("buildManualRiddleScheduleRequest", () => {
  it("builds the fixed shared-riddle request with speed and failure penalties", () => {
    expect(buildManualRiddleScheduleRequest({
      activeDate: "2030-05-06",
      difficulty: "standard",
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
        standard: {
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
      selected_difficulty: "standard",
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
      difficulty: "standard",
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
    difficulty: "standard",
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
        standard: {
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
      selected_difficulty: "standard",
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
