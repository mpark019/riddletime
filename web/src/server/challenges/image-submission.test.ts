import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser, insertPuzzle, requireTestAdminPool } from "@/server/test/fixtures";

const mocks = vi.hoisted(() => ({
  getVerifiedUser: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  createSignedUrls: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser: mocks.getVerifiedUser }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    storage: {
      from: () => ({
        upload: mocks.upload,
        remove: mocks.remove,
        createSignedUrls: mocks.createSignedUrls,
      }),
    },
  }),
}));

const {
  gradeSubmission,
  listPendingReviews,
  removeSubmissionImage,
  saveSubmissionNote,
  submitImagesForReview,
  uploadSubmissionImage,
} = await import("./image-submission");
const { getChallengeSession, getStaffPlayerStatuses, submitChallenge } = await import("./challenges");
const { deleteSchedule, getScheduleDetail } = await import("@/server/schedules/schedules");
const { getLeaderboard } = await import("@/server/points/points");
const { createSharedImageSubmission } = await import("@/server/schedules/schedules");
const { createPuzzle, deletePuzzle, discardPromptImage } = await import("@/server/puzzles/puzzles");
const { withTransaction } = await import("@/lib/db");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upload.mockResolvedValue({ data: { path: "uploaded" }, error: null });
  mocks.remove.mockResolvedValue({ data: [], error: null });
  mocks.createSignedUrls.mockImplementation(async (paths: string[]) => ({
    data: paths.map((path) => ({ path, signedUrl: `https://signed.test/${path}`, error: null })),
    error: null,
  }));
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function pngFile(name = "a.png") {
  return new File([PNG], name, { type: "image/png" });
}

async function createProfile(role: "admin" | "player" | "spectator") {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Img ', ($1::uuid)::text), $2)",
    [id, role],
  );
  return id;
}

