import { describe, expect, it, vi } from "vitest";
import { createActivityTracker, isPromptCopy } from "./session-activity";

function setup() {
  const send = vi.fn();
  return { send, tracker: createActivityTracker(send) };
}

describe("createActivityTracker", () => {
  it("sends back on start when the page is visible and focused (AC-10)", () => {
    const { send, tracker } = setup();

    tracker.start({ hidden: false, focused: true });

    expect(send.mock.calls).toEqual([["back"]]);
  });

  it("sends away on start when the page loads hidden", () => {
    const { send, tracker } = setup();

    tracker.start({ hidden: true, focused: false });

    expect(send.mock.calls).toEqual([["away"]]);
  });

  it("sends one away when the tab hides and one back when it shows (AC-9)", () => {
    const { send, tracker } = setup();
    tracker.start({ hidden: false, focused: true });
    send.mockClear();

    tracker.visibilityChanged(true);
    tracker.visibilityChanged(false);

    expect(send.mock.calls).toEqual([["away"], ["back"]]);
  });

  it("merges overlapping hidden and blur into one absence (AC-9)", () => {
    const { send, tracker } = setup();
    tracker.start({ hidden: false, focused: true });
    send.mockClear();

    tracker.focusChanged(false);
    tracker.visibilityChanged(true);
    tracker.visibilityChanged(false);
    expect(send.mock.calls).toEqual([["away"]]);

    tracker.focusChanged(true);
    expect(send.mock.calls).toEqual([["away"], ["back"]]);
  });

  it("counts a blur with the tab still visible as an absence", () => {
    const { send, tracker } = setup();
    tracker.start({ hidden: false, focused: true });
    send.mockClear();

    tracker.focusChanged(false);
    tracker.focusChanged(true);

    expect(send.mock.calls).toEqual([["away"], ["back"]]);
  });

  it("sends typing once per draft, and again after the answer is cleared (AC-11)", () => {
    const { send, tracker } = setup();
    tracker.start({ hidden: false, focused: true });
    send.mockClear();

    tracker.answerChanged("p");
    tracker.answerChanged("pi");
    tracker.answerChanged("");
    tracker.answerChanged("g");

    expect(send.mock.calls).toEqual([["typing"], ["typing"]]);
  });

  it("does not send typing for an empty answer", () => {
    const { send, tracker } = setup();
    tracker.start({ hidden: false, focused: true });
    send.mockClear();

    tracker.answerChanged("");

    expect(send).not.toHaveBeenCalled();
  });
});

describe("isPromptCopy", () => {
  const prompt = "What has keys but no locks, space but no room?";

  it("matches a selection taken from the prompt, ignoring case and spacing", () => {
    expect(isPromptCopy("has keys  but no LOCKS", prompt)).toBe(true);
  });

  it("matches a selection that contains the whole prompt, such as select-all", () => {
    expect(isPromptCopy(`Riddle\n${prompt}\nSubmit`, prompt)).toBe(true);
  });

  it("ignores empty and very short selections", () => {
    expect(isPromptCopy("", prompt)).toBe(false);
    expect(isPromptCopy("  ", prompt)).toBe(false);
    expect(isPromptCopy("ke", prompt)).toBe(false);
  });

  it("ignores text that is not from the prompt", () => {
    expect(isPromptCopy("piano", prompt)).toBe(false);
  });

  it("ignores everything when the prompt is empty", () => {
    expect(isPromptCopy("anything", "")).toBe(false);
  });
});

describe("createActivityTracker copy", () => {
  it("sends copy when the selection comes from the prompt (AC-14)", () => {
    const { send, tracker } = setup();
    tracker.start({ hidden: false, focused: true });
    send.mockClear();

    tracker.copied("keys but no locks", "What has keys but no locks?");

    expect(send.mock.calls).toEqual([["copy"]]);
  });

  it("does not send copy for other text (AC-14)", () => {
    const { send, tracker } = setup();
    tracker.start({ hidden: false, focused: true });
    send.mockClear();

    tracker.copied("Leaderboard", "What has keys but no locks?");

    expect(send).not.toHaveBeenCalled();
  });
});

describe("createActivityTracker paste", () => {
  it("sends paste (AC-15)", () => {
    const { send, tracker } = setup();
    tracker.start({ hidden: false, focused: true });
    send.mockClear();

    tracker.pasted();

    expect(send.mock.calls).toEqual([["paste"]]);
  });
});
