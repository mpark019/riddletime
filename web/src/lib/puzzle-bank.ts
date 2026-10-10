import { CHARACTER_SET, MAX_TARGET_LENGTH } from "@/server/challenges/character-puzzle";
import { isDifficulty } from "./difficulty";
import type { StaffRiddlePreview } from "./challenge-state";

export type BankPuzzleKind = "riddle" | "character_puzzle";

export interface PuzzleForm {
  name?: string;
  kind: BankPuzzleKind;
  difficulty: string;
  prompt: string;
  acceptedAnswers: string;
  targetWord: string;
}

export const MAX_NAME_LENGTH = 80;

export function buildPuzzleRequest(form: PuzzleForm) {
  const difficulty = form.difficulty.trim();
  if (!isDifficulty(difficulty)) throw new Error("Choose a difficulty.");
  const name = (form.name ?? "").trim();
  if (!name) throw new Error("Enter a name for the puzzle.");
  if (name.length > MAX_NAME_LENGTH) throw new Error(`The name can be at most ${MAX_NAME_LENGTH} characters.`);
  const named = { name };

  if (form.kind === "character_puzzle") {
    const target = form.targetWord.trim().toUpperCase();
    if (!target) throw new Error("Enter the word or code players will guess.");
    if (!/^[A-Z0-9]+$/.test(target)) {
      throw new Error("The answer can only use letters A-Z and digits 0-9, with no spaces.");
    }
    if (target.length > MAX_TARGET_LENGTH) {
      throw new Error(`The answer must be at most ${MAX_TARGET_LENGTH} characters.`);
    }
    return { ...named, difficulty, puzzle: { type: "character_puzzle" as const, target } };
  }

  const prompt = form.prompt.trim();
  const acceptedAnswers = form.acceptedAnswers.split("\n").map((answer) => answer.trim()).filter(Boolean);
  if (!prompt) throw new Error("Enter the riddle prompt.");
  if (acceptedAnswers.length === 0) throw new Error("Enter at least one accepted answer.");
  return { ...named, difficulty, puzzle: { type: "riddle" as const, prompt, accepted_answers: acceptedAnswers } };
}

export function formatSolveRate(rate: number | null): string {
  return rate === null ? "-" : `${Math.round(rate * 100)}%`;
}

export function formatMedianSeconds(seconds: number | null): string {
  if (seconds === null) return "-";
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

// Without a Rules card to read (the Puzzles tab), the preview shows plain sample rules.
const SAMPLE_TIME_LIMIT_SECONDS = 120;
const SAMPLE_RIDDLE_TRIES = 1;
const SAMPLE_LETTER_TRIES = 6;
const SAMPLE_BASE_POINTS = 100;
const SAMPLE_FAILURE_PENALTY = 20;

export interface PreviewRules {
  timeLimitSeconds: number | null;
  maxAttempts: number;
  scoringPolicy: { base_points: number; failure_penalty_points: number };
  speedBonuses: Array<{ under_ms: number; points: number }>;
}

interface RulesFormValues {
  timeLimitSeconds: string;
  noTimeLimit: boolean;
  maxAttempts: string;
  basePoints: string;
  failurePenaltyPoints: string;
  speedBonuses: Array<{ underSeconds: string; points: string }>;
}

function wholeOr(value: string, minimum: number, fallback: number): number {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

// Lenient on purpose: a half-typed field shows its sample value instead of breaking the preview.
export function previewRulesFromForm(form: RulesFormValues): PreviewRules {
  const timeLimitSeconds = form.noTimeLimit ? null : wholeOr(form.timeLimitSeconds, 1, SAMPLE_TIME_LIMIT_SECONDS);
  const speedBonuses = form.speedBonuses.flatMap((tier) => {
    const underSeconds = wholeOr(tier.underSeconds, 1, 0);
    const points = wholeOr(tier.points, 0, -1);
    const valid = underSeconds > 0 && points >= 0 && (timeLimitSeconds === null || underSeconds < timeLimitSeconds);
    return valid ? [{ under_ms: underSeconds * 1000, points }] : [];
  });
  return {
    timeLimitSeconds,
    maxAttempts: wholeOr(form.maxAttempts, 1, SAMPLE_RIDDLE_TRIES),
    scoringPolicy: {
      base_points: wholeOr(form.basePoints, 0, SAMPLE_BASE_POINTS),
      failure_penalty_points: wholeOr(form.failurePenaltyPoints, 0, SAMPLE_FAILURE_PENALTY),
    },
    speedBonuses,
  };
}

export function buildPuzzlePreview(form: PuzzleForm, rules?: PreviewRules): StaffRiddlePreview | null {
  const resolved: PreviewRules = rules ?? {
    timeLimitSeconds: SAMPLE_TIME_LIMIT_SECONDS,
    maxAttempts: form.kind === "character_puzzle" ? SAMPLE_LETTER_TRIES : SAMPLE_RIDDLE_TRIES,
    scoringPolicy: { base_points: SAMPLE_BASE_POINTS, failure_penalty_points: SAMPLE_FAILURE_PENALTY },
    speedBonuses: [],
  };
  const base = {
    difficulty: form.difficulty,
    timeLimitSeconds: resolved.timeLimitSeconds,
    maxAttempts: resolved.maxAttempts,
    scoringPolicy: resolved.scoringPolicy,
    speedBonuses: resolved.speedBonuses,
  };
  if (form.kind === "character_puzzle") {
    const target = form.targetWord.trim().toUpperCase();
    if (!target || target.length > MAX_TARGET_LENGTH || !/^[A-Z0-9]+$/.test(target)) return null;
    return {
      ...base,
      type: "character_puzzle",
      prompt: "Letter game",
      config: { target_length: target.length, character_set: CHARACTER_SET },
    };
  }
  const prompt = form.prompt.trim();
  if (!prompt) return null;
  return { ...base, type: "riddle", prompt };
}
