import { describe, expect, it, vi } from "vitest";
import {
  estimateServerClockOffset,
  attemptsUrgency,
  countdownUrgency,
  formatCountdown,
  isPastDeadline,
  isRepeatGuess,
  isSubmissionConfirmed,
  needsPendingRetry,
  stakesPressure,
  persistPendingSubmission,
  remainingSeconds,
  removePendingSubmission,
  retryWithDelays,
  restorePendingSubmission,
  shakeLevel,
  speedTierStatuses,
  stakeScales,
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

  it("waits for a grace period after the deadline before reporting it passed", () => {
    const deadline = "2026-10-07T12:00:00.000Z";
    expect(isPastDeadline(deadline, 0, Date.parse("2026-10-07T12:00:00.500Z"))).toBe(false);
    expect(isPastDeadline(deadline, 0, Date.parse("2026-10-07T12:00:01.000Z"))).toBe(true);
  });

  it("uses the server clock offset when checking the deadline", () => {
    expect(
      isPastDeadline("2026-10-07T12:00:00.000Z", 2_000, Date.parse("2026-10-07T11:59:59.000Z")),
    ).toBe(true);
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
      play: { status: "not_started", available: true, difficulty: "standard" },
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

describe("speedTierStatuses", () => {
  const tiers = [
    { under_ms: 30_000, points: 20 },
    { under_ms: 10_000, points: 50 },
  ];
  const deadline = "2026-10-07T12:02:00.000Z";
  const at = (iso: string) => Date.parse(iso);

  it("orders tiers fastest first and marks the best reachable one as current", () => {
    const statuses = speedTierStatuses(tiers, 120, deadline, 0, at("2026-10-07T12:00:05.000Z"));

    expect(statuses).toEqual([
      { underMs: 10_000, points: 50, expired: false, current: true },
      { underMs: 30_000, points: 20, expired: false, current: false },
    ]);
  });

  it("expires a tier once its window has passed and promotes the next best", () => {
    const statuses = speedTierStatuses(tiers, 120, deadline, 0, at("2026-10-07T12:00:12.000Z"));

    expect(statuses).toEqual([
      { underMs: 10_000, points: 50, expired: true, current: false },
      { underMs: 30_000, points: 20, expired: false, current: true },
    ]);
  });

  it("treats the exact threshold as expired, matching the server rule", () => {
    const statuses = speedTierStatuses(tiers, 120, deadline, 0, at("2026-10-07T12:00:10.000Z"));

    expect(statuses[0].expired).toBe(true);
  });

  it("marks every tier expired and none current when all windows have passed", () => {
    const statuses = speedTierStatuses(tiers, 120, deadline, 0, at("2026-10-07T12:01:00.000Z"));

    expect(statuses.every((tier) => tier.expired && !tier.current)).toBe(true);
  });

  it("returns nothing when no tiers are configured", () => {
    expect(speedTierStatuses(undefined, 120, deadline, 0, 0)).toEqual([]);
  });
});

describe("countdownUrgency", () => {
  it("stays zero until the last 30 percent of the time limit", () => {
    expect(countdownUrgency(120, 120)).toBe(0);
    expect(countdownUrgency(36, 120)).toBe(0);
  });

  it("rises toward one as time runs out", () => {
    expect(countdownUrgency(23, 120)).toBeCloseTo(0.5);
    expect(countdownUrgency(0, 120)).toBe(1);
  });

  it("is fully red for the final ten seconds whatever the time limit", () => {
    expect(countdownUrgency(10, 120)).toBe(1);
    expect(countdownUrgency(10, 20)).toBe(1);
    expect(countdownUrgency(8, 20)).toBe(1);
  });

  it("begins reddening at fifteen seconds on a short riddle", () => {
    expect(countdownUrgency(15, 20)).toBe(0);
    expect(countdownUrgency(12.5, 20)).toBeCloseTo(0.5);
  });
});

describe("retryWithDelays", () => {
  function recorder() {
    const sleeps: number[] = [];
    return { sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
  }

  it("returns true without waiting when the first attempt succeeds", async () => {
    const { sleeps, sleep } = recorder();
    const attempt = vi.fn().mockResolvedValue(true);

    expect(await retryWithDelays(attempt, [2000, 5000], sleep)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("waits the listed delays between attempts until one succeeds", async () => {
    const { sleeps, sleep } = recorder();
    const attempt = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await retryWithDelays(attempt, [2000, 5000], sleep)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });

  it("gives up after the initial attempt plus one retry per delay", async () => {
    const { sleeps, sleep } = recorder();
    const attempt = vi.fn().mockResolvedValue(false);

    expect(await retryWithDelays(attempt, [2000, 5000], sleep)).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, 5000]);
  });

  it("treats a thrown attempt as a failure", async () => {
    const { sleep } = recorder();
    const attempt = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(true);

    expect(await retryWithDelays(attempt, [1], sleep)).toBe(true);
  });

  it("stops retrying once told to", async () => {
    const { sleep } = recorder();
    const attempt = vi.fn().mockResolvedValue(false);
    let keepGoing = true;

    const result = retryWithDelays(attempt, [1, 1, 1], async () => { keepGoing = false; }, () => keepGoing);

    expect(await result).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
    void sleep;
  });
});

describe("attemptsUrgency", () => {
  it("is calm with every try left and fully red on the last one", () => {
    expect(attemptsUrgency(3, 3)).toBe(0);
    expect(attemptsUrgency(1, 3)).toBe(1);
  });

  it("reddens evenly as tries are used", () => {
    expect(attemptsUrgency(2, 3)).toBeCloseTo(0.5);
    expect(attemptsUrgency(4, 5)).toBeCloseTo(0.25);
    expect(attemptsUrgency(2, 5)).toBeCloseTo(0.75);
  });

  it("stays calm when there is only ever one try", () => {
    expect(attemptsUrgency(1, 1)).toBe(0);
  });

  it("clamps out-of-range values", () => {
    expect(attemptsUrgency(0, 3)).toBe(1);
    expect(attemptsUrgency(9, 3)).toBe(0);
  });
});

describe("stakesPressure", () => {
  it("is zero at the start with every try left", () => {
    expect(stakesPressure(120, 120, 3, 3)).toBe(0);
  });

  it("follows the share of time used", () => {
    expect(stakesPressure(60, 120, 3, 3)).toBeCloseTo(0.5);
    expect(stakesPressure(30, 120, 3, 3)).toBeCloseTo(0.75);
    expect(stakesPressure(0, 120, 3, 3)).toBe(1);
  });

  it("follows wrong tries when they are further along than the clock", () => {
    expect(stakesPressure(120, 120, 2, 3)).toBeCloseTo(0.5);
    expect(stakesPressure(120, 120, 1, 3)).toBe(1);
  });

  it("uses whichever of time or tries is further along", () => {
    expect(stakesPressure(90, 120, 2, 3)).toBeCloseTo(0.5);
    expect(stakesPressure(30, 120, 2, 3)).toBeCloseTo(0.75);
  });

  it("ignores tries on a single-try riddle and clamps bad values", () => {
    expect(stakesPressure(120, 120, 1, 1)).toBe(0);
    expect(stakesPressure(-5, 120, 3, 3)).toBe(1);
    expect(stakesPressure(500, 120, 3, 3)).toBe(0);
    expect(stakesPressure(10, 0, 1, 1)).toBe(1);
  });
});

describe("stakeScales", () => {
  it("starts both numbers at normal size", () => {
    expect(stakeScales(0)).toEqual({ reward: 1, penalty: 1 });
  });

  it("shrinks the reward steadily and swells the penalty faster toward the end", () => {
    expect(stakeScales(0.5).reward).toBeCloseTo(0.65);
    expect(stakeScales(0.5).penalty).toBeCloseTo(1.875);
    expect(stakeScales(1).reward).toBeCloseTo(0.3);
    expect(stakeScales(1).penalty).toBeCloseTo(4.5);
  });

  it("clamps pressure to its range", () => {
    expect(stakeScales(9)).toEqual(stakeScales(1));
    expect(stakeScales(-3)).toEqual(stakeScales(0));
  });
});

describe("shakeLevel", () => {
  it("is still until the halfway point, then ramps to full", () => {
    expect(shakeLevel(0)).toBe(0);
    expect(shakeLevel(0.5)).toBe(0);
    expect(shakeLevel(0.75)).toBeCloseTo(0.5);
    expect(shakeLevel(1)).toBe(1);
    expect(shakeLevel(7)).toBe(1);
  });
});

describe("needsPendingRetry", () => {
  const pending: PendingRiddleSubmission = {
    dailyChallengeId: "d",
    submissionId: "s",
    response: "piano",
    operationKey: "k",
  };

  it("stays hidden while the submission request is still in flight", () => {
    expect(needsPendingRetry(pending, true)).toBe(false);
  });

  it("shows once a request has finished and the submission is still unconfirmed", () => {
    expect(needsPendingRetry(pending, false)).toBe(true);
  });

  it("stays hidden when nothing is pending", () => {
    expect(needsPendingRetry(null, false)).toBe(false);
    expect(needsPendingRetry(null, true)).toBe(false);
  });
});

describe("isRepeatGuess", () => {
  const history = [{ response: "Bra" }, { response: "r3" }];

  it("matches an earlier guess ignoring case, punctuation, and spacing", () => {
    expect(isRepeatGuess(history, "bra")).toBe(true);
    expect(isRepeatGuess(history, "  BRA!! ")).toBe(true);
    expect(isRepeatGuess(history, "R 3".replace(" ", ""))).toBe(true);
  });

  it("allows a new guess and an empty history", () => {
    expect(isRepeatGuess(history, "brat")).toBe(false);
    expect(isRepeatGuess([], "bra")).toBe(false);
  });

  it("compares inner spacing the way the grader does", () => {
    expect(isRepeatGuess([{ response: "a  piano" }], "A piano")).toBe(true);
  });
});
