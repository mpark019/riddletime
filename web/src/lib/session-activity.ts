export type ActivityKind = "away" | "back" | "typing" | "copy" | "paste";

const MIN_COPY_LENGTH = 3;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// True when the copied selection is part of the prompt, or contains all of it (select-all).
export function isPromptCopy(selection: string, prompt: string): boolean {
  const copied = normalize(selection);
  const target = normalize(prompt);
  if (copied.length < MIN_COPY_LENGTH || target.length === 0) return false;
  return target.includes(copied) || copied.includes(target);
}

export interface ActivityTracker {
  start(state: { hidden: boolean; focused: boolean }): void;
  visibilityChanged(hidden: boolean): void;
  focusChanged(focused: boolean): void;
  answerChanged(answer: string): void;
  copied(selection: string, prompt: string): void;
  pasted(): void;
}

// Merges tab visibility and window focus into one away/back signal and marks the start of each guess draft.
export function createActivityTracker(send: (kind: ActivityKind) => void): ActivityTracker {
  let hidden = false;
  let blurred = false;
  let reportedAway = false;
  let drafting = false;

  function sync() {
    const away = hidden || blurred;
    if (away === reportedAway) return;
    reportedAway = away;
    send(away ? "away" : "back");
  }

  return {
    start(state) {
      hidden = state.hidden;
      blurred = !state.focused;
      reportedAway = hidden || blurred;
      send(reportedAway ? "away" : "back");
    },
    visibilityChanged(nextHidden) {
      hidden = nextHidden;
      sync();
    },
    focusChanged(focused) {
      blurred = !focused;
      sync();
    },
    answerChanged(answer) {
      if (answer.length === 0) {
        drafting = false;
        return;
      }
      if (drafting) return;
      drafting = true;
      send("typing");
    },
    copied(selection, prompt) {
      if (isPromptCopy(selection, prompt)) send("copy");
    },
    pasted() {
      send("paste");
    },
  };
}
