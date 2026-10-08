"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "@/lib/challenge-state";
import { difficultyColor } from "@/lib/difficulty";
import { summarizePlayers } from "@/lib/admin-riddle-stats";
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

  if (error) return <section aria-label="Riddle details"><BackButton onBack={onBack} /><p role="alert" className="mt-4 rounded-md border border-red-300/60 bg-red-950/45 px-4 py-3 text-sm text-red-100">{error}</p></section>;
  if (!detail) return <section aria-label="Riddle details"><BackButton onBack={onBack} /><p className="mt-4 text-white/60">Loading riddle…</p></section>;
  return <section aria-label="Riddle details">
    <BackButton onBack={onBack} />
    <RiddleDashboard detail={detail} appTimezone={appTimezone} deleting={deleting} onDelete={onDelete} />
  </section>;
}

function BackButton({ onBack }: { onBack: () => void }) {
  return <button type="button" onClick={onBack} className="rounded-md border border-white/25 px-3 py-1.5 text-sm font-semibold hover:bg-white/10">← All riddles</button>;
}

const typeLabels: Record<string, string> = { riddle: "Riddle", character_puzzle: "Letter game" };

const toneClasses = { positive: "text-[#00940a]", negative: "text-[#f00000]", zero: "text-white" } as const;

function toneOf(value: number) {
  return value > 0 ? "positive" : value < 0 ? "negative" : "zero";
}

export function RiddleDashboard({
  detail,
  appTimezone,
  deleting,
  onDelete,
}: {
  detail: Detail;
  appTimezone: string;
  deleting: boolean;
  onDelete: (riddle: ScheduledRiddle) => void;
}) {
  const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: appTimezone });
  const played = detail.players.filter((player) => player.status !== "not_started");
  const notPlayed = detail.players.filter((player) => player.status === "not_started");
  return <>
    <RiddleHeader riddle={detail.schedule} deleting={deleting} onDelete={() => onDelete(detail.schedule)} />
    <SummaryTiles players={detail.players} />
    <RulesBlock riddle={detail.schedule} />
    <h3 className="mt-8 text-xl font-semibold">Played <span className="text-white/55">({played.length})</span></h3>
    {played.length === 0
      ? <p className="mt-3 rounded-md border border-dashed border-white/25 px-4 py-5 text-center text-sm text-white/55">Nobody has played this riddle yet.</p>
      : <PlayersTable players={played} maxAttempts={detail.schedule.maxAttempts} timeFormat={timeFormat} />}
    <h3 className="mt-8 text-xl font-semibold">Did not play <span className="text-white/55">({notPlayed.length})</span></h3>
    {notPlayed.length === 0
      ? <p className="mt-3 text-sm text-white/55">Every player has played.</p>
      : <ul className="mt-3 flex flex-wrap gap-2">{notPlayed.map((player) => <li key={player.userId} className="rounded-full border border-white/25 px-3 py-1 text-sm">{player.displayName}</li>)}</ul>}
  </>;
}

function RiddleHeader({ riddle, deleting, onDelete }: { riddle: ScheduledRiddle; deleting: boolean; onDelete: () => void }) {
  return <div className="mt-4 rounded-md border border-white/25 bg-black/[0.04] p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-white/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide">{typeLabels[riddle.type ?? ""] ?? "Puzzle"}</span>
        <span style={difficultyColor(riddle.difficulty) ? { borderColor: difficultyColor(riddle.difficulty), color: difficultyColor(riddle.difficulty) } : undefined} className="rounded-full border border-white/25 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white/70">{riddle.difficulty ?? "?"}</span>
        <p className="ml-1 font-semibold tabular-nums">{riddle.activeDate} <span className="ml-1 text-sm font-normal uppercase tracking-wide text-white/55">{riddle.timing}</span></p>
      </div>
      <button type="button" disabled={deleting} onClick={onDelete} className="rounded-md border border-[#f00000] px-3 py-1.5 text-xs font-semibold text-[#f00000] transition hover:bg-[#f00000] hover:text-white disabled:opacity-50">Delete</button>
    </div>
    <p className="mt-3 whitespace-pre-wrap break-words text-lg">{riddle.prompt ?? "No puzzle saved for this date."}</p>
    {riddle.acceptedAnswers.length > 0 && <p className="mt-2 break-words text-sm text-white/70"><span className="font-semibold text-white/85">Answers:</span> {riddle.acceptedAnswers.join(", ")}</p>}
  </div>;
}

