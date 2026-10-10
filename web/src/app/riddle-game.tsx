"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import type { Role } from "@/server/identity/identity";
import { sanitizeCharacterInput } from "@/server/challenges/character-puzzle";
import { difficultyColor } from "@/lib/difficulty";
import { CharacterBoard, CharacterKeyboard } from "./character-grid";
import { compareByName } from "@/lib/account-order";
import { FloatingQuestionMarks } from "./floating-question-marks";
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
  speedTierStatusesAtElapsed,
  formatTimeLimit,
  stakeScales,
  withAuthoritativePlay,
  type ChallengeMutationResponse,
  type PendingRiddleSubmission,
  type PlayerChallengeState,
  type ScoringPolicy,
  type StaffPlayerStatus,
  type StaffPlayerStatusKind,
  type StaffRiddlePreview,
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
    if (loaded.data.playerStatuses) return <StaffPlayerRiddles players={loaded.data.playerStatuses} />;
    return loaded.data.preview
      ? <StaffRiddleView preview={loaded.data.preview} />
      : <RiddleFrame><p className="text-lg font-semibold">Today’s challenge is ready.</p><p className="mt-2 text-white/65">Only player accounts can start and submit scored riddles.</p></RiddleFrame>;
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
  const speedTiers = play.timeLimitSeconds === null || play.deadline === null
    ? speedTierStatusesAtElapsed(
      play.scoringPolicy.speed_bonuses,
      clientNow + loaded.serverClockOffsetMs - Date.parse(play.startedAt),
    )
    : speedTierStatuses(
      play.scoringPolicy.speed_bonuses,
      play.timeLimitSeconds,
      play.deadline,
      loaded.serverClockOffsetMs,
      clientNow,
    );

  return <RiddleFrame>
    <PlayHeader
      policy={play.scoringPolicy}
      pressure={stakesPressure(secondsRemaining, play.timeLimitSeconds, play.attemptsRemaining, play.maxAttempts)}
      difficulty={play.difficulty}
      time={play.timeLimitSeconds === null ? formatTimeLimit(null) : formatCountdown(secondsRemaining)}
      urgency={urgency}
      tries={`${play.attemptsRemaining}/${play.maxAttempts}`}
      triesUrgency={attemptsUrgency(play.attemptsRemaining, play.maxAttempts)}
    />

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

const LONG_LETTER_GAME_LENGTH = 10;

export function NotStartedRiddle({
  play,
  busy,
  error,
  onStart,
  readOnly = false,
}: {
  play: Extract<PlayerChallengeState, { status: "not_started" }>;
  busy: boolean;
  error: string | null;
  onStart: () => void;
  readOnly?: boolean;
}) {
  const isLetterGame = play.type === "character_puzzle";
  const gameLabel = play.type === undefined ? null : isLetterGame ? "Letter game" : "Riddle";
  const wide = isLetterGame && (play.targetLength ?? 0) > LONG_LETTER_GAME_LENGTH;
  return <RiddleFrame>
    <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/55">Daily challenge{gameLabel && ` · ${gameLabel}`}</p>
    <h3 style={{ color: difficultyColor(play.difficulty) }} className="mt-3 text-2xl font-bold uppercase">{play.difficulty ?? "Ready when you are?"}</h3>
    <p className="mt-3 max-w-xl text-white/70">Your timer starts only after the game has begun. Refreshing will not reset it.</p>
    {wide && <p role="note" className="mt-4 max-w-xl rounded-md border border-amber-700/50 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
      This letter game has {play.targetLength} letters. The board is wide, so play on a laptop or desktop if feasible.
    </p>}
    {play.scoringPolicy && <div className="mt-6"><RiddleStakes policy={play.scoringPolicy} /></div>}
    {error && <div className="mt-5"><ErrorMessage message={error} /></div>}
    {readOnly ? null : play.available
      ? <PrimaryButton type="button" disabled={busy} onClick={onStart} className="mt-7 px-6 py-3">{busy ? "Starting…" : isLetterGame ? "Start letter game" : "Start riddle"}</PrimaryButton>
      : <p className="mt-6 rounded-md border border-white/25 bg-black/[0.04] px-4 py-3 text-white/70">Today’s puzzle has not been published yet.</p>}
  </RiddleFrame>;
}

const staffStatusLabels: Record<StaffPlayerStatusKind, { label: string; tone: string }> = {
  no_riddle: { label: "No riddle today", tone: "text-white/60" },
  not_started: { label: "Not started", tone: "" },
  in_progress: { label: "In progress", tone: "" },
  expired: { label: "Time expired", tone: "text-[#f00000]" },
  solved: { label: "Solved", tone: "text-[#00940a]" },
  failed: { label: "Failed", tone: "text-[#f00000]" },
};

