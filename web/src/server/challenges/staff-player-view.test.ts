import { beforeEach, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const { query, requireProfileRead } = vi.hoisted(() => ({
  query: vi.fn(),
  requireProfileRead: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  withTransaction: (run: (client: PoolClient) => unknown) => run({ query } as unknown as PoolClient),
}));
vi.mock("@/server/identity/identity", () => ({ requireProfileRead, requirePlayer: vi.fn() }));
vi.mock("@/server/storage/puzzle-images", () => ({ signPuzzleImages: vi.fn(), submissionImageId: vi.fn() }));

const { loadTodayChallenge } = await import("./challenges");

beforeEach(() => vi.resetAllMocks());

it.each(["admin", "spectator"])("gives %s the same read-only personal player screens", async (role) => {
  requireProfileRead.mockResolvedValue({ id: "viewer", role });
  const common = {
    challenge_id: "challenge", difficulty: "easy", max_attempts: 2, time_limit_seconds: 120,
    scoring_policy: { base_points: 25, failure_penalty_points: 10 },
    hint: null, hint_cost_points: 0,
  };
  const active = {
    ...common, type: "riddle", submission_id: "session", prompt: "Player prompt",
    started_at: "2026-10-20T12:00:00Z", server_time: "2026-10-20T12:00:30Z",
    deadline: "2026-10-20T12:02:00Z", attempts: 1,
    guess_history: [{ response: "wrong guess", correct: false, offsetMs: 1200 }],
    answer_data: { accepted: ["secret answer"] },
  };
  query
    .mockResolvedValueOnce({ rows: [{ id: "day", mode: "personal", allowed_types: ["riddle", "image_submission"] }] })
    .mockResolvedValueOnce({ rows: [
      { ...common, user_id: "new", display_name: "New", type: "image_submission" },
      { ...active, user_id: "active", display_name: "Active" },
      { ...active, user_id: "done", display_name: "Done", submitted_at: active.server_time, correct: true },
      { user_id: "unassigned", display_name: "Unassigned" },
    ] })
    .mockResolvedValueOnce({ rows: [{ ...common, type: "image_submission", config: { max_images: 5 } }] })
    .mockResolvedValueOnce({ rows: [active] })
    .mockResolvedValueOnce({ rows: [{ ...active, submitted_at: active.server_time, correct: true, time_taken_ms: 30000, scoring_breakdown: { total_points: 25 } }] });

  const result = await loadTodayChallenge();
  expect(result).toMatchObject({ finalized: 0, result: { playerStatuses: [
    { userId: "new", play: { status: "not_started", type: "image_submission", maxImages: 5, scoringPolicy: { base_points: 25 } } },
    { userId: "active", play: { status: "in_progress", prompt: "Player prompt", guessHistory: [{ response: "wrong guess", correct: false }] } },
    { userId: "done", play: { status: "completed", result: { correct: true, scoringBreakdown: { total_points: 25 } } } },
    { userId: "unassigned", play: null },
  ] } });
  expect(JSON.stringify(result)).not.toMatch(/secret answer|answer_data|offsetMs/);
  expect(query).toHaveBeenCalledTimes(5);
  for (const [sql] of query.mock.calls) expect(sql.trim()).toMatch(/^select\b/i);
});