function Tile({ label, value, note, tone = "zero" }: { label: string; value: string; note?: string; tone?: keyof typeof toneClasses }) {
  return <div>
    <p className="text-xs font-semibold uppercase tracking-wide text-white/55">{label}</p>
    <p className={`mt-1 text-3xl font-bold tabular-nums ${toneClasses[tone]}`}>{value}</p>
    {note && <p className="mt-1 text-xs text-white/55">{note}</p>}
  </div>;
}

function SummaryTiles({ players }: { players: ScheduledRiddlePlayer[] }) {
  const stats = summarizePlayers(players);
  const percent = (count: number) => (stats.total > 0 ? `${Math.round((count / stats.total) * 100)}%` : "0%");
  return <div className="mt-6 flex flex-wrap gap-x-14 gap-y-5">
    <Tile label="Played" value={String(stats.played)} note={`of ${stats.total} ${stats.total === 1 ? "player" : "players"} (${percent(stats.played)})`} />
    <Tile label="Solved" value={String(stats.solved)} tone={stats.solved > 0 ? "positive" : "zero"} note={percent(stats.solved)} />
    <Tile label="Failed" value={String(stats.failed)} tone={stats.failed > 0 ? "negative" : "zero"} note={percent(stats.failed)} />
    <Tile label="Avg time" value={stats.averageTimeMs === null ? "-" : formatCountdown(Math.round(stats.averageTimeMs / 1000))} />
    <Tile label="Points given" value={formatPoints(stats.pointsGiven)} tone={toneOf(stats.pointsGiven)} />
  </div>;
}

function RulesBlock({ riddle }: { riddle: ScheduledRiddle }) {
  const scoring = (riddle.scoringPolicy ?? {}) as ScoringSummary;
  const tiers = (scoring.speed_bonuses ?? []) as Array<{ under_ms: number; points: number }>;
  const penalty = scoring.failure_penalty_points ?? 0;
  return <div className="mt-6 border-t border-white/25 pt-4">
    <p className="text-xs font-semibold uppercase tracking-wide text-white/55">Rules</p>
    <p className="mt-2 text-sm">
      <span className="text-white/55">Time limit</span> {riddle.timeLimitSeconds === null ? "?" : formatCountdown(riddle.timeLimitSeconds)}
      <span className="mx-3 text-white/30">·</span>
      <span className="text-white/55">Tries</span> {riddle.maxAttempts ?? "?"}
      <span className="mx-3 text-white/30">·</span>
      <span className="text-white/55">Correct</span> <span className="font-semibold text-[#00940a]">+{scoring.base_points ?? 0}</span>
      {penalty > 0 && <><span className="mx-3 text-white/30">·</span><span className="text-white/55">Fail</span> <span className="font-semibold text-[#f00000]">-{penalty}</span></>}
    </p>
    {tiers.length > 0 && <p className="mt-2 text-sm">
      <span className="text-white/55">Speed bonuses</span>{" "}
      {tiers.map((tier) => `Under ${tier.under_ms / 1000}s +${tier.points}`).join("  ·  ")}
    </p>}
  </div>;
}

const outcomeLabels: Record<ScheduledRiddlePlayer["status"], string> = {
  completed: "",
  in_progress: "In progress",
  expired: "Expired",
  not_started: "",
};

