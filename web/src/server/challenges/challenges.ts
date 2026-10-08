import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { requireProfileRead, requirePlayer } from "@/server/identity/identity";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/server/http/errors";
import { isRepeatGuess } from "@/lib/challenge-state";
import {
  characterConfigSchema,
  gradeCharacterGuess,
  normalizeCharacterGuess,
  validateCharacterGuess,
  type CharacterConfig,
  type CharacterFeedback,
} from "./character-puzzle";
import { gradeRiddle } from "./grading";
import { computeResult, type SpeedBonus } from "./scoring";

// Shared-mode puzzles only; no personal mode yet.

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
  }).passthrough(),
);

function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

async function getStaffPreview(client: PoolClient, dailyChallengeId: string) {
  const { rows } = await client.query(
    `select type, difficulty, prompt, time_limit_seconds, max_attempts, scoring_policy
     from challenges
     where daily_challenge_id = $1 and mode = 'shared'`,
    [dailyChallengeId],
  );
  const row = rows[0];
  const policy = scoringPolicySchema.safeParse(row?.scoring_policy);
  if (!row || !policy.success) return null;
  return {
    type: row.type as "riddle" | "character_puzzle",
    difficulty: row.difficulty as string,
    prompt: row.prompt as string,
    timeLimitSeconds: row.time_limit_seconds as number,
    maxAttempts: row.max_attempts as number,
    scoringPolicy: toPublicScoringPolicy(policy.data),
  };
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
    `select c.id as challenge_id, c.type, c.difficulty, c.prompt,
            c.scoring_policy, c.config, c.time_limit_seconds, c.max_attempts,
            s.id as submission_id, s.started_at, s.submitted_at, s.correct,
            s.feedback, s.guess_history, s.attempts, s.time_taken_ms,
            s.scoring_breakdown, clock_timestamp() as server_time,
            s.started_at + (c.time_limit_seconds * interval '1 second') as deadline
     from challenges c
     left join submissions s
       on s.challenge_id = c.id and s.user_id = $2
     where c.daily_challenge_id = $1 and c.mode = 'shared'`,
    [dailyChallengeId, playerId],
  );
  const row = rows[0];
  if (!row?.submission_id) {
    const policy = scoringPolicySchema.safeParse(row?.scoring_policy);
    return {
      status: "not_started" as const,
      available: Boolean(row?.challenge_id),
      difficulty: (row?.difficulty as string | undefined) ?? null,
      ...(policy.success ? { scoringPolicy: toPublicScoringPolicy(policy.data) } : {}),
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
    deadline: toIsoTimestamp(row.deadline),
    serverTime: toIsoTimestamp(row.server_time),
    timeLimitSeconds: row.time_limit_seconds,
    maxAttempts: row.max_attempts,
    attempts: row.attempts,
    attemptsRemaining: row.submitted_at
      ? 0
      : Math.max(row.max_attempts - row.attempts, 0),
    guessHistory,
    feedback: row.feedback,
    scoringPolicy,
    ...(row.type === "character_puzzle" ? { config: parseStoredCharacterConfig(row.config) } : {}),
  };

  if (!row.submitted_at) {
    return { status: "in_progress" as const, ...restored };
  }

  return {
    status: "completed" as const,
    ...restored,
    result: {
      correct: row.correct,
      timeTakenMs: Number(row.time_taken_ms),
      scoringBreakdown: row.scoring_breakdown,
    },
  };
}

async function requireSavedSharedPlayState(
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

export async function getTodayChallenge() {
  return withTransaction(async (client) => {
    const profile = await requireProfileRead(client);

    if (profile.role === "player") {
      const { rows: unresolvedRows } = await client.query(
        `select d.id, d.mode, d.allowed_types
         from submissions s
         join challenges c on c.id = s.challenge_id
         join daily_challenges d on d.id = c.daily_challenge_id
         where s.user_id = $1 and s.submitted_at is null and c.mode = 'shared'
         order by s.started_at desc
         limit 1`,
        [profile.id],
      );
      const unresolved = unresolvedRows[0];
      if (unresolved) {
        return {
          schedule: toSchedule(unresolved),
          play: await requireSavedSharedPlayState(client, unresolved.id, profile.id),
        };
      }
    }

    const { rows } = await client.query(
      `select id, mode, allowed_types
       from daily_challenges
       where active_date = current_date and mode = 'shared'`,
    );
    const daily = rows[0];
    if (!daily) return { schedule: null };
    const schedule = toSchedule(daily);

    if (profile.role !== "player") {
      const preview = await getStaffPreview(client, daily.id);
      return preview ? { schedule, preview } : { schedule };
    }
    return { schedule, play: await getSharedPlayState(client, daily.id, profile.id) };
  });
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
       where id = $1 and mode = 'shared'`,
      [dailyChallengeId],
    );
    const daily = rows[0];
    if (!daily) throw new NotFoundError("Shared challenge not found");

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
       where id = $1 and mode = 'shared' and active_date = current_date
       for update`,
      [dailyChallengeId],
    );
    if (!dailyRows[0]) {
      throw new NotFoundError("No active shared challenge for that id today");
    }

    const { rows: challengeRows } = await client.query(
      `select id
       from challenges where daily_challenge_id = $1 and mode = 'shared'`,
      [dailyChallengeId],
    );
    const challenge = challengeRows[0];
    if (!challenge) {
      throw new NotFoundError("Shared puzzle not yet published for today");
    }

    await client.query(
      `insert into submissions (challenge_id, challenge_mode, user_id)
       values ($1, 'shared', $2)
       on conflict (challenge_id, user_id) do nothing`,
      [challenge.id, player.id],
    );

    return requireSavedSharedPlayState(client, dailyChallengeId, player.id);
  });
}

export async function submitChallenge(
  dailyChallengeId: string,
  response: string | null,
  operationKey: string = randomUUID(),
) {
  return withTransaction(async (client) => {
    const player = await requirePlayer(client);

    const { rows: challengeRows } = await client.query(
      `select c.id as challenge_id, c.type, c.answer_data, c.config, c.scoring_policy,
              c.max_attempts, c.time_limit_seconds
       from challenges c
       join daily_challenges d on d.id = c.daily_challenge_id
       where d.id = $1 and c.mode = 'shared'`,
      [dailyChallengeId],
    );
    const challenge = challengeRows[0];
    if (!challenge) throw new NotFoundError("Shared puzzle not found for today");

    const { rows: submissionRows } = await client.query(
      `select id, started_at, submitted_at, correct, scoring_breakdown, attempts, guess_history
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
      rows: [{ t: now, elapsed_ms: elapsedMsRaw }],
    } = await client.query(
      `with now_at as (select clock_timestamp() as t)
       select t, floor(extract(epoch from (t - $1::timestamptz)) * 1000)::bigint as elapsed_ms
       from now_at`,
      [submission.started_at],
    );
    const elapsedMs = Number(elapsedMsRaw);
    const deadlineMs = challenge.time_limit_seconds * 1000;

    if (elapsedMs >= deadlineMs) {
      const breakdown = computeResult(
        false,
        0,
        [],
        deadlineMs,
        failurePenaltyFromStoredPolicy(challenge.scoring_policy),
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
                   'operationKey', $5::text
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
                 'feedback', $5::jsonb
               ))
             )
         where s.id = $1
         returning attempts`,
        [submission.id, storedResponse, correct, operationKey, feedback ? JSON.stringify(feedback) : null],
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
               'feedback', $7::jsonb
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
