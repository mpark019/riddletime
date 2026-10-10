import { z } from "zod";
import { BadRequestError } from "@/server/http/errors";

// Every image puzzle allows the same number of images; the stored config keeps it so old rows stay readable.
export const MAX_IMAGES = 5;
export const MAX_NOTE_LENGTH = 1000;
export const MAX_REVIEW_COMMENT_LENGTH = 500;

export const imageConfigSchema = z.object({
  max_images: z.number().int().min(1).max(10),
  prompt_image_path: z.string().min(1).optional(),
});
export type ImageConfig = z.infer<typeof imageConfigSchema>;

export type ReviewOutcome = "full" | "partial" | "none";

const commentSchema = z.string().trim().max(MAX_REVIEW_COMMENT_LENGTH)
  .transform((value) => (value === "" ? null : value))
  .nullish()
  .transform((value) => value ?? null);

export const reviewInputSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("full"), comment: commentSchema }).strict(),
  z.object({ outcome: z.literal("none"), comment: commentSchema }).strict(),
  z.object({
    outcome: z.literal("partial"),
    points: z.number().int().positive().max(2_147_483_647),
    comment: commentSchema,
  }).strict(),
]);
export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const noteSchema = z.string().trim().max(MAX_NOTE_LENGTH)
  .transform((value) => (value === "" ? null : value));

export interface ReviewResult {
  correct: boolean;
  breakdown: {
    base_points: number;
    speed_bonus_points: null;
    penalty_points: number;
    total_points: number;
    bonus_under_ms: null;
    outcome: ReviewOutcome;
  };
}

// Grading is flat: no speed bonus, and a partial must sit strictly between nothing and full.
export function computeReviewResult(
  input: ReviewInput,
  basePoints: number,
  failurePenaltyPoints: number,
): ReviewResult {
  if (input.outcome === "none") {
    return {
      correct: false,
      breakdown: {
        base_points: 0,
        speed_bonus_points: null,
        penalty_points: failurePenaltyPoints,
        total_points: failurePenaltyPoints === 0 ? 0 : -failurePenaltyPoints,
        bonus_under_ms: null,
        outcome: "none",
      },
    };
  }
  if (input.outcome === "full") {
    return {
      correct: true,
      breakdown: {
        base_points: basePoints,
        speed_bonus_points: null,
        penalty_points: 0,
        total_points: basePoints,
        bonus_under_ms: null,
        outcome: "full",
      },
    };
  }
  if (basePoints < 2) {
    throw new BadRequestError("Partial credit needs a puzzle worth at least 2 points");
  }
  if (input.points >= basePoints) {
    throw new BadRequestError(`Partial points must be between 1 and ${basePoints - 1}`);
  }
  return {
    correct: true,
    breakdown: {
      base_points: input.points,
      speed_bonus_points: null,
      penalty_points: 0,
      total_points: input.points,
      bonus_under_ms: null,
      outcome: "partial",
    },
  };
}
