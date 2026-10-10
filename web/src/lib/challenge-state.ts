import type { CharacterConfig, CharacterFeedback } from "@/server/challenges/character-puzzle";
import { normalizeAnswer } from "@/server/challenges/grading";

export interface ChallengeSchedule {
  id: string;
  mode: "shared" | "personal";
  allowedTypes: string[];
}

export interface GuessHistoryEntry {
  response: string;
  correct: boolean;
  operationKey?: string;
  feedback?: CharacterFeedback[];
}

export interface ScoringPolicy {
  base_points: number;
  failure_penalty_points?: number;
  speed_bonuses?: Array<{ under_ms: number; points: number }>;
}

export interface ScoringBreakdown {
  base_points: number;
  speed_bonus_points: number | null;
  penalty_points?: number;
  total_points: number;
  bonus_under_ms: number | null;
}

export interface ActiveRiddle {
  submissionId: string;
  challengeId: string;
  type: "riddle" | "character_puzzle";
  config?: CharacterConfig;
  difficulty: string;
  prompt: string;
  startedAt: string;
  deadline: string | null;
  serverTime: string;
  timeLimitSeconds: number | null;
  maxAttempts: number;
  attempts: number;
  attemptsRemaining: number;
  guessHistory: GuessHistoryEntry[];
  feedback: CharacterFeedback[] | null;
  scoringPolicy: ScoringPolicy;
}

export type PlayerChallengeState =
  | {
      status: "not_started";
      available: boolean;
      difficulty: string | null;
      type?: "riddle" | "character_puzzle";
      targetLength?: number;
      scoringPolicy?: PublicScoringPolicy;
    }
  | ({ status: "in_progress" } & ActiveRiddle)
  | ({
      status: "completed";
      result: {
        correct: boolean;
        timeTakenMs: number;
        scoringBreakdown: ScoringBreakdown;
      };
    } & ActiveRiddle);

export type PublicScoringPolicy = Pick<ScoringPolicy, "base_points" | "failure_penalty_points">;

export interface StaffRiddlePreview {
  type: "riddle" | "character_puzzle";
  difficulty: string;
  prompt: string;
  timeLimitSeconds: number | null;
  maxAttempts: number;
  scoringPolicy: PublicScoringPolicy;
  speedBonuses?: ScoringPolicy["speed_bonuses"];
  config?: CharacterConfig;
}

export type StaffPlayerStatusKind = "no_riddle" | "not_started" | "in_progress" | "expired" | "solved" | "failed";

export interface StaffPlayerStatus {
  userId: string;
  displayName: string;
  name: string | null;
  puzzle: {
    type: "riddle" | "character_puzzle";
    difficulty: string;
    maxAttempts: number;
    timeLimitSeconds: number | null;
  } | null;
  status: StaffPlayerStatusKind;
  attempts: number;
  timeTakenMs: number | null;
  points: number | null;
  play?: PlayerChallengeState | null;
}

export type TodayChallengeResponse =
  | { schedule: null }
  | {
    schedule: ChallengeSchedule;
    play?: PlayerChallengeState;
    preview?: StaffRiddlePreview;
    playerStatuses?: StaffPlayerStatus[];
  };

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

// Uses the grader's normalization so "Bra!" and "bra" count as the same guess.
export function isRepeatGuess(history: readonly { response: string }[], response: string): boolean {
  const normalized = normalizeAnswer(response);
  return history.some((guess) => normalizeAnswer(guess.response) === normalized);
}

// While a request is still in flight the pending note is expected, so only warn once it has settled unconfirmed.
export function needsPendingRetry(pending: PendingRiddleSubmission | null, busy: boolean): boolean {
  return pending !== null && !busy;
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
  deadline: string | null,
  serverClockOffsetMs: number,
  clientNow: number,
): number {
  if (deadline === null) return Infinity;
  const milliseconds = Date.parse(deadline) - (clientNow + serverClockOffsetMs);
  return Math.max(0, Math.ceil(milliseconds / 1000));
}

// The client clock estimate can run slightly ahead of the server, which rejects an early finalize.
const DEADLINE_GRACE_MS = 1_000;

export function isPastDeadline(
  deadline: string | null,
  serverClockOffsetMs: number,
  clientNow: number,
): boolean {
  if (deadline === null) return false;
  return clientNow + serverClockOffsetMs >= Date.parse(deadline) + DEADLINE_GRACE_MS;
}

