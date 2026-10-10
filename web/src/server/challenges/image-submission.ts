import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { requireAdmin, requireAdminRead, requirePlayer } from "@/server/identity/identity";
import { BadRequestError, ConflictError, NotFoundError } from "@/server/http/errors";
import { readImageFile } from "@/server/storage/image-file";
import {
  newSubmissionImagePath,
  removePuzzleImages,
  signPuzzleImages,
  submissionImageId,
  uploadPuzzleImage,
} from "@/server/storage/puzzle-images";
import { requireSavedSharedPlayState } from "./challenges";
import { MAX_ACTIVITY_EVENTS } from "./activity";
import {
  computeReviewResult,
  imageConfigSchema,
  noteSchema,
  reviewInputSchema,
  type ReviewOutcome,
} from "./image-puzzle";

// Routes pass the body reader itself, so it runs only after the role check.
type LazyInput = unknown | (() => Promise<unknown>);

async function resolveInput(input: LazyInput): Promise<unknown> {
  return typeof input === "function" ? (input as () => Promise<unknown>)() : input;
}

interface ImageSession {
  id: string;
  reviewState: string | null;
  submittedAt: Date | null;
  imagePaths: string[];
  maxImages: number;
  expired: boolean;
}

// The row lock serializes player edits with submit, the expiry sweep, and grading.
async function lockImageSession(
  client: PoolClient,
  dailyChallengeId: string,
  playerId: string,
): Promise<ImageSession> {
  const { rows } = await client.query(
    `select s.id, s.review_state, s.submitted_at, s.image_paths, pz.config,
            coalesce(riddle_private.session_deadline(s.started_at, c.time_limit_seconds, d.active_date, current_setting('timezone')) <= clock_timestamp(), false) as expired
     from daily_challenges d
     join challenges c on c.daily_challenge_id = d.id and (c.mode = 'shared' or c.assigned_to = $2)
     join puzzles pz on pz.id = c.puzzle_id
     join submissions s on s.challenge_id = c.id and s.user_id = $2
     where d.id = $1 and c.type = 'image_submission'
     for update of s`,
    [dailyChallengeId, playerId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("No saved image session for that challenge");
  const config = imageConfigSchema.safeParse(row.config);
  if (!config.success) throw new Error("Stored puzzle data is malformed");
  return {
    id: row.id,
    reviewState: row.review_state,
    submittedAt: row.submitted_at,
    imagePaths: row.image_paths,
    maxImages: config.data.max_images,
    expired: row.expired,
  };
}

// Part of the admin timeline; skipped once the session's event cap is reached, like client activity.
async function recordImageEvent(client: PoolClient, sessionId: string, kind: "image_added" | "image_removed") {
  await client.query(
    `insert into submission_activity (submission_id, kind)
     select $1, $2
     where (select count(*) from submission_activity where submission_id = $1) < $3`,
    [sessionId, kind, MAX_ACTIVITY_EVENTS],
  );
}

function requireEditableDraft(session: ImageSession) {
  if (session.reviewState || session.submittedAt) {
    throw new ConflictError("This submission has already been sent for review");
  }
  if (session.expired) throw new BadRequestError("Time is up for this puzzle");
}

// Storage work happens outside any transaction so a slow upload never holds a connection or a row lock.
export async function uploadSubmissionImage(dailyChallengeId: string, rawFile: unknown) {
  const { playerId, sessionId } = await withTransaction(async (client) => {
    const player = await requirePlayer(client);
    const session = await lockImageSession(client, dailyChallengeId, player.id);
    requireEditableDraft(session);
    if (session.imagePaths.length >= session.maxImages) {
      throw new BadRequestError(`You can add up to ${session.maxImages} images`);
    }
    return { playerId: player.id, sessionId: session.id };
  });

  const image = await readImageFile(rawFile, "Image");
  const path = newSubmissionImagePath(playerId, sessionId, image.extension);
  await uploadPuzzleImage(path, image);

  try {
    return await withTransaction(async (client) => {
      const player = await requirePlayer(client);
      const session = await lockImageSession(client, dailyChallengeId, player.id);
      requireEditableDraft(session);
      if (session.imagePaths.length >= session.maxImages) {
        throw new BadRequestError(`You can add up to ${session.maxImages} images`);
      }
      await client.query(
        "update submissions set image_paths = array_append(image_paths, $2) where id = $1",
        [session.id, path],
      );
      await recordImageEvent(client, session.id, "image_added");
      return { play: await requireSavedSharedPlayState(client, dailyChallengeId, player.id) };
    });
  } catch (error) {
    await removePuzzleImages([path]);
    throw error;
  }
}

export async function removeSubmissionImage(dailyChallengeId: string, imageId: unknown) {
  const removedPath = await withTransaction(async (client) => {
    const player = await requirePlayer(client);
    const id = z.string().min(1).max(100).parse(imageId);
    const session = await lockImageSession(client, dailyChallengeId, player.id);
    requireEditableDraft(session);
    const path = session.imagePaths.find((candidate) => submissionImageId(candidate) === id);
    if (!path) throw new NotFoundError("Image not found");
    await client.query(
      "update submissions set image_paths = array_remove(image_paths, $2) where id = $1",
      [session.id, path],
    );
    await recordImageEvent(client, session.id, "image_removed");
    return path;
  });
  await removePuzzleImages([removedPath]);
  return withTransaction(async (client) => {
    const player = await requirePlayer(client);
    return { play: await requireSavedSharedPlayState(client, dailyChallengeId, player.id) };
  });
}

export async function saveSubmissionNote(dailyChallengeId: string, rawNote: LazyInput) {
  return withTransaction(async (client) => {
    const player = await requirePlayer(client);
    const note = noteSchema.parse(await resolveInput(rawNote));
    const session = await lockImageSession(client, dailyChallengeId, player.id);
    requireEditableDraft(session);
    await client.query("update submissions set note = $2 where id = $1", [session.id, note]);
    return { play: await requireSavedSharedPlayState(client, dailyChallengeId, player.id) };
  });
}

export async function submitImagesForReview(dailyChallengeId: string) {
  return withTransaction(async (client) => {
    const player = await requirePlayer(client);
    const session = await lockImageSession(client, dailyChallengeId, player.id);

    let submitted = false;
    if (!session.reviewState && !session.submittedAt) {
      if (session.expired) {
        // The sweep decides: a draft with images goes to review, an empty one takes the penalty.
        await client.query("select riddle_private.finalize_expired_sessions($1)", [player.id]);
      } else {
        if (session.imagePaths.length === 0) {
          throw new BadRequestError("Add at least one image before submitting");
        }
        await client.query(
          `update submissions
           set review_state = 'pending_review', review_submitted_at = clock_timestamp()
           where id = $1`,
          [session.id],
        );
        submitted = true;
      }
    }
    return {
      submitted,
      play: await requireSavedSharedPlayState(client, dailyChallengeId, player.id),
    };
  });
}

export interface PendingReview {
  submissionId: string;
  scheduleId: string;
  activeDate: string;
  playerName: string;
  puzzleName: string | null;
  prompt: string;
  promptImageUrl: string | null;
  images: Array<{ id: string; url: string }>;
  note: string | null;
  submittedAt: string;
  timeTakenMs: number;
  basePoints: number;
  failurePenaltyPoints: number;
}

const policySchema = z.object({
  base_points: z.number().int().nonnegative(),
  failure_penalty_points: z.number().int().nonnegative().optional(),
});

export async function listPendingReviews(): Promise<PendingReview[]> {
  return withTransaction(async (client) => {
    await requireAdminRead(client);
    const { rows } = await client.query(
      `select s.id as submission_id, s.image_paths, s.note, s.review_submitted_at, s.started_at,
              c.scoring_policy, d.id as schedule_id, d.active_date::text as active_date,
              p.display_name, pz.name as puzzle_name, pz.prompt, pz.config
       from submissions s
       join challenges c on c.id = s.challenge_id
       join puzzles pz on pz.id = c.puzzle_id
       join daily_challenges d on d.id = c.daily_challenge_id
       join profiles p on p.id = s.user_id
       where s.review_state = 'pending_review'
       order by s.review_submitted_at, s.id`,
    );
    const urls = await signPuzzleImages(rows.flatMap((row) => {
      const promptPath = (row.config as { prompt_image_path?: unknown })?.prompt_image_path;
      return [...row.image_paths, ...(typeof promptPath === "string" ? [promptPath] : [])];
    }));
    return rows.flatMap((row): PendingReview[] => {
      const policy = policySchema.safeParse(row.scoring_policy);
      if (!policy.success) return [];
      const promptPath = (row.config as { prompt_image_path?: unknown })?.prompt_image_path;
      const submittedAt = new Date(row.review_submitted_at);
      return [{
        submissionId: row.submission_id,
        scheduleId: row.schedule_id,
        activeDate: row.active_date,
        playerName: row.display_name,
        puzzleName: row.puzzle_name ?? null,
        prompt: row.prompt,
        promptImageUrl: typeof promptPath === "string" ? (urls.get(promptPath) ?? null) : null,
        images: (row.image_paths as string[]).flatMap((path) => {
          const url = urls.get(path);
          return url ? [{ id: submissionImageId(path), url }] : [];
        }),
        note: row.note ?? null,
        submittedAt: submittedAt.toISOString(),
        timeTakenMs: Math.max(0, submittedAt.getTime() - new Date(row.started_at).getTime()),
        basePoints: policy.data.base_points,
        failurePenaltyPoints: policy.data.failure_penalty_points ?? 0,
      }];
    });
  });
}

export interface GradedSubmission {
  submissionId: string;
  outcome: ReviewOutcome;
  totalPoints: number;
  comment: string | null;
  alreadyReviewed: boolean;
}

export async function gradeSubmission(rawId: unknown, input: LazyInput): Promise<GradedSubmission> {
  return withTransaction(async (client) => {
    const admin = await requireAdmin(client);
    const submissionId = z.uuid().parse(rawId);
    const parsed = reviewInputSchema.parse(await resolveInput(input));

    // Profile before submission, the same order account deletion uses.
    const { rows: owner } = await client.query(
      `select s.user_id from submissions s
       join challenges c on c.id = s.challenge_id
       where s.id = $1 and c.type = 'image_submission'`,
      [submissionId],
    );
    if (!owner[0]) throw new NotFoundError("Submission not found");
    await client.query("select 1 from profiles where id = $1 for share", [owner[0].user_id]);

    const { rows } = await client.query(
      `select s.id, s.user_id, s.review_state, s.review_submitted_at, s.started_at,
              s.scoring_breakdown, s.review_comment, c.scoring_policy
       from submissions s
       join challenges c on c.id = s.challenge_id
       where s.id = $1 and c.type = 'image_submission'
       for update of s`,
      [submissionId],
    );
    const session = rows[0];
    if (!session) throw new NotFoundError("Submission not found");

    if (session.review_state === "reviewed") {
      const stored = session.scoring_breakdown as { outcome: ReviewOutcome; total_points: number };
      const samePoints = parsed.outcome !== "partial" || parsed.points === stored.total_points;
      if (stored.outcome === parsed.outcome && samePoints && session.review_comment === parsed.comment) {
        return {
          submissionId,
          outcome: stored.outcome,
          totalPoints: stored.total_points,
          comment: session.review_comment,
          alreadyReviewed: true,
        };
      }
      throw new ConflictError("This submission has already been graded");
    }
    if (session.review_state !== "pending_review") {
      throw new ConflictError("This submission is not awaiting review");
    }

    const policy = policySchema.parse(session.scoring_policy);
    const result = computeReviewResult(parsed, policy.base_points, policy.failure_penalty_points ?? 0);

    await client.query(
      `update submissions s
       set review_state = 'reviewed',
           submitted_at = s.review_submitted_at,
           time_taken_ms = floor(extract(epoch from (s.review_submitted_at - s.started_at)) * 1000),
           correct = $2,
           scoring_breakdown = $3::jsonb,
           reviewed_by = $4,
           reviewed_at = clock_timestamp(),
           review_comment = $5
       where s.id = $1`,
      [submissionId, result.correct, JSON.stringify(result.breakdown), admin.id, parsed.comment],
    );
    await client.query(
      `insert into point_transactions (user_id, amount, kind, reason, submission_id, operation_key)
       values ($1, $2, 'challenge_result', $3, $4, $5)`,
      [
        session.user_id,
        result.breakdown.total_points,
        `Image submission graded: ${parsed.outcome}`,
        submissionId,
        `result:${submissionId}`,
      ],
    );
    return {
      submissionId,
      outcome: parsed.outcome,
      totalPoints: result.breakdown.total_points,
      comment: parsed.comment,
      alreadyReviewed: false,
    };
  });
}
