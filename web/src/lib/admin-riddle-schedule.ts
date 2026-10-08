export interface ManualRiddleScheduleForm {
  activeDate: string;
  difficulty: string;
  prompt: string;
  acceptedAnswers: string;
  timeLimitSeconds: string;
  maxAttempts: string;
  basePoints: string;
  failurePenaltyPoints: string;
  speedBonuses: Array<{ underSeconds: string; points: string }>;
}

const MAX_DATABASE_INTEGER = 2_147_483_647;

function wholeNumber(value: string, label: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > MAX_DATABASE_INTEGER) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${MAX_DATABASE_INTEGER}.`);
  }
  return parsed;
}

export function buildManualRiddleScheduleRequest(form: ManualRiddleScheduleForm) {
  const activeDate = form.activeDate.trim();
  const difficulty = form.difficulty.trim();
  const prompt = form.prompt.trim();
  const acceptedAnswers = form.acceptedAnswers
    .split("\n")
    .map((answer) => answer.trim())
    .filter(Boolean);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(activeDate)) throw new Error("Choose a schedule date.");
  if (!difficulty) throw new Error("Enter a difficulty name.");
  if (!prompt) throw new Error("Enter the riddle prompt.");
  if (acceptedAnswers.length === 0) throw new Error("Enter at least one accepted answer.");

  const timeLimitSeconds = wholeNumber(form.timeLimitSeconds, "Time limit", 1);
  const maxAttempts = wholeNumber(form.maxAttempts, "Maximum attempts", 1);
  const basePoints = wholeNumber(form.basePoints, "Base points", 0);
  const failurePenaltyPoints = wholeNumber(form.failurePenaltyPoints, "Failure penalty", 0);
  const thresholds = new Set<number>();
  const speedBonuses = form.speedBonuses.map((bonus, index) => {
    const underSeconds = wholeNumber(bonus.underSeconds, `Speed tier ${index + 1} time`, 1);
    const underMs = underSeconds * 1000;
    const points = wholeNumber(bonus.points, `Speed tier ${index + 1} points`, 0);
    if (!Number.isSafeInteger(underMs) || underSeconds >= timeLimitSeconds) {
      throw new Error(`Speed tier ${index + 1} must be shorter than the time limit.`);
    }
    if (thresholds.has(underMs)) throw new Error("Speed bonus times must be distinct.");
    thresholds.add(underMs);
    return { under_ms: underMs, points };
  });
  const highestBonus = Math.max(0, ...speedBonuses.map((bonus) => bonus.points));
  if (basePoints + highestBonus > MAX_DATABASE_INTEGER) {
    throw new Error("Maximum reward exceeds the database integer limit.");
  }

  return {
    active_date: activeDate,
    mode: "shared" as const,
    allowed_types: ["riddle"] as ["riddle"],
    difficulty_selection: "fixed" as const,
    difficulty_presets: {
      [difficulty]: {
        types: {
          riddle: {
            time_limit_seconds: timeLimitSeconds,
            max_attempts: maxAttempts,
            generation_settings: {},
            config: {},
            scoring_policy: {
              base_points: basePoints,
              speed_bonuses: speedBonuses,
              failure_penalty_points: failurePenaltyPoints,
            },
          },
        },
      },
    },
    selected_difficulty: difficulty,
    manual_puzzle: {
      type: "riddle" as const,
      prompt,
      accepted_answers: acceptedAnswers,
    },
  };
}
