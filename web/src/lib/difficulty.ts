export const DIFFICULTIES = ["easy", "medium", "hard", "extreme"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  easy: "#00940a",
  medium: "#f5b400",
  hard: "#ff6a00",
  extreme: "#f00000",
};

export function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}

export function difficultyColor(value: string | null | undefined): string | undefined {
  const key = value?.trim().toLowerCase() ?? "";
  return isDifficulty(key) ? DIFFICULTY_COLORS[key] : undefined;
}
