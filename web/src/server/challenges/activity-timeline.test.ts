import { describe, expect, it } from "vitest";
import { buildTimeline, summarizeTimeline } from "./activity-timeline";

const START = 1_000_000;
const at = (offsetMs: number) => START + offsetMs;

describe("buildTimeline", () => {
  it("pairs away with back and orders typing, absences and guesses by offset", () => {
    const timeline = buildTimeline({
      startedAtMs: START,
      endMs: at(21_000),
      events: [
        { kind: "back", atMs: at(15_000) },
        { kind: "typing", atMs: at(3_000) },
        { kind: "away", atMs: at(7_000) },
      ],
      guesses: [{ response: "piano", correct: true, offsetMs: 21_000 }],
    });
    expect(timeline).toEqual([
      { kind: "typing", offsetMs: 3_000 },
      { kind: "away", offsetMs: 7_000, durationMs: 8_000, returned: true },
      { kind: "guess", offsetMs: 21_000, response: "piano", correct: true },
    ]);
  });

  it("runs an absence with no back to the session end and marks it unreturned", () => {
    const [entry] = buildTimeline({
      startedAtMs: START,
      endMs: at(30_000),
      events: [{ kind: "away", atMs: at(10_000) }],
      guesses: [],
    });
    expect(entry).toEqual({ kind: "away", offsetMs: 10_000, durationMs: 20_000, returned: false });
  });

  it("ignores a repeated away and a back with nothing open", () => {
    const timeline = buildTimeline({
      startedAtMs: START,
      endMs: at(60_000),
      events: [
        { kind: "back", atMs: at(1_000) },
        { kind: "away", atMs: at(5_000) },
        { kind: "away", atMs: at(6_000) },
        { kind: "back", atMs: at(9_000) },
        { kind: "back", atMs: at(10_000) },
      ],
      guesses: [],
    });
    expect(timeline).toEqual([{ kind: "away", offsetMs: 5_000, durationMs: 4_000, returned: true }]);
  });

  it("never reports an offset or duration beyond the session's elapsed time", () => {
    const timeline = buildTimeline({
      startedAtMs: START,
      endMs: at(10_000),
      events: [
        { kind: "away", atMs: at(8_000) },
        { kind: "back", atMs: at(99_000) },
        { kind: "typing", atMs: at(50_000) },
        { kind: "typing", atMs: at(-5_000) },
      ],
      guesses: [{ response: "x", correct: false, offsetMs: 70_000 }],
    });
    expect(timeline).toEqual([
      { kind: "typing", offsetMs: 0 },
      { kind: "away", offsetMs: 8_000, durationMs: 2_000, returned: true },
      { kind: "typing", offsetMs: 10_000 },
      { kind: "guess", offsetMs: 10_000, response: "x", correct: false },
    ]);
  });

  it("lists guesses without a stored offset after the timed entries", () => {
    const timeline = buildTimeline({
      startedAtMs: START,
      endMs: at(40_000),
      events: [{ kind: "typing", atMs: at(30_000) }],
      guesses: [
        { response: "old", correct: false, offsetMs: null },
        { response: "new", correct: true, offsetMs: 35_000 },
      ],
    });
    expect(timeline.map((entry) => entry.kind === "guess" ? entry.response : entry.kind)).toEqual([
      "typing",
      "new",
      "old",
    ]);
    expect(timeline[2]).toMatchObject({ kind: "guess", offsetMs: null });
  });

  it("includes copy events in order, ahead of a guess at the same offset (AC-14)", () => {
    const timeline = buildTimeline({
      startedAtMs: START,
      endMs: at(30_000),
      events: [
        { kind: "away", atMs: at(3_000) },
        { kind: "copy", atMs: at(2_000) },
        { kind: "back", atMs: at(20_000) },
      ],
      guesses: [{ response: "piano", correct: true, offsetMs: 22_000 }],
    });
    expect(timeline).toEqual([
      { kind: "copy", offsetMs: 2_000 },
      { kind: "away", offsetMs: 3_000, durationMs: 17_000, returned: true },
      { kind: "guess", offsetMs: 22_000, response: "piano", correct: true },
    ]);
  });

  it("includes paste events between an absence and the guess (AC-15)", () => {
    const timeline = buildTimeline({
      startedAtMs: START,
      endMs: at(30_000),
      events: [
        { kind: "paste", atMs: at(21_000) },
        { kind: "away", atMs: at(3_000) },
        { kind: "back", atMs: at(20_000) },
      ],
      guesses: [{ response: "piano", correct: true, offsetMs: 22_000 }],
    });
    expect(timeline).toEqual([
      { kind: "away", offsetMs: 3_000, durationMs: 17_000, returned: true },
      { kind: "paste", offsetMs: 21_000 },
      { kind: "guess", offsetMs: 22_000, response: "piano", correct: true },
    ]);
  });

  it("returns an empty timeline when nothing happened", () => {
    expect(buildTimeline({ startedAtMs: START, endMs: at(5_000), events: [], guesses: [] })).toEqual([]);
  });
});

describe("summarizeTimeline", () => {
  it("counts absences and sums time away", () => {
    const summary = summarizeTimeline([
      { kind: "typing", offsetMs: 100 },
      { kind: "away", offsetMs: 7_000, durationMs: 8_000, returned: true },
      { kind: "away", offsetMs: 20_000, durationMs: 3_000, returned: false },
    ]);
    expect(summary).toEqual({ awayCount: 2, awayMs: 11_000 });
  });

  it("leaves out absences under one second", () => {
    const summary = summarizeTimeline([
      { kind: "away", offsetMs: 1_000, durationMs: 400, returned: true },
      { kind: "away", offsetMs: 2_000, durationMs: 1_000, returned: true },
    ]);
    expect(summary).toEqual({ awayCount: 1, awayMs: 1_000 });
  });
});

describe("buildTimeline image events", () => {
  it("orders image changes with tab absences and puts the submit time last", () => {
    const timeline = buildTimeline({
      startedAtMs: START,
      endMs: at(60_000),
      events: [
        { kind: "image_added", atMs: at(10_000) },
        { kind: "away", atMs: at(12_000) },
        { kind: "back", atMs: at(20_000) },
        { kind: "image_removed", atMs: at(25_000) },
        { kind: "image_added", atMs: at(30_000) },
      ],
      guesses: [],
      submittedAtMs: at(45_000),
    });
    expect(timeline).toEqual([
      { kind: "image_added", offsetMs: 10_000 },
      { kind: "away", offsetMs: 12_000, durationMs: 8_000, returned: true },
      { kind: "image_removed", offsetMs: 25_000 },
      { kind: "image_added", offsetMs: 30_000 },
      { kind: "submitted", offsetMs: 45_000 },
    ]);
  });

  it("omits the submit entry when nothing was submitted and clamps it to the session", () => {
    const base = { startedAtMs: START, endMs: at(5_000), events: [], guesses: [] };
    expect(buildTimeline({ ...base, submittedAtMs: null })).toEqual([]);
    expect(buildTimeline({ ...base, submittedAtMs: at(9_000) })).toEqual([{ kind: "submitted", offsetMs: 5_000 }]);
  });
});

