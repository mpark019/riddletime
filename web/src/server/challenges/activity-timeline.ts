export type TimelineEntry =
  | { kind: "typing"; offsetMs: number }
  | { kind: "copy"; offsetMs: number }
  | { kind: "paste"; offsetMs: number }
  | { kind: "away"; offsetMs: number; durationMs: number; returned: boolean }
  | { kind: "guess"; offsetMs: number | null; response: string; correct: boolean };

export interface ActivityEvent {
  kind: "away" | "back" | "typing" | "copy" | "paste";
  atMs: number;
}

export interface TimelineGuess {
  response: string;
  correct: boolean;
  offsetMs: number | null;
}

export const MIN_VISIBLE_AWAY_MS = 1_000;

const KIND_RANK = { typing: 0, copy: 0, paste: 0, away: 1, guess: 2 } as const;

export function buildTimeline(input: {
  startedAtMs: number;
  endMs: number;
  events: ActivityEvent[];
  guesses: TimelineGuess[];
}): TimelineEntry[] {
  const elapsedMs = Math.max(input.endMs - input.startedAtMs, 0);
  const clamp = (offsetMs: number) => Math.min(Math.max(offsetMs, 0), elapsedMs);
  const entries: TimelineEntry[] = [];
  let openAwayOffsetMs: number | null = null;

  const events = [...input.events].sort((a, b) => a.atMs - b.atMs);
  for (const event of events) {
    const offsetMs = clamp(event.atMs - input.startedAtMs);
    if (event.kind === "typing" || event.kind === "copy" || event.kind === "paste") {
      entries.push({ kind: event.kind, offsetMs });
    } else if (event.kind === "away") {
      if (openAwayOffsetMs === null) openAwayOffsetMs = offsetMs;
    } else if (openAwayOffsetMs !== null) {
      entries.push({ kind: "away", offsetMs: openAwayOffsetMs, durationMs: offsetMs - openAwayOffsetMs, returned: true });
      openAwayOffsetMs = null;
    }
  }
  if (openAwayOffsetMs !== null) {
    entries.push({ kind: "away", offsetMs: openAwayOffsetMs, durationMs: elapsedMs - openAwayOffsetMs, returned: false });
  }

  const timed: TimelineEntry[] = [...entries];
  const untimed: TimelineEntry[] = [];
  for (const guess of input.guesses) {
    if (guess.offsetMs === null) {
      untimed.push({ kind: "guess", offsetMs: null, response: guess.response, correct: guess.correct });
    } else {
      timed.push({ kind: "guess", offsetMs: clamp(guess.offsetMs), response: guess.response, correct: guess.correct });
    }
  }
  timed.sort((a, b) => (a.offsetMs ?? 0) - (b.offsetMs ?? 0) || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  return [...timed, ...untimed];
}

export function summarizeTimeline(timeline: TimelineEntry[]): { awayCount: number; awayMs: number } {
  let awayCount = 0;
  let awayMs = 0;
  for (const entry of timeline) {
    if (entry.kind === "away" && entry.durationMs >= MIN_VISIBLE_AWAY_MS) {
      awayCount += 1;
      awayMs += entry.durationMs;
    }
  }
  return { awayCount, awayMs };
}
