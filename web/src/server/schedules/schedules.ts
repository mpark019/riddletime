import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { characterTargetSchema } from "@/server/challenges/character-puzzle";
import {
  buildTimeline,
  type ActivityEvent,
  type TimelineEntry,
  type TimelineGuess,
} from "@/server/challenges/activity-timeline";
import { normalizeAnswer } from "@/server/challenges/grading";
import { isPromptImagePath, removePuzzleImages } from "@/server/storage/puzzle-images";
import { loadSessionImagePaths } from "@/server/challenges/session-images";
import { requireAdmin, requireAdminRead } from "@/server/identity/identity";
import { BadRequestError, ConflictError, NotFoundError } from "@/server/http/errors";
import {
  puzzleAnswers,
  resolvePersonalPuzzle,
  resolveSharedPuzzle,
  type PuzzleSource,
} from "@/server/puzzles/puzzle-store";

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
  time_limit_seconds: z.number().int().positive().max(MAX_DATABASE_INTEGER).nullable(),
  generation_settings: z.object({}).strict().default({}),
  scoring_policy: scoringPolicySchema,
};

function refineSettings(
  settings: { time_limit_seconds: number | null; scoring_policy: z.infer<typeof scoringPolicySchema> },
  context: z.RefinementCtx,
) {
  const durationMs = settings.time_limit_seconds === null ? Infinity : settings.time_limit_seconds * 1000;
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

// An image puzzle is one submission, graded later, so it always has exactly one "try".
const imageSettingsSchema = z.object({
  ...baseSettingsShape,
  scoring_policy: scoringPolicySchema.extend({
    speed_bonuses: z.array(speedBonusSchema).max(0, "Image puzzles have no speed bonuses").default([]),
  }),
  max_attempts: z.literal(1).default(1),
  config: z.object({}).strict().default({}),
}).strict().superRefine(refineSettings);

const presetSchema = z.object({
  types: z.object({ riddle: riddleSettingsSchema }).strict(),
}).strict();

const imagePresetSchema = z.object({
  types: z.object({ image_submission: imageSettingsSchema }).strict(),
}).strict();

const characterPresetSchema = z.object({
  types: z.object({ character_puzzle: characterSettingsSchema }).strict(),
}).strict();

export const characterPuzzleSchema = z.object({
  type: z.literal("character_puzzle"),
  target: characterTargetSchema,
}).strict();

export const imagePuzzleSchema = z.object({
  type: z.literal("image_submission"),
  prompt: z.string().trim().max(10_000).default(""),
  prompt_image_path: z.string().refine(isPromptImagePath, "Upload the prompt image first").optional(),
}).strict().refine((puzzle) => puzzle.prompt.length > 0 || puzzle.prompt_image_path !== undefined, {
  message: "Provide prompt text, a prompt image, or both",
  path: ["prompt"],
});

export const manualPuzzleSchema = z.object({
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

export const presetNameSchema = z.string().trim().min(1).max(100);

export const createManualSharedRiddleInput = z.object({
  active_date: z.iso.date(),
  mode: z.literal("shared"),
  allowed_types: z.tuple([z.literal("riddle")]),
  difficulty_selection: z.literal("fixed"),
  difficulty_presets: z.record(presetNameSchema, presetSchema),
  selected_difficulty: presetNameSchema,
  generation_prompt: z.string().trim().min(1).max(5_000).optional(),
  puzzle_id: z.uuid(),
}).strict().superRefine(refineSelectedPreset);

export const createSharedCharacterPuzzleInput = z.object({
  active_date: z.iso.date(),
  mode: z.literal("shared"),
  allowed_types: z.tuple([z.literal("character_puzzle")]),
  difficulty_selection: z.literal("fixed"),
  difficulty_presets: z.record(presetNameSchema, characterPresetSchema),
  selected_difficulty: presetNameSchema,
  puzzle_id: z.uuid(),
}).strict().superRefine(refineSelectedPreset);

export const createSharedImageSubmissionInput = z.object({
  active_date: z.iso.date(),
  mode: z.literal("shared"),
  allowed_types: z.tuple([z.literal("image_submission")]),
  difficulty_selection: z.literal("fixed"),
  difficulty_presets: z.record(presetNameSchema, imagePresetSchema),
  selected_difficulty: presetNameSchema,
  puzzle_id: z.uuid(),
}).strict().superRefine(refineSelectedPreset);

const MAX_ASSIGNED_PLAYERS = 500;

const assignedPlayersShape = {
  mode: z.literal("personal"),
  player_ids: z.array(z.uuid()).min(1).max(MAX_ASSIGNED_PLAYERS),
};

function refineDistinctPlayers(input: { player_ids: string[] }, context: z.RefinementCtx) {
  if (new Set(input.player_ids).size !== input.player_ids.length) {
    context.addIssue({ code: "custom", path: ["player_ids"], message: "Each player can be selected only once" });
  }
}

export const assignPersonalRiddleInput = z.object({
  active_date: z.iso.date(),
  ...assignedPlayersShape,
  allowed_types: z.tuple([z.literal("riddle")]),
  difficulty_selection: z.literal("fixed"),
  difficulty_presets: z.record(presetNameSchema, presetSchema),
  selected_difficulty: presetNameSchema,
  puzzle_id: z.uuid(),
}).strict().superRefine(refineSelectedPreset).superRefine(refineDistinctPlayers);

export const assignPersonalCharacterInput = z.object({
  active_date: z.iso.date(),
  ...assignedPlayersShape,
  allowed_types: z.tuple([z.literal("character_puzzle")]),
  difficulty_selection: z.literal("fixed"),
  difficulty_presets: z.record(presetNameSchema, characterPresetSchema),
  selected_difficulty: presetNameSchema,
  puzzle_id: z.uuid(),
}).strict().superRefine(refineSelectedPreset).superRefine(refineDistinctPlayers);

export const assignPersonalImageInput = z.object({
  active_date: z.iso.date(),
  ...assignedPlayersShape,
  allowed_types: z.tuple([z.literal("image_submission")]),
  difficulty_selection: z.literal("fixed"),
  difficulty_presets: z.record(presetNameSchema, imagePresetSchema),
  selected_difficulty: presetNameSchema,
  puzzle_id: z.uuid(),
}).strict().superRefine(refineSelectedPreset).superRefine(refineDistinctPlayers);

export type CreateManualSharedRiddleInput = z.infer<typeof createManualSharedRiddleInput>;
export type CreateSharedCharacterPuzzleInput = z.infer<typeof createSharedCharacterPuzzleInput>;

const DUPLICATE_DATE_MESSAGE = "A riddle is already scheduled for that date";

export function isDuplicateDateViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "23505"
    && (error as { constraint?: unknown }).constraint === "daily_challenges_active_date_key";
}

interface PuzzlePlacement {
  source: PuzzleSource;
  maxAttempts: number;
  timeLimitSeconds: number | null;
  scoringPolicy: object;
}

async function insertSharedSchedule(
  client: PoolClient,
  adminId: string,
  schedule: {
    activeDate: string;
    allowedType: PuzzleSource["type"];
    presets: object;
    difficulty: string;
    generationPrompt?: string;
  },
  puzzle: PuzzlePlacement,
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

  const puzzleId = await resolveSharedPuzzle(client, puzzle.source);
  await client.query(
    `insert into challenges
       (daily_challenge_id, mode, type, puzzle_id, difficulty,
        max_attempts, time_limit_seconds, scoring_policy)
     values ($1, 'shared', $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      scheduleId,
      puzzle.source.type,
      puzzleId,
      schedule.difficulty,
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
        source: { puzzleId: parsed.puzzle_id, type: "riddle" },
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
        source: { puzzleId: parsed.puzzle_id, type: "character_puzzle" },
        maxAttempts: settings.max_attempts,
        timeLimitSeconds: settings.time_limit_seconds,
        scoringPolicy: settings.scoring_policy,
      },
    );
  }));
}

export async function createSharedImageSubmission(input: unknown) {
  return withDuplicateDateGuard(() => withTransaction(async (client) => {
    const admin = await requireAdmin(client);
    const parsed = createSharedImageSubmissionInput.parse(input);
    const settings = parsed.difficulty_presets[parsed.selected_difficulty].types.image_submission;
    return insertSharedSchedule(
      client,
      admin.id,
      {
        activeDate: parsed.active_date,
        allowedType: "image_submission",
        presets: parsed.difficulty_presets,
        difficulty: parsed.selected_difficulty,
      },
      {
        source: { puzzleId: parsed.puzzle_id, type: "image_submission" },
        maxAttempts: settings.max_attempts,
        timeLimitSeconds: settings.time_limit_seconds,
        scoringPolicy: settings.scoring_policy,
      },
    );
  }));
}

const NATIVE_SHARED_MESSAGE = "That date already has a riddle for everyone";
const ALREADY_ASSIGNED_MESSAGE = "Every selected player already has a riddle for that date";

async function lockOrCreatePersonalSchedule(
  client: PoolClient,
  adminId: string,
  schedule: { activeDate: string; presets: object },
): Promise<string> {
  const { rows } = await client.query(
    "select id, mode from daily_challenges where active_date = $1::date for update",
    [schedule.activeDate],
  );
  if (rows[0]) {
    if (rows[0].mode !== "personal") throw new ConflictError(NATIVE_SHARED_MESSAGE);
    return rows[0].id as string;
  }
  const { rows: created } = await client.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection,
        difficulty_presets, selected_difficulty, created_by)
     values ($1::date, 'personal', array['riddle', 'character_puzzle', 'image_submission']::text[],
             'random_player', $2::jsonb, null, $3)
     returning id`,
    [schedule.activeDate, JSON.stringify(schedule.presets), adminId],
  );
  return created[0].id as string;
}

async function assignPersonalPuzzles(
  client: PoolClient,
  adminId: string,
  assignment: {
    activeDate: string;
    playerIds: string[];
    presets: object;
    difficulty: string;
  },
  puzzle: PuzzlePlacement,
) {
  const { rows: dateRows } = await client.query(
    "select $1::date < current_date as is_past",
    [assignment.activeDate],
  );
  if (dateRows[0].is_past) throw new BadRequestError("Scheduled date cannot be in the past");

  const { rows: players } = await client.query(
    "select id from profiles where id = any($1::uuid[]) and role = 'player' for share",
    [assignment.playerIds],
  );
  if (players.length !== assignment.playerIds.length) {
    throw new BadRequestError("Select existing players only");
  }

  const scheduleId = await lockOrCreatePersonalSchedule(client, adminId, assignment);
  const { rows: existing } = await client.query(
    "select assigned_to from challenges where daily_challenge_id = $1 and assigned_to = any($2::uuid[])",
    [scheduleId, assignment.playerIds],
  );
  const alreadyAssigned = new Set(existing.map((row) => row.assigned_to as string));
  const assignedPlayerIds = assignment.playerIds.filter((id) => !alreadyAssigned.has(id));
  const skippedPlayerIds = assignment.playerIds.filter((id) => alreadyAssigned.has(id));
  if (assignedPlayerIds.length === 0) throw new ConflictError(ALREADY_ASSIGNED_MESSAGE);

  const puzzleId = await resolvePersonalPuzzle(client, puzzle.source, assignedPlayerIds);
  await client.query(
    `insert into challenges
       (daily_challenge_id, mode, assigned_to, type, puzzle_id, difficulty,
        max_attempts, time_limit_seconds, scoring_policy)
     select $1, 'personal', player_id, $2, $3, $4, $5, $6, $7::jsonb
     from unnest($8::uuid[]) as player_id`,
    [
      scheduleId,
      puzzle.source.type,
      puzzleId,
      assignment.difficulty,
      puzzle.maxAttempts,
      puzzle.timeLimitSeconds,
      JSON.stringify(puzzle.scoringPolicy),
      assignedPlayerIds,
    ],
  );

  return {
    scheduleId,
    activeDate: assignment.activeDate,
    status: "ready" as const,
    assignedPlayerIds,
    skippedPlayerIds,
  };
}

export async function assignPersonalRiddle(input: unknown) {
  return withDuplicateDateGuard(() => withTransaction(async (client) => {
    const admin = await requireAdmin(client);
    const parsed = assignPersonalRiddleInput.parse(input);
    const settings = parsed.difficulty_presets[parsed.selected_difficulty].types.riddle;
    return assignPersonalPuzzles(
      client,
      admin.id,
      {
        activeDate: parsed.active_date,
        playerIds: parsed.player_ids,
        presets: parsed.difficulty_presets,
        difficulty: parsed.selected_difficulty,
      },
      {
        source: { puzzleId: parsed.puzzle_id, type: "riddle" },
        maxAttempts: settings.max_attempts,
        timeLimitSeconds: settings.time_limit_seconds,
        scoringPolicy: settings.scoring_policy,
      },
    );
  }));
}

export async function assignPersonalCharacterPuzzle(input: unknown) {
  return withDuplicateDateGuard(() => withTransaction(async (client) => {
    const admin = await requireAdmin(client);
    const parsed = assignPersonalCharacterInput.parse(input);
    const settings = parsed.difficulty_presets[parsed.selected_difficulty].types.character_puzzle;
    return assignPersonalPuzzles(
      client,
      admin.id,
      {
        activeDate: parsed.active_date,
        playerIds: parsed.player_ids,
        presets: parsed.difficulty_presets,
        difficulty: parsed.selected_difficulty,
      },
      {
        source: { puzzleId: parsed.puzzle_id, type: "character_puzzle" },
        maxAttempts: settings.max_attempts,
        timeLimitSeconds: settings.time_limit_seconds,
        scoringPolicy: settings.scoring_policy,
      },
    );
  }));
}

export async function assignPersonalImageSubmission(input: unknown) {
  return withDuplicateDateGuard(() => withTransaction(async (client) => {
    const admin = await requireAdmin(client);
    const parsed = assignPersonalImageInput.parse(input);
    const settings = parsed.difficulty_presets[parsed.selected_difficulty].types.image_submission;
    return assignPersonalPuzzles(
      client,
      admin.id,
      {
        activeDate: parsed.active_date,
        playerIds: parsed.player_ids,
        presets: parsed.difficulty_presets,
        difficulty: parsed.selected_difficulty,
      },
      {
        source: { puzzleId: parsed.puzzle_id, type: "image_submission" },
        maxAttempts: settings.max_attempts,
        timeLimitSeconds: settings.time_limit_seconds,
        scoringPolicy: settings.scoring_policy,
      },
    );
  }));
}

export function isPersonalScheduleRequest(input: unknown): boolean {
  return (input as { mode?: unknown } | null)?.mode === "personal";
}

export function isCharacterScheduleRequest(input: unknown): boolean {
  const allowed = (input as { allowed_types?: unknown } | null)?.allowed_types;
  return Array.isArray(allowed) && allowed.includes("character_puzzle");
}

export function isImageScheduleRequest(input: unknown): boolean {
  const allowed = (input as { allowed_types?: unknown } | null)?.allowed_types;
  return Array.isArray(allowed) && allowed.includes("image_submission");
}

export interface ScheduledRiddle {
  id: string;
  activeDate: string;
  mode: "shared" | "personal";
  assignedCount: number;
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

export interface AssignedPuzzle {
  type: string;
  name: string | null;
  difficulty: string;
  prompt: string;
  acceptedAnswers: string[];
  maxAttempts: number;
  timeLimitSeconds: number | null;
}

export interface ScheduledRiddlePlayer {
  userId: string;
  displayName: string;
  status: "not_assigned" | "not_started" | "in_progress" | "pending_review" | "expired" | "completed";
  puzzle: AssignedPuzzle | null;
  correct: boolean | null;
  attempts: number;
  guesses: Array<{ response: string; correct: boolean }>;
  timeline: TimelineEntry[];
  startedAt: string | null;
  submittedAt: string | null;
  timeTakenMs: number | null;
  points: number | null;
  breakdown: { basePoints: number; speedBonusPoints: number; penaltyPoints: number } | null;
  missed: boolean;
  outcome: "full" | "partial" | "none" | null;
  reviewComment: string | null;
}

async function selectSchedules(client: PoolClient, scheduleId: string | null): Promise<ScheduledRiddle[]> {
  const { rows } = await client.query(
    `select d.id, d.active_date::text as active_date,
            case when d.active_date < current_date then 'past'
                 when d.active_date = current_date then 'today'
                 else 'upcoming' end as timing,
            d.mode, c.type, d.selected_difficulty, pz.prompt, pz.answer_data, c.time_limit_seconds,
            c.max_attempts, c.scoring_policy,
            (select count(*)::int from challenges x where x.daily_challenge_id = d.id) as assigned_count,
            (select count(*)::int from submissions s
              join challenges x on x.id = s.challenge_id
              where x.daily_challenge_id = d.id) as started_count,
            (select count(s.submitted_at)::int from submissions s
              join challenges x on x.id = s.challenge_id
              where x.daily_challenge_id = d.id) as finished_count
     from daily_challenges d
     left join challenges c on c.daily_challenge_id = d.id and c.mode = 'shared'
     left join puzzles pz on pz.id = c.puzzle_id
     where $1::uuid is null or d.id = $1
     order by d.active_date desc`,
    [scheduleId],
  );
  return rows.map((row) => ({
    id: row.id,
    activeDate: row.active_date,
    mode: row.mode,
    assignedCount: row.assigned_count,
    timing: row.timing,
    type: row.type,
    difficulty: row.selected_difficulty,
    prompt: row.prompt,
    acceptedAnswers: puzzleAnswers(row.answer_data),
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

function toTimelineGuesses(history: unknown): TimelineGuess[] {
  if (!Array.isArray(history)) return [];
  return history.flatMap((guess) =>
    typeof guess?.response === "string" && typeof guess?.correct === "boolean"
      ? [{
        response: guess.response,
        correct: guess.correct,
        offsetMs: typeof guess.offsetMs === "number" ? guess.offsetMs : null,
      }]
      : [],
  );
}

async function loadActivityBySubmission(client: PoolClient, scheduleId: string) {
  const { rows } = await client.query(
    `select a.submission_id, a.kind, a.at
     from submission_activity a
     join submissions s on s.id = a.submission_id
     join challenges c on c.id = s.challenge_id
     where c.daily_challenge_id = $1
     order by a.at, a.id`,
    [scheduleId],
  );
  const bySubmission = new Map<string, ActivityEvent[]>();
  for (const row of rows) {
    const events = bySubmission.get(row.submission_id) ?? [];
    events.push({ kind: row.kind, atMs: new Date(row.at).getTime() });
    bySubmission.set(row.submission_id, events);
  }
  return bySubmission;
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
              c.id as challenge_id, c.type, c.difficulty, pz.name as puzzle_name, pz.prompt, pz.answer_data,
              c.max_attempts, c.time_limit_seconds,
              s.id as submission_id, s.started_at, s.submitted_at, s.correct,
              s.attempts, s.guess_history, s.time_taken_ms, s.scoring_breakdown, s.review_comment, s.review_submitted_at,
              coalesce(s.scoring_breakdown @> '{"missed": true}', false) as missed,
              coalesce(s.scoring_breakdown @> '{"outcome": "partial"}', false) as partial,
              s.review_state,
              s.submitted_at is null and s.review_submitted_at is null
                and riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, current_setting('timezone')) <= clock_timestamp() as overdue,
              coalesce(s.submitted_at, s.review_submitted_at, least(
                riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, current_setting('timezone')),
                clock_timestamp())) as session_end,
              (select sum(pt.amount)::int from point_transactions pt
                where pt.submission_id = s.id and pt.kind = 'challenge_result') as points
       from profiles p
       join daily_challenges d on d.id = $1
       left join challenges c on c.daily_challenge_id = d.id and (c.mode = 'shared' or c.assigned_to = p.id)
       left join puzzles pz on pz.id = c.puzzle_id
       left join submissions s on s.challenge_id = c.id and s.user_id = p.id
       where p.role = 'player'
       order by (s.id is null), (c.id is null), s.started_at, lower(p.display_name), p.id`,
      [id],
    );
    const activity = await loadActivityBySubmission(client, id);
    const players = rows.map((row): ScheduledRiddlePlayer => ({
      userId: row.user_id,
      displayName: row.display_name,
      status: !row.submission_id ? (!row.challenge_id && schedule.mode === "personal" ? "not_assigned" : "not_started")
        : row.submitted_at ? "completed"
        : row.review_state === "pending_review" ? "pending_review"
        : row.overdue ? "expired" : "in_progress",
      correct: row.correct,
      attempts: row.attempts ?? 0,
      puzzle: schedule.mode === "personal" && row.challenge_id
        ? {
          type: row.type,
          name: row.puzzle_name ?? null,
          difficulty: row.difficulty,
          prompt: row.prompt,
          acceptedAnswers: puzzleAnswers(row.answer_data),
          maxAttempts: row.max_attempts,
          timeLimitSeconds: row.time_limit_seconds,
        }
        : null,
      guesses: toGuesses(row.guess_history),
      timeline: row.submission_id
        ? buildTimeline({
          startedAtMs: new Date(row.started_at).getTime(),
          endMs: new Date(row.session_end ?? row.started_at).getTime(),
          events: activity.get(row.submission_id) ?? [],
          guesses: toTimelineGuesses(row.guess_history),
          submittedAtMs: row.review_submitted_at ? new Date(row.review_submitted_at).getTime() : null,
        })
        : [],
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
      submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
      timeTakenMs: row.time_taken_ms === null || row.time_taken_ms === undefined ? null : Number(row.time_taken_ms),
      points: row.points ?? null,
      breakdown: toBreakdown(row.scoring_breakdown),
      missed: row.missed,
      outcome: ["full", "partial", "none"].includes(row.scoring_breakdown?.outcome) ? row.scoring_breakdown.outcome : null,
      reviewComment: row.review_comment ?? null,
    }));
    return { schedule, players };
  });
}

export async function deleteSchedule(id: string): Promise<{ id: string; removedResults: number }> {
  const { result, imagePaths } = await withTransaction(async (client) => {
    const admin = await requireAdmin(client);
    const imagePaths = await loadSessionImagePaths(client, { scheduleId: id });
    try {
      const { rows } = await client.query(
        "select riddle_private.delete_schedule($1, $2) as removed_results",
        [id, admin.id],
      );
      return { result: { id, removedResults: rows[0].removed_results as number }, imagePaths };
    } catch (error) {
      if ((error as { code?: unknown }).code === "P0002") throw new NotFoundError("Riddle not found");
      throw error;
    }
  });
  await removePuzzleImages(imagePaths);
  return result;
}

export interface DateAssignment {
  playerId: string | null;
  challengeId: string;
  type: string;
  name: string | null;
  difficulty: string;
  prompt: string;
  status: "not_started" | "in_progress" | "pending_review" | "expired" | "completed";
  correct: boolean | null;
  points: number | null;
  missed: boolean;
  partial: boolean;
}

export interface DateRoster {
  scheduleId: string | null;
  mode: "shared" | "personal" | null;
  assignments: DateAssignment[];
}

export async function getDateAssignments(activeDate: string): Promise<DateRoster> {
  const date = z.iso.date().parse(activeDate);
  return withTransaction(async (client) => {
    await requireAdminRead(client);
    const { rows } = await client.query(
      `select d.id as schedule_id, d.mode, c.id as challenge_id, c.assigned_to, c.type,
              c.difficulty, pz.name as puzzle_name, pz.prompt, s.id as submission_id, s.submitted_at, s.correct,
              coalesce(s.scoring_breakdown @> '{"missed": true}', false) as missed,
              s.review_state,
              s.submitted_at is null and s.review_submitted_at is null
                and riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, current_setting('timezone')) <= clock_timestamp() as overdue,
              (select sum(pt.amount)::int from point_transactions pt
                where pt.submission_id = s.id and pt.kind = 'challenge_result') as points
       from daily_challenges d
       left join challenges c on c.daily_challenge_id = d.id
       left join puzzles pz on pz.id = c.puzzle_id
       left join submissions s on s.challenge_id = c.id
       where d.active_date = $1::date
       order by c.created_at, s.started_at`,
      [date],
    );
    if (rows.length === 0) return { scheduleId: null, mode: null, assignments: [] };
    const sharedSeen = new Set<string>();
    const assignments = rows.flatMap((row): DateAssignment[] => {
      if (row.challenge_id === null) return [];
      if (row.mode === "shared") {
        if (sharedSeen.has(row.challenge_id)) return [];
        sharedSeen.add(row.challenge_id);
      }
      return [{
        playerId: row.assigned_to,
        challengeId: row.challenge_id,
        type: row.type,
        name: row.puzzle_name ?? null,
        difficulty: row.difficulty,
        prompt: row.prompt,
        status: !row.submission_id || row.mode === "shared" ? "not_started"
          : row.submitted_at ? "completed"
          : row.review_state === "pending_review" ? "pending_review"
          : row.overdue ? "expired" : "in_progress",
        correct: row.mode === "shared" ? null : row.correct,
        points: row.mode === "shared" ? null : row.points,
        missed: row.mode !== "shared" && row.missed,
        partial: row.mode !== "shared" && row.partial,
      }];
    });
    return { scheduleId: rows[0].schedule_id, mode: rows[0].mode, assignments };
  });
}

export async function removeAssignment(
  challengeId: string,
): Promise<{ challengeId: string; removedResults: number; scheduleRemoved: boolean }> {
  const { result, imagePaths } = await withTransaction(async (client) => {
    const admin = await requireAdmin(client);
    const imagePaths = await loadSessionImagePaths(client, { challengeId });
    try {
      const { rows } = await client.query(
        "select riddle_private.delete_assignment($1, $2) as outcome",
        [challengeId, admin.id],
      );
      return {
        result: {
          challengeId,
          removedResults: rows[0].outcome.removed_results as number,
          scheduleRemoved: rows[0].outcome.schedule_removed as boolean,
        },
        imagePaths,
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "P0002") throw new NotFoundError("Assignment not found");
      if (code === "22023") throw new ConflictError("Only personal assignments can be removed");
      throw error;
    }
  });
  await removePuzzleImages(imagePaths);
  return result;
}