function staffPillStatusTone(status: StaffPlayerStatusKind, active: boolean): string {
  if (status === "solved") return active ? "text-[#00940a]" : "text-[#4ade80]";
  if (status === "failed" || status === "expired") return active ? "text-[#d40000]" : "text-[#ff6b6b]";
  return active ? "text-black/75" : "text-white/85";
}

export function StaffPlayerRiddles({ players }: { players: StaffPlayerStatus[] }) {
  const sorted = [...players].sort(compareByName);
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = sorted.find((player) => player.userId === chosen)
    ?? sorted.find((player) => player.puzzle)
    ?? sorted[0];

  return <RiddleFrame>
    <div className="lg:grid lg:min-h-[28rem] lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-8">
      <div className="lg:relative lg:order-2"><section aria-label="Players" className="app-header relative isolate flex flex-col overflow-hidden rounded-md p-3 max-lg:fixed max-lg:inset-x-4 max-lg:bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] max-lg:z-40 max-lg:shadow-[0_-0.5rem_1.5rem_rgb(0_2_46_/_25%)] lg:absolute lg:inset-0 lg:p-4">
        <FloatingQuestionMarks contained compact />
        <p className="mb-3 hidden text-sm font-semibold lg:block">Players <span className="font-normal text-white/65">({sorted.length})</span></p>
        <div role="tablist" aria-label="Players" aria-orientation="vertical" className="flex gap-2 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:min-h-0 lg:flex-1 lg:flex-col lg:gap-1.5 lg:overflow-y-auto lg:overflow-x-hidden">
          {sorted.map((player) => {
            const active = player.userId === selected?.userId;
            const { label } = staffStatusLabels[player.status];
            return <button
              key={player.userId}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setChosen(player.userId)}
              className={`flex h-11 shrink-0 select-none items-center gap-2 rounded-md border px-4 text-left text-[15px] font-semibold transition focus-visible:outline-2 focus-visible:outline-white lg:w-full lg:justify-between ${active ? "border-white bg-white text-black" : "border-white/40 bg-white/10 text-white hover:bg-white/20"} ${player.puzzle ? "" : "opacity-70"}`}
            >
              <span className="min-w-0 truncate">{player.displayName}</span>
              <span className={`shrink-0 text-sm font-semibold ${staffPillStatusTone(player.status, active)}`}>{label.toLowerCase()}</span>
            </button>;
          })}
        </div>
      </section></div>
      <div className="mt-6 min-w-0 max-lg:pb-24 lg:mt-0">
        {selected
          ? selected.play
            ? <NestedFrame.Provider value><StaffPlayView player={selected} play={selected.play} /></NestedFrame.Provider>
            : <StaffPlayerStatusCard player={selected} />
          : <p className="rounded-md border border-dashed border-white/25 px-4 py-6 text-center text-white/65">No players yet.</p>}
      </div>
    </div>
  </RiddleFrame>;
}

function StaffPlayView({ player, play }: { player: StaffPlayerStatus; play: PlayerChallengeState }) {
  const label = <p className="mb-5 text-xs font-semibold uppercase tracking-[0.14em] text-white/55 sm:text-sm sm:tracking-[0.2em]">View only · what {player.displayName} sees</p>;
  if (play.status === "completed") return <>{label}<CompletedRiddle play={play} /></>;
  if (play.status === "not_started") return <>{label}<NotStartedRiddle play={play} busy={false} error={null} onStart={noop} readOnly /></>;
  const remaining = play.deadline === null
    ? Infinity
    : Math.max(0, Math.round((Date.parse(play.deadline) - Date.parse(play.serverTime)) / 1000));
  const characterConfig = play.type === "character_puzzle" ? play.config : undefined;
  return <>
    {label}
    <PlayHeader
      policy={play.scoringPolicy}
      difficulty={play.difficulty}
      time={Number.isFinite(remaining) ? formatCountdown(remaining) : formatTimeLimit(null)}
      tries={`${play.attemptsRemaining}/${play.maxAttempts}`}
    />
    {characterConfig
      ? <div className="mt-8 border-t border-white/25 pt-6">
        <p className="mb-5 text-center text-sm font-semibold uppercase tracking-wide text-white/55">Letter game</p>
        <CharacterBoard guesses={play.guessHistory} current="" length={characterConfig.target_length} rows={play.maxAttempts} />
      </div>
      : <p className="mt-8 border-y border-white/25 py-8 text-balance text-2xl font-medium leading-relaxed sm:text-3xl">{play.prompt}</p>}
    {!characterConfig && play.guessHistory.length > 0 && <div className="mt-6">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-white/55">Previous guesses</h4>
      <ul className="mt-2 divide-y divide-white/20 border-y border-white/25">
        {play.guessHistory.map((guess, index) => <li key={`${guess.response}-${index}`} className="flex items-center justify-between gap-4 py-3"><span>{guess.response}</span><span className={`text-sm font-semibold ${guess.correct ? "text-emerald-700" : "text-red-700"}`}>{guess.correct ? "Correct" : "Incorrect"}</span></li>)}
      </ul>
    </div>}
    {remaining === 0 && <p role="status" className="mt-7 text-lg font-semibold">Time’s up. Result not recorded yet.</p>}
  </>;
}

