import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlayerChallengeState } from "@/lib/challenge-state";
import { CompletedRiddle, NotStartedRiddle, RiddleStakes, StaffPlayerRiddles, StaffRiddleView } from "./riddle-game";

type Completed = Extract<PlayerChallengeState, { status: "completed" }>;

function completed(correct: boolean, breakdown: Partial<Completed["result"]["scoringBreakdown"]>): Completed {
  return {
    status: "completed",
    submissionId: "s",
    challengeId: "c",
    type: "riddle",
    difficulty: "standard",
    prompt: "2 + 2 ?",
    startedAt: "2026-10-07T12:00:00.000Z",
    deadline: "2026-10-07T12:02:00.000Z",
    serverTime: "2026-10-07T12:01:00.000Z",
    timeLimitSeconds: 120,
    maxAttempts: 2,
    attempts: 2,
    attemptsRemaining: 0,
    guessHistory: [],
    feedback: null,
    scoringPolicy: { base_points: 100 },
    result: {
      correct,
      timeTakenMs: 5_000,
      scoringBreakdown: {
        base_points: 0,
        speed_bonus_points: null,
        penalty_points: 0,
        total_points: 0,
        bonus_under_ms: null,
        ...breakdown,
      },
    },
  };
}

function render(play: Completed) {
  return renderToStaticMarkup(createElement(CompletedRiddle, { play }));
}

// The surface class forces its own text color, so the tone color must sit on the number itself.
function valueClasses(html: string, label: string) {
  return new RegExp(`${label}</p><p[^>]*class="([^"]*)"`).exec(html)?.[1] ?? "";
}

function tone(html: string, label: string) {
  return new RegExp(`data-tone="(\\w+)"><p[^>]*>${label}</p>`).exec(html)?.[1];
}

describe("CompletedRiddle for a letter game", () => {
  it("labels it Letter game and does not show the stored instruction sentence", () => {
    const html = render({
      ...completed(false, { penalty_points: 20, total_points: -20 }),
      type: "character_puzzle",
      prompt: "Guess the 8-character code using letters A-Z and digits 0-9.",
      config: { target_length: 3, character_set: "ABC" },
      guessHistory: [{ response: "ABC", correct: false, feedback: ["absent", "absent", "absent"] }],
    });

    expect(html).toContain("Letter game");
    expect(html).not.toContain("Guess the");
    expect(html).not.toContain(">Code<");
  });

  it("keeps the Riddle label and prompt for riddles", () => {
    const html = render(completed(true, { base_points: 100, total_points: 100 }));

    expect(html).toContain(">Riddle<");
    expect(html).toContain("2 + 2 ?");
    expect(html).not.toContain("Letter game");
  });
});