export interface SpeedTierStatus {
  underMs: number;
  points: number;
  expired: boolean;
  current: boolean;
}

// Mirrors the server rule: a tier pays only while elapsed time is strictly under its threshold.
export function speedTierStatuses(
  tiers: ScoringPolicy["speed_bonuses"],
  timeLimitSeconds: number,
  deadline: string,
  serverClockOffsetMs: number,
  clientNow: number,
): SpeedTierStatus[] {
  const elapsedMs = timeLimitSeconds * 1000 - (Date.parse(deadline) - (clientNow + serverClockOffsetMs));
  return speedTierStatusesAtElapsed(tiers, elapsedMs);
}

export function speedTierStatusesAtElapsed(
  tiers: ScoringPolicy["speed_bonuses"],
  elapsedMs: number,
): SpeedTierStatus[] {
  const statuses = [...(tiers ?? [])]
    .sort((a, b) => a.under_ms - b.under_ms)
    .map((tier) => ({
      underMs: tier.under_ms,
      points: tier.points,
      expired: elapsedMs >= tier.under_ms,
      current: false,
    }));
  const best = statuses
    .filter((tier) => !tier.expired)
    .reduce<SpeedTierStatus | null>((max, tier) => (!max || tier.points > max.points ? tier : max), null);
  return statuses.map((tier) => ({ ...tier, current: tier === best }));
}

// Runs `attempt` once, then once more after each delay, stopping at the first success.
export async function retryWithDelays(
  attempt: () => Promise<boolean>,
  delaysMs: readonly number[],
  sleep: (ms: number) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  for (let index = 0; index <= delaysMs.length; index += 1) {
    if (await attempt().catch(() => false)) return true;
    if (index === delaysMs.length) break;
    await sleep(delaysMs[index]);
    if (!shouldContinue()) break;
  }
  return false;
}

const URGENT_SECONDS = 10;
const MIN_WARNING_SECONDS = 15;

// 0 = calm, 1 = fully urgent; ramps up over the last 30 percent of the limit and is full in the last 10 seconds.
export function countdownUrgency(secondsRemaining: number, timeLimitSeconds: number | null): number {
  if (timeLimitSeconds === null) return 0;
  const rampStart = Math.max(timeLimitSeconds * 0.3, MIN_WARNING_SECONDS);
  if (secondsRemaining <= URGENT_SECONDS) return 1;
  if (secondsRemaining >= rampStart) return 0;
  return (rampStart - secondsRemaining) / (rampStart - URGENT_SECONDS);
}

// 0 with every try left, 1 on the last one; a single-try riddle has no build-up.
export function attemptsUrgency(attemptsRemaining: number, maxAttempts: number): number {
  if (maxAttempts <= 1) return 0;
  const used = (maxAttempts - attemptsRemaining) / (maxAttempts - 1);
  return Math.min(1, Math.max(0, used));
}

// 0 at the start, 1 once time is up or on the last try; whichever is further along drives it.
export function stakesPressure(
  secondsRemaining: number,
  timeLimitSeconds: number | null,
  attemptsRemaining: number,
  maxAttempts: number,
): number {
  const timeUsed = timeLimitSeconds === null ? 0
    : timeLimitSeconds <= 0
    ? 1
    : Math.min(1, Math.max(0, 1 - secondsRemaining / timeLimitSeconds));
  return Math.max(timeUsed, attemptsUrgency(attemptsRemaining, maxAttempts));
}

const MIN_REWARD_SCALE = 0.3;
const MAX_PENALTY_SCALE = 4.5;

// The reward shrinks steadily while the penalty swells slowly at first and fast near the end.
export function stakeScales(pressure: number): { reward: number; penalty: number } {
  const level = Math.min(1, Math.max(0, pressure));
  return {
    reward: 1 - (1 - MIN_REWARD_SCALE) * level,
    penalty: 1 + (MAX_PENALTY_SCALE - 1) * level * level,
  };
}

// 0 until pressure passes the halfway point, then ramps to 1.
export function shakeLevel(pressure: number): number {
  return Math.min(1, Math.max(0, (pressure - 0.5) / 0.5));
}

export function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export const NO_TIME_LIMIT_LABEL = "No limit";

export function formatTimeLimit(seconds: number | null): string {
  return seconds === null ? NO_TIME_LIMIT_LABEL : formatCountdown(seconds);
}
