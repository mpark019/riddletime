import { describe, expect, it } from "vitest";
import { keyboardRows, keyStatuses } from "./character-keyboard";

describe("keyboardRows", () => {
  it("uses QWERTY rows filtered to the allowed letters", () => {
    expect(keyboardRows("ABCQ")).toEqual([["Q"], ["A"], ["C", "B"]]);
  });

  it("puts digits on a top row in keyboard order", () => {
    expect(keyboardRows("A1920")).toEqual([["1", "2", "9", "0"], ["A"]]);
  });

  it("drops rows with no allowed characters", () => {
    expect(keyboardRows("ZM")).toEqual([["Z", "M"]]);
  });

  it("keeps every allowed character exactly once", () => {
    const set = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    expect(keyboardRows(set).flat().sort()).toEqual([...set].sort());
  });
});

describe("keyStatuses", () => {
  it("keeps the best status seen for each character", () => {
    const statuses = keyStatuses([
      { response: "AB", feedback: ["present", "absent"] },
      { response: "BA", feedback: ["absent", "correct"] },
    ]);
    expect(statuses.get("A")).toBe("correct");
    expect(statuses.get("B")).toBe("absent");
  });

  it("does not downgrade a correct character that is absent elsewhere in a guess", () => {
    const statuses = keyStatuses([{ response: "AA", feedback: ["correct", "absent"] }]);
    expect(statuses.get("A")).toBe("correct");
  });

  it("prefers present over absent", () => {
    const statuses = keyStatuses([
      { response: "AA", feedback: ["absent", "present"] },
    ]);
    expect(statuses.get("A")).toBe("present");
  });

  it("ignores guesses with no feedback and leaves unused characters unset", () => {
    const statuses = keyStatuses([{ response: "AB" }]);
    expect(statuses.size).toBe(0);
  });
});
