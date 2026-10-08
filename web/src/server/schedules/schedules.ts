import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import {
  CHARACTER_SET,
  characterTargetSchema,
  type CharacterConfig,
} from "@/server/challenges/character-puzzle";
import { normalizeAnswer } from "@/server/challenges/grading";
import { requireAdmin, requireAdminRead } from "@/server/identity/identity";
import { BadRequestError, ConflictError, NotFoundError } from "@/server/http/errors";

const MAX_DATABASE_INTEGER = 2_147_483_647;
const MAX_PRESETS = 20;
const MAX_SPEED_BONUSES = 20;
const MAX_ACCEPTED_ANSWERS = 50;
const MAX_CHARACTER_ATTEMPTS = 100;

const speedBonusSchema = z.object({
  under_ms: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  points: z.number().int().nonnegative().max(MAX_DATABASE_INTEGER),
}).strict();

const scoringPolicySchema = z.object({
  base_points: z.number().int().nonnegative().max(MAX_DATABASE_INTEGER),
  speed_bonuses: z.array(speedBonusSchema).max(MAX_SPEED_BONUSES).default([]),
  failure_penalty_points: z.number().int().nonnegative().max(MAX_DATABASE_INTEGER).default(0),
}).strict();

const baseSettingsShape = {
  time_limit_seconds: z.number().int().positive().max(MAX_DATABASE_INTEGER),
  generation_settings: z.object({}).strict().default({}),
  scoring_policy: scoringPolicySchema,
};

function refineSettings(
  settings: { time_limit_seconds: number; scoring_policy: z.infer<typeof scoringPolicySchema> },
  context: z.RefinementCtx,
) {
  const durationMs = settings.time_limit_seconds * 1000;
  const thresholds = new Set<number>();
  for (const [index, bonus] of settings.scoring_policy.speed_bonuses.entries()) {
    if (bonus.under_ms >= durationMs) {
      context.addIssue({
        code: "custom",
        path: ["scoring_policy", "speed_bonuses", index, "under_ms"],
        message: "Speed bonus thresholds must be shorter than the time limit",
      });
    }
    if (thresholds.has(bonus.under_ms)) {
      context.addIssue({
        code: "custom",
        path: ["scoring_policy", "speed_bonuses", index, "under_ms"],
        message: "Speed bonus thresholds must be distinct",
      });
    }
    thresholds.add(bonus.under_ms);
  }

  const highestBonus = Math.max(
    0,
    ...settings.scoring_policy.speed_bonuses.map((bonus) => bonus.points),
  );
  if (settings.scoring_policy.base_points + highestBonus > MAX_DATABASE_INTEGER) {
    context.addIssue({
      code: "custom",
      path: ["scoring_policy"],
      message: "Maximum reward exceeds the database integer limit",
    });
  }
}

const riddleSettingsSchema = z.object({
  ...baseSettingsShape,
  max_attempts: z.number().int().positive().max(MAX_DATABASE_INTEGER).default(1),
  config: z.object({}).strict().default({}),
}).strict().superRefine(refineSettings);

const characterSettingsSchema = z.object({
  ...baseSettingsShape,
  max_attempts: z.number().int().positive().max(MAX_CHARACTER_ATTEMPTS),
  config: z.object({}).strict().default({}),
}).strict().superRefine(refineSettings);

const presetSchema = z.object({
  types: z.object({ riddle: riddleSettingsSchema }).strict(),
}).strict();

const characterPresetSchema = z.object({
  types: z.object({ character_puzzle: characterSettingsSchema }).strict(),
}).strict();

const characterPuzzleSchema = z.object({
  type: z.literal("character_puzzle"),
  target: characterTargetSchema,
}).strict();

const manualPuzzleSchema = z.object({
  type: z.literal("riddle"),
  prompt: z.string().trim().min(1).max(10_000),
  accepted_answers: z.array(z.string().trim().min(1).max(500))
    .min(1)
    .max(MAX_ACCEPTED_ANSWERS),
}).strict().superRefine((puzzle, context) => {
  const seen = new Set<string>();
  for (const [index, answer] of puzzle.accepted_answers.entries()) {
    const normalized = normalizeAnswer(answer);
    if (!normalized) {
      context.addIssue({
        code: "custom",
        path: ["accepted_answers", index],
        message: "Accepted answers must contain letters or numbers",
      });
    } else if (seen.has(normalized)) {
      context.addIssue({
        code: "custom",
        path: ["accepted_answers", index],
        message: "Accepted answers must be distinct after normalization",
      });
    }
    seen.add(normalized);
  }
});

