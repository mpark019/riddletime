export interface SpeedBonus {
  underMs: number;
  points: number;
}

export interface ScoringBreakdown {
  base_points: number;
  speed_bonus_points: number | null;
  total_points: number;
  bonus_under_ms: number | null;
}

// Bonuses don't stack: only the single highest applicable tier counts.
export function computeResult(
  correct: boolean,
  basePoints: number,
  speedBonuses: readonly SpeedBonus[],
  elapsedMs: number,
): ScoringBreakdown {
  if (!correct) {
    return {
      base_points: 0,
      speed_bonus_points: null,
      total_points: 0,
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
    total_points: basePoints + (best ? best.points : 0),
    bonus_under_ms: best ? best.underMs : null,
  };
}