describe("CompletedRiddle", () => {
  it("shows a SUCCESS stamp and green positive numbers for a solved riddle", () => {
    const html = render(completed(true, { base_points: 100, speed_bonus_points: 50, total_points: 150 }));

    expect(html).toContain('aria-label="Success"');
    expect(html).toContain("SUCCESS");
    expect(html).not.toContain("FAIL");
    expect(tone(html, "Base points")).toBe("positive");
    expect(tone(html, "Speed bonus")).toBe("positive");
    expect(tone(html, "Total points")).toBe("positive");
  });

  it("shows a FAIL stamp and red negative numbers for a failed riddle", () => {
    const html = render(completed(false, { penalty_points: 20, total_points: -20 }));

    expect(html).toContain('aria-label="Fail"');
    expect(html).toContain("FAIL");
    expect(html).not.toContain("SUCCESS");
    expect(tone(html, "Penalty")).toBe("negative");
    expect(tone(html, "Total points")).toBe("negative");
  });

  it("shows the points as bare numbers with no navy box or bordered grid", () => {
    const html = render(completed(true, { base_points: 100, total_points: 100 }));

    expect(html).not.toContain("navy-surface");
    expect(html).not.toContain("gap-px");
    expect(html).not.toContain("overflow-hidden");
  });

  it("reports a solve with the time taken and tries used", () => {
    const html = render({ ...completed(true, { base_points: 100, total_points: 100 }), attempts: 2, maxAttempts: 3 });

    expect(html).toContain("Results · standard · 2:00");
    expect(html).toContain(">Solved</h3>");
    expect(html).toContain("2 of 3 tries used · 0:05");
    expect(html).not.toContain("nice job");
  });

  it("reports running out of tries", () => {
    const html = render({ ...completed(false, { penalty_points: 20, total_points: -20 }), attempts: 2, maxAttempts: 2 });

    expect(html).toContain("Results · standard · 2:00");
    expect(html).toContain(">Out of tries</h3>");
    expect(html).toContain("2 of 2 tries used · 0:05");
    expect(html).not.toContain("you cant do nathan");
  });

  it("reports running out of time when tries remain", () => {
    const html = render({ ...completed(false, { penalty_points: 20, total_points: -20 }), attempts: 1, maxAttempts: 3 });

    expect(html).toContain("Results · standard · 2:00");
    expect(html).toContain(">Time ran out</h3>");
    expect(html).toContain("1 of 3 tries used · 0:05");
  });

  it("uses the singular for a single try", () => {
    const html = render({ ...completed(true, { base_points: 100, total_points: 100 }), attempts: 1, maxAttempts: 1 });

    expect(html).toContain("1 of 1 try used · 0:05");
  });

  it("leaves zero values neutral", () => {
    const html = render(completed(false, { penalty_points: 20, total_points: -20 }));

    expect(tone(html, "Base points")).toBe("zero");
    expect(tone(html, "Speed bonus")).toBe("zero");
  });

  it("shows FAIL with a neutral zero total when there is no penalty", () => {
    const html = render(completed(false, {}));

    expect(html).toContain("FAIL");
    expect(tone(html, "Total points")).toBe("zero");
  });

  it("puts the tone color on the number so the surface text color cannot override it", () => {
    const html = render(completed(false, { penalty_points: 20, total_points: -20 }));

    expect(valueClasses(html, "Penalty")).toContain("text-[#f00000]");
    expect(valueClasses(html, "Total points")).toContain("text-[#f00000]");
    expect(valueClasses(html, "Base points")).toContain("text-white");

    const solved = render(completed(true, { base_points: 100, speed_bonus_points: 50, total_points: 150 }));
    expect(valueClasses(solved, "Base points")).toContain("text-[#00940a]");
    expect(valueClasses(solved, "Speed bonus")).toContain("text-[#00940a]");
  });
});

describe("RiddleStakes", () => {
  function stakes(policy: Parameters<typeof RiddleStakes>[0]["policy"], pressure?: number) {
    return renderToStaticMarkup(createElement(RiddleStakes, { policy, pressure }));
  }

  it("shows only the reward and the failure penalty, not the speed bonus", () => {
    const html = stakes({
      base_points: 100,
      speed_bonuses: [{ under_ms: 30_000, points: 20 }, { under_ms: 50_000, points: 10 }],
      failure_penalty_points: 20,
    });

    expect(tone(html, "Correct answer")).toBe("positive");
    expect(html).toContain("+100");
    expect(tone(html, "If you fail")).toBe("negative");
    expect(html).toContain("-20");
    expect(html).toContain("Out of tries or time");
    expect(html).not.toContain("Speed bonus");
  });

  it("omits the penalty cell when the riddle has none", () => {
    const html = stakes({ base_points: 50 });

    expect(html).toContain("+50");
    expect(html).not.toContain("If you fail");
  });

  it("colors the number itself so the surface text color cannot override it", () => {
    const html = stakes({ base_points: 100, failure_penalty_points: 20 });

    expect(valueClasses(html, "Correct answer")).toContain("text-[#00940a]");
    expect(valueClasses(html, "If you fail")).toContain("text-[#f00000]");
  });

  function scales(html: string) {
    return [...html.matchAll(/--stake-scale:([\d.]+)/g)].map((match) => match[1]);
  }

  const policy = { base_points: 100, failure_penalty_points: 20 };

  it("starts both numbers at normal size and still", () => {
    const html = stakes(policy, 0);

    expect(scales(html)).toEqual(["1.000", "1.000"]);
    expect(html).not.toContain("stake-shake");
  });

  it("shrinks the reward and swells the penalty over it as pressure builds, keeping the amounts", () => {
    const half = stakes(policy, 0.5);
    const full = stakes(policy, 1);

    expect(scales(half)).toEqual(["0.650", "1.875"]);
    expect(scales(full)).toEqual(["0.300", "4.500"]);
    expect(full).toContain("+100");
    expect(full).toContain("-20");
    expect(full).toContain("pointer-events-none");
  });

  it("shakes only the penalty, harder and faster as pressure rises", () => {
    expect(stakes(policy, 0.5)).not.toContain("stake-shake");

    const mid = stakes(policy, 0.75);
    expect(mid.match(/stake-shake/g)).toHaveLength(1);
    expect(mid).toContain("--shake:3.5px");
    expect(mid).toContain("--shake-duration:0.325s");

    const full = stakes(policy, 1);
    expect(full).toContain("--shake:7px");
    expect(full).toContain("--shake-duration:0.15s");
  });

  it("clamps the pressure to its range", () => {
    expect(scales(stakes(policy, 4))).toEqual(["0.300", "4.500"]);
    expect(scales(stakes(policy, -1))).toEqual(["1.000", "1.000"]);
  });

  it("shrinks the reward even when there is no penalty cell", () => {
    expect(scales(stakes({ base_points: 50 }, 1))).toEqual(["0.300"]);
  });

  it("sits directly on the page without a card or navy box around it", () => {
    const html = stakes({ base_points: 100, failure_penalty_points: 20 });

    expect(html).not.toContain("navy-surface");
    expect(html).not.toContain("border");
    expect(html).not.toContain("overflow-hidden");
  });
});

