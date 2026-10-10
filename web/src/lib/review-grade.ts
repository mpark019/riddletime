export type GradeChoice = "full" | "partial" | "none";

export const MAX_REVIEW_COMMENT = 500;

export interface GradeDraft {
  choice: GradeChoice | null;
  partialPoints: string;
  comment: string;
}

export function canGradePartial(basePoints: number): boolean {
  return basePoints >= 2;
}

// Partial must be a whole number from 1 up to one below full.
export function parsePartialPoints(raw: string, basePoints: number): number | null {
  if (!/^\d+$/.test(raw.trim()) || !canGradePartial(basePoints)) return null;
  const points = Number(raw.trim());
  return points >= 1 && points <= basePoints - 1 ? points : null;
}

export function buildReviewRequest(
  draft: GradeDraft,
  basePoints: number,
): { outcome: GradeChoice; points?: number; comment?: string } | null {
  const comment = draft.comment.trim();
  if (comment.length > MAX_REVIEW_COMMENT || draft.choice === null) return null;
  const withComment = comment ? { comment } : {};
  if (draft.choice === "partial") {
    const points = parsePartialPoints(draft.partialPoints, basePoints);
    return points === null ? null : { outcome: "partial", points, ...withComment };
  }
  return { outcome: draft.choice, ...withComment };
}
