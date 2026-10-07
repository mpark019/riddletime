export interface ChallengeSchedule {
  id: string;
  mode: "shared" | "personal";
  allowedTypes: string[];
}

export interface GuessHistoryEntry {
  response: string;
  correct: boolean;
  operationKey?: string;
}

export interface ScoringPolicy {
  base_points: number;
  speed_bonuses?: Array<{ under_ms: number; points: number }>;
}

export interface ScoringBreakdown {
  base_points: number;
  speed_bonus_points: number | null;
  total_points: number;
  bonus_under_ms: number | null;
}

export interface ActiveRiddle {
  submissionId: string;
  challengeId: string;
  type: "riddle";
  difficulty: string;
  prompt: string;
  startedAt: string;
  deadline: string;
  serverTime: string;
  timeLimitSeconds: number;
  maxAttempts: number;
  attempts: number;
  attemptsRemaining: number;
  guessHistory: GuessHistoryEntry[];
  feedback: unknown[] | null;
  scoringPolicy: ScoringPolicy;
}

export type PlayerChallengeState =
  | { status: "not_started"; available: boolean }
  | ({ status: "in_progress" } & ActiveRiddle)
  | ({
      status: "completed";
      result: {
        correct: boolean;
        timeTakenMs: number;
        scoringBreakdown: ScoringBreakdown;
      };
    } & ActiveRiddle);

export type TodayChallengeResponse =
  | { schedule: null }
  | { schedule: ChallengeSchedule; play?: PlayerChallengeState };

export interface ChallengeMutationResponse {
  finalized: boolean;
  alreadyFinalized: boolean;
  play: Exclude<PlayerChallengeState, { status: "not_started" }>;
}

export interface PendingRiddleSubmission {
  dailyChallengeId: string;
  submissionId: string;
  response: string;
  operationKey: string;
}

export interface PendingSubmissionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pendingSubmissionStorageKey(playerId: string, submissionId: string): string {
  return `riddletime:pending-riddle:${playerId}:${submissionId}`;
}

function isPendingRiddleSubmission(value: unknown): value is PendingRiddleSubmission {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.response === "string" && candidate.response.trim().length > 0 &&
    typeof candidate.dailyChallengeId === "string" && UUID_PATTERN.test(candidate.dailyChallengeId) &&
    typeof candidate.submissionId === "string" && UUID_PATTERN.test(candidate.submissionId) &&
    typeof candidate.operationKey === "string" && UUID_PATTERN.test(candidate.operationKey);
}

export function persistPendingSubmission(
  storage: PendingSubmissionStorage,
  playerId: string,
  pending: PendingRiddleSubmission,
): void {
  storage.setItem(
    pendingSubmissionStorageKey(playerId, pending.submissionId),
    JSON.stringify(pending),
  );
}

export function restorePendingSubmission(
  storage: PendingSubmissionStorage,
  playerId: string,
  dailyChallengeId: string,
  submissionId: string,
): PendingRiddleSubmission | null {
  const stored = storage.getItem(pendingSubmissionStorageKey(playerId, submissionId));
  if (!stored) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new Error("Saved pending submission is malformed");
  }
  if (!isPendingRiddleSubmission(parsed)) {
    throw new Error("Saved pending submission is malformed");
  }
  if (parsed.dailyChallengeId !== dailyChallengeId || parsed.submissionId !== submissionId) {
    return null;
  }
  return parsed;
}

export function removePendingSubmission(
  storage: PendingSubmissionStorage,
  playerId: string,
  submissionId: string,
  confirmedOperationKey: string,
): boolean {
  const storageKey = pendingSubmissionStorageKey(playerId, submissionId);
  const stored = storage.getItem(storageKey);
  if (!stored) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return false;
  }
  if (!isPendingRiddleSubmission(parsed) || parsed.operationKey !== confirmedOperationKey) {
    return false;
  }

  storage.removeItem(storageKey);
  return true;
}

export function withAuthoritativePlay(
  current: TodayChallengeResponse,
  play: PlayerChallengeState,
): TodayChallengeResponse {
  if (!current.schedule) return current;
  return { schedule: current.schedule, play };
}

export function isSubmissionConfirmed(
  play: PlayerChallengeState,
  operationKey: string,
): boolean {
  return play.status === "completed" || (
    play.status === "in_progress" &&
    play.guessHistory.some((guess) => guess.operationKey === operationKey)
  );
}

export function estimateServerClockOffset(
  serverTime: string,
  requestStartedAt: number,
  responseReceivedAt: number,
): number {
  const midpoint = requestStartedAt + (responseReceivedAt - requestStartedAt) / 2;
  return Date.parse(serverTime) - midpoint;
}

export function remainingSeconds(
  deadline: string,
  serverClockOffsetMs: number,
  clientNow: number,
): number {
  const milliseconds = Date.parse(deadline) - (clientNow + serverClockOffsetMs);
  return Math.max(0, Math.ceil(milliseconds / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
