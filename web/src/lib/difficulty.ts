export const DIFFICULTIES = ["easy", "medium", "hard", "extreme"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  easy: "#00940a",
  medium: "#f5b400",
  hard: "#ff6a00",
  extreme: "#f00000",
};

export interface DifficultyRules {
  timeLimitSeconds: string;
  maxAttempts: string;
  basePoints: string;
  failurePenaltyPoints: string;
}

export const DIFFICULTY_RULES: Record<Difficulty, DifficultyRules> = {
  easy: { timeLimitSeconds: "240", maxAttempts: "3", basePoints: "5", failurePenaltyPoints: "10" },
  medium: { timeLimitSeconds: "240", maxAttempts: "3", basePoints: "10", failurePenaltyPoints: "15" },
  hard: { timeLimitSeconds: "180", maxAttempts: "3", basePoints: "10", failurePenaltyPoints: "25" },
  extreme: { timeLimitSeconds: "120", maxAttempts: "2", basePoints: "5", failurePenaltyPoints: "25" },
};

export function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}

export function difficultyColor(value: string | null | undefined): string | undefined {
  const key = value?.trim().toLowerCase() ?? "";
  return isDifficulty(key) ? DIFFICULTY_COLORS[key] : undefined;
}