function StaffPlayerStatusCard({ player }: { player: StaffPlayerStatus }) {
  const { label, tone } = staffStatusLabels[player.status];
  const { puzzle } = player;
  const finished = player.status === "solved" || player.status === "failed" || player.status === "expired";
  const started = player.status !== "no_riddle" && player.status !== "not_started";
  return <div className="mt-4 rounded-md border border-white/25 bg-black/[0.04] p-5 sm:p-6">
    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/55 sm:text-sm">{player.displayName}{player.name && ` · ${player.name}`}</p>
    <p className={`mt-2 text-3xl font-bold sm:text-4xl ${tone}`} aria-live="polite">{label}</p>
    {puzzle && <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
      <StaffFact label="Puzzle" value={`${puzzle.type === "character_puzzle" ? "Letter game" : "Riddle"} · ${puzzle.difficulty}`} />
      <StaffFact label="Tries" value={started ? `${player.attempts}/${puzzle.maxAttempts}` : `${puzzle.maxAttempts} allowed`} />
      <StaffFact label="Time" value={player.timeTakenMs !== null ? formatCountdown(Math.round(player.timeTakenMs / 1000)) : puzzle.timeLimitSeconds === null ? formatTimeLimit(null) : `${formatCountdown(puzzle.timeLimitSeconds)} limit`} />
      {finished && <StaffFact label="Points" value={player.points === null ? "-" : `${player.points > 0 ? "+" : ""}${player.points}`} />}
    </div>}
  </div>;
}

function StaffFact({ label, value }: { label: string; value: string }) {
  return <div>
    <p className="text-xs font-semibold uppercase tracking-wide text-white/55">{label}</p>
    <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
  </div>;
}

export function StaffRiddleView({ preview }: { preview: StaffRiddlePreview }) {
  return <RiddleFrame><StaffRiddleBody preview={preview} /></RiddleFrame>;
}

// The same player screen without the page-level frame, for embedding inside another card.
export function StaffRiddleSandbox({ preview }: { preview: StaffRiddlePreview }) {
  return <StaffRiddleBody preview={preview} />;
}

function StaffRiddleBody({ preview }: { preview: StaffRiddlePreview }) {
  const { config } = preview;
  const speedTiers = preview.timeLimitSeconds === null
    ? speedTierStatusesAtElapsed(preview.speedBonuses, 0)
    : speedTierStatuses(
      preview.speedBonuses,
      preview.timeLimitSeconds,
      new Date(preview.timeLimitSeconds * 1000).toISOString(),
      0,
      0,
    );
  return <>
    <p className="mb-6 text-xs font-semibold uppercase tracking-[0.14em] text-white/55 sm:text-sm sm:tracking-[0.2em]">View only · players see this when they start</p>
    <PlayHeader
      policy={preview.scoringPolicy}
      difficulty={preview.difficulty}
      time={formatTimeLimit(preview.timeLimitSeconds)}
      tries={`${preview.maxAttempts}/${preview.maxAttempts}`}
    />

    {speedTiers.length > 0 && <SpeedTiers tiers={speedTiers} basePoints={preview.scoringPolicy.base_points} />}

    {config
      ? <div className="mt-8 border-t border-white/25 pt-6">
        <p className="mb-5 text-center text-sm font-semibold uppercase tracking-wide text-white/55">Letter game</p>
        <CharacterBoard guesses={[]} current="" length={config.target_length} rows={preview.maxAttempts} />
        <CharacterKeyboard
          characterSet={config.character_set}
          guesses={[]}
          disabled
          canSubmit={false}
          onCharacter={noop}
          onDelete={noop}
          onEnter={noop}
        />
      </div>
      : <>
        <p className="mt-8 border-y border-white/25 py-8 text-balance text-2xl font-medium leading-relaxed sm:text-3xl">{preview.prompt}</p>
        <div className="mt-7">
          <label htmlFor="riddle-response" className="text-sm font-semibold text-white/70">Your answer</label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <input id="riddle-response" disabled className="min-w-0 flex-1 rounded-md border border-white/70 bg-black/[0.06] px-4 py-3 text-lg text-white placeholder:text-white/45 disabled:opacity-50" placeholder="Enter your answer" />
            <PrimaryButton type="button" disabled className="px-6 py-3">Submit answer</PrimaryButton>
          </div>
        </div>
      </>}
  </>;
}

function noop() {}

