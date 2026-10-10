import { describe, expect, it } from "vitest";
import {
  buildPuzzlePreview,
  buildPuzzleRequest,
  previewRulesFromForm,
  formatMedianSeconds,
  formatSolveRate,
  randomTarget,
} from "./puzzle-bank";

describe("buildPuzzleRequest", () => {
  it("builds a riddle request with trimmed prompt and one answer per line", () => {
    expect(buildPuzzleRequest({
      name: "Keys",
      kind: "riddle",
      difficulty: "hard",
      prompt: "  What has keys?  ",
      acceptedAnswers: "piano\n a piano \n\n",
      targetWord: "",
    })).toEqual({
      name: "Keys",
      difficulty: "hard",
      puzzle: { type: "riddle", prompt: "What has keys?", accepted_answers: ["piano", "a piano"] },
    });
  });

  it("requires a name and trims it", () => {
    const form = { kind: "riddle" as const, difficulty: "easy", prompt: "p", acceptedAnswers: "a", targetWord: "" };
    expect(buildPuzzleRequest({ ...form, name: "  Keys riddle " })).toMatchObject({ name: "Keys riddle" });
    expect(() => buildPuzzleRequest({ ...form, name: "   " })).toThrow("Enter a name for the puzzle.");
    expect(() => buildPuzzleRequest(form)).toThrow("Enter a name for the puzzle.");
    expect(() => buildPuzzleRequest({ ...form, name: "x".repeat(81) })).toThrow("The name can be at most 80 characters.");
  });

  it("builds a letter-game request with an uppercased target", () => {
    expect(buildPuzzleRequest({
      name: "Crane", kind: "character_puzzle", difficulty: "easy", prompt: "", acceptedAnswers: "", targetWord: " crane7 ",
    })).toEqual({ name: "Crane", difficulty: "easy", puzzle: { type: "character_puzzle", target: "CRANE7" } });
  });

  it.each([
    [{ name: "N", kind: "riddle", difficulty: "easy", prompt: "  ", acceptedAnswers: "x", targetWord: "" }, "Enter the riddle prompt."],
    [{ name: "N", kind: "riddle", difficulty: "easy", prompt: "ok", acceptedAnswers: " \n ", targetWord: "" }, "Enter at least one accepted answer."],
    [{ name: "N", kind: "riddle", difficulty: "nope", prompt: "ok", acceptedAnswers: "x", targetWord: "" }, "Choose a difficulty."],
    [{ name: "N", kind: "character_puzzle", difficulty: "easy", prompt: "", acceptedAnswers: "", targetWord: "" }, "Enter the word or code players will guess."],
    [{ name: "N", kind: "character_puzzle", difficulty: "easy", prompt: "", acceptedAnswers: "", targetWord: "no spaces" }, "The answer can only use letters A-Z and digits 0-9, with no spaces."],
    [{ name: "N", kind: "character_puzzle", difficulty: "easy", prompt: "", acceptedAnswers: "", targetWord: "A".repeat(51) }, "The answer must be at most 50 characters."],
  ] as const)("rejects invalid input %#", (form, message) => {
    expect(() => buildPuzzleRequest(form)).toThrow(message);
  });
});

describe("randomTarget", () => {
  it("returns the requested length from letters and digits only", () => {
    const target = randomTarget(8);
    expect(target).toMatch(/^[A-Z0-9]{8}$/);
  });

  it("is driven by the supplied random source", () => {
    expect(randomTarget(3, () => 0)).toBe("AAA");
    expect(randomTarget(2, () => 0.999999)).toBe("99");
  });

  it.each([0, 51, 1.5])("rejects the length %s", (length) => {
    expect(() => randomTarget(length)).toThrow();
  });
});

describe("statistics formatting", () => {
  it("formats the solve rate as a whole percent, or a dash when nobody finished", () => {
    expect(formatSolveRate(2 / 3)).toBe("67%");
    expect(formatSolveRate(1)).toBe("100%");
    expect(formatSolveRate(null)).toBe("-");
  });

  it("formats the median in seconds or minutes", () => {
    expect(formatMedianSeconds(null)).toBe("-");
    expect(formatMedianSeconds(20)).toBe("20s");
    expect(formatMedianSeconds(20.4)).toBe("20s");
    expect(formatMedianSeconds(125)).toBe("2m 5s");
  });
});

