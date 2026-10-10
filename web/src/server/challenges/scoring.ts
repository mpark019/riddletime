const MAX_DATABASE_INTEGER = 2_147_483_647;

export interface SpeedBonus {
  underMs: number;
  points: number;
}

export interface ScoringBreakdown {
  base_points: number;
  speed_bonus_points: number | null;
  penalty_points: number;
  hint_cost_points?: number;
  total_points: number;
  bonus_under_ms: number | null;
}

// Bonuses don't stack: only the single highest applicable tier counts.
// A hint never takes a correct result below zero; an incorrect one pays the hint on top of its penalty.
export function computeResult(
  correct: boolean,
  basePoints: number,
  speedBonuses: readonly SpeedBonus[],
  elapsedMs: number,
  failurePenaltyPoints = 0,
  hintCostPoints = 0,
): ScoringBreakdown {
  const hint = hintCostPoints > 0 ? { hint_cost_points: hintCostPoints } : {};

  if (!correct) {
    const deduction = Math.min(failurePenaltyPoints + hintCostPoints, MAX_DATABASE_INTEGER);
    return {
      base_points: 0,
      speed_bonus_points: null,
      penalty_points: failurePenaltyPoints,
      ...hint,
      total_points: deduction === 0 ? 0 : -deduction,
      bonus_under_ms: null,
    };
  }

  const applicable = speedBonuses.filter((b) => elapsedMs < b.underMs);
  const best = applicable.reduce<SpeedBonus | null>((max, bonus) => {
    if (!max || bonus.points > max.points) return bonus;
    return max;
  }, null);

  return {
    base_points: basePoints,
    speed_bonus_points: best ? best.points : null,
    penalty_points: 0,
    ...hint,
    total_points: Math.max(0, basePoints + (best ? best.points : 0) - hintCostPoints),
    bonus_under_ms: best ? best.underMs : null,
  };
}