function refineSelectedPreset(
  input: { difficulty_presets: Record<string, unknown>; selected_difficulty: string },
  context: z.RefinementCtx,
) {
  const presetNames = Object.keys(input.difficulty_presets);
  if (presetNames.length === 0 || presetNames.length > MAX_PRESETS) {
    context.addIssue({
      code: "custom",
      path: ["difficulty_presets"],
      message: `Provide between 1 and ${MAX_PRESETS} difficulty presets`,
    });
  }
  if (!Object.hasOwn(input.difficulty_presets, input.selected_difficulty)) {
    context.addIssue({
      code: "custom",
      path: ["selected_difficulty"],
      message: "Selected difficulty must name one of the submitted presets",
    });
  }
}

const presetNameSchema = z.string().trim().min(1).max(100);

export const createManualSharedRiddleInput = z.object({
  active_date: z.iso.date(),
  mode: z.literal("shared"),
  allowed_types: z.tuple([z.literal("riddle")]),
  difficulty_selection: z.literal("fixed"),
  difficulty_presets: z.record(presetNameSchema, presetSchema),
  selected_difficulty: presetNameSchema,
  generation_prompt: z.string().trim().min(1).max(5_000).optional(),
  manual_puzzle: manualPuzzleSchema,
}).strict().superRefine(refineSelectedPreset);

export const createSharedCharacterPuzzleInput = z.object({
  active_date: z.iso.date(),
  mode: z.literal("shared"),
  allowed_types: z.tuple([z.literal("character_puzzle")]),
  difficulty_selection: z.literal("fixed"),
  difficulty_presets: z.record(presetNameSchema, characterPresetSchema),
  selected_difficulty: presetNameSchema,
  manual_puzzle: characterPuzzleSchema,
}).strict().superRefine(refineSelectedPreset);

export type CreateManualSharedRiddleInput = z.infer<typeof createManualSharedRiddleInput>;
export type CreateSharedCharacterPuzzleInput = z.infer<typeof createSharedCharacterPuzzleInput>;

const DUPLICATE_DATE_MESSAGE = "A riddle is already scheduled for that date";

export function isDuplicateDateViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "23505"
    && (error as { constraint?: unknown }).constraint === "daily_challenges_active_date_key";
}

interface SharedPuzzleRow {
  type: "riddle" | "character_puzzle";
  prompt: string;
  config: object;
  answerData: object;
  maxAttempts: number;
  timeLimitSeconds: number;
  scoringPolicy: object;
}

