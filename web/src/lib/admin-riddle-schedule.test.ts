import { describe, expect, it } from "vitest";
import { buildManualRiddleScheduleRequest } from "./admin-riddle-schedule";

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
