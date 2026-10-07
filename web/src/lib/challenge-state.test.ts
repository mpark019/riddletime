import { describe, expect, it } from "vitest";
import {
  estimateServerClockOffset,
  formatCountdown,
  isSubmissionConfirmed,
  persistPendingSubmission,
  remainingSeconds,
  removePendingSubmission,
  restorePendingSubmission,
  withAuthoritativePlay,
} from "./challenge-state";
import type {
  PendingRiddleSubmission,
  PendingSubmissionStorage,
  PlayerChallengeState,
  TodayChallengeResponse,
} from "./challenge-state";

function memoryStorage(): PendingSubmissionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("shared-riddle countdown", () => {
  it("uses the server clock midpoint offset instead of trusting the browser clock", () => {
    const requestStartedAt = Date.parse("2026-10-07T12:00:05.000Z");
    const responseReceivedAt = Date.parse("2026-10-07T12:00:07.000Z");
    const offset = estimateServerClockOffset(
      "2026-10-07T12:00:01.000Z",
      requestStartedAt,
      responseReceivedAt,
    );

    expect(offset).toBe(-5_000);
    expect(
      remainingSeconds("2026-10-07T12:01:01.000Z", offset, responseReceivedAt),
    ).toBe(59);
  });

  it("clamps an expired countdown at zero", () => {
    expect(
      remainingSeconds(
        "2026-10-07T12:00:00.000Z",
        0,
        Date.parse("2026-10-07T12:00:01.000Z"),
      ),
    ).toBe(0);
  });

  it("formats the countdown without dropping leading seconds", () => {
    expect(formatCountdown(65)).toBe("1:05");
  });
});

describe("authoritative mutation state", () => {
  it("only confirms a pending submission after its operation key is stored", () => {
    const pendingKey = "88fd76a3-a596-4b3c-9a42-bfcf0eb194c3";
    const play = {
      status: "in_progress",
      guessHistory: [{ response: "guitar", correct: false }],
    } as PlayerChallengeState;

    expect(isSubmissionConfirmed(play, pendingKey)).toBe(false);
    expect(isSubmissionConfirmed({
      ...play,
      guessHistory: [{ response: "guitar", correct: false, operationKey: pendingKey }],
    } as PlayerChallengeState, pendingKey)).toBe(true);
  });

  it("treats a completed game as confirmation even when older history has no operation keys", () => {
    expect(isSubmissionConfirmed({ status: "completed" } as PlayerChallengeState, "pending-key"))
      .toBe(true);
  });

  it("keeps the active schedule id while applying the saved play state", () => {
    const current = {
      schedule: { id: "previous-day", mode: "shared", allowedTypes: ["riddle"] },
      play: { status: "not_started", available: true },
    } satisfies TodayChallengeResponse;
    const play = {
      status: "completed",
      submissionId: "submission",
      challengeId: "challenge",
      type: "riddle",
      difficulty: "standard",
      prompt: "Prompt",
      startedAt: "2026-10-07T23:59:00.000Z",
      deadline: "2026-10-08T00:01:00.000Z",
      serverTime: "2026-10-08T00:00:10.000Z",
      timeLimitSeconds: 120,
      maxAttempts: 2,
      attempts: 1,
      attemptsRemaining: 0,
      guessHistory: [{ response: "piano", correct: true }],
      feedback: null,
      scoringPolicy: { base_points: 100, speed_bonuses: [] },
      result: {
        correct: true,
        timeTakenMs: 70_000,
        scoringBreakdown: {
          base_points: 100,
          speed_bonus_points: null,
          total_points: 100,
          bonus_under_ms: null,
        },
      },
    } satisfies PlayerChallengeState;

    expect(withAuthoritativePlay(current, play)).toEqual({
      schedule: current.schedule,
      play,
    });
  });
});

describe("pending submission persistence", () => {
  const playerId = "4ba101ca-6f02-4bd5-bc88-4eb69338b51b";
  const otherPlayerId = "f6408f3a-8045-40b9-aa84-21cd8ffcb9a5";
  const pending = {
    dailyChallengeId: "58e792ff-8f55-45f6-893c-3818ad7b1092",
    submissionId: "3503005a-a9b3-4f6d-84a0-b3287d193c76",
    response: "guitar",
    operationKey: "88fd76a3-a596-4b3c-9a42-bfcf0eb194c3",
  } satisfies PendingRiddleSubmission;

  it("restores a pending payload after remount for the same player and session only", () => {
    const storage = memoryStorage();
    persistPendingSubmission(storage, playerId, pending);

    expect(restorePendingSubmission(
      storage,
      playerId,
      pending.dailyChallengeId,
      pending.submissionId,
    )).toEqual(pending);
    expect(restorePendingSubmission(
      storage,
      otherPlayerId,
      pending.dailyChallengeId,
      pending.submissionId,
    )).toBeNull();
    expect(restorePendingSubmission(
      storage,
      playerId,
      "bc4070e8-c130-4b70-a38e-65964a1cc2a7",
      pending.submissionId,
    )).toBeNull();
  });

  it("removes the persisted payload only when explicitly confirmed", () => {
    const storage = memoryStorage();
    persistPendingSubmission(storage, playerId, pending);
    removePendingSubmission(storage, playerId, pending.submissionId, pending.operationKey);

    expect(restorePendingSubmission(
      storage,
      playerId,
      pending.dailyChallengeId,
      pending.submissionId,
    )).toBeNull();
  });

  it("does not let delayed cleanup remove a newer operation for the same session", () => {
    const storage = memoryStorage();
    const newerPending = {
      ...pending,
      response: "piano",
      operationKey: "e80d8955-83f8-45f4-858d-354efb291d2e",
    };
    persistPendingSubmission(storage, playerId, pending);
    persistPendingSubmission(storage, playerId, newerPending);

    expect(removePendingSubmission(
      storage,
      playerId,
      pending.submissionId,
      pending.operationKey,
    )).toBe(false);
    expect(restorePendingSubmission(
      storage,
      playerId,
      newerPending.dailyChallengeId,
      newerPending.submissionId,
    )).toEqual(newerPending);

    expect(removePendingSubmission(
      storage,
      playerId,
      newerPending.submissionId,
      newerPending.operationKey,
    )).toBe(true);
  });
});
