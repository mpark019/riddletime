"use client";

import { useEffect, useState } from "react";
import type { ScheduledRiddle, ScheduledRiddlePlayer } from "@/server/schedules/schedules";

interface Detail {
  schedule: ScheduledRiddle;
  players: ScheduledRiddlePlayer[];
}

interface ScoringSummary {
  base_points?: number;
  failure_penalty_points?: number;
  speed_bonuses?: unknown[];
}

const statusLabels: Record<ScheduledRiddlePlayer["status"], string> = {
  completed: "Finished",
  in_progress: "In progress",
  expired: "Expired, not finalized",
  not_started: "Did not play",
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return minutes > 0 ? `${minutes}m ${totalSeconds % 60}s` : `${totalSeconds}s`;
}

function formatPoints(points: number): string {
  return points > 0 ? `+${points}` : String(points);
}

export function AdminRiddleDetail({
  scheduleId,
  appTimezone,
  deleting,
  onBack,
  onDelete,
}: {
  scheduleId: string;
  appTimezone: string;
  deleting: boolean;
  onBack: () => void;
  onDelete: (riddle: ScheduledRiddle) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/admin/challenges/${scheduleId}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as Partial<Detail> & { error?: string };
        if (!response.ok || !body.schedule || !body.players) throw new Error(body.error ?? "Could not load this riddle.");
        if (active) setDetail({ schedule: body.schedule, players: body.players });
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Could not load this riddle.");
      });
    return () => {
      active = false;
    };
  }, [scheduleId]);

  const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: appTimezone });
  const played = detail?.players.filter((player) => player.status !== "not_started") ?? [];
  const notPlayed = detail?.players.filter((player) => player.status === "not_started") ?? [];

  return <section aria-label="Riddle details">
    <button type="button" onClick={onBack} className="rounded-md border border-white/25 px-3 py-1.5 text-sm font-semibold hover:bg-white/10">← All riddles</button>
    {error && <p role="alert" className="mt-4 rounded-md border border-red-300/60 bg-red-950/45 px-4 py-3 text-sm text-red-100">{error}</p>}
    {!detail ? !error && <p className="mt-4 text-white/60">Loading riddle…</p> : <>
      <RiddleSummary riddle={detail.schedule} deleting={deleting} onDelete={() => onDelete(detail.schedule)} />
      <h3 className="mt-8 text-xl font-semibold">Played <span className="text-white/55">({played.length})</span></h3>
      {played.length === 0
        ? <p className="mt-3 rounded-md border border-dashed border-white/25 px-4 py-5 text-center text-sm text-white/55">Nobody has played this riddle yet.</p>
        : <ul className="mt-3 space-y-3">{played.map((player) => <PlayedRow key={player.userId} player={player} timeFormat={timeFormat} />)}</ul>}
      <h3 className="mt-8 text-xl font-semibold">Did not play <span className="text-white/55">({notPlayed.length})</span></h3>
      {notPlayed.length === 0
        ? <p className="mt-3 text-sm text-white/55">Every player has played.</p>
        : <ul className="mt-3 flex flex-wrap gap-2">{notPlayed.map((player) => <li key={player.userId} className="rounded-full border border-white/25 px-3 py-1 text-sm">{player.displayName}</li>)}</ul>}
    </>}
  </section>;
}

function RiddleSummary({ riddle, deleting, onDelete }: { riddle: ScheduledRiddle; deleting: boolean; onDelete: () => void }) {
  const scoring = (riddle.scoringPolicy ?? {}) as ScoringSummary;
  const speedTiers = scoring.speed_bonuses?.length ?? 0;
  return <div className="mt-4 rounded-md border border-white/25 bg-black/[0.04] p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="font-semibold tabular-nums">{riddle.activeDate} <span className="ml-2 text-sm font-normal uppercase tracking-wide text-white/55">{riddle.timing}</span></p>
      <button type="button" disabled={deleting} onClick={onDelete} className="rounded-md border border-white/25 px-3 py-1.5 text-xs font-semibold text-red-200 transition hover:bg-white/10 disabled:opacity-50">Delete</button>
    </div>
    <p className="mt-3 whitespace-pre-wrap break-words">{riddle.prompt ?? "No puzzle saved for this date."}</p>
    {riddle.acceptedAnswers.length > 0 && <p className="mt-2 break-words text-sm text-white/70"><span className="font-semibold text-white/85">Answers:</span> {riddle.acceptedAnswers.join(", ")}</p>}
    <p className="mt-2 text-sm text-white/55">
      {riddle.difficulty ?? "?"} · {riddle.timeLimitSeconds ?? "?"}s · {riddle.maxAttempts ?? "?"} {riddle.maxAttempts === 1 ? "attempt" : "attempts"} · {scoring.base_points ?? 0} points
      {speedTiers > 0 && ` · ${speedTiers} speed ${speedTiers === 1 ? "tier" : "tiers"}`}
      {(scoring.failure_penalty_points ?? 0) > 0 && ` · -${scoring.failure_penalty_points} on fail`}
    </p>
  </div>;
}

function PlayedRow({ player, timeFormat }: { player: ScheduledRiddlePlayer; timeFormat: Intl.DateTimeFormat }) {
  const pointsColor = (player.points ?? 0) < 0 ? "text-red-300" : "text-emerald-300";
  return <li className="rounded-md border border-white/25 bg-black/[0.04] p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-semibold">{player.displayName}</p>
      <p className="text-sm text-white/65">
        {statusLabels[player.status]}
        {player.points !== null && <span className={`ml-3 text-base font-bold tabular-nums ${pointsColor}`}>{formatPoints(player.points)} pts</span>}
      </p>
    </div>
    <p className="mt-1 text-sm text-white/55">
      {player.startedAt && `Started ${timeFormat.format(new Date(player.startedAt))}`}
      {player.submittedAt && ` · Finished ${timeFormat.format(new Date(player.submittedAt))}`}
      {player.timeTakenMs !== null && ` · ${formatDuration(player.timeTakenMs)}`}
    </p>
    {player.guesses.length === 0
      ? <p className="mt-2 text-sm text-white/50">No answers submitted.</p>
      : <ol className="mt-2 space-y-1 text-sm">{player.guesses.map((guess, index) => <li key={index} className="flex gap-2">
        <span className="text-white/45">{index + 1}.</span>
        <span className="break-words">{guess.response}</span>
        <span className={guess.correct ? "text-emerald-300" : "text-red-300"}>{guess.correct ? "correct" : "wrong"}</span>
      </li>)}</ol>}
  </li>;
}