function PlayHeader({ policy, pressure, difficulty, time, urgency = 0, tries, triesUrgency = 0 }: {
  policy: ScoringPolicy;
  pressure?: number;
  difficulty: string;
  time: string;
  urgency?: number;
  tries: string;
  triesUrgency?: number;
}) {
  return <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
    <RiddleStakes policy={policy} pressure={pressure} />
    <div className="w-full sm:ml-auto sm:w-auto">
      <p style={{ color: difficultyColor(difficulty) }} className="mb-2 text-2xl font-extrabold uppercase tracking-[0.2em] text-white/55 sm:text-center">{difficulty}</p>
      <div className="grid grid-cols-2 gap-3 sm:flex sm:text-right">
        <Stat label="Time" value={time} live urgency={urgency} />
        <Stat label="Tries left" value={tries} urgency={triesUrgency} pulse={false} />
      </div>
    </div>
  </div>;
}

function resultSummary(play: Extract<PlayerChallengeState, { status: "completed" }>) {
  const heading = play.result.correct ? "Solved" : play.attempts >= play.maxAttempts ? "Out of tries" : "Time ran out";
  return {
    heading,
    detail: `${play.attempts} of ${play.maxAttempts} ${play.maxAttempts === 1 ? "try" : "tries"} used · ${formatCountdown(Math.round(play.result.timeTakenMs / 1000))}`,
  };
}

export function CompletedRiddle({ play }: { play: Extract<PlayerChallengeState, { status: "completed" }> }) {
  const breakdown = play.result.scoringBreakdown;
  const penaltyPoints = breakdown.penalty_points ?? 0;
  const summary = resultSummary(play);
  return <RiddleFrame>
    <div className="relative">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/55">{`Results · ${play.difficulty} · ${formatTimeLimit(play.timeLimitSeconds)}`}</p>
      <h3 className="mt-3 text-3xl font-semibold">{summary.heading}</h3>
      <p className="mt-3 text-white/70">{summary.detail}</p>
      <ResultStamp success={play.result.correct} />
    </div>
    <div className="mt-8 flex flex-wrap items-end gap-x-14 gap-y-4">
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

const NestedFrame = createContext(false);

function RiddleFrame({ children }: { children: ReactNode }) {
  if (useContext(NestedFrame)) return <>{children}</>;
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
    <h4 className="text-sm font-semibold uppercase tracking-wide text-white/55">Speed bonuses</h4>
    <ul className="mt-3 flex flex-wrap gap-3">
      {tiers.map((tier) => <li
        key={tier.underMs}
        className={`min-w-28 rounded-md border px-4 py-2.5 ${
          tier.expired
            ? "border-white/15 opacity-40"
            : tier.current
              ? "border-[#00940a] bg-[#00940a]/10"
              : "border-white/30"
        }`}
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-white/55">Under {tier.underMs / 1000}s{tier.expired && " · expired"}</p>
        <p className={`mt-0.5 text-2xl font-bold tabular-nums ${tier.expired ? "line-through" : "text-[#00940a]"}`}>+{tier.points}</p>
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
    { label: "Correct answer", value: `+${policy.base_points}`, note: "Points for solving it", tone: "positive" as const, style: stakeStyle(scales.reward, 0), scale: 1, className: "origin-bottom-left" },
    ...(penalty > 0 ? [{ label: "If you fail", value: `-${penalty}`, note: "Out of tries or time", tone: "negative" as const, style: stakeStyle(scales.penalty, shake), scale: scales.penalty, className: `relative z-10 origin-top-left ${shake > 0 ? "stake-shake" : ""}` }] : []),
  ];
  return <div className="grid grid-cols-2 items-end gap-x-4 gap-y-4 sm:flex sm:flex-wrap sm:gap-x-14">
    {cells.map((cell) => <div key={cell.label} data-tone={cell.tone}>
      <p className="text-xs font-semibold uppercase tracking-wide text-white/55">{cell.label}</p>
      <p style={cell.style} className={`stake-number pointer-events-none mt-1 select-none text-3xl font-bold tabular-nums ${cell.className} ${toneClasses[cell.tone]}`}>{cell.value}</p>
      <p style={{ opacity: Math.max(0, 1 - (cell.scale - 1) / 1.5) }} className="mt-1 text-xs text-white/55">{cell.note}</p>
    </div>)}
  </div>;
}

const toneClasses = { positive: "text-[#00940a]", negative: "text-[#f00000]", zero: "text-white" } as const;

function ResultStat({ label, value }: { label: string; value: number }) {
  const tone = value > 0 ? "positive" : value < 0 ? "negative" : "zero";
  return <div data-tone={tone}><p className="text-xs font-semibold uppercase tracking-wide text-white/55">{label}</p><p className={`mt-1 text-3xl font-bold tabular-nums ${toneClasses[tone]}`}>{value}</p></div>;
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
