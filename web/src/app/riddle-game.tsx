"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import type { Role } from "@/server/identity/identity";
import { sanitizeCharacterInput } from "@/server/challenges/character-puzzle";
import { CharacterBoard, CharacterKeyboard } from "./character-grid";
import { PrimaryButton } from "./primary-button";
import {
  attemptsUrgency,
  estimateServerClockOffset,
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
  restorePendingSubmission,
  retryWithDelays,
  shakeLevel,
  speedTierStatuses,
  stakeScales,
  withAuthoritativePlay,
  type ChallengeMutationResponse,
  type PendingRiddleSubmission,
  type PlayerChallengeState,
  type ScoringPolicy,
  type TodayChallengeResponse,
} from "@/lib/challenge-state";

interface LoadedChallenge {
  data: TodayChallengeResponse;
  serverClockOffsetMs: number;
}

const AUTO_SAVE_RETRY_DELAYS_MS = [2_000, 5_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? fallback;
}

export function RiddleGame({
  playerId,
  role,
  onCompleted,
}: {
  playerId: string;
  role: Role;
  onCompleted: () => void;
}) {
  const [loaded, setLoaded] = useState<LoadedChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<PendingRiddleSubmission | null>(null);
  const [response, setResponse] = useState("");
  const [clientNow, setClientNow] = useState(() => Date.now());
  const autoFinalizedSubmissionId = useRef<string | null>(null);
  const [autoSaveFailedFor, setAutoSaveFailedFor] = useState<string | null>(null);
  const mounted = useRef(true);

  const loadToday = useCallback(async () => {
    const requestStartedAt = Date.now();
    const request = await fetch("/api/challenge/today", { cache: "no-store" });
    const responseReceivedAt = Date.now();
    if (!request.ok) {
      throw new Error(await responseError(request, "Could not load today's riddle."));
    }
    const data = await request.json() as TodayChallengeResponse;
    const play = data.schedule ? data.play : undefined;
    let restoredPending: PendingRiddleSubmission | null = null;
    if (data.schedule && play && play.status !== "not_started") {
      const storage = window.sessionStorage;
      restoredPending = restorePendingSubmission(
        storage,
        playerId,
        data.schedule.id,
        play.submissionId,
      );
      if (restoredPending && isSubmissionConfirmed(play, restoredPending.operationKey)) {
        removePendingSubmission(
          storage,
          playerId,
          play.submissionId,
          restoredPending.operationKey,
        );
        restoredPending = null;
      }
    }
    const serverClockOffsetMs = play && play.status !== "not_started"
      ? estimateServerClockOffset(play.serverTime, requestStartedAt, responseReceivedAt)
      : 0;
    setLoaded({ data, serverClockOffsetMs });
    setClientNow(responseReceivedAt);
    setError(null);
    setRefreshRequired(false);
    setPendingSubmission(restoredPending);
  }, [playerId]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void loadToday()
        .catch((err: unknown) => {
          if (active) setError(err instanceof Error ? err.message : "Could not load today's riddle.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [loadToday]);

  const play = loaded?.data.schedule ? loaded.data.play : undefined;
  useEffect(() => {
    if (!play || play.status !== "in_progress") return;
    const timer = window.setInterval(() => setClientNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [play]);

  const deadlinePassed = play?.status === "in_progress"
    && loaded !== null
    && isPastDeadline(play.deadline, loaded.serverClockOffsetMs, clientNow);
  const expiredSubmissionId = deadlinePassed && play?.status === "in_progress" ? play.submissionId : null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function applyAuthoritativePlay(
    nextPlay: PlayerChallengeState,
    requestStartedAt: number,
    responseReceivedAt: number,
  ) {
    setLoaded((current) => current
      ? {
          data: withAuthoritativePlay(current.data, nextPlay),
          serverClockOffsetMs: nextPlay.status === "not_started"
            ? 0
            : estimateServerClockOffset(
                nextPlay.serverTime,
                requestStartedAt,
                responseReceivedAt,
              ),
        }
      : current);
    setClientNow(responseReceivedAt);
    setResponse("");
    setError(null);
    setRefreshRequired(false);
  }

  function clearConfirmedPending(pending: PendingRiddleSubmission) {
    try {
      removePendingSubmission(
        window.sessionStorage,
        playerId,
        pending.submissionId,
        pending.operationKey,
      );
    } catch {
      // The server-confirmed key remains safe to retry if browser storage cannot be cleared.
    } finally {
      setPendingSubmission(null);
    }
  }

  async function refreshSavedGame() {
    if (!loaded?.data.schedule) return;
    setBusy(true);
    setError(null);
    const requestStartedAt = Date.now();
    try {
      const request = await fetch(`/api/challenge/${loaded.data.schedule.id}`, {
        cache: "no-store",
      });
      const responseReceivedAt = Date.now();
      if (!request.ok) {
        setError(await responseError(request, "Could not refresh the saved game."));
        return;
      }
      const data = await request.json() as TodayChallengeResponse;
      const nextPlay = data.schedule ? data.play : undefined;
      if (!nextPlay) throw new Error("Saved game state was not returned.");
      setLoaded({
        data,
        serverClockOffsetMs: nextPlay.status === "not_started"
          ? 0
          : estimateServerClockOffset(nextPlay.serverTime, requestStartedAt, responseReceivedAt),
      });
      setClientNow(responseReceivedAt);
      setResponse("");
      setError(null);
      setRefreshRequired(false);
      if (pendingSubmission && isSubmissionConfirmed(nextPlay, pendingSubmission.operationKey)) {
        clearConfirmedPending(pendingSubmission);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh the saved game.");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!loaded?.data.schedule) return;
    setBusy(true);
    setError(null);
    const requestStartedAt = Date.now();
    try {
      const result = await fetch(`/api/challenge/${loaded.data.schedule.id}/start`, {
        method: "POST",
      });
      if (!result.ok) {
        setError(await responseError(result, "Could not start the riddle."));
        return;
      }
      const responseReceivedAt = Date.now();
      const nextPlay = await result.json() as PlayerChallengeState;
      applyAuthoritativePlay(nextPlay, requestStartedAt, responseReceivedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the riddle.");
    } finally {
      setBusy(false);
    }
  }

  async function requestFinalizeExpired(): Promise<boolean> {
    if (!loaded?.data.schedule) return false;
    const requestStartedAt = Date.now();
    try {
      const result = await fetch(`/api/challenge/${loaded.data.schedule.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ finalizeExpired: true }),
      });
      if (!result.ok) return false;
      const responseReceivedAt = Date.now();
      const outcome = await result.json() as ChallengeMutationResponse;
      applyAuthoritativePlay(outcome.play, requestStartedAt, responseReceivedAt);
      if (outcome.finalized) onCompleted();
      return true;
    } catch {
      return false;
    }
  }

  // Finalizing is idempotent, so retrying quietly is safe; the server also finalizes overdue games itself.
  async function finalizeAutomatically(submissionId: string) {
    const saved = await retryWithDelays(
      requestFinalizeExpired,
      AUTO_SAVE_RETRY_DELAYS_MS,
      sleep,
      () => mounted.current,
    );
    if (!saved && mounted.current) setAutoSaveFailedFor(submissionId);
  }

  async function tryAgain(submissionId: string) {
    setBusy(true);
    setError(null);
    try {
      if (await requestFinalizeExpired()) return;
      // Loading riddle state makes the server finalize any overdue game.
      await loadToday();
      setAutoSaveFailedFor((current) => (current === submissionId ? null : current));
      autoFinalizedSubmissionId.current = null;
    } catch {
      setError("Still could not reach the server. Your result will be recorded either way.");
    } finally {
      setBusy(false);
    }
  }

  async function submitPayload(body: PendingRiddleSubmission) {
    if (!loaded?.data.schedule) return;
    setBusy(true);
    setError(null);
    const requestStartedAt = Date.now();
    try {
      const result = await fetch(`/api/challenge/${loaded.data.schedule.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: body.response, operationKey: body.operationKey }),
      });
      if (!result.ok) {
        const message = await responseError(result, "Could not submit that answer.");
        if (result.status >= 500) {
          setRefreshRequired(true);
          setError(`The submission may have been saved. ${message}`);
        } else {
          setRefreshRequired(true);
          setError(message);
        }
        return;
      }
      const responseReceivedAt = Date.now();
      const outcome = await result.json() as ChallengeMutationResponse;
      applyAuthoritativePlay(outcome.play, requestStartedAt, responseReceivedAt);
      clearConfirmedPending(body);
      if (outcome.finalized) onCompleted();
    } catch (err) {
      setRefreshRequired(true);
      setError(err instanceof Error
        ? `The submission may have been saved. ${err.message}`
        : "The submission may have been saved. Refresh the saved game before trying again.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!expiredSubmissionId || busy || pendingSubmission || refreshRequired) return;
    if (autoFinalizedSubmissionId.current === expiredSubmissionId) return;
    const timer = window.setTimeout(() => {
      autoFinalizedSubmissionId.current = expiredSubmissionId;
      void finalizeAutomatically(expiredSubmissionId);
    }, 0);
    return () => window.clearTimeout(timer);
  });

  const activeCharacterConfig = play?.status === "in_progress" && play.type === "character_puzzle"
    ? play.config
    : undefined;
  const typingLocked = busy || refreshRequired || pendingSubmission !== null || deadlinePassed
    || (play?.status === "in_progress" && loaded !== null
      && remainingSeconds(play.deadline, loaded.serverClockOffsetMs, clientNow) === 0);

  useEffect(() => {
    if (!activeCharacterConfig || typingLocked) return;
    const config = activeCharacterConfig;
    function handleKey(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (play?.status === "in_progress" && response.length === config.target_length && !isRepeatGuess(play.guessHistory, response)) {
          void submitGuess(response);
        }
        return;
      }
      if (event.key === "Backspace") {
        setResponse((current) => current.slice(0, -1));
        return;
      }
      if (event.key.length !== 1) return;
      const character = sanitizeCharacterInput(event.key, config);
      if (character) setResponse((current) => sanitizeCharacterInput(current + character, config));
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitGuess(response);
  }

  async function submitGuess(value: string) {
    if (!value.trim() || !loaded?.data.schedule || play?.status !== "in_progress") return;
    if (isRepeatGuess(play.guessHistory, value)) return;
    const pending = {
      dailyChallengeId: loaded.data.schedule.id,
      submissionId: play.submissionId,
      response: value,
      operationKey: crypto.randomUUID(),
    };
    try {
      persistPendingSubmission(window.sessionStorage, playerId, pending);
    } catch {
      setError("Could not save retry protection. The answer was not submitted.");
      return;
    }
    setPendingSubmission(pending);
    await submitPayload(pending);
  }

  if (loading) return <RiddleFrame><p aria-live="polite">Loading today’s riddle…</p></RiddleFrame>;

  if (!loaded) {
    return <RiddleFrame><ErrorMessage message={error ?? "Could not load today's riddle."} /><PrimaryButton type="button" onClick={() => { setError(null); setLoading(true); void loadToday().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load today's riddle.")).finally(() => setLoading(false)); }} className="mt-5 px-5 py-2.5">Try again</PrimaryButton></RiddleFrame>;
  }

  if (!loaded.data.schedule) {
    return <RiddleFrame><p className="text-lg font-semibold">Nothing here right now</p><p className="mt-2 text-white/65">Check later</p></RiddleFrame>;
  }

  if (role !== "player") {
    return <RiddleFrame><p className="text-lg font-semibold">Today’s challenge is ready.</p><p className="mt-2 text-white/65">Only player accounts can start and submit scored riddles.</p></RiddleFrame>;
  }

  if (!play) {
    return <RiddleFrame><ErrorMessage message="Player challenge state was not returned." /></RiddleFrame>;
  }

  if (play.status === "not_started") {
    return <NotStartedRiddle play={play} busy={busy} error={error} onStart={() => void start()} />;
  }

  if (play.status === "completed") {
    return <CompletedRiddle play={play} />;
  }

  const secondsRemaining = remainingSeconds(
    play.deadline,
    loaded.serverClockOffsetMs,
    clientNow,
  );

  const urgency = countdownUrgency(secondsRemaining, play.timeLimitSeconds);
  const repeatGuess = response.trim() !== "" && isRepeatGuess(play.guessHistory, response);
  const characterConfig = play.type === "character_puzzle" ? play.config : undefined;
  const speedTiers = speedTierStatuses(
    play.scoringPolicy.speed_bonuses,
    play.timeLimitSeconds,
    play.deadline,
    loaded.serverClockOffsetMs,
    clientNow,
  );

  return <RiddleFrame>
    <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
      <RiddleStakes policy={play.scoringPolicy} pressure={stakesPressure(secondsRemaining, play.timeLimitSeconds, play.attemptsRemaining, play.maxAttempts)} />
      <div className="ml-auto">
        <p className="mb-2 text-right text-sm font-semibold uppercase tracking-[0.2em] text-white/55">{play.difficulty}</p>
        <div className="flex gap-3 text-right">
          <Stat label="Time" value={formatCountdown(secondsRemaining)} live urgency={urgency} />
          <Stat label="Tries left" value={`${play.attemptsRemaining}/${play.maxAttempts}`} urgency={attemptsUrgency(play.attemptsRemaining, play.maxAttempts)} pulse={false} />
        </div>
      </div>
    </div>

    {speedTiers.length > 0 && <SpeedTiers tiers={speedTiers} basePoints={play.scoringPolicy.base_points} />}

    {characterConfig
      ? <div className="mt-8 border-t border-white/25 pt-6">
        <p className="mb-5 text-center text-sm font-semibold uppercase tracking-wide text-white/55">Letter game</p>
        <div>
          <CharacterBoard guesses={play.guessHistory} current={response} length={characterConfig.target_length} rows={play.maxAttempts} />
          {repeatGuess && <p role="status" className="mt-4 text-center text-sm font-semibold text-[#f00000]">You already tried that code.</p>}
          {!refreshRequired && !needsPendingRetry(pendingSubmission, busy) && secondsRemaining > 0 && <CharacterKeyboard
            characterSet={characterConfig.character_set}
            guesses={play.guessHistory}
            disabled={busy}
            canSubmit={response.length === characterConfig.target_length && !repeatGuess}
            onCharacter={(character) => setResponse((current) => sanitizeCharacterInput(current + character, characterConfig))}
            onDelete={() => setResponse((current) => current.slice(0, -1))}
            onEnter={() => void submitGuess(response)}
          />}
        </div>
      </div>
      : <p className="mt-8 border-y border-white/25 py-8 text-balance text-2xl font-medium leading-relaxed sm:text-3xl">{play.prompt}</p>}

    {!characterConfig && play.guessHistory.length > 0 && <div className="mt-6">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-white/55">Previous guesses</h4>
      <ul className="mt-2 divide-y divide-white/20 border-y border-white/25">
        {play.guessHistory.map((guess, index) => <li key={`${guess.response}-${index}`} className="flex items-center justify-between gap-4 py-3"><span>{guess.response}</span><span className={`text-sm font-semibold ${guess.correct ? "text-emerald-700" : "text-red-700"}`}>{guess.correct ? "Correct" : "Incorrect"}</span></li>)}
      </ul>
    </div>}

    {refreshRequired
      ? <div className="mt-7 rounded-md border border-amber-700/50 bg-amber-50 p-4"><p className="text-amber-900">Do not submit again until the saved result has been checked.</p><PrimaryButton type="button" disabled={busy} onClick={() => void refreshSavedGame()} className="mt-4 px-5 py-2.5">{busy ? "Refreshing…" : "Refresh saved game"}</PrimaryButton></div>
      : needsPendingRetry(pendingSubmission, busy) && pendingSubmission
        ? <div className="mt-7 rounded-md border border-amber-700/50 bg-amber-50 p-4"><p className="text-amber-900">The saved game still does not show the previous submission. Retry that same submission safely before entering another answer.</p><PrimaryButton type="button" onClick={() => void submitPayload(pendingSubmission)} className="mt-4 px-5 py-2.5">Retry submission</PrimaryButton></div>
      : secondsRemaining === 0
        ? autoSaveFailedFor === play.submissionId
          ? <div className="mt-7 rounded-md border border-white/25 bg-black/[0.04] p-5">
            <p className="font-semibold">Time has expired.</p>
            <p className="mt-1 text-sm text-white/65">
              {typeof navigator !== "undefined" && !navigator.onLine ? "You appear to be offline. " : "We could not confirm your result right now. "}
              It will be recorded either way{(play.scoringPolicy.failure_penalty_points ?? 0) > 0 ? `, including the ${play.scoringPolicy.failure_penalty_points}-point deduction` : ""}, and you will see it when you are back.
            </p>
            <PrimaryButton type="button" disabled={busy} onClick={() => void tryAgain(play.submissionId)} className="mt-4 px-5 py-2.5">{busy ? "Trying…" : "Try again"}</PrimaryButton>
          </div>
          : <p role="status" className="mt-7 text-lg font-semibold">Time’s up. Saving your result…</p>
        : characterConfig ? null
        : <form onSubmit={submit} className="mt-7">
          <label htmlFor="riddle-response" className="text-sm font-semibold text-white/70">Your answer</label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <input id="riddle-response" value={response} onChange={(event) => setResponse(event.target.value)} autoComplete="off" disabled={busy} className="min-w-0 flex-1 rounded-md border border-white/70 bg-black/[0.06] px-4 py-3 text-lg text-white placeholder:text-white/45 focus:outline-2 focus:outline-white disabled:opacity-50" placeholder="Enter your answer" />
            <PrimaryButton type="submit" disabled={busy || !response.trim() || repeatGuess} className="px-6 py-3">{busy ? "Checking…" : "Submit answer"}</PrimaryButton>
          </div>
          {repeatGuess && <p role="status" className="mt-2 text-sm font-semibold text-[#f00000]">You already tried that answer.</p>}
        </form>}
    {error && <div className="mt-5"><ErrorMessage message={error} /></div>}
  </RiddleFrame>;
}

export function NotStartedRiddle({
  play,
  busy,
  error,
  onStart,
}: {
  play: Extract<PlayerChallengeState, { status: "not_started" }>;
  busy: boolean;
  error: string | null;
  onStart: () => void;
}) {
  return <RiddleFrame>
    <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/55">Daily challenge</p>
    <h3 className="mt-3 text-2xl font-semibold capitalize">{play.difficulty ?? "Ready when you are?"}</h3>
    <p className="mt-3 max-w-xl text-white/70">Your timer starts only after the game has begun. Refreshing will not reset it.</p>
    {play.scoringPolicy && <div className="mt-6"><RiddleStakes policy={play.scoringPolicy} /></div>}
    {error && <div className="mt-5"><ErrorMessage message={error} /></div>}
    {play.available
      ? <PrimaryButton type="button" disabled={busy} onClick={onStart} className="mt-7 px-6 py-3">{busy ? "Starting…" : "Start riddle"}</PrimaryButton>
      : <p className="mt-6 rounded-md border border-white/25 bg-black/[0.04] px-4 py-3 text-white/70">Today’s puzzle has not been published yet.</p>}
  </RiddleFrame>;
}

export function CompletedRiddle({ play }: { play: Extract<PlayerChallengeState, { status: "completed" }> }) {
  const breakdown = play.result.scoringBreakdown;
  const penaltyPoints = breakdown.penalty_points ?? 0;
  return <RiddleFrame>
    <div className="relative">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/55">Results</p>
      <h3 className="mt-3 text-3xl font-semibold">{play.result.correct ? "awesome sauce" : "epic fail"}</h3>
      <p className="mt-3 text-white/70">{play.result.correct ? "nice job" : "you cant do nathan"}</p>
      <ResultStamp success={play.result.correct} />
    </div>
    <div className={`mt-8 grid gap-px overflow-hidden rounded-md border border-white/50 bg-white/30 ${penaltyPoints > 0 ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
      <ResultStat label="Base points" value={breakdown.base_points} />
      <ResultStat label="Speed bonus" value={breakdown.speed_bonus_points ?? 0} />
      {penaltyPoints > 0 && <ResultStat label="Penalty" value={-penaltyPoints} />}
      <ResultStat label="Total points" value={breakdown.total_points} />
    </div>
    <div className="mt-7">
      <p className="text-sm font-semibold uppercase tracking-wide text-white/55">{play.type === "character_puzzle" ? "Letter game" : "Riddle"}</p>
      {play.type !== "character_puzzle" && <p className="mt-2 text-xl font-medium">{play.prompt}</p>}
    </div>
    {play.guessHistory.length > 0 && <div className="mt-6">
      <p className="text-sm font-semibold uppercase tracking-wide text-white/55">Your answers</p>
      {play.type === "character_puzzle"
        ? <div className="mt-3"><CharacterBoard guesses={play.guessHistory} length={play.config?.target_length ?? play.guessHistory[0].response.length} /></div>
        : <ul className="mt-2 space-y-2">{play.guessHistory.map((guess, index) => <li key={`${guess.response}-${index}`} className="flex justify-between rounded-md border border-white/25 bg-black/[0.04] px-4 py-3"><span>{guess.response}</span><span className={guess.correct ? "text-emerald-700" : "text-red-700"}>{guess.correct ? "Correct" : "Incorrect"}</span></li>)}</ul>}
    </div>}
  </RiddleFrame>;
}

function RiddleFrame({ children }: { children: ReactNode }) {
  return <section className="mx-auto w-[calc(100%-2rem)] max-w-[1280px] overflow-x-clip py-6 lg:py-10"><h2 className="text-[26px] font-semibold tracking-tight lg:text-[34px]">Riddle</h2><div className="mt-6">{children}</div></section>;
}

function Stat({ label, value, live = false, urgency = 0, pulse = urgency === 1 }: { label: string; value: string; live?: boolean; urgency?: number; pulse?: boolean }) {
  const percent = Math.round(urgency * 100);
  const style = urgency > 0
    ? {
        color: `color-mix(in srgb, #ff4d4d ${percent}%, var(--color-white))`,
        borderColor: `color-mix(in srgb, #ff4d4d ${percent}%, transparent)`,
      }
    : undefined;
  return <div style={style} className={`min-w-24 rounded-md border border-white/25 bg-black/[0.04] px-3 py-2 ${pulse ? "animate-pulse" : ""}`}><p className="text-xs font-semibold uppercase tracking-wide opacity-60">{label}</p><p className="mt-1 text-xl font-bold tabular-nums" aria-live={live && urgency < 1 ? "polite" : undefined}>{value}</p></div>;
}

function SpeedTiers({ tiers, basePoints }: { tiers: ReturnType<typeof speedTierStatuses>; basePoints: number }) {
  return <div className="mt-6">
    <h4 className="text-sm font-semibold uppercase tracking-wide text-white/55">Speed bonuses <span className="font-normal normal-case tracking-normal">(on top of {basePoints} points; the best tier you still qualify for applies)</span></h4>
    <ul className="mt-2 flex flex-wrap gap-2">
      {tiers.map((tier) => <li
        key={tier.underMs}
        className={`rounded-md border px-3 py-2 text-sm ${
          tier.expired
            ? "border-white/15 text-white/35 line-through"
            : tier.current
              ? "border-emerald-300/70 bg-emerald-950/40 font-semibold text-emerald-200"
              : "border-white/30 text-white/80"
        }`}
      >
        Under {tier.underMs / 1000}s: +{tier.points}
        {tier.expired && <span className="ml-2 inline-block text-xs font-semibold uppercase">expired</span>}
        {tier.current && <span className="ml-2 text-xs font-semibold uppercase"></span>}
      </li>)}
    </ul>
  </div>;
}

const MAX_SHAKE_PX = 7;

function stakeStyle(scale: number, shake: number): CSSProperties {
  const style: Record<string, string> = { "--stake-scale": scale.toFixed(3) };
  if (shake > 0) {
    style["--shake"] = `${Number((shake * MAX_SHAKE_PX).toFixed(2))}px`;
    style["--shake-level"] = String(Number(shake.toFixed(3)));
    style["--shake-duration"] = `${Number((0.5 - 0.35 * shake).toFixed(3))}s`;
  }
  return style as CSSProperties;
}

// pressure runs 0 to 1: the reward shrinks, the penalty swells over the page and shakes; the amounts never change.
export function RiddleStakes({ policy, pressure = 0 }: { policy: ScoringPolicy; pressure?: number }) {
  const scales = stakeScales(pressure);
  const shake = shakeLevel(pressure);
  const penalty = policy.failure_penalty_points ?? 0;
  const cells = [
    { label: "Correct answer", value: `+${policy.base_points}`, note: "Points for solving it", tone: "positive" as const, style: stakeStyle(scales.reward, 0), className: "origin-bottom-left" },
    ...(penalty > 0 ? [{ label: "If you fail", value: `-${penalty}`, note: "Out of tries or time", tone: "negative" as const, style: stakeStyle(scales.penalty, shake), className: `relative z-10 origin-top-left ${shake > 0 ? "stake-shake" : ""}` }] : []),
  ];
  return <div className="flex flex-wrap items-end gap-x-14 gap-y-4">
    {cells.map((cell) => <div key={cell.label} data-tone={cell.tone}>
      <p className="text-xs font-semibold uppercase tracking-wide text-white/55">{cell.label}</p>
      <p style={cell.style} className={`stake-number pointer-events-none mt-1 select-none text-3xl font-bold tabular-nums ${cell.className} ${toneClasses[cell.tone]}`}>{cell.value}</p>
      <p className="mt-1 text-xs text-white/55">{cell.note}</p>
    </div>)}
  </div>;
}

const toneClasses = { positive: "text-[#00940a]", negative: "text-[#f00000]", zero: "text-white" } as const;

function ResultStat({ label, value }: { label: string; value: number }) {
  const tone = value > 0 ? "positive" : value < 0 ? "negative" : "zero";
  return <div className="navy-surface px-5 py-5" data-tone={tone}><p className="text-xs font-semibold uppercase tracking-wide opacity-60">{label}</p><p className={`mt-1 text-3xl font-bold tabular-nums ${toneClasses[tone]}`}>{value}</p></div>;
}

function ResultStamp({ success }: { success: boolean }) {
  return <div
    role="img"
    aria-label={success ? "Success" : "Fail"}
    style={{ color: success ? "#00940a" : "#f00000" }}
    className="result-stamp pointer-events-none mt-6 w-fit select-none lg:absolute lg:-top-8 lg:right-2 lg:mt-0"
  >
    <svg width="0" height="0" aria-hidden="true" focusable="false" className="absolute">
      <filter id="stamp-grunge" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="noise" />
        <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -12 8.3" result="speckle" />
        <feComposite in="SourceGraphic" in2="speckle" operator="in" />
      </filter>
    </svg>
    <div style={{ filter: "url(#stamp-grunge)" }} className="rounded-xl border-[10px] border-current p-1.5">
      <div className="rounded-md border-4 border-current px-6 py-1 text-5xl font-black uppercase leading-tight tracking-[0.12em] sm:text-6xl lg:text-7xl">{success ? "SUCCESS" : "FAIL"}</div>
    </div>
  </div>;
}

function ErrorMessage({ message }: { message: string }) {
  return <p role="alert" className="rounded-md border border-red-700/50 bg-red-50 px-4 py-3 text-red-800">{message}</p>;
}
