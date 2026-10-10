import { describe, expect, it } from "vitest";
import {
  characterConfigSchema,
  characterTargetSchema,
  gradeCharacterGuess,
  normalizeCharacterGuess,
  sanitizeCharacterInput,
  validateCharacterGuess,
} from "./character-puzzle";

describe("gradeCharacterGuess", () => {
  it("marks every position correct on an exact match", () => {
    expect(gradeCharacterGuess("AB1", "AB1")).toEqual({
      correct: true,
      feedback: ["correct", "correct", "correct"],
    });
  });

  it("marks characters absent or present by position", () => {
    expect(gradeCharacterGuess("ABCD", "BADD").feedback).toEqual([
      "present",
      "present",
      "absent",
      "correct",
    ]);
  });

  it("consumes exact matches before allocating repeated characters", () => {
    expect(gradeCharacterGuess("AABB", "BAAB").feedback).toEqual([
      "present",
      "correct",
      "present",
      "correct",
    ]);
  });

  it("gives extra guessed copies no credit once the target count is used", () => {
    expect(gradeCharacterGuess("ABCD", "AAAA").feedback).toEqual([
      "correct",
      "absent",
      "absent",
      "absent",
    ]);
    expect(gradeCharacterGuess("ABAB", "BBBB").feedback).toEqual([
      "absent",
      "correct",
      "absent",
      "correct",
    ]);
  });

  it("allocates remaining counts left to right", () => {
    expect(gradeCharacterGuess("ABCA", "AAAB").feedback).toEqual([
      "correct",
      "present",
      "absent",
      "present",
    ]);
  });

  it("is not correct when any position differs", () => {
    expect(gradeCharacterGuess("AB", "BA").correct).toBe(false);
  });
});

describe("normalizeCharacterGuess", () => {
  it("trims and uppercases", () => {
    expect(normalizeCharacterGuess("  a1b ")).toBe("A1B");
  });
});

describe("validateCharacterGuess", () => {
  const config = { target_length: 3, character_set: "ABC123" };

  it("accepts a guess of the exact length and alphabet", () => {
    expect(validateCharacterGuess("A1C", config)).toBeNull();
  });

  it("rejects the wrong length", () => {
    expect(validateCharacterGuess("A1", config)).toMatch(/3 characters/);
    expect(validateCharacterGuess("A1CB", config)).toMatch(/3 characters/);
  });

  it("rejects characters outside the set", () => {
    expect(validateCharacterGuess("A1Z", config)).toMatch(/A, B, C, 1, 2, 3|allowed/i);
  });
});

describe("characterConfigSchema", () => {
  it("accepts unique uppercase letters and digits", () => {
    expect(characterConfigSchema.safeParse({ target_length: 7, character_set: "ABCD1234" }).success).toBe(true);
  });

  it.each([
    [{ target_length: 0, character_set: "AB" }],
    [{ target_length: 51, character_set: "AB" }],
    [{ target_length: 1.5, character_set: "AB" }],
    [{ target_length: 4, character_set: "" }],
    [{ target_length: 4, character_set: "AAB" }],
    [{ target_length: 4, character_set: "abc" }],
    [{ target_length: 4, character_set: "A-B" }],
    [{ target_length: 4, character_set: "AB", extra: 1 }],
  ])("rejects %j", (config) => {
    expect(characterConfigSchema.safeParse(config).success).toBe(false);
  });

  it("still reads stored games longer than the 25-letter authoring cap", () => {
    const set = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    expect(characterConfigSchema.safeParse({ target_length: 50, character_set: set }).success).toBe(true);
  });
});

describe("characterTargetSchema", () => {
  it("accepts up to 25 letters and digits and uppercases them", () => {
    expect(characterTargetSchema.parse("a".repeat(25))).toBe("A".repeat(25));
  });

  it("rejects 26 characters", () => {
    expect(characterTargetSchema.safeParse("A".repeat(26)).success).toBe(false);
  });
});

describe("sanitizeCharacterInput", () => {
  const config = { target_length: 4, character_set: "AB12" };

  it("uppercases and drops characters outside the set", () => {
    expect(sanitizeCharacterInput("a-b z1", config)).toBe("AB1");
  });

  it("stops at the target length", () => {
    expect(sanitizeCharacterInput("ababab", config)).toBe("ABAB");
  });

  it("returns an empty string when nothing is allowed", () => {
    expect(sanitizeCharacterInput("xyz!", config)).toBe("");
  });
});
