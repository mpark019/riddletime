import { isDifficulty } from "./difficulty";

interface ScheduleRulesForm {
  activeDate: string;
  playerIds?: string[];
  difficulty: string;
  timeLimitSeconds: string | null;
  maxAttempts: string;
  basePoints: string;
  failurePenaltyPoints: string;
  speedBonuses: Array<{ underSeconds: string; points: string }>;
}

export interface ManualRiddleScheduleForm extends ScheduleRulesForm {
  prompt: string;
  acceptedAnswers: string;
}

export interface CharacterScheduleForm extends ScheduleRulesForm {
  targetWord: string;
}

const MAX_TARGET_LENGTH = 50;
const MAX_CHARACTER_ATTEMPTS = 100;

const MAX_DATABASE_INTEGER = 2_147_483_647;

function wholeNumber(value: string, label: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > MAX_DATABASE_INTEGER) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${MAX_DATABASE_INTEGER}.`);
  }
  return parsed;
}

function buildRules(form: ScheduleRulesForm, maxAttemptsLimit = MAX_DATABASE_INTEGER) {
  const activeDate = form.activeDate.trim();
  const difficulty = form.difficulty.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(activeDate)) throw new Error("Choose a schedule date.");
  if (!isDifficulty(difficulty)) throw new Error("Choose a difficulty.");

  const timeLimitSeconds = form.timeLimitSeconds === null ? null : wholeNumber(form.timeLimitSeconds, "Time limit", 1);
  const maxAttempts = wholeNumber(form.maxAttempts, "Maximum attempts", 1);
  if (maxAttempts > maxAttemptsLimit) {
    throw new Error(`Maximum attempts must be at most ${maxAttemptsLimit}.`);
  }
  const basePoints = wholeNumber(form.basePoints, "Base points", 0);
  const failurePenaltyPoints = wholeNumber(form.failurePenaltyPoints, "Failure penalty", 0);
  const thresholds = new Set<number>();
  const speedBonuses = form.speedBonuses.map((bonus, index) => {
    const underSeconds = wholeNumber(bonus.underSeconds, `Speed tier ${index + 1} time`, 1);
    const underMs = underSeconds * 1000;
    const points = wholeNumber(bonus.points, `Speed tier ${index + 1} points`, 0);
    if (!Number.isSafeInteger(underMs) || (timeLimitSeconds !== null && underSeconds >= timeLimitSeconds)) {
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
    activeDate,
    difficulty,
    timeLimitSeconds,
    maxAttempts,
    scoringPolicy: {
      base_points: basePoints,
      speed_bonuses: speedBonuses,
      failure_penalty_points: failurePenaltyPoints,
    },
  };
}

function requirePlayers(playerIds: string[] | undefined) {
  if (playerIds !== undefined && playerIds.length === 0) throw new Error("Select at least one player.");
}

function targeting(playerIds: string[] | undefined) {
  return playerIds === undefined
    ? { mode: "shared" as const }
    : { mode: "personal" as const, player_ids: playerIds };
}

export function buildManualRiddleScheduleRequest(form: ManualRiddleScheduleForm) {
  const prompt = form.prompt.trim();
  const acceptedAnswers = form.acceptedAnswers
    .split("\n")
    .map((answer) => answer.trim())
    .filter(Boolean);
  if (!prompt) throw new Error("Enter the riddle prompt.");
  if (acceptedAnswers.length === 0) throw new Error("Enter at least one accepted answer.");
  const rules = buildRules(form);
  requirePlayers(form.playerIds);

  return {
    active_date: rules.activeDate,
    ...targeting(form.playerIds),
    allowed_types: ["riddle"] as ["riddle"],
    difficulty_selection: "fixed" as const,
    difficulty_presets: {
      [rules.difficulty]: {
        types: {
          riddle: {
            time_limit_seconds: rules.timeLimitSeconds,
            max_attempts: rules.maxAttempts,
            generation_settings: {},
            config: {},
            scoring_policy: rules.scoringPolicy,
          },
        },
      },
    },
    selected_difficulty: rules.difficulty,
    manual_puzzle: {
      type: "riddle" as const,
      prompt,
      accepted_answers: acceptedAnswers,
    },
  };
}

export function buildCharacterScheduleRequest(form: CharacterScheduleForm) {
  const target = form.targetWord.trim().toUpperCase();
  if (!target) throw new Error("Enter the word or code players will guess.");
  if (!/^[A-Z0-9]+$/.test(target)) {
    throw new Error("The answer can only use letters A-Z and digits 0-9, with no spaces.");
  }
  if (target.length > MAX_TARGET_LENGTH) {
    throw new Error(`The answer must be at most ${MAX_TARGET_LENGTH} characters.`);
  }
  const rules = buildRules(form, MAX_CHARACTER_ATTEMPTS);
  requirePlayers(form.playerIds);

  return {
    active_date: rules.activeDate,
    ...targeting(form.playerIds),
    allowed_types: ["character_puzzle"] as ["character_puzzle"],
    difficulty_selection: "fixed" as const,
    difficulty_presets: {
      [rules.difficulty]: {
        types: {
          character_puzzle: {
            time_limit_seconds: rules.timeLimitSeconds,
            max_attempts: rules.maxAttempts,
            generation_settings: {},
            config: {},
            scoring_policy: rules.scoringPolicy,
          },
        },
      },
    },
    selected_difficulty: rules.difficulty,
    manual_puzzle: { type: "character_puzzle" as const, target },
  };
}

export interface BankScheduleForm extends ScheduleRulesForm {
  kind: "riddle" | "character_puzzle";
  puzzleId: string;
}

export function buildBankScheduleRequest(form: BankScheduleForm) {
  if (!form.puzzleId.trim()) throw new Error("Choose a puzzle from the bank.");
  const rules = buildRules(form, form.kind === "character_puzzle" ? MAX_CHARACTER_ATTEMPTS : MAX_DATABASE_INTEGER);
  requirePlayers(form.playerIds);

  return {
    active_date: rules.activeDate,
    ...targeting(form.playerIds),
    allowed_types: [form.kind] as ["riddle" | "character_puzzle"],
    difficulty_selection: "fixed" as const,
    difficulty_presets: {
      [rules.difficulty]: {
        types: {
          [form.kind]: {
            time_limit_seconds: rules.timeLimitSeconds,
            max_attempts: rules.maxAttempts,
            generation_settings: {},
            config: {},
            scoring_policy: rules.scoringPolicy,
          },
        },
      },
    } as Record<string, { types: Record<string, object> }>,
    selected_difficulty: rules.difficulty,
    puzzle_id: form.puzzleId.trim(),
  };
}
