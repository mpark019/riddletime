import type { PoolClient } from "pg";

export type PlayOutcome = "solved" | "failed" | "missed" | "in_progress" | "expired" | "not_started" | "did_not_play";

export interface PuzzleRules {
  maxAttempts: number;
  timeLimitSeconds: number | null;
  basePoints: number | null;
  failurePenaltyPoints: number | null;
  speedBonuses: Array<{ underMs: number; points: number }>;
}

export interface PuzzlePlay {
  playerId: string;
  playerName: string;
  date: string;
  outcome: PlayOutcome;
  attempts: number | null;
  timeTakenMs: number | null;
  points: number | null;
  rules: PuzzleRules;
}

export interface RuleSetStats extends PuzzleRules {
  daysUsed: number;
  assigned: number;
  started: number;
  finished: number;
  solved: number;
  failed: number;
  missed: number;
  solveRate: number | null;
  medianSolveSeconds: number | null;
  averageAttempts: number | null;
}

export interface PuzzleActivity {
  ruleSets: RuleSetStats[];
  plays: PuzzlePlay[];
}

const MAX_PLAYS = 1000;

function toSpeedBonuses(value: unknown): PuzzleRules["speedBonuses"] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((tier: { under_ms?: unknown; points?: unknown }) =>
      typeof tier?.under_ms === "number" && typeof tier?.points === "number" ? [{ underMs: tier.under_ms, points: tier.points }] : [])
    .sort((a, b) => a.underMs - b.underMs);
}

export const rulesKey = (rules: PuzzleRules) =>
  `${rules.maxAttempts}|${rules.timeLimitSeconds ?? "none"}|${rules.basePoints ?? ""}|${rules.failurePenaltyPoints ?? ""}|${rules.speedBonuses.map((tier) => `${tier.underMs}:${tier.points}`).join(",")}`;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Missed days carry no play, so they stay out of every rate.
export function summarizeRuleSets(plays: readonly PuzzlePlay[]): RuleSetStats[] {
  const groups = new Map<string, PuzzlePlay[]>();
  for (const play of plays) {
    const key = rulesKey(play.rules);
    groups.set(key, [...(groups.get(key) ?? []), play]);
  }
  return [...groups.values()].map((group) => {
    const finished = group.filter((play) => play.outcome === "solved" || play.outcome === "failed");
    const solved = group.filter((play) => play.outcome === "solved");
    const started = group.filter((play) => ["solved", "failed", "in_progress", "expired"].includes(play.outcome));
    const attempts = finished.flatMap((play) => play.attempts === null ? [] : [play.attempts]);
    const times = solved.flatMap((play) => play.timeTakenMs === null ? [] : [play.timeTakenMs / 1000]);
    return {
      ...group[0].rules,
      daysUsed: new Set(group.map((play) => play.date)).size,
      assigned: group.length,
      started: started.length,
      finished: finished.length,
      solved: solved.length,
      failed: finished.length - solved.length,
      missed: group.filter((play) => play.outcome === "missed").length,
      solveRate: finished.length > 0 ? solved.length / finished.length : null,
      medianSolveSeconds: median(times),
      averageAttempts: attempts.length > 0 ? attempts.reduce((sum, value) => sum + value, 0) / attempts.length : null,
    };
  }).sort((a, b) => b.assigned - a.assigned);
}

export async function loadPuzzleActivity(client: PoolClient, puzzleId: string): Promise<PuzzleActivity> {
  const { rows } = await client.query(
    `select d.active_date::text as active_date, c.max_attempts, c.time_limit_seconds, c.scoring_policy,
            d.active_date < current_date as day_over,
            p.id as player_id, p.display_name,
            s.id as submission_id, s.submitted_at, s.correct, s.attempts, s.time_taken_ms,
            coalesce(s.scoring_breakdown @> '{"missed": true}', false) as missed,
            s.submitted_at is null
              and riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, current_setting('timezone')) <= clock_timestamp() as overdue,
            (select sum(pt.amount)::int from point_transactions pt
              where pt.submission_id = s.id and pt.kind = 'challenge_result') as points
     from challenges c
     join daily_challenges d on d.id = c.daily_challenge_id
     join profiles p on p.role = 'player' and (
       c.assigned_to = p.id
       or (c.assigned_to is null and p.created_at < riddle_private.day_end(d.active_date, current_setting('timezone'))))
     left join submissions s on s.challenge_id = c.id and s.user_id = p.id
     where c.puzzle_id = $1
     order by d.active_date desc, lower(p.display_name), p.id
     limit ${MAX_PLAYS}`,
    [puzzleId],
  );
  const plays = rows.map((row): PuzzlePlay => {
    const policy = (row.scoring_policy ?? {}) as { base_points?: unknown; failure_penalty_points?: unknown; speed_bonuses?: unknown };
    const finished = row.submitted_at !== null && row.submitted_at !== undefined;
    let outcome: PlayOutcome;
    if (!row.submission_id) outcome = row.day_over ? "did_not_play" : "not_started";
    else if (row.missed) outcome = "missed";
    else if (finished) outcome = row.correct ? "solved" : "failed";
    else outcome = row.overdue ? "expired" : "in_progress";
    return {
      playerId: row.player_id,
      playerName: row.display_name,
      date: row.active_date,
      outcome,
      attempts: row.submission_id && outcome !== "missed" ? row.attempts : null,
      timeTakenMs: row.time_taken_ms === null || row.time_taken_ms === undefined ? null : Number(row.time_taken_ms),
      points: row.points ?? null,
      rules: {
        maxAttempts: row.max_attempts,
        timeLimitSeconds: row.time_limit_seconds,
        basePoints: typeof policy.base_points === "number" ? policy.base_points : null,
        failurePenaltyPoints: typeof policy.failure_penalty_points === "number" ? policy.failure_penalty_points : null,
        speedBonuses: toSpeedBonuses(policy.speed_bonuses),
      },
    };
  });
  return { ruleSets: summarizeRuleSets(plays), plays };
}