describe("NotStartedRiddle", () => {
  function render(play: {
    available: boolean;
    difficulty: string | null;
    type?: "riddle" | "character_puzzle";
    targetLength?: number;
    scoringPolicy?: { base_points: number; failure_penalty_points?: number };
  }) {
    return renderToStaticMarkup(createElement(NotStartedRiddle, {
      play: { status: "not_started", ...play },
      busy: false,
      error: null,
      onStart: () => undefined,
    }));
  }

  it("shows the difficulty level instead of the generic prompt", () => {
    const html = render({ available: true, difficulty: "hard" });

    expect(html).toContain("hard");
    expect(html).not.toContain("Ready when you are");
    expect(html).toContain("Start riddle");
  });

  it("shows the winnable points and the failure penalty before the game starts", () => {
    const html = render({ available: true, difficulty: "hard", scoringPolicy: { base_points: 100, failure_penalty_points: 20 } });

    expect(html).toContain("+100");
    expect(html).toContain("-20");
  });

  it("omits the stakes when no scoring policy is available", () => {
    const html = render({ available: true, difficulty: "hard" });

    expect(html).not.toContain("Correct answer");
  });

  it("names the game type and labels the Start button to match", () => {
    const riddle = render({ available: true, difficulty: "hard", type: "riddle" });
    expect(riddle).toContain("Daily challenge");
    expect(riddle).toContain("Riddle");
    expect(riddle).toContain("Start riddle");

    const letters = render({ available: true, difficulty: "hard", type: "character_puzzle", targetLength: 5 });
    expect(letters).toContain("Letter game");
    expect(letters).toContain("Start letter game");
    expect(letters).not.toContain("Start riddle");
  });

  it.each([
    ["a riddle", { type: "riddle" as const }],
    ["a letter game of 10 letters", { type: "character_puzzle" as const, targetLength: 10 }],
    ["a letter game of unknown length", { type: "character_puzzle" as const }],
  ])("shows no laptop advice for %s", (_label, extra) => {
    expect(render({ available: true, difficulty: "hard", ...extra })).not.toContain("laptop");
  });

  it("advises a laptop for a letter game above 10 letters and says how long it is", () => {
    const html = render({ available: true, difficulty: "hard", type: "character_puzzle", targetLength: 11 });

    expect(html).toContain("11 letters");
    expect(html).toContain("laptop");
  });

  it("falls back to a neutral heading when the difficulty is unknown", () => {
    const html = render({ available: false, difficulty: null });

    expect(html).toContain("Ready when you are?");
    expect(html).toContain("has not been published yet");
  });
});

