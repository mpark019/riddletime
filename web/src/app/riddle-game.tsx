"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { Role } from "@/server/identity/identity";
import {
  estimateServerClockOffset,
  formatCountdown,
  isSubmissionConfirmed,
  persistPendingSubmission,
  remainingSeconds,
  removePendingSubmission,
  restorePendingSubmission,
  withAuthoritativePlay,
  type ActiveRiddle,
  type ChallengeMutationResponse,
  type PendingRiddleSubmission,
  type PlayerChallengeState,
  type TodayChallengeResponse,
} from "@/lib/challenge-state";

interface LoadedChallenge {
  data: TodayChallengeResponse;
  serverClockOffsetMs: number;
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

  async function submitPayload(
    body: PendingRiddleSubmission | { finalizeExpired: true },
  ) {
    if (!loaded?.data.schedule) return;
    setBusy(true);
    setError(null);
    const requestStartedAt = Date.now();
    try {
      const result = await fetch(`/api/challenge/${loaded.data.schedule.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify("response" in body
          ? { response: body.response, operationKey: body.operationKey }
          : body),
      });
      if (!result.ok) {
        const message = await responseError(result, "Could not submit that answer.");
        if (result.status >= 500) {
          setRefreshRequired(true);
          setError(`The submission may have been saved. ${message}`);
        } else {
          if ("response" in body) setRefreshRequired(true);
          setError(message);
        }
        return;
      }
      const responseReceivedAt = Date.now();
      const outcome = await result.json() as ChallengeMutationResponse;
      applyAuthoritativePlay(outcome.play, requestStartedAt, responseReceivedAt);
      if ("response" in body) clearConfirmedPending(body);
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!response.trim() || !loaded?.data.schedule || play?.status !== "in_progress") return;
    const pending = {
      dailyChallengeId: loaded.data.schedule.id,
      submissionId: play.submissionId,
      response,
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
    return <RiddleFrame><ErrorMessage message={error ?? "Could not load today's riddle."} /><button type="button" onClick={() => { setError(null); setLoading(true); void loadToday().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load today's riddle.")).finally(() => setLoading(false)); }} className="mt-5 border border-white px-5 py-2.5 font-semibold hover:bg-white hover:text-[#102a43]">Try again</button></RiddleFrame>;
  }

  if (!loaded.data.schedule) {
    return <RiddleFrame><p className="text-lg font-semibold">No riddle is scheduled for today.</p><p className="mt-2 text-white/65">Check back tomorrow for a new challenge.</p></RiddleFrame>;
  }

  if (role !== "player") {
    return <RiddleFrame><p className="text-lg font-semibold">Today’s challenge is ready.</p><p className="mt-2 text-white/65">Only player accounts can start and submit scored riddles.</p></RiddleFrame>;
  }

  if (!play) {
    return <RiddleFrame><ErrorMessage message="Player challenge state was not returned." /></RiddleFrame>;
  }

  if (play.status === "not_started") {
    return <RiddleFrame>
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/55">Daily challenge</p>
      <h3 className="mt-3 text-2xl font-semibold">Ready when you are?</h3>
      <p className="mt-3 max-w-xl text-white/70">Your timer starts only after the server confirms the game has begun. Refreshing will not reset it.</p>
      {error && <div className="mt-5"><ErrorMessage message={error} /></div>}
      {play.available
        ? <button type="button" disabled={busy} onClick={() => void start()} className="mt-7 border border-white bg-white px-6 py-3 font-bold text-[#102a43] transition hover:bg-transparent hover:text-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Starting…" : "Start riddle"}</button>
        : <p className="mt-6 border border-white/40 bg-black/10 px-4 py-3 text-white/70">Today’s puzzle has not been published yet.</p>}
    </RiddleFrame>;
  }

  if (play.status === "completed") {
    return <CompletedRiddle play={play} />;
  }

  const secondsRemaining = remainingSeconds(
    play.deadline,
    loaded.serverClockOffsetMs,
    clientNow,
  );

  return <RiddleFrame>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/55">{play.difficulty}</p>
        <h3 className="mt-2 text-2xl font-semibold">Today’s riddle</h3>
      </div>
      <div className="flex gap-3 text-right">
        <Stat label="Time" value={formatCountdown(secondsRemaining)} live />
        <Stat label="Tries left" value={`${play.attemptsRemaining}/${play.maxAttempts}`} />
      </div>
    </div>

    <p className="mt-8 border-y border-white/35 py-8 text-balance text-2xl font-medium leading-relaxed sm:text-3xl">{play.prompt}</p>

    {play.guessHistory.length > 0 && <div className="mt-6">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-white/55">Previous guesses</h4>
      <ul className="mt-2 divide-y divide-white/20 border-y border-white/30">
        {play.guessHistory.map((guess, index) => <li key={`${guess.response}-${index}`} className="flex items-center justify-between gap-4 py-3"><span>{guess.response}</span><span className={`text-sm font-semibold ${guess.correct ? "text-emerald-300" : "text-red-300"}`}>{guess.correct ? "Correct" : "Incorrect"}</span></li>)}
      </ul>
    </div>}

    {refreshRequired
      ? <div className="mt-7 border border-amber-200/60 bg-amber-950/20 p-4"><p className="text-amber-100">Do not submit again until the saved result has been checked.</p><button type="button" disabled={busy} onClick={() => void refreshSavedGame()} className="mt-4 border border-white bg-white px-5 py-2.5 font-bold text-[#102a43] hover:bg-transparent hover:text-white disabled:opacity-50">{busy ? "Refreshing…" : "Refresh saved game"}</button></div>
      : pendingSubmission
        ? <div className="mt-7 border border-amber-200/60 bg-amber-950/20 p-4"><p className="text-amber-100">The saved game still does not show the previous submission. Retry that same submission safely before entering another answer.</p><button type="button" disabled={busy} onClick={() => void submitPayload(pendingSubmission)} className="mt-4 border border-white bg-white px-5 py-2.5 font-bold text-[#102a43] hover:bg-transparent hover:text-white disabled:opacity-50">{busy ? "Retrying…" : "Retry submission"}</button></div>
      : secondsRemaining === 0
        ? <div className="mt-7 border border-white/40 bg-black/10 p-5"><p className="font-semibold">Time has expired.</p><p className="mt-1 text-sm text-white/65">Finish the game to save the expired result. No answer is required.</p><button type="button" disabled={busy} onClick={() => void submitPayload({ finalizeExpired: true })} className="mt-4 border border-white bg-white px-5 py-2.5 font-bold text-[#102a43] hover:bg-transparent hover:text-white disabled:opacity-50">{busy ? "Finishing…" : "Finish game"}</button></div>
        : <form onSubmit={submit} className="mt-7">
          <label htmlFor="riddle-response" className="text-sm font-semibold text-white/70">Your answer</label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <input id="riddle-response" value={response} onChange={(event) => setResponse(event.target.value)} autoComplete="off" disabled={busy} className="min-w-0 flex-1 border border-white/70 bg-black/15 px-4 py-3 text-lg text-white placeholder:text-white/35 focus:outline-2 focus:outline-white disabled:opacity-50" placeholder="Enter your answer" />
            <button type="submit" disabled={busy || !response.trim()} className="border border-white bg-white px-6 py-3 font-bold text-[#102a43] transition hover:bg-transparent hover:text-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Checking…" : "Submit answer"}</button>
          </div>
          <p className="mt-2 text-sm text-white/55">Worth up to {maximumPoints(play)} points. Answers are checked without regard to capitalization or punctuation.</p>
        </form>}
    {error && <div className="mt-5"><ErrorMessage message={error} /></div>}
  </RiddleFrame>;
}

function maximumPoints(play: ActiveRiddle): number {
  return play.scoringPolicy.base_points + Math.max(
    0,
    ...(play.scoringPolicy.speed_bonuses ?? []).map((bonus) => bonus.points),
  );
}

function CompletedRiddle({ play }: { play: Extract<PlayerChallengeState, { status: "completed" }> }) {
  const breakdown = play.result.scoringBreakdown;
  return <RiddleFrame>
    <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/55">Completed</p>
    <h3 className="mt-3 text-3xl font-semibold">{play.result.correct ? "You solved it!" : "Riddle complete"}</h3>
    <p className="mt-3 text-white/70">{play.result.correct ? "Nice work. Your result and points are saved." : "Not this time. Your result is saved and tomorrow brings another puzzle."}</p>
    <div className="mt-8 grid gap-px border border-white/50 bg-white/30 sm:grid-cols-3">
      <ResultStat label="Base points" value={breakdown.base_points} />
      <ResultStat label="Speed bonus" value={breakdown.speed_bonus_points ?? 0} />
      <ResultStat label="Total points" value={breakdown.total_points} prominent />
    </div>
    <div className="mt-7">
      <p className="text-sm font-semibold uppercase tracking-wide text-white/55">Riddle</p>
      <p className="mt-2 text-xl font-medium">{play.prompt}</p>
    </div>
    {play.guessHistory.length > 0 && <div className="mt-6">
      <p className="text-sm font-semibold uppercase tracking-wide text-white/55">Your answers</p>
      <ul className="mt-2 space-y-2">{play.guessHistory.map((guess, index) => <li key={`${guess.response}-${index}`} className="flex justify-between border border-white/30 bg-black/10 px-4 py-3"><span>{guess.response}</span><span className={guess.correct ? "text-emerald-300" : "text-red-300"}>{guess.correct ? "Correct" : "Incorrect"}</span></li>)}</ul>
    </div>}
  </RiddleFrame>;
}

function RiddleFrame({ children }: { children: ReactNode }) {
  return <section className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8 sm:py-12"><h2 className="text-3xl font-semibold tracking-tight">Riddle</h2><div className="mt-8 border border-white/80 bg-black/10 p-6 sm:p-8">{children}</div></section>;
}

function Stat({ label, value, live = false }: { label: string; value: string; live?: boolean }) {
  return <div className="min-w-24 border border-white/40 bg-black/10 px-3 py-2"><p className="text-xs font-semibold uppercase tracking-wide text-white/50">{label}</p><p className="mt-1 text-xl font-bold tabular-nums" aria-live={live ? "polite" : undefined}>{value}</p></div>;
}

function ResultStat({ label, value, prominent = false }: { label: string; value: number; prominent?: boolean }) {
  return <div className={`bg-[#00022e] px-5 py-5 ${prominent ? "text-emerald-300" : "text-white"}`}><p className="text-xs font-semibold uppercase tracking-wide opacity-60">{label}</p><p className="mt-1 text-3xl font-bold tabular-nums">{value}</p></div>;
}

function ErrorMessage({ message }: { message: string }) {
  return <p role="alert" className="border border-red-300/70 bg-red-950/30 px-4 py-3 text-red-100">{message}</p>;
}