async function insertSharedSchedule(
  client: PoolClient,
  adminId: string,
  schedule: {
    activeDate: string;
    allowedType: SharedPuzzleRow["type"];
    presets: object;
    difficulty: string;
    generationPrompt?: string;
  },
  puzzle: SharedPuzzleRow,
) {
  const { rows: dateRows } = await client.query(
    `select $1::date < current_date as is_past,
            exists(select 1 from daily_challenges where active_date = $1::date) as already_exists`,
    [schedule.activeDate],
  );
  if (dateRows[0].is_past) {
    throw new BadRequestError("Scheduled date cannot be in the past");
  }
  if (dateRows[0].already_exists) {
    throw new ConflictError(DUPLICATE_DATE_MESSAGE);
  }

  const { rows: scheduleRows } = await client.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection,
        difficulty_presets, selected_difficulty, generation_prompt, created_by)
     values ($1::date, 'shared', array[$2]::text[], 'fixed', $3::jsonb, $4, $5, $6)
     returning id`,
    [
      schedule.activeDate,
      schedule.allowedType,
      JSON.stringify(schedule.presets),
      schedule.difficulty,
      schedule.generationPrompt ?? null,
      adminId,
    ],
  );
  const scheduleId = scheduleRows[0].id as string;

  await client.query(
    `insert into challenges
       (daily_challenge_id, mode, type, difficulty, prompt, config,
        answer_data, max_attempts, time_limit_seconds, scoring_policy)
     values ($1, 'shared', $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb)`,
    [
      scheduleId,
      puzzle.type,
      schedule.difficulty,
      puzzle.prompt,
      JSON.stringify(puzzle.config),
      JSON.stringify(puzzle.answerData),
      puzzle.maxAttempts,
      puzzle.timeLimitSeconds,
      JSON.stringify(puzzle.scoringPolicy),
    ],
  );

  return { scheduleId, activeDate: schedule.activeDate, status: "ready" as const };
}

async function withDuplicateDateGuard<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (isDuplicateDateViolation(error)) throw new ConflictError(DUPLICATE_DATE_MESSAGE);
    throw error;
  }
}

export async function createManualSharedRiddle(input: unknown) {
  return withDuplicateDateGuard(() => withTransaction(async (client) => {
    const admin = await requireAdmin(client);
    const parsed = createManualSharedRiddleInput.parse(input);
    const settings = parsed.difficulty_presets[parsed.selected_difficulty].types.riddle;
    return insertSharedSchedule(
      client,
      admin.id,
      {
        activeDate: parsed.active_date,
        allowedType: "riddle",
        presets: parsed.difficulty_presets,
        difficulty: parsed.selected_difficulty,
        generationPrompt: parsed.generation_prompt,
      },
      {
        type: "riddle",
        prompt: parsed.manual_puzzle.prompt,
        config: settings.config,
        answerData: { accepted: parsed.manual_puzzle.accepted_answers },
        maxAttempts: settings.max_attempts,
        timeLimitSeconds: settings.time_limit_seconds,
        scoringPolicy: settings.scoring_policy,
      },
    );
  }));
}

export async function createSharedCharacterPuzzle(input: unknown) {
  return withDuplicateDateGuard(() => withTransaction(async (client) => {
    const admin = await requireAdmin(client);
    const parsed = createSharedCharacterPuzzleInput.parse(input);
    const settings = parsed.difficulty_presets[parsed.selected_difficulty].types.character_puzzle;
    const target = parsed.manual_puzzle.target;
    const config: CharacterConfig = { target_length: target.length, character_set: CHARACTER_SET };
    return insertSharedSchedule(
      client,
      admin.id,
      {
        activeDate: parsed.active_date,
        allowedType: "character_puzzle",
        presets: parsed.difficulty_presets,
        difficulty: parsed.selected_difficulty,
      },
      {
        type: "character_puzzle",
        prompt: "Letter game",
        config,
        answerData: { target },
        maxAttempts: settings.max_attempts,
        timeLimitSeconds: settings.time_limit_seconds,
        scoringPolicy: settings.scoring_policy,
      },
    );
  }));
}

export function isCharacterScheduleRequest(input: unknown): boolean {
  const allowed = (input as { allowed_types?: unknown } | null)?.allowed_types;
  return Array.isArray(allowed) && allowed.includes("character_puzzle");
}

export interface ScheduledRiddle {
  id: string;
  activeDate: string;
  timing: "past" | "today" | "upcoming";
  type: string | null;
  difficulty: string | null;
  prompt: string | null;
  acceptedAnswers: string[];
  timeLimitSeconds: number | null;
  maxAttempts: number | null;
  scoringPolicy: unknown;
  startedCount: number;
  finishedCount: number;
}

export interface ScheduledRiddlePlayer {
  userId: string;
  displayName: string;
  status: "not_started" | "in_progress" | "expired" | "completed";
  correct: boolean | null;
  attempts: number;
  guesses: Array<{ response: string; correct: boolean }>;
  startedAt: string | null;
  submittedAt: string | null;
  timeTakenMs: number | null;
  points: number | null;
  breakdown: { basePoints: number; speedBonusPoints: number; penaltyPoints: number } | null;
}

function adminAnswers(answerData: { accepted?: unknown; target?: unknown } | null): string[] {
  if (Array.isArray(answerData?.accepted)) return answerData.accepted;
  return typeof answerData?.target === "string" ? [answerData.target] : [];
}

async function selectSchedules(client: PoolClient, scheduleId: string | null): Promise<ScheduledRiddle[]> {
  const { rows } = await client.query(
    `select d.id, d.active_date::text as active_date,
            case when d.active_date < current_date then 'past'
                 when d.active_date = current_date then 'today'
                 else 'upcoming' end as timing,
            c.type, d.selected_difficulty, c.prompt, c.answer_data, c.time_limit_seconds,
            c.max_attempts, c.scoring_policy,
            count(s.id)::int as started_count,
            count(s.submitted_at)::int as finished_count
     from daily_challenges d
     left join challenges c on c.daily_challenge_id = d.id and c.mode = 'shared'
     left join submissions s on s.challenge_id = c.id
     where $1::uuid is null or d.id = $1
     group by d.id, c.id
     order by d.active_date desc`,
    [scheduleId],
  );
  return rows.map((row) => ({
    id: row.id,
    activeDate: row.active_date,
    timing: row.timing,
    type: row.type,
    difficulty: row.selected_difficulty,
    prompt: row.prompt,
    acceptedAnswers: adminAnswers(row.answer_data),
    timeLimitSeconds: row.time_limit_seconds,
    maxAttempts: row.max_attempts,
    scoringPolicy: row.scoring_policy,
    startedCount: row.started_count,
    finishedCount: row.finished_count,
  }));
}

export async function listSchedules(): Promise<ScheduledRiddle[]> {
  return withTransaction(async (client) => {
    await requireAdminRead(client);
    return selectSchedules(client, null);
  });
}

function toGuesses(history: unknown): ScheduledRiddlePlayer["guesses"] {
  if (!Array.isArray(history)) return [];
  return history.flatMap((guess) =>
    typeof guess?.response === "string" && typeof guess?.correct === "boolean"
      ? [{ response: guess.response, correct: guess.correct }]
      : [],
  );
}

function toBreakdown(value: unknown): ScheduledRiddlePlayer["breakdown"] {
  if (typeof value !== "object" || value === null) return null;
  const { base_points, speed_bonus_points, penalty_points } = value as Record<string, unknown>;
  if (typeof base_points !== "number") return null;
  return {
    basePoints: base_points,
    speedBonusPoints: typeof speed_bonus_points === "number" ? speed_bonus_points : 0,
    penaltyPoints: typeof penalty_points === "number" ? penalty_points : 0,
  };
}

export async function getScheduleDetail(
  id: string,
): Promise<{ schedule: ScheduledRiddle; players: ScheduledRiddlePlayer[] }> {
  return withTransaction(async (client) => {
    await requireAdminRead(client);
    const [schedule] = await selectSchedules(client, id);
    if (!schedule) throw new NotFoundError("Riddle not found");

    const { rows } = await client.query(
      `select p.id as user_id, p.display_name,
              s.id as submission_id, s.started_at, s.submitted_at, s.correct,
              s.attempts, s.guess_history, s.time_taken_ms, s.scoring_breakdown,
              s.submitted_at is null
                and s.started_at + c.time_limit_seconds * interval '1 second' <= clock_timestamp() as overdue,
              (select sum(pt.amount)::int from point_transactions pt
                where pt.submission_id = s.id and pt.kind = 'challenge_result') as points
       from profiles p
       left join challenges c on c.daily_challenge_id = $1 and c.mode = 'shared'
       left join submissions s on s.challenge_id = c.id and s.user_id = p.id
       where p.role = 'player'
       order by (s.id is null), s.started_at, lower(p.display_name), p.id`,
      [id],
    );
    const players = rows.map((row): ScheduledRiddlePlayer => ({
      userId: row.user_id,
      displayName: row.display_name,
      status: !row.submission_id ? "not_started"
        : row.submitted_at ? "completed"
        : row.overdue ? "expired" : "in_progress",
      correct: row.correct,
      attempts: row.attempts ?? 0,
      guesses: toGuesses(row.guess_history),
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
      submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
      timeTakenMs: row.time_taken_ms === null || row.time_taken_ms === undefined ? null : Number(row.time_taken_ms),
      points: row.points ?? null,
      breakdown: toBreakdown(row.scoring_breakdown),
    }));
    return { schedule, players };
  });
}

export async function deleteSchedule(id: string): Promise<{ id: string; removedResults: number }> {
  return withTransaction(async (client) => {
    const admin = await requireAdmin(client);
    try {
      const { rows } = await client.query(
        "select riddle_private.delete_schedule($1, $2) as removed_results",
        [id, admin.id],
      );
      return { id, removedResults: rows[0].removed_results };
    } catch (error) {
      if ((error as { code?: unknown }).code === "P0002") throw new NotFoundError("Riddle not found");
      throw error;
    }
  });
}
