import "server-only";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { requireProfile, requirePlayer } from "@/server/identity/identity";
import { NotFoundError } from "@/server/http/errors";
import { gradeRiddle } from "./grading";
import { computeResult, type SpeedBonus } from "./scoring";

// Shared-mode riddles only; no personal mode or character puzzles yet.

const answerDataSchema = z.object({
  accepted: z.array(z.string().min(1)).min(1),
});

const scoringPolicySchema = z.object({
  base_points: z.number().int().nonnegative(),
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

// CHECK constraints only verify coarse JSON shape, not element types; fail with a logged error, not Zod's raw issues, since this is a stored-data problem.
function parseChallengeData(challenge: { answer_data: unknown; scoring_policy: unknown }) {
  try {
    return {
      answerData: answerDataSchema.parse(challenge.answer_data),
      scoringPolicy: scoringPolicySchema.parse(challenge.scoring_policy),
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

export async function getTodayChallenge() {
  return withTransaction(async (client) => {
    await requireProfile(client);
    const { rows } = await client.query(
      `select id, mode, allowed_types
       from daily_challenges
       where active_date = current_date and mode = 'shared'`,
    );
    const daily = rows[0];
    if (!daily) return { schedule: null };
    return {
      schedule: { id: daily.id, mode: daily.mode, allowedTypes: daily.allowed_types },
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
      `select id, prompt, time_limit_seconds, max_attempts
       from challenges where daily_challenge_id = $1 and mode = 'shared'`,
      [dailyChallengeId],
    );
    const challenge = challengeRows[0];
    if (!challenge) {
      throw new NotFoundError("Shared puzzle not yet published for today");
    }

    const { rows: inserted } = await client.query(
      `insert into submissions (challenge_id, challenge_mode, user_id)
       values ($1, 'shared', $2)
       on conflict (challenge_id, user_id) do nothing
       returning id, started_at`,
      [challenge.id, player.id],
    );
    const submission =
      inserted[0] ??
      (
        await client.query(
          "select id, started_at from submissions where challenge_id = $1 and user_id = $2",
          [challenge.id, player.id],
        )
      ).rows[0];

    return {
      submissionId: submission.id,
      challengeId: challenge.id,
      prompt: challenge.prompt,
      startedAt: submission.started_at,
      timeLimitSeconds: challenge.time_limit_seconds,
      maxAttempts: challenge.max_attempts,
    };
  });
}

export async function submitChallenge(dailyChallengeId: string, response: string) {
  return withTransaction(async (client) => {
    const player = await requirePlayer(client);

    const { rows: challengeRows } = await client.query(
      `select c.id as challenge_id, c.answer_data, c.scoring_policy, c.max_attempts,
              c.time_limit_seconds
       from challenges c
       join daily_challenges d on d.id = c.daily_challenge_id
       where d.id = $1 and c.mode = 'shared'`,
      [dailyChallengeId],
    );
    const challenge = challengeRows[0];
    if (!challenge) throw new NotFoundError("Shared puzzle not found for today");

    const { rows: submissionRows } = await client.query(
      `select id, started_at, submitted_at, correct, scoring_breakdown, attempts
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
      };
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
      const breakdown = computeResult(false, 0, [], deadlineMs);
      await client.query(
        `update submissions s
         set submitted_at = s.started_at + ($2 * interval '1 millisecond'),
             time_taken_ms = $2,
             response = $3,
             correct = false,
             attempts = s.attempts + 1,
             guess_history = s.guess_history || jsonb_build_array(
               jsonb_build_object('response', $3::text, 'correct', false)
             ),
             scoring_breakdown = $4::jsonb
         where s.id = $1`,
        [submission.id, deadlineMs, response, JSON.stringify(breakdown)],
      );
      await client.query(
        `insert into point_transactions (user_id, amount, kind, reason, submission_id, operation_key)
         values ($1, 0, 'challenge_result', 'Deadline expired', $2, $3)`,
        [player.id, submission.id, `result:${submission.id}`],
      );
      return {
        submissionId: submission.id,
        correct: false,
        scoringBreakdown: breakdown,
        finalized: true,
        alreadyFinalized: false,
        expired: true,
      };
    }

    // Parse only now: an already-finalized or expired session shouldn't fail just because stored data is malformed.
    const { answerData, scoringPolicy } = parseChallengeData(challenge);
    const correct = gradeRiddle(response, answerData.accepted);
    const isFinal = correct || submission.attempts + 1 >= challenge.max_attempts;

    if (!isFinal) {
      const { rows } = await client.query(
        `update submissions s
         set attempts = s.attempts + 1,
             response = $2,
             guess_history = s.guess_history || jsonb_build_array(
               jsonb_build_object('response', $2::text, 'correct', $3::boolean)
             )
         where s.id = $1
         returning attempts`,
        [submission.id, response, correct],
      );
      return {
        submissionId: submission.id,
        correct: false,
        finalized: false,
        alreadyFinalized: false,
        attemptsRemaining: challenge.max_attempts - rows[0].attempts,
      };
    }

    const breakdown = computeResult(
      correct,
      scoringPolicy.base_points,
      toSpeedBonuses(scoringPolicy),
      elapsedMs,
    );

    await client.query(
      `update submissions s
       set submitted_at = $2::timestamptz,
           time_taken_ms = floor(extract(epoch from ($2::timestamptz - s.started_at)) * 1000),
           response = $3,
           correct = $4,
           attempts = s.attempts + 1,
           guess_history = s.guess_history || jsonb_build_array(
             jsonb_build_object('response', $3::text, 'correct', $4::boolean)
           ),
           scoring_breakdown = $5::jsonb
       where s.id = $1`,
      [submission.id, now, response, correct, JSON.stringify(breakdown)],
    );

    await client.query(
      `insert into point_transactions (user_id, amount, kind, reason, submission_id, operation_key)
       values ($1, $2, 'challenge_result', $3, $4, $5)`,
      [
        player.id,
        breakdown.total_points,
        correct ? "Correct riddle answer" : "Incorrect riddle answer",
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
    };
  });
}