async function createImageSession(options: { basePoints?: number; penalty?: number; maxImages?: number } = {}) {
  const { basePoints = 100, penalty = 20, maxImages = 2 } = options;
  const adminId = await createProfile("admin");
  const playerId = await createProfile("player");
  const daysAhead = 2000 + Math.floor(Math.random() * 1_000_000);
  const { rows: dailyRows } = await pool.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
     values (current_date + $3::int, 'shared', array['image_submission'], 'fixed', $1::jsonb, 'standard', $2)
     returning id`,
    [JSON.stringify({ standard: { types: { image_submission: { time_limit_seconds: 120 } } } }), adminId, daysAhead],
  );
  const puzzleId = await insertPuzzle(pool, {
    createdBy: adminId,
    type: "image_submission",
    config: { max_images: maxImages },
  });
  const { rows: challengeRows } = await pool.query(
    `insert into challenges
       (daily_challenge_id, mode, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
     values ($1, 'shared', 'image_submission', $2, 'standard', 1, 120, $3::jsonb)
     returning id`,
    [dailyRows[0].id, puzzleId, JSON.stringify({ base_points: basePoints, speed_bonuses: [], failure_penalty_points: penalty })],
  );
  const { rows: submissionRows } = await pool.query(
    "insert into submissions (challenge_id, challenge_mode, user_id) values ($1, 'shared', $2) returning id",
    [challengeRows[0].id, playerId],
  );
  mocks.getVerifiedUser.mockResolvedValue({ id: playerId });
  return {
    adminId,
    playerId,
    dailyId: dailyRows[0].id as string,
    submissionId: submissionRows[0].id as string,
  };
}

async function backdateStart(submissionId: string, secondsAgo: number) {
  const admin = requireTestAdminPool();
  await admin.query("begin");
  try {
    await admin.query("set local session_replication_role = replica");
    await admin.query(
      "update submissions set started_at = started_at - ($2 * interval '1 second') where id = $1",
      [submissionId, secondsAgo],
    );
    await admin.query("commit");
  } catch (error) {
    await admin.query("rollback");
    throw error;
  }
}

async function sweep(playerId: string) {
  await pool.query("select riddle_private.finalize_expired_sessions($1)", [playerId]);
}

async function results(submissionId: string) {
  const { rows } = await pool.query(
    "select amount, reason from point_transactions where submission_id = $1 order by created_at",
    [submissionId],
  );
  return rows as Array<{ amount: number; reason: string }>;
}

async function asUser(id: string) {
  mocks.getVerifiedUser.mockResolvedValue({ id });
}

async function readSession(submissionId: string) {
  const { rows } = await pool.query(
    "select review_state, submitted_at, correct, image_paths, note, scoring_breakdown, review_comment from submissions where id = $1",
    [submissionId],
  );
  return rows[0];
}

describe("draft images and note", () => {
  it("stores an upload under a server-generated path and returns a signed URL", async () => {
    const { playerId, submissionId, dailyId } = await createImageSession();
    const { play } = await uploadSubmissionImage(dailyId, pngFile());

    const stored = (await readSession(submissionId)).image_paths as string[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(new RegExp(`^submissions/${playerId}/${submissionId}/[0-9a-f-]{36}\\.png$`));
    expect(mocks.upload).toHaveBeenCalledWith(stored[0], expect.anything(), expect.objectContaining({ upsert: false }));
    expect(play.status).toBe("in_progress");
    expect(play).toMatchObject({ type: "image_submission", maxImages: 2 });
    expect(play.images).toEqual([{ id: stored[0].split("/").pop(), url: `https://signed.test/${stored[0]}` }]);
  });

  it("rejects non-images, oversize files, a missing file, and uploads past the maximum", async () => {
    const { dailyId } = await createImageSession({ maxImages: 1 });
    await expect(uploadSubmissionImage(dailyId, new File(["text"], "a.png", { type: "image/png" })))
      .rejects.toMatchObject({ status: 400 });
    await expect(uploadSubmissionImage(dailyId, new File([PNG], "a.svg", { type: "image/svg+xml" })))
      .rejects.toMatchObject({ status: 400 });
    await expect(uploadSubmissionImage(dailyId, new File([new Uint8Array(5 * 1024 * 1024 + 1)], "a.png", { type: "image/png" })))
      .rejects.toMatchObject({ status: 400 });
    await expect(uploadSubmissionImage(dailyId, null)).rejects.toMatchObject({ status: 400 });
    expect(mocks.upload).not.toHaveBeenCalled();

    await uploadSubmissionImage(dailyId, pngFile());
    await expect(uploadSubmissionImage(dailyId, pngFile())).rejects.toMatchObject({ status: 400 });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("forbids spectators and admins from uploading", async () => {
    const { dailyId } = await createImageSession();
    for (const role of ["spectator", "admin"] as const) {
      await asUser(await createProfile(role));
      await expect(uploadSubmissionImage(dailyId, pngFile())).rejects.toMatchObject({ status: 403 });
    }
  });

  it("removes the stored object and the reference when an image is deleted", async () => {
    const { dailyId, submissionId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    const [path] = (await readSession(submissionId)).image_paths as string[];

    const { play } = await removeSubmissionImage(dailyId, path.split("/").pop());
    expect(play.images).toEqual([]);
    expect(mocks.remove).toHaveBeenCalledWith([path]);
    await expect(removeSubmissionImage(dailyId, "missing.png")).rejects.toMatchObject({ status: 404 });
  });

  it("saves, trims, clears, and caps the note", async () => {
    const { dailyId, submissionId } = await createImageSession();
    await saveSubmissionNote(dailyId, "  my drawing  ");
    expect((await readSession(submissionId)).note).toBe("my drawing");
    await saveSubmissionNote(dailyId, "   ");
    expect((await readSession(submissionId)).note).toBeNull();
    await expect(saveSubmissionNote(dailyId, "x".repeat(1001))).rejects.toThrow();
  });
});

describe("submitting for review", () => {
  it("requires an image, then locks the session as pending with no points", async () => {
    const { dailyId, submissionId } = await createImageSession();
    await expect(submitImagesForReview(dailyId)).rejects.toMatchObject({ status: 400 });

    await uploadSubmissionImage(dailyId, pngFile());
    const first = await submitImagesForReview(dailyId);
    expect(first).toMatchObject({ submitted: true, play: { status: "pending_review" } });
    expect(await results(submissionId)).toEqual([]);

    const again = await submitImagesForReview(dailyId);
    expect(again.submitted).toBe(false);
    expect(again.play.status).toBe("pending_review");
  });

  it("locks images and note once submitted", async () => {
    const { dailyId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await submitImagesForReview(dailyId);
    await expect(uploadSubmissionImage(dailyId, pngFile())).rejects.toMatchObject({ status: 409 });
    await expect(saveSubmissionNote(dailyId, "late")).rejects.toMatchObject({ status: 409 });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("cannot be graded or resolved through the riddle submit path", async () => {
    const { dailyId } = await createImageSession();
    await expect(submitChallenge(dailyId, "an answer")).rejects.toMatchObject({ status: 400 });
  });

  it("blocks direct database edits to a submitted session", async () => {
    const { dailyId, submissionId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await submitImagesForReview(dailyId);
    await expect(pool.query("update submissions set image_paths = '{}' where id = $1", [submissionId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("update submissions set note = 'x' where id = $1", [submissionId]))
      .rejects.toMatchObject({ code: "23514" });
  });
});

describe("deadline handling", () => {
  it("submits a draft with images for review instead of penalizing it", async () => {
    const { dailyId, submissionId, playerId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await backdateStart(submissionId, 600);
    await sweep(playerId);

    const session = await readSession(submissionId);
    expect(session.review_state).toBe("pending_review");
    expect(session.submitted_at).toBeNull();
    expect(await results(submissionId)).toEqual([]);
  });

  it("penalizes an empty draft exactly once", async () => {
    const { dailyId, submissionId, playerId } = await createImageSession();
    await backdateStart(submissionId, 600);
    await sweep(playerId);
    await sweep(playerId);

    expect(await results(submissionId)).toEqual([{ amount: -20, reason: "Deadline expired" }]);
    const play = (await getChallengeSession(dailyId)).play;
    expect(play.status).toBe("completed");
  });

  it("rejects draft edits once time is up", async () => {
    const { dailyId, submissionId } = await createImageSession();
    await backdateStart(submissionId, 600);
    await expect(uploadSubmissionImage(dailyId, pngFile())).rejects.toMatchObject({ status: 400 });
    await expect(saveSubmissionNote(dailyId, "late")).rejects.toMatchObject({ status: 400 });
  });

  it("auto-submits when the player presses submit after the deadline with images", async () => {
    const { dailyId, submissionId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await backdateStart(submissionId, 600);
    const result = await submitImagesForReview(dailyId);
    expect(result.play.status).toBe("pending_review");
    expect(await results(submissionId)).toEqual([]);
  });

  it("leaves a pending session alone once its deadline has passed", async () => {
    const { dailyId, submissionId, playerId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await submitImagesForReview(dailyId);
    await backdateStart(submissionId, 100_000);
    await sweep(playerId);
    await sweep(playerId);
    expect((await readSession(submissionId)).review_state).toBe("pending_review");
    expect(await results(submissionId)).toEqual([]);
  });

  it("records the deadline as the submit time for an auto-submitted draft", async () => {
    const { dailyId, submissionId, playerId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await backdateStart(submissionId, 600);
    await sweep(playerId);
    const { rows } = await pool.query(
      "select review_submitted_at = started_at + interval '120 seconds' as at_deadline from submissions where id = $1",
      [submissionId],
    );
    expect(rows[0].at_deadline).toBe(true);
  });
});

describe("grading", () => {
  async function pendingSession(options: { basePoints?: number; penalty?: number } = {}) {
    const session = await createImageSession(options);
    await uploadSubmissionImage(session.dailyId, pngFile());
    await saveSubmissionNote(session.dailyId, "here you go");
    await submitImagesForReview(session.dailyId);
    await asUser(session.adminId);
    return session;
  }

  it("awards flat base points for full and records the reviewer", async () => {
    const { submissionId, adminId } = await pendingSession();
    const graded = await gradeSubmission(submissionId, { outcome: "full", comment: "  Great  " });
    expect(graded).toMatchObject({ outcome: "full", totalPoints: 100, comment: "Great", alreadyReviewed: false });

    const { rows } = await pool.query(
      "select review_state, correct, reviewed_by, review_comment, time_taken_ms, scoring_breakdown from submissions where id = $1",
      [submissionId],
    );
    expect(rows[0]).toMatchObject({ review_state: "reviewed", correct: true, reviewed_by: adminId, review_comment: "Great" });
    expect(rows[0].scoring_breakdown).toMatchObject({ outcome: "full", total_points: 100 });
    expect(await results(submissionId)).toEqual([{ amount: 100, reason: "Image submission graded: full" }]);
  });

  it("applies the failure penalty for none", async () => {
    const { submissionId } = await pendingSession({ penalty: 30 });
    await gradeSubmission(submissionId, { outcome: "none" });
    expect(await results(submissionId)).toEqual([{ amount: -30, reason: "Image submission graded: none" }]);
    expect((await readSession(submissionId)).correct).toBe(false);
  });

  it("awards a custom partial amount strictly below full", async () => {
    const { submissionId } = await pendingSession();
    await gradeSubmission(submissionId, { outcome: "partial", points: 40 });
    expect(await results(submissionId)).toEqual([{ amount: 40, reason: "Image submission graded: partial" }]);
  });

  it.each([100, 150])("rejects a partial of %i and leaves the session pending", async (points) => {
    const { submissionId } = await pendingSession();
    await expect(gradeSubmission(submissionId, { outcome: "partial", points })).rejects.toMatchObject({ status: 400 });
    expect((await readSession(submissionId)).review_state).toBe("pending_review");
    expect(await results(submissionId)).toEqual([]);
  });

  it("rejects partial when the puzzle is worth less than 2 points", async () => {
    const { submissionId } = await pendingSession({ basePoints: 1 });
    await expect(gradeSubmission(submissionId, { outcome: "partial", points: 1 })).rejects.toMatchObject({ status: 400 });
    await gradeSubmission(submissionId, { outcome: "full" });
    expect(await results(submissionId)).toEqual([{ amount: 1, reason: "Image submission graded: full" }]);
  });

  it("stores a blank comment as null and rejects one over 500 characters", async () => {
    const { submissionId } = await pendingSession();
    await expect(gradeSubmission(submissionId, { outcome: "full", comment: "x".repeat(501) })).rejects.toThrow();
    await gradeSubmission(submissionId, { outcome: "full", comment: "   " });
    expect((await readSession(submissionId)).review_comment).toBeNull();
  });

  it("returns 403 to non-admins before reading the body", async () => {
    const { submissionId, playerId } = await pendingSession();
    const body = vi.fn(async () => ({ outcome: "full" }));
    await asUser(playerId);
    await expect(gradeSubmission(submissionId, body)).rejects.toMatchObject({ status: 403 });
    await asUser(await createProfile("spectator"));
    await expect(gradeSubmission(submissionId, body)).rejects.toMatchObject({ status: 403 });
    expect(body).not.toHaveBeenCalled();
    expect((await readSession(submissionId)).review_state).toBe("pending_review");
  });

  it("treats a repeated identical grade as a no-op and rejects a conflicting one", async () => {
    const { submissionId } = await pendingSession();
    await gradeSubmission(submissionId, { outcome: "partial", points: 25, comment: "ok" });
    const repeat = await gradeSubmission(submissionId, { outcome: "partial", points: 25, comment: "ok" });
    expect(repeat).toMatchObject({ alreadyReviewed: true, totalPoints: 25 });
    await expect(gradeSubmission(submissionId, { outcome: "full" })).rejects.toMatchObject({ status: 409 });
    expect(await results(submissionId)).toHaveLength(1);
  });

  it("refuses to grade a draft that has not been submitted", async () => {
    const { adminId, submissionId, dailyId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await asUser(adminId);
    await expect(gradeSubmission(submissionId, { outcome: "full" })).rejects.toMatchObject({ status: 409 });
  });

  it("shows the player the outcome and comment but nobody else", async () => {
    const { submissionId, playerId, dailyId } = await pendingSession();
    await gradeSubmission(submissionId, { outcome: "none", comment: "Off topic" });

    await asUser(playerId);
    const { play } = await getChallengeSession(dailyId);
    expect(play).toMatchObject({
      status: "completed",
      result: { correct: false, outcome: "none", reviewComment: "Off topic" },
    });
    expect(JSON.stringify(play)).toContain("Off topic");

    await asUser(await createProfile("player"));
    await expect(getChallengeSession(dailyId)).rejects.toMatchObject({ status: 404 });
    const board = JSON.stringify(await getLeaderboard());
    expect(board).not.toContain("Off topic");
    expect(board).not.toContain("here you go");
  });
});

describe("review queue and statuses", () => {
  it("lists pending submissions for admins only, with signed image URLs", async () => {
    const { adminId, playerId, submissionId, dailyId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await saveSubmissionNote(dailyId, "look");
    await submitImagesForReview(dailyId);

    await asUser(playerId);
    await expect(listPendingReviews()).rejects.toMatchObject({ status: 403 });
    await asUser(await createProfile("spectator"));
    await expect(listPendingReviews()).rejects.toMatchObject({ status: 403 });

    await asUser(adminId);
    const queue = await listPendingReviews();
    const mine = queue.find((entry) => entry.submissionId === submissionId);
    expect(mine).toMatchObject({ note: "look", basePoints: 100, failurePenaltyPoints: 20 });
    expect(mine?.images).toHaveLength(1);
    expect(mine?.images[0].url).toMatch(/^https:\/\/signed\.test\//);

    const detail = await getScheduleDetail(dailyId);
    expect(detail.players.find((entry) => entry.userId === playerId)?.status).toBe("pending_review");
  });
});

describe("leaderboard tallies", () => {
  it("counts full as correct and none as incorrect, and skips partial and pending", async () => {
    const outcomes = [
      { outcome: "full" },
      { outcome: "none" },
      { outcome: "partial", points: 10 },
      null,
    ] as const;
    for (const outcome of outcomes) {
      const session = await createImageSession();
      await uploadSubmissionImage(session.dailyId, pngFile());
      await submitImagesForReview(session.dailyId);
      if (outcome) {
        await asUser(session.adminId);
        await gradeSubmission(session.submissionId, outcome);
      }
      await asUser(session.playerId);
      const entry = (await getLeaderboard()).find((row) => row.userId === session.playerId);
      const expected = !outcome ? [0, 0]
        : outcome.outcome === "full" ? [1, 0]
        : outcome.outcome === "none" ? [0, 1]
        : [0, 0];
      expect([entry?.correctRiddles, entry?.incorrectRiddles]).toEqual(expected);
    }
  });
});

describe("puzzle bank and scheduling", () => {
  it("requires prompt text or a prompt image and does not accept a custom image limit", async () => {
    const adminId = await createProfile("admin");
    await asUser(adminId);
    const bad = [
      { difficulty: "easy", puzzle: { type: "image_submission" } },
      { difficulty: "easy", puzzle: { type: "image_submission", prompt: "   " } },
      { difficulty: "easy", puzzle: { type: "image_submission", prompt: "Draw", max_images: 3 } },
      { difficulty: "easy", puzzle: { type: "image_submission", prompt: "Draw", prompt_image_path: "../etc/passwd" } },
    ];
    for (const input of bad) await expect(createPuzzle(input)).rejects.toThrow();
    const { rowCount } = await pool.query("select 1 from puzzles where created_by = $1", [adminId]);
    expect(rowCount).toBe(0);
  });

  it("creates an image puzzle with default max images and an empty answer", async () => {
    await asUser(await createProfile("admin"));
    const puzzle = await createPuzzle({ difficulty: "easy", puzzle: { type: "image_submission", prompt: "Draw a cat" } });
    expect(puzzle).toMatchObject({ type: "image_submission", maxImages: 5, acceptedAnswers: [] });
    const { rows } = await pool.query("select answer_data, config from puzzles where id = $1", [puzzle.id]);
    expect(rows[0]).toMatchObject({ answer_data: {}, config: { max_images: 5 } });
  });

  it("accepts an image-only prompt for the uploader's own file and rejects another account's", async () => {
    const adminId = await createProfile("admin");
    await asUser(adminId);
    const own = `prompts/${adminId}/${randomUUID()}.png`;
    const puzzle = await createPuzzle({
      difficulty: "easy",
      puzzle: { type: "image_submission", prompt_image_path: own },
    });
    expect(puzzle).toMatchObject({ prompt: "", promptImagePath: own, maxImages: 5 });
    expect(puzzle.promptImageUrl).toBe(`https://signed.test/${own}`);

    const someoneElse = `prompts/${randomUUID()}/${randomUUID()}.png`;
    await expect(createPuzzle({
      difficulty: "easy",
      puzzle: { type: "image_submission", prompt_image_path: someoneElse },
    })).rejects.toMatchObject({ status: 400 });
  });

  it("schedules an image puzzle with a single try and rejects other try counts", async () => {
    const adminId = await createProfile("admin");
    await asUser(adminId);
    const puzzle = await createPuzzle({
      status: "active",
      difficulty: "easy",
      puzzle: { type: "image_submission", prompt: "Draw a boat" },
    });
    const presets = {
      standard: {
        types: {
          image_submission: {
            time_limit_seconds: 300,
            scoring_policy: { base_points: 50, speed_bonuses: [], failure_penalty_points: 10 },
          },
        },
      },
    };
    const activeDate = `2999-0${1 + Math.floor(Math.random() * 9)}-${10 + Math.floor(Math.random() * 18)}`;
    const body = {
      active_date: activeDate,
      mode: "shared",
      allowed_types: ["image_submission"],
      difficulty_selection: "fixed",
      difficulty_presets: presets,
      selected_difficulty: "standard",
      puzzle_id: puzzle.id,
    };
    const bad = structuredClone(body);
    (bad.difficulty_presets.standard.types.image_submission as Record<string, unknown>).max_attempts = 3;
    await expect(createSharedImageSubmission(bad)).rejects.toThrow();

    const created = await createSharedImageSubmission(body);
    const { rows } = await pool.query(
      "select type, max_attempts, time_limit_seconds from challenges where daily_challenge_id = $1",
      [created.scheduleId],
    );
    expect(rows[0]).toEqual({ type: "image_submission", max_attempts: 1, time_limit_seconds: 300 });
  });

  it("does not expose the prompt image before the player starts", async () => {
    const adminId = await createProfile("admin");
    const playerId = await createProfile("player");
    const { rows: dailyRows } = await pool.query(
      `insert into daily_challenges
         (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, selected_difficulty, created_by)
       values (current_date + $2::int, 'personal', array['image_submission'], 'fixed', $1::jsonb, 'standard', $3)
       returning id`,
      [
        JSON.stringify({ standard: { types: { image_submission: { time_limit_seconds: 120 } } } }),
        3000 + Math.floor(Math.random() * 1_000_000),
        adminId,
      ],
    );
    const promptPath = `prompts/${adminId}/${randomUUID()}.png`;
    const puzzleId = await insertPuzzle(pool, {
      createdBy: adminId,
      type: "image_submission",
      prompt: "",
      config: { max_images: 2, prompt_image_path: promptPath },
    });
    await pool.query(
      `insert into challenges
         (daily_challenge_id, mode, assigned_to, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
       values ($1, 'personal', $2, 'image_submission', $3, 'standard', 1, 120, $4::jsonb)`,
      [dailyRows[0].id, playerId, puzzleId, JSON.stringify({ base_points: 10, failure_penalty_points: 5 })],
    );
    await asUser(adminId);
    const statuses = await withTransaction((client) => getStaffPlayerStatuses(client, dailyRows[0].id, true));
    const play = statuses.find((entry) => entry.userId === playerId)?.play;
    expect(play).toMatchObject({ status: "not_started", type: "image_submission", maxImages: 2 });
    expect(JSON.stringify(play)).not.toContain(promptPath);
    expect(mocks.createSignedUrls).not.toHaveBeenCalled();
  });
});

describe("storage cleanup", () => {
  it("removes submitted images when the schedule is deleted", async () => {
    const { adminId, dailyId, submissionId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await uploadSubmissionImage(dailyId, pngFile());
    const stored = (await readSession(submissionId)).image_paths as string[];
    mocks.remove.mockClear();

    await asUser(adminId);
    await deleteSchedule(dailyId);
    expect(mocks.remove).toHaveBeenCalledWith(expect.arrayContaining(stored));
    expect(mocks.remove.mock.calls[0][0]).toHaveLength(2);
  });

  it("keeps the database change when object removal fails", async () => {
    const { adminId, dailyId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    mocks.remove.mockRejectedValue(new Error("storage down"));

    await asUser(adminId);
    await expect(deleteSchedule(dailyId)).resolves.toMatchObject({ id: dailyId });
    const { rowCount } = await pool.query("select 1 from daily_challenges where id = $1", [dailyId]);
    expect(rowCount).toBe(0);
  });
});

describe("integrity hardening", () => {
  it("rejects a prompt image path already used by another puzzle and keeps it while shared", async () => {
    const adminId = await createProfile("admin");
    await asUser(adminId);
    const path = `prompts/${adminId}/${randomUUID()}.png`;
    const first = await createPuzzle({ difficulty: "easy", puzzle: { type: "image_submission", prompt_image_path: path } });
    await expect(createPuzzle({
      difficulty: "easy",
      puzzle: { type: "image_submission", prompt_image_path: path },
    })).rejects.toMatchObject({ status: 400 });
    expect(first.promptImagePath).toBe(path);
  });

  it("does not let a database write resolve an image session that has images", async () => {
    const { dailyId, submissionId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await expect(pool.query(
      `update submissions
       set submitted_at = started_at, time_taken_ms = 0, correct = true,
           scoring_breakdown = '{"total_points": 100}'::jsonb
       where id = $1`,
      [submissionId],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects image paths that do not belong to the session", async () => {
    const { submissionId } = await createImageSession();
    await expect(pool.query(
      "update submissions set image_paths = array['submissions/other/other/x.png'] where id = $1",
      [submissionId],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("holds no upload slot across the storage call", async () => {
    const { dailyId } = await createImageSession();
    let release: () => void = () => undefined;
    mocks.upload.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ data: { path: "uploaded" }, error: null });
    }));
    const pending = uploadSubmissionImage(dailyId, pngFile());
    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalled());
    // The note write needs the session row; it would block here if the upload kept its lock.
    await expect(saveSubmissionNote(dailyId, "while uploading")).resolves.toBeDefined();
    release();
    await expect(pending).resolves.toBeDefined();
  });
});

describe("admin timeline", () => {
  it("shows image uploads, removals, and the submit time", async () => {
    const { adminId, dailyId, submissionId, playerId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await uploadSubmissionImage(dailyId, pngFile());
    const [first] = (await readSession(submissionId)).image_paths as string[];
    await removeSubmissionImage(dailyId, first.split("/").pop());
    await submitImagesForReview(dailyId);

    await asUser(adminId);
    const detail = await getScheduleDetail(dailyId);
    const timeline = detail.players.find((entry) => entry.userId === playerId)?.timeline ?? [];
    expect(timeline.map((entry) => entry.kind)).toEqual(["image_added", "image_added", "image_removed", "submitted"]);
  });

  it("records the deadline as the submit entry for an auto-submitted draft", async () => {
    const { adminId, dailyId, submissionId, playerId } = await createImageSession();
    await uploadSubmissionImage(dailyId, pngFile());
    await backdateStart(submissionId, 600);
    await sweep(playerId);

    await asUser(adminId);
    const detail = await getScheduleDetail(dailyId);
    const timeline = detail.players.find((entry) => entry.userId === playerId)?.timeline ?? [];
    expect(timeline.at(-1)).toMatchObject({ kind: "submitted", offsetMs: 120_000 });
  });

  it("does not let a client post the server-only event kinds", async () => {
    const { POST } = await import("@/app/api/challenge/[id]/activity/route");
    const { dailyId, submissionId } = await createImageSession();
    for (const kind of ["image_added", "image_removed"]) {
      const response = await POST(
        new Request("https://riddletime.example/api/challenge/x/activity", {
          method: "POST",
          body: JSON.stringify({ kind }),
        }),
        { params: Promise.resolve({ id: dailyId }) } as never,
      );
      expect(response.status).toBe(400);
    }
    const { rowCount } = await pool.query("select 1 from submission_activity where submission_id = $1", [submissionId]);
    expect(rowCount).toBe(0);
  });
});

describe("discarding an unsaved prompt image", () => {
  it("removes the caller's unattached upload", async () => {
    const adminId = await createProfile("admin");
    await asUser(adminId);
    const path = `prompts/${adminId}/${randomUUID()}.png`;
    await expect(discardPromptImage(path)).resolves.toEqual({ removed: true });
    expect(mocks.remove).toHaveBeenCalledWith([path]);
  });

  it("never removes a prompt image that a saved puzzle uses", async () => {
    const adminId = await createProfile("admin");
    await asUser(adminId);
    const path = `prompts/${adminId}/${randomUUID()}.png`;
    await createPuzzle({ difficulty: "easy", puzzle: { type: "image_submission", prompt_image_path: path } });
    mocks.remove.mockClear();

    await expect(discardPromptImage(path)).resolves.toEqual({ removed: false });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses another account's path, a malformed path, and non-staff callers", async () => {
    const adminId = await createProfile("admin");
    await asUser(adminId);
    await expect(discardPromptImage(`prompts/${randomUUID()}/${randomUUID()}.png`)).rejects.toMatchObject({ status: 400 });
    await expect(discardPromptImage("submissions/a/b/c.png")).rejects.toMatchObject({ status: 400 });
    await expect(discardPromptImage("../../etc/passwd")).rejects.toMatchObject({ status: 400 });

    await asUser(await createProfile("player"));
    await expect(discardPromptImage(`prompts/${adminId}/${randomUUID()}.png`)).rejects.toMatchObject({ status: 403 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe("deleting a puzzle", () => {
  it("removes its prompt image from storage", async () => {
    const adminId = await createProfile("admin");
    await asUser(adminId);
    const path = `prompts/${adminId}/${randomUUID()}.png`;
    const puzzle = await createPuzzle({ difficulty: "easy", puzzle: { type: "image_submission", prompt: "Draw", prompt_image_path: path } });
    mocks.remove.mockClear();

    await deletePuzzle(puzzle.id);
    expect(mocks.remove).toHaveBeenCalledWith([path]);
  });

  it("keeps a prompt image that another puzzle still references", async () => {
    const adminId = await createProfile("admin");
    await asUser(adminId);
    const path = `prompts/${adminId}/${randomUUID()}.png`;
    const first = await createPuzzle({ difficulty: "easy", puzzle: { type: "image_submission", prompt_image_path: path } });
    // A second reference can only exist through direct data, since the API rejects reused paths.
    const second = await insertPuzzle(pool, { createdBy: adminId, type: "image_submission", prompt: "Other", config: { max_images: 5, prompt_image_path: path } });
    mocks.remove.mockClear();

    await deletePuzzle(first.id);
    expect(mocks.remove).not.toHaveBeenCalled();
    await deletePuzzle(second);
    expect(mocks.remove).toHaveBeenCalledWith([path]);
  });
});