function outcomeOf(player: ScheduledRiddlePlayer) {
  if (player.status !== "completed") return { label: outcomeLabels[player.status], tone: "zero" as const };
  return player.correct ? { label: "Solved", tone: "positive" as const } : { label: "Failed", tone: "negative" as const };
}

function PlayersTable({ players, maxAttempts, timeFormat }: { players: ScheduledRiddlePlayer[]; maxAttempts: number | null; timeFormat: Intl.DateTimeFormat }) {
  const cell = "px-3 py-2 align-top tabular-nums";
  const optional = "hidden sm:table-cell";
  return <div className="mt-3 overflow-x-auto rounded-md border border-white/25">
    <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
      <thead className="bg-black/[0.04] text-xs uppercase tracking-wide text-white/55">
        <tr>
          <th scope="col" className="px-3 py-2 font-semibold">Player</th>
          <th scope="col" className="px-3 py-2 font-semibold">Result</th>
          <th scope="col" className="px-3 py-2 font-semibold">Tries</th>
          <th scope="col" className="px-3 py-2 font-semibold">Time</th>
          <th scope="col" className={`px-3 py-2 font-semibold ${optional}`}>Base</th>
          <th scope="col" className={`px-3 py-2 font-semibold ${optional}`}>Speed</th>
          <th scope="col" className={`px-3 py-2 font-semibold ${optional}`}>Penalty</th>
          <th scope="col" className="px-3 py-2 font-semibold">Total</th>
        </tr>
      </thead>
      <tbody>{players.map((player) => <PlayerRow key={player.userId} player={player} maxAttempts={maxAttempts} cell={cell} optional={optional} timeFormat={timeFormat} />)}</tbody>
    </table>
  </div>;
}

function PlayerRow({ player, maxAttempts, cell, optional, timeFormat }: { player: ScheduledRiddlePlayer; maxAttempts: number | null; cell: string; optional: string; timeFormat: Intl.DateTimeFormat }) {
  const outcome = outcomeOf(player);
  const breakdown = player.breakdown;
  const total = player.points;
  return <>
    <tr className="border-t border-white/25">
      <td className={`${cell} font-semibold`}>{player.displayName}</td>
      <td className={`${cell} font-semibold ${toneClasses[outcome.tone]}`}>{outcome.label}</td>
      <td className={cell}>{player.attempts}/{maxAttempts ?? "?"}</td>
      <td className={cell}>{player.timeTakenMs === null ? "-" : formatCountdown(Math.round(player.timeTakenMs / 1000))}</td>
      <td className={`${cell} ${optional}`}>{breakdown ? breakdown.basePoints : "-"}</td>
      <td className={`${cell} ${optional}`}>{breakdown ? formatPoints(breakdown.speedBonusPoints) : "-"}</td>
      <td className={`${cell} ${optional}`}>{breakdown ? formatPoints(-breakdown.penaltyPoints) : "-"}</td>
      <td className={`${cell} font-bold ${total === null ? "" : toneClasses[toneOf(total)]}`}>{total === null ? "-" : formatPoints(total)}</td>
    </tr>
    <tr>
      <td colSpan={8} className="px-3 pb-3 pt-0 text-xs text-white/55">
        {player.startedAt && `Started ${timeFormat.format(new Date(player.startedAt))}`}
        {player.submittedAt && ` · Finished ${timeFormat.format(new Date(player.submittedAt))}`}
        {player.guesses.length === 0
          ? <span className="block">No answers submitted.</span>
          : <ol className="mt-1 flex flex-wrap gap-x-4 gap-y-1">{player.guesses.map((guess, index) => <li key={index} className="break-words">
            <span className="text-white/45">{index + 1}.</span> <span className="text-white">{guess.response}</span>{" "}
            <span className={guess.correct ? "text-[#00940a]" : "text-[#f00000]"}>{guess.correct ? "correct" : "wrong"}</span>
          </li>)}</ol>}
      </td>
    </tr>
  </>;
}