describe("StaffRiddleView", () => {
  const base = {
    difficulty: "hard",
    prompt: "What has keys but no locks?",
    timeLimitSeconds: 120,
    maxAttempts: 3,
    scoringPolicy: { base_points: 100, failure_penalty_points: 20 },
  };
  const riddleHtml = renderToStaticMarkup(createElement(StaffRiddleView, {
    preview: { ...base, type: "riddle", speedBonuses: [{ under_ms: 30000, points: 50 }] },
  }));
  const letterHtml = renderToStaticMarkup(createElement(StaffRiddleView, {
    preview: { ...base, type: "character_puzzle", config: { target_length: 5, character_set: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" } },
  }));

  it("shows the same prompt, timer, tries, stakes and speed tiers a player sees (AC-1, AC-2)", () => {
    expect(riddleHtml).toContain("What has keys but no locks?");
    expect(riddleHtml).toContain("2:00");
    expect(riddleHtml).toContain("3/3");
    expect(riddleHtml).toContain("+100");
    expect(riddleHtml).toContain("-20");
    expect(riddleHtml).toContain("Under 30s");
    expect(riddleHtml).toContain("+50");
  });

  it("shows the empty letter board and keyboard for a letter game", () => {
    expect(letterHtml).toContain("Letter game");
    expect(letterHtml).toContain('aria-label="Keyboard"');
  });

  it("offers no enabled way to start or answer (AC-6)", () => {
    for (const html of [riddleHtml, letterHtml]) {
      const controls = html.match(/<(button|input)\b[^>]*>/g) ?? [];
      expect(controls.length).toBeGreaterThan(0);
      expect(controls.every((control) => control.includes("disabled"))).toBe(true);
      expect(html).not.toContain("<form");
    }
  });
});

describe("StaffPlayerRiddles (AC-11)", () => {
  const puzzle = { type: "riddle" as const, difficulty: "easy", maxAttempts: 2, timeLimitSeconds: 90 };
  const base = { name: null, attempts: 0, timeTakenMs: null, points: null };
  const players = [
    { ...base, userId: "b", displayName: "bob", puzzle: null, status: "no_riddle" as const },
    { ...base, userId: "a", displayName: "ada", puzzle, status: "solved" as const, attempts: 1, timeTakenMs: 42_000, points: 120 },
    { ...base, userId: "c", displayName: "cy", puzzle, status: "not_started" as const },
  ];

  it("shows a pill with a status per player and opens on the first player who has a riddle", () => {
    const html = renderToStaticMarkup(createElement(StaffPlayerRiddles, { players }));

    expect(html).toContain('role="tablist"');
    for (const text of ["ada", "bob", "cy", "no riddle today", "not started"]) expect(html).toContain(text);
    expect(html).toContain("Solved");
    expect(html).toContain("1/2");
    expect(html).toContain("0:42");
    expect(html).toContain("+120");
  });

  it("never shows the puzzle prompt or an answer box", () => {
    const html = renderToStaticMarkup(createElement(StaffPlayerRiddles, { players }));

    expect(html).not.toContain("Submit answer");
    expect(html).not.toContain("Your answer");
  });

  it("describes a player with no riddle", () => {
    const html = renderToStaticMarkup(createElement(StaffPlayerRiddles, { players: [players[0]] }));

    expect(html).toContain("No riddle today");
    expect(html).not.toContain("Tries");
  });
});

describe("StaffPlayerRiddles with a player's own screen (AC-12)", () => {
  const puzzle = { type: "riddle" as const, difficulty: "standard", maxAttempts: 2, timeLimitSeconds: 120 };
  const base = { name: null, attempts: 0, timeTakenMs: null, points: null, puzzle };
  const inProgress = {
    status: "in_progress" as const,
    submissionId: "s", challengeId: "c", type: "riddle" as const, difficulty: "standard", prompt: "Pending prompt",
    startedAt: "2026-10-07T12:00:00.000Z", deadline: "2026-10-07T12:02:00.000Z", serverTime: "2026-10-07T12:01:00.000Z",
    timeLimitSeconds: 120, maxAttempts: 2, attempts: 1, attemptsRemaining: 1,
    guessHistory: [{ response: "wrong one", correct: false }], feedback: null, scoringPolicy: { base_points: 100 },
  };

  it("renders a completed player's results screen with their answers and no second page title", () => {
    const html = renderToStaticMarkup(createElement(StaffPlayerRiddles, { players: [
      { ...base, userId: "a", displayName: "ada", status: "solved" as const, play: completed(true, { base_points: 100, total_points: 100 }) },
    ] }));

    expect(html).toContain("what ada sees");
    expect(html).toContain("Solved");
    expect(html).toContain("Total points");
    expect(html).toContain("2 + 2 ?");
    expect(html.match(/<h2/g)).toHaveLength(1);
  });

  it("renders an in-progress player's prompt, guesses and time left without controls", () => {
    const html = renderToStaticMarkup(createElement(StaffPlayerRiddles, { players: [
      { ...base, userId: "a", displayName: "ada", status: "in_progress" as const, play: inProgress },
    ] }));

    expect(html).toContain("Pending prompt");
    expect(html).toContain("wrong one");
    expect(html).toContain("1:00");
    expect(html).not.toContain("Submit answer");
  });

  it("shows a not-started player's start screen without a Start button", () => {
    const html = renderToStaticMarkup(createElement(StaffPlayerRiddles, { players: [
      { ...base, userId: "a", displayName: "ada", status: "not_started" as const, play: { status: "not_started" as const, available: true, difficulty: "standard", scoringPolicy: { base_points: 100 } } },
    ] }));

    expect(html).toContain("Daily challenge");
    expect(html).not.toContain("Start riddle");
  });
});

