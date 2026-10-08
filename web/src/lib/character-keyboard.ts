import type { CharacterFeedback } from "@/server/challenges/character-puzzle";

const LAYOUT_ROWS = ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];

const STATUS_RANK: Record<CharacterFeedback, number> = { absent: 1, present: 2, correct: 3 };

export function keyboardRows(characterSet: string): string[][] {
  const allowed = new Set(characterSet);
  return LAYOUT_ROWS
    .map((row) => [...row].filter((character) => allowed.has(character)))
    .filter((row) => row.length > 0);
}

// A key shows the best result seen, so a correct spot is never hidden by an absent repeat.
export function keyStatuses(
  history: ReadonlyArray<{ response: string; feedback?: CharacterFeedback[] }>,
): Map<string, CharacterFeedback> {
  const statuses = new Map<string, CharacterFeedback>();
  for (const guess of history) {
    if (!guess.feedback) continue;
    [...guess.response].forEach((character, index) => {
      const next = guess.feedback?.[index];
      if (!next) return;
      const current = statuses.get(character);
      if (!current || STATUS_RANK[next] > STATUS_RANK[current]) statuses.set(character, next);
    });
  }
  return statuses;
}