describe("buildPuzzlePreview", () => {
  it("shows a riddle exactly as typed, with sample rules", () => {
    expect(buildPuzzlePreview({
      kind: "riddle", difficulty: "hard", prompt: "  What has keys?  ", acceptedAnswers: "piano", targetWord: "",
    })).toEqual({
      type: "riddle",
      difficulty: "hard",
      prompt: "What has keys?",
      timeLimitSeconds: 120,
      maxAttempts: 1,
      scoringPolicy: { base_points: 100, failure_penalty_points: 20 },
      speedBonuses: [],
    });
  });

  it("derives the letter game's board length from the answer and gives it six tries", () => {
    const preview = buildPuzzlePreview({
      kind: "character_puzzle", difficulty: "easy", prompt: "", acceptedAnswers: "", targetWord: " crane7 ",
    });
    expect(preview).toMatchObject({
      type: "character_puzzle",
      maxAttempts: 6,
      config: { target_length: 6, character_set: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
    });
  });

  it("never exposes the answer in the preview object", () => {
    const riddle = buildPuzzlePreview({ kind: "riddle", difficulty: "easy", prompt: "Q?", acceptedAnswers: "secret-answer", targetWord: "" });
    const letters = buildPuzzlePreview({ kind: "character_puzzle", difficulty: "easy", prompt: "", acceptedAnswers: "", targetWord: "SECRET" });
    expect(JSON.stringify(riddle)).not.toContain("secret-answer");
    expect(JSON.stringify(letters)).not.toContain("SECRET");
  });

  it.each([
    [{ name: "N", kind: "riddle", difficulty: "easy", prompt: "   ", acceptedAnswers: "", targetWord: "" }],
    [{ name: "N", kind: "character_puzzle", difficulty: "easy", prompt: "", acceptedAnswers: "", targetWord: "" }],
    [{ name: "N", kind: "character_puzzle", difficulty: "easy", prompt: "", acceptedAnswers: "", targetWord: "bad word" }],
    [{ name: "N", kind: "character_puzzle", difficulty: "easy", prompt: "", acceptedAnswers: "", targetWord: "A".repeat(51) }],
  ] as const)("returns nothing while the content is not valid yet %#", (form) => {
    expect(buildPuzzlePreview(form)).toBeNull();
  });
});

describe("previewRulesFromForm", () => {
  const form = {
    timeLimitSeconds: "90",
    noTimeLimit: false,
    maxAttempts: "3",
    basePoints: "250",
    failurePenaltyPoints: "40",
    speedBonuses: [{ underSeconds: "30", points: "20" }, { underSeconds: "10", points: "50" }],
  };

  it("mirrors the Rules card so the sandbox shows what players will get", () => {
    expect(previewRulesFromForm(form)).toEqual({
      timeLimitSeconds: 90,
      maxAttempts: 3,
      scoringPolicy: { base_points: 250, failure_penalty_points: 40 },
      speedBonuses: [{ under_ms: 30_000, points: 20 }, { under_ms: 10_000, points: 50 }],
    });
  });

  it("shows no time limit when the box is ticked", () => {
    expect(previewRulesFromForm({ ...form, noTimeLimit: true }).timeLimitSeconds).toBeNull();
  });

  it("falls back to sample values while a field is blank or invalid, and skips bad speed tiers", () => {
    const rules = previewRulesFromForm({
      timeLimitSeconds: "",
      noTimeLimit: false,
      maxAttempts: "0",
      basePoints: "abc",
      failurePenaltyPoints: "-5",
      speedBonuses: [{ underSeconds: "", points: "5" }, { underSeconds: "20", points: "10" }],
    });
    expect(rules).toEqual({
      timeLimitSeconds: 120,
      maxAttempts: 1,
      scoringPolicy: { base_points: 100, failure_penalty_points: 20 },
      speedBonuses: [{ under_ms: 20_000, points: 10 }],
    });
  });

  it("drops speed tiers that are not shorter than the time limit", () => {
    expect(previewRulesFromForm({ ...form, speedBonuses: [{ underSeconds: "90", points: "5" }, { underSeconds: "60", points: "5" }] }).speedBonuses)
      .toEqual([{ under_ms: 60_000, points: 5 }]);
  });
});

describe("buildPuzzlePreview with the Rules card values", () => {
  it("uses the supplied rules instead of the samples", () => {
    const rules = previewRulesFromForm({
      timeLimitSeconds: "45", noTimeLimit: false, maxAttempts: "2", basePoints: "300",
      failurePenaltyPoints: "10", speedBonuses: [],
    });
    expect(buildPuzzlePreview({
      kind: "riddle", difficulty: "easy", prompt: "Q?", acceptedAnswers: "a", targetWord: "",
    }, rules)).toMatchObject({
      timeLimitSeconds: 45,
      maxAttempts: 2,
      scoringPolicy: { base_points: 300, failure_penalty_points: 10 },
    });
  });
});
