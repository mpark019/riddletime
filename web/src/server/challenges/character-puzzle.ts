import { z } from "zod";

export const MAX_TARGET_LENGTH = 50;
export const MAX_CHARACTER_SET_SIZE = 36;

export const CHARACTER_SET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export type CharacterFeedback = "correct" | "present" | "absent";

export const characterConfigSchema = z.object({
  target_length: z.number().int().positive().max(MAX_TARGET_LENGTH),
  character_set: z.string()
    .min(1)
    .max(MAX_CHARACTER_SET_SIZE)
    .regex(/^[A-Z0-9]+$/, "Use uppercase letters and digits only")
    .refine((set) => new Set(set).size === set.length, "Characters must be unique"),
}).strict();

export type CharacterConfig = z.infer<typeof characterConfigSchema>;

export const characterTargetSchema = z.string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(MAX_TARGET_LENGTH)
  .regex(/^[A-Z0-9]+$/, "Use letters A-Z and digits 0-9 only");

export function normalizeCharacterGuess(input: string): string {
  return input.trim().toUpperCase();
}

export function validateCharacterGuess(guess: string, config: CharacterConfig): string | null {
  if (guess.length !== config.target_length) {
    return `Enter exactly ${config.target_length} characters`;
  }
  const allowed = new Set(config.character_set);
  if ([...guess].some((character) => !allowed.has(character))) {
    return `Use only these allowed characters: ${[...config.character_set].join(", ")}`;
  }
  return null;
}

// Exact matches are consumed first so repeated characters never earn extra credit.
export function gradeCharacterGuess(
  target: string,
  guess: string,
): { correct: boolean; feedback: CharacterFeedback[] } {
  const feedback: CharacterFeedback[] = Array.from({ length: guess.length }, () => "absent");
  const remaining = new Map<string, number>();

  for (let index = 0; index < target.length; index += 1) {
    if (guess[index] === target[index]) {
      feedback[index] = "correct";
    } else {
      remaining.set(target[index], (remaining.get(target[index]) ?? 0) + 1);
    }
  }
  for (let index = 0; index < guess.length; index += 1) {
    if (feedback[index] === "correct") continue;
    const left = remaining.get(guess[index]) ?? 0;
    if (left > 0) {
      feedback[index] = "present";
      remaining.set(guess[index], left - 1);
    }
  }

  return { correct: feedback.every((entry) => entry === "correct"), feedback };
}

// Keeps typing within the rules: uppercases, drops characters outside the set, and stops at the target length.
export function sanitizeCharacterInput(input: string, config: CharacterConfig): string {
  const allowed = new Set(config.character_set);
  return [...input.toUpperCase()]
    .filter((character) => allowed.has(character))
    .slice(0, config.target_length)
    .join("");
}
