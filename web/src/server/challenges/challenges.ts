import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { requireProfileRead, requirePlayer } from "@/server/identity/identity";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@/server/http/errors";
import { isRepeatGuess, type StaffPlayerStatusKind } from "@/lib/challenge-state";
import {
  characterConfigSchema,
  gradeCharacterGuess,
  normalizeCharacterGuess,
  validateCharacterGuess,
  type CharacterConfig,
  type CharacterFeedback,
} from "./character-puzzle";
import { gradeRiddle } from "./grading";
import { imageConfigSchema, type ImageConfig } from "./image-puzzle";
import { signPuzzleImages, submissionImageId } from "@/server/storage/puzzle-images";
import { computeResult, type SpeedBonus } from "./scoring";

const riddleAnswerDataSchema = z.object({
  accepted: z.array(z.string().min(1)).min(1),
});

const characterAnswerDataSchema = z.object({ target: z.string().min(1) });

const scoringPolicySchema = z.object({
  base_points: z.number().int().nonnegative(),
  failure_penalty_points: z.number().int().nonnegative().max(2_147_483_647).optional(),
  speed_bonuses: z
    .array(
      z.object({
        under_ms: z.number().int().positive(),
        points: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
type ScoringPolicy = z.infer<typeof scoringPolicySchema>;

const guessHistorySchema = z.array(
  z.object({
    response: z.string(),
    correct: z.boolean(),
    operationKey: z.uuid().optional(),
    offsetMs: z.number().optional(),
  }).passthrough(),
);

function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Guess timing is an admin-only signal and must not reach player-facing state.
function withoutOffset<T extends { offsetMs?: number }>(guess: T): T {
  const copy = { ...guess };
  delete copy.offsetMs;
  return copy;
}

function parseGuessHistory(guessHistory: unknown) {
  try {
    return guessHistorySchema.parse(guessHistory);
  } catch (err) {
    console.error("Malformed stored session data:", err);
    throw new Error("Stored session data is malformed");
  }
}

type PuzzleData =
  | { type: "riddle"; accepted: string[]; scoringPolicy: ScoringPolicy }
  | { type: "character_puzzle"; target: string; config: CharacterConfig; scoringPolicy: ScoringPolicy };

// CHECK constraints only verify coarse JSON shape, not element types; fail with a logged error, not Zod's raw issues, since this is a stored-data problem.
function parseChallengeData(challenge: {
  type: string;
  answer_data: unknown;
  config: unknown;
  scoring_policy: unknown;
}): PuzzleData {
  try {
    const scoringPolicy = scoringPolicySchema.parse(challenge.scoring_policy);
    if (challenge.type === "character_puzzle") {
      return {
        type: "character_puzzle",
        target: characterAnswerDataSchema.parse(challenge.answer_data).target,
        config: characterConfigSchema.parse(challenge.config),
        scoringPolicy,
      };
    }
    return {
      type: "riddle",
      accepted: riddleAnswerDataSchema.parse(challenge.answer_data).accepted,
      scoringPolicy,
    };
  } catch (err) {
    console.error("Malformed stored puzzle data:", err);
    throw new Error("Stored puzzle data is malformed");
  }
}

function toSpeedBonuses(policy: ScoringPolicy): SpeedBonus[] {
  return (policy.speed_bonuses ?? []).map((b) => ({
    underMs: b.under_ms,
    points: b.points,
  }));
}

function failurePenaltyFromStoredPolicy(scoringPolicy: unknown): number {
  const parsed = scoringPolicySchema.safeParse(scoringPolicy);
  return parsed.success ? (parsed.data.failure_penalty_points ?? 0) : 0;
}

function toSchedule(daily: { id: string; mode: string; allowed_types: string[] }) {
  return {
    id: daily.id,
    mode: daily.mode,
    allowedTypes: daily.allowed_types,
  };
}

function toPublicScoringPolicy(policy: ScoringPolicy) {
  return {
    base_points: policy.base_points,
    ...(policy.failure_penalty_points === undefined
      ? {}
      : { failure_penalty_points: policy.failure_penalty_points }),
  };
}

async function toStaffPreview(row: Record<string, unknown> | undefined) {
  const policy = scoringPolicySchema.safeParse(row?.scoring_policy);
  if (!row || !policy.success) return null;
  const config = row.type === "character_puzzle" ? characterConfigSchema.safeParse(row.config) : null;
  if (config && !config.success) return null;
  const image = row.type === "image_submission" ? imageConfigSchema.safeParse(row.config) : null;
  if (image && !image.success) return null;
  return {
    type: row.type as "riddle" | "character_puzzle" | "image_submission",
    difficulty: row.difficulty as string,
    prompt: row.prompt as string,
    timeLimitSeconds: row.time_limit_seconds as number | null,
    maxAttempts: row.max_attempts as number,
    scoringPolicy: toPublicScoringPolicy(policy.data),
    ...(policy.data.speed_bonuses ? { speedBonuses: policy.data.speed_bonuses } : {}),
    ...(config?.success ? { config: config.data } : {}),
    ...(image?.success ? await toImagePuzzleView(image.data) : {}),
  };
}

async function toImagePuzzleView(config: ImageConfig) {
  const urls = config.prompt_image_path ? await signPuzzleImages([config.prompt_image_path]) : new Map<string, string>();
  return {
    maxImages: config.max_images,
    promptImageUrl: config.prompt_image_path ? (urls.get(config.prompt_image_path) ?? null) : null,
  };
}

async function getStaffPreview(client: PoolClient, dailyChallengeId: string) {
  const { rows } = await client.query(
    `select c.type, c.difficulty, pz.prompt, c.time_limit_seconds, c.max_attempts, c.scoring_policy, pz.config
     from challenges c
     join puzzles pz on pz.id = c.puzzle_id
     where c.daily_challenge_id = $1 and c.mode = 'shared'`,
    [dailyChallengeId],
  );
  return toStaffPreview(rows[0]);
}

export async function getStaffPlayerStatuses(client: PoolClient, dailyChallengeId: string, includePlay = false) {
  const { rows } = await client.query(
    `select p.id as user_id, p.display_name, p.name,
            c.id as challenge_id, c.type, c.difficulty, c.max_attempts, c.time_limit_seconds,
            s.id as submission_id, s.submitted_at, s.correct, s.attempts, s.time_taken_ms,
            s.scoring_breakdown, s.review_state,
            s.submitted_at is null and s.review_submitted_at is null
              and riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, current_setting('timezone')) <= clock_timestamp() as overdue,
            (select sum(pt.amount)::int from point_transactions pt
              where pt.submission_id = s.id and pt.kind = 'challenge_result') as points
     from profiles p
     join daily_challenges d on d.id = $1
     left join challenges c on c.daily_challenge_id = d.id and c.assigned_to = p.id
     left join submissions s on s.challenge_id = c.id and s.user_id = p.id
     where p.role = 'player'`,
    [dailyChallengeId],
  );
  const plays = new Map<string, Awaited<ReturnType<typeof getSharedPlayState>>>();
  if (includePlay) {
    for (const row of rows) {
      if (row.challenge_id) plays.set(row.user_id, await getSharedPlayState(client, dailyChallengeId, row.user_id));
    }
  }
  return rows.map((row) => ({
    userId: row.user_id as string,
    displayName: row.display_name as string,
    name: (row.name as string | null) ?? null,
    play: plays.get(row.user_id) ?? null,
    puzzle: row.challenge_id
      ? {
        type: row.type as "riddle" | "character_puzzle" | "image_submission",
        difficulty: row.difficulty as string,
        maxAttempts: row.max_attempts as number,
        timeLimitSeconds: row.time_limit_seconds as number | null,
      }
      : null,
    status: (!row.challenge_id ? "no_riddle"
      : !row.submission_id ? "not_started"
      : row.submitted_at ? (outcomeOf(row.scoring_breakdown) === "partial" ? "partial" : row.correct ? "solved" : "failed")
      : row.review_state === "pending_review" ? "pending_review"
      : row.overdue ? "expired" : "in_progress") as StaffPlayerStatusKind,
    attempts: (row.attempts as number | null) ?? 0,
    timeTakenMs: row.time_taken_ms === null || row.time_taken_ms === undefined ? null : Number(row.time_taken_ms),
    points: (row.points as number | null) ?? null,
  }));
}

function parseStoredCharacterConfig(config: unknown): CharacterConfig {
  try {
    return characterConfigSchema.parse(config);
  } catch (err) {
    console.error("Malformed stored session data:", err);
    throw new Error("Stored session data is malformed");
  }
}

async function getSharedPlayState(
  client: PoolClient,
  dailyChallengeId: string,
  playerId: string,
) {
  const { rows } = await client.query(
    `select c.id as challenge_id, c.type, c.difficulty, pz.prompt,
            c.scoring_policy, pz.config, pz.hint, pz.hint_cost_points, c.time_limit_seconds, c.max_attempts,
            s.id as submission_id, s.started_at, s.submitted_at, s.hint_used_at, s.correct,
            s.feedback, s.guess_history, s.attempts, s.time_taken_ms,
            s.image_paths, s.note, s.review_state, s.review_comment,
            s.scoring_breakdown, clock_timestamp() as server_time,
            riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, current_setting('timezone')) as deadline
     from challenges c
     join puzzles pz on pz.id = c.puzzle_id
     join daily_challenges d on d.id = c.daily_challenge_id
     left join submissions s
       on s.challenge_id = c.id and s.user_id = $2
     where c.daily_challenge_id = $1 and (c.mode = 'shared' or c.assigned_to = $2)`,
    [dailyChallengeId, playerId],
  );
  const row = rows[0];
  if (!row?.submission_id) {
    const policy = scoringPolicySchema.safeParse(row?.scoring_policy);
    const config = row?.type === "character_puzzle" ? characterConfigSchema.safeParse(row.config) : null;
    const image = row?.type === "image_submission" ? imageConfigSchema.safeParse(row.config) : null;
    return {
      status: "not_started" as const,
      available: Boolean(row?.challenge_id),
      difficulty: (row?.difficulty as string | undefined) ?? null,
      ...(row?.type ? { type: row.type as "riddle" | "character_puzzle" | "image_submission" } : {}),
      ...(config?.success ? { targetLength: config.data.target_length } : {}),
      ...(image?.success ? { maxImages: image.data.max_images } : {}),
      ...(policy.success ? { scoringPolicy: toPublicScoringPolicy(policy.data) } : {}),
      ...(row ? toHintView(row) : {}),
    };
  }

  const guessHistory = parseGuessHistory(row.guess_history);
  const parsedScoringPolicy = scoringPolicySchema.safeParse(row.scoring_policy);
  if (!row.submitted_at && !parsedScoringPolicy.success) {
    console.error("Malformed stored session data:", parsedScoringPolicy.error);
    throw new Error("Stored session data is malformed");
  }
  // A finalized result remains readable even if old puzzle settings are malformed.
  // Completed UI uses the immutable result breakdown, not this fallback policy.
  const scoringPolicy = parsedScoringPolicy.success
    ? parsedScoringPolicy.data
    : { base_points: 0, speed_bonuses: [] };
  const restored = {
    submissionId: row.submission_id,
    challengeId: row.challenge_id,
    type: row.type,
    difficulty: row.difficulty,
    prompt: row.prompt,
    startedAt: toIsoTimestamp(row.started_at),
    deadline: row.deadline === null ? null : toIsoTimestamp(row.deadline),
    serverTime: toIsoTimestamp(row.server_time),
    timeLimitSeconds: row.time_limit_seconds,
    maxAttempts: row.max_attempts,
    attempts: row.attempts,
    attemptsRemaining: row.submitted_at
      ? 0
      : Math.max(row.max_attempts - row.attempts, 0),
    guessHistory: guessHistory.map(withoutOffset),
    feedback: row.feedback,
    scoringPolicy,
    ...toHintView(row),
    ...(row.type === "character_puzzle" ? { config: parseStoredCharacterConfig(row.config) } : {}),
    ...(row.type === "image_submission" ? await toImageSessionView(row) : {}),
  };

  if (!row.submitted_at) {
    return {
      status: row.review_state === "pending_review" ? "pending_review" as const : "in_progress" as const,
      ...restored,
    };
  }

  return {
    status: "completed" as const,
    ...restored,
    result: {
      correct: row.correct,
      timeTakenMs: Number(row.time_taken_ms),
      scoringBreakdown: row.scoring_breakdown,
      ...(row.type === "image_submission"
        ? { outcome: outcomeOf(row.scoring_breakdown), reviewComment: (row.review_comment as string | null) ?? null }
        : {}),
    },
  };
}

// The hint text leaves the server only after the player has paid for it.
function toHintView(row: Record<string, unknown>) {
  const costPoints = row.hint_cost_points;
  if (typeof costPoints !== "number") return {};
  const revealed = row.hint_used_at !== null && row.hint_used_at !== undefined;
  return { hint: { costPoints, revealed, text: revealed ? (row.hint as string) : null } };
}

function outcomeOf(breakdown: unknown): "full" | "partial" | "none" | null {
  const outcome = (breakdown as { outcome?: unknown } | null)?.outcome;
  return outcome === "full" || outcome === "partial" || outcome === "none" ? outcome : null;
}

// Images are signed only after Start, so a prompt image never reaches a player who has not begun.
async function toImageSessionView(row: Record<string, unknown>) {
  let config: ImageConfig;
  try {
    config = imageConfigSchema.parse(row.config);
  } catch (err) {
    console.error("Malformed stored session data:", err);
    throw new Error("Stored session data is malformed");
  }
  const paths = (row.image_paths as string[] | null) ?? [];
  const urls = await signPuzzleImages(
    config.prompt_image_path ? [config.prompt_image_path, ...paths] : paths,
  );
  return {
    maxImages: config.max_images,
    promptImageUrl: config.prompt_image_path ? (urls.get(config.prompt_image_path) ?? null) : null,
    images: paths.flatMap((path) => {
      const url = urls.get(path);
      return url ? [{ id: submissionImageId(path), url }] : [];
    }),
    note: (row.note as string | null) ?? null,
  };
}

export async function requireSavedSharedPlayState(
  client: PoolClient,
  dailyChallengeId: string,
  playerId: string,
) {
  const play = await getSharedPlayState(client, dailyChallengeId, playerId);
  if (play.status === "not_started") {
    throw new NotFoundError("No saved session for that challenge");
  }
  return play;
}

function resultReason(type: PuzzleData["type"], correct: boolean): string {
  const label = type === "character_puzzle" ? "character puzzle" : "riddle";
  return `${correct ? "Correct" : "Incorrect"} ${label} answer`;
}

// Character guesses are validated here so a malformed one is rejected before it can consume a try.
function gradeGuess(
  puzzle: PuzzleData,
  guess: string,
): { correct: boolean; feedback: CharacterFeedback[] | null } {
  if (puzzle.type === "riddle") {
    return { correct: gradeRiddle(guess, puzzle.accepted), feedback: null };
  }
  const invalid = validateCharacterGuess(guess, puzzle.config);
  if (invalid) throw new BadRequestError(invalid);
  return gradeCharacterGuess(puzzle.target, guess);
}

async function findUnresolvedSharedGame(client: PoolClient, playerId: string) {
  const { rows } = await client.query(
    `select d.id, d.mode, d.allowed_types
     from submissions s
     join challenges c on c.id = s.challenge_id
     join daily_challenges d on d.id = c.daily_challenge_id
     where s.user_id = $1 and s.submitted_at is null and s.review_submitted_at is null
     order by s.started_at desc
     limit 1`,
    [playerId],
  );
  return rows[0];
}

async function loadTodayChallengeIn(client: PoolClient) {
  const profile = await requireProfileRead(client);
  let finalized = 0;

  if (profile.role === "player") {
    const { rows } = await client.query(
      "select riddle_private.finalize_expired_sessions($1) as finalized",
      [profile.id],
    );
    finalized = rows[0].finalized;
    const unresolved = await findUnresolvedSharedGame(client, profile.id);
    if (unresolved) {
      return {
        finalized,
        result: {
          schedule: toSchedule(unresolved),
          play: await requireSavedSharedPlayState(client, unresolved.id, profile.id),
        },
      };
    }
  }

  const { rows } = await client.query(
    `select id, mode, allowed_types
     from daily_challenges
     where active_date = current_date`,
  );
  const daily = rows[0];
  if (!daily) return { finalized, result: { schedule: null } };
  const schedule = toSchedule(daily);

  if (profile.role !== "player") {
    if (daily.mode === "personal") {
      return { finalized, result: { schedule, playerStatuses: await getStaffPlayerStatuses(client, daily.id, profile.role === "admin") } };
    }
    const preview = await getStaffPreview(client, daily.id);
    return { finalized, result: preview ? { schedule, preview } : { schedule } };
  }
  return { finalized, result: { schedule, play: await getSharedPlayState(client, daily.id, profile.id) } };
}

export async function loadTodayChallenge() {
  return withTransaction(loadTodayChallengeIn);
}

export async function getTodayChallenge() {
  return (await loadTodayChallenge()).result;
}

export async function finalizeOverdueSessions(): Promise<number> {
  return withTransaction(async (client) => {
    const profile = await requireProfileRead(client);
    if (profile.role !== "player") return 0;
    const { rows } = await client.query(
      "select riddle_private.finalize_expired_sessions($1) as finalized",
      [profile.id],
    );
    return rows[0].finalized;
  });
}

export async function getChallengeSession(dailyChallengeId: string) {
  return withTransaction(async (client) => {
    const profile = await requireProfileRead(client);
    if (profile.role !== "player") throw new ForbiddenError("Player role required");

    const { rows } = await client.query(
      `select id, mode, allowed_types
       from daily_challenges
       where id = $1`,
      [dailyChallengeId],
    );
    const daily = rows[0];
    if (!daily) throw new NotFoundError("Challenge not found");

    return {
      schedule: toSchedule(daily),
      play: await requireSavedSharedPlayState(client, daily.id, profile.id),
    };
  });
}

export async function startChallenge(dailyChallengeId: string) {
  return withTransaction(async (client) => {
    const player = await requirePlayer(client);

    const { rows: dailyRows } = await client.query(
      `select id from daily_challenges
       where id = $1 and active_date = current_date
       for update`,
      [dailyChallengeId],
    );
    if (!dailyRows[0]) {
      throw new NotFoundError("No active challenge for that id today");
    }

    const { rows: challengeRows } = await client.query(
      `select id, mode, assigned_to
       from challenges
       where daily_challenge_id = $1 and (mode = 'shared' or assigned_to = $2)`,
      [dailyChallengeId, player.id],
    );
    const challenge = challengeRows[0];
    if (!challenge) {
      throw new NotFoundError("No puzzle for you is published for today");
    }

    await client.query(
      `insert into submissions (challenge_id, challenge_mode, assigned_to, user_id)
       values ($1, $2, $3, $4)
       on conflict (challenge_id, user_id) do nothing`,
      [challenge.id, challenge.mode, challenge.assigned_to, player.id],
    );

    return requireSavedSharedPlayState(client, dailyChallengeId, player.id);
  });
}

// Expiry for an image session is shared with the sweep: a draft with images goes to review, an empty one is penalized.
async function resolveImageSessionAtDeadline(client: PoolClient, dailyChallengeId: string, playerId: string) {
  const { rows } = await client.query(
    "select riddle_private.finalize_expired_sessions($1) as finalized",
    [playerId],
  );
  const play = await requireSavedSharedPlayState(client, dailyChallengeId, playerId);
  const finalized = rows[0].finalized > 0 && play.status === "completed";
  return {
    submissionId: "submissionId" in play ? play.submissionId : null,
    correct: play.status === "completed" ? Boolean(play.result.correct) : false,
    scoringBreakdown: play.status === "completed" ? (play.result.scoringBreakdown as unknown) : null,
    finalized,
    alreadyFinalized: false,
    play,
  };
}

export async function submitChallenge(
  dailyChallengeId: string,
  response: string | null,
  operationKey: string = randomUUID(),
) {
  return withTransaction(async (client) => {
    const player = await requirePlayer(client);

    const { rows: challengeRows } = await client.query(
      `select c.id as challenge_id, c.type, pz.answer_data, pz.config, pz.hint_cost_points, c.scoring_policy,
              c.max_attempts, c.time_limit_seconds, d.active_date::text as active_date
       from challenges c
       join puzzles pz on pz.id = c.puzzle_id
       join daily_challenges d on d.id = c.daily_challenge_id
       where d.id = $1 and (c.mode = 'shared' or c.assigned_to = $2)`,
      [dailyChallengeId, player.id],
    );
    const challenge = challengeRows[0];
    if (!challenge) throw new NotFoundError("Puzzle not found for today");

    if (challenge.type === "image_submission") {
      if (response !== null) throw new BadRequestError("Submit this puzzle's images for review instead");
      return resolveImageSessionAtDeadline(client, dailyChallengeId, player.id);
    }

    const { rows: submissionRows } = await client.query(
      `select id, started_at, submitted_at, hint_used_at, correct, scoring_breakdown, attempts, guess_history
       from submissions where challenge_id = $1 and user_id = $2 for update`,
      [challenge.challenge_id, player.id],
    );
    const submission = submissionRows[0];
    if (!submission) {
      throw new NotFoundError("Start the challenge before submitting");
    }

    if (submission.submitted_at) {
      return {
        submissionId: submission.id,
        correct: submission.correct,
        scoringBreakdown: submission.scoring_breakdown,
        finalized: true,
        alreadyFinalized: true,
        play: await requireSavedSharedPlayState(client, dailyChallengeId, player.id),
      };
    }

    // Character guesses are stored trimmed and uppercased, so retries compare on that form.
    const storedResponse = response !== null && challenge.type === "character_puzzle"
      ? normalizeCharacterGuess(response)
      : response;

    if (storedResponse !== null) {
      const previousGuess = parseGuessHistory(submission.guess_history).find(
        (guess) => guess.operationKey === operationKey,
      );
      if (previousGuess) {
        if (previousGuess.response !== storedResponse) {
          throw new BadRequestError("Operation key was already used for a different answer");
        }
        return {
          submissionId: submission.id,
          correct: previousGuess.correct,
          finalized: false,
          alreadyFinalized: false,
          duplicateOperation: true,
          attemptsRemaining: challenge.max_attempts - submission.attempts,
          play: await requireSavedSharedPlayState(client, dailyChallengeId, player.id),
        };
      }
    }

    // One clock read reused for both the stored timestamp and elapsed time, so they can't disagree.
    const {
      rows: [{ t: now, elapsed_ms: elapsedMsRaw, deadline_ms: deadlineMsRaw }],
    } = await client.query(
      `with now_at as (select clock_timestamp() as t)
       select t, floor(extract(epoch from (t - $1::timestamptz)) * 1000)::bigint as elapsed_ms,
              greatest(floor(extract(epoch from (
                riddle_private.session_deadline($1::timestamptz, $2::int, $3::date, current_setting('timezone')) - $1::timestamptz
              )) * 1000), 0)::bigint as deadline_ms
       from now_at`,
      [submission.started_at, challenge.time_limit_seconds, challenge.active_date],
    );
    const elapsedMs = Number(elapsedMsRaw);
    const deadlineMs = Number(deadlineMsRaw);
    const hintCostPoints = submission.hint_used_at ? ((challenge.hint_cost_points as number | null) ?? 0) : 0;

    if (elapsedMs >= deadlineMs) {
      const breakdown = computeResult(
        false,
        0,
        [],
        deadlineMs,
        failurePenaltyFromStoredPolicy(challenge.scoring_policy),
        hintCostPoints,
      );
      if (storedResponse === null) {
        await client.query(
          `update submissions s
           set submitted_at = s.started_at + ($2 * interval '1 millisecond'),
               time_taken_ms = $2,
               correct = false,
               scoring_breakdown = $3::jsonb
           where s.id = $1`,
          [submission.id, deadlineMs, JSON.stringify(breakdown)],
        );
      } else {
        await client.query(
          `update submissions s
           set submitted_at = s.started_at + ($2 * interval '1 millisecond'),
               time_taken_ms = $2,
               response = $3,
               correct = false,
               attempts = s.attempts + 1,
               guess_history = s.guess_history || jsonb_build_array(
                 jsonb_build_object(
                   'response', $3::text,
                   'correct', false,
                   'operationKey', $5::text,
                   'offsetMs', $2::bigint
                 )
               ),
               scoring_breakdown = $4::jsonb
           where s.id = $1`,
          [submission.id, deadlineMs, storedResponse, JSON.stringify(breakdown), operationKey],
        );
      }
      await client.query(
        `insert into point_transactions (user_id, amount, kind, reason, submission_id, operation_key)
         values ($1, $2, 'challenge_result', 'Deadline expired', $3, $4)`,
        [player.id, breakdown.total_points, submission.id, `result:${submission.id}`],
      );
      return {
        submissionId: submission.id,
        correct: false,
        scoringBreakdown: breakdown,
        finalized: true,
        alreadyFinalized: false,
        expired: true,
        play: await requireSavedSharedPlayState(client, dailyChallengeId, player.id),
      };
    }

    if (storedResponse === null) {
      throw new BadRequestError("The challenge has not expired");
    }

    // Parse only now: an already-finalized or expired session shouldn't fail just because stored data is malformed.
    const puzzle = parseChallengeData(challenge);
    const graded = gradeGuess(puzzle, storedResponse);
    const { correct, feedback } = graded;
    const scoringPolicy = puzzle.scoringPolicy;

    if (isRepeatGuess(parseGuessHistory(submission.guess_history), storedResponse)) {
      throw new BadRequestError("You already tried that answer");
    }
    const isFinal = correct || submission.attempts + 1 >= challenge.max_attempts;

    if (!isFinal) {
      const { rows } = await client.query(
        `update submissions s
         set attempts = s.attempts + 1,
             response = $2,
             feedback = $5::jsonb,
             guess_history = s.guess_history || jsonb_build_array(
               jsonb_strip_nulls(jsonb_build_object(
                 'response', $2::text,
                 'correct', $3::boolean,
                 'operationKey', $4::text,
                 'feedback', $5::jsonb,
                 'offsetMs', $6::bigint
               ))
             )
         where s.id = $1
         returning attempts`,
        [submission.id, storedResponse, correct, operationKey, feedback ? JSON.stringify(feedback) : null, elapsedMs],
      );
      return {
        submissionId: submission.id,
        correct: false,
        finalized: false,
        alreadyFinalized: false,
        attemptsRemaining: challenge.max_attempts - rows[0].attempts,
        play: await requireSavedSharedPlayState(client, dailyChallengeId, player.id),
      };
    }

    const breakdown = computeResult(
      correct,
      scoringPolicy.base_points,
      toSpeedBonuses(scoringPolicy),
      elapsedMs,
      scoringPolicy.failure_penalty_points ?? 0,
      hintCostPoints,
    );

    await client.query(
      `update submissions s
       set submitted_at = $2::timestamptz,
           time_taken_ms = floor(extract(epoch from ($2::timestamptz - s.started_at)) * 1000),
           response = $3,
           correct = $4,
           feedback = $7::jsonb,
           attempts = s.attempts + 1,
           guess_history = s.guess_history || jsonb_build_array(
             jsonb_strip_nulls(jsonb_build_object(
               'response', $3::text,
               'correct', $4::boolean,
               'operationKey', $6::text,
               'feedback', $7::jsonb,
               'offsetMs', $8::bigint
             ))
           ),
           scoring_breakdown = $5::jsonb
       where s.id = $1`,
      [
        submission.id,
        now,
        storedResponse,
        correct,
        JSON.stringify(breakdown),
        operationKey,
        feedback ? JSON.stringify(feedback) : null,
        elapsedMs,
      ],
    );

    await client.query(
      `insert into point_transactions (user_id, amount, kind, reason, submission_id, operation_key)
       values ($1, $2, 'challenge_result', $3, $4, $5)`,
      [
        player.id,
        breakdown.total_points,
        resultReason(puzzle.type, correct),
        submission.id,
        `result:${submission.id}`,
      ],
    );

    return {
      submissionId: submission.id,
      correct,
      scoringBreakdown: breakdown,
      finalized: true,
      alreadyFinalized: false,
      play: await requireSavedSharedPlayState(client, dailyChallengeId, player.id),
    };
  });
}

export async function revealHint(dailyChallengeId: string) {
  return withTransaction(async (client) => {
    const player = await requirePlayer(client);

    const { rows: challengeRows } = await client.query(
      `select c.id as challenge_id, pz.hint_cost_points, c.time_limit_seconds, d.active_date::text as active_date
       from challenges c
       join puzzles pz on pz.id = c.puzzle_id
       join daily_challenges d on d.id = c.daily_challenge_id
       where d.id = $1 and (c.mode = 'shared' or c.assigned_to = $2)`,
      [dailyChallengeId, player.id],
    );
    const challenge = challengeRows[0];
    if (!challenge) throw new NotFoundError("Puzzle not found for today");
    if (challenge.hint_cost_points === null) throw new BadRequestError("This puzzle has no hint");

    const { rows: submissionRows } = await client.query(
      `select s.id, s.submitted_at, s.review_submitted_at,
              riddle_private.session_deadline(s.started_at, $3::int, $4::date, current_setting('timezone')) <= clock_timestamp() as expired
       from submissions s where s.challenge_id = $1 and s.user_id = $2 for update`,
      [challenge.challenge_id, player.id, challenge.time_limit_seconds, challenge.active_date],
    );
    const submission = submissionRows[0];
    if (!submission) throw new NotFoundError("Start the challenge before asking for a hint");
    if (submission.submitted_at || submission.expired) {
      throw new ConflictError("This challenge is finished, so a hint can no longer be revealed");
    }

    await client.query(
      "update submissions set hint_used_at = coalesce(hint_used_at, clock_timestamp()) where id = $1",
      [submission.id],
    );
    return { play: await requireSavedSharedPlayState(client, dailyChallengeId, player.id) };
  });
}
