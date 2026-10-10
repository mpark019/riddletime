"use client";

import { useEffect, useState } from "react";
import { formatCountdown, formatTimeLimit } from "@/lib/challenge-state";
import { difficultyColor } from "@/lib/difficulty";
import { groupPlayersByPuzzle } from "@/lib/admin-riddle-groups";
import { summarizePlayers } from "@/lib/admin-riddle-stats";
import {
  MIN_VISIBLE_AWAY_MS,
  summarizeTimeline,
  type TimelineEntry,
} from "@/server/challenges/activity-timeline";
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

function toggleMember(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  return next;
}

function formatOffset(ms: number): string {
  return formatCountdown(Math.floor(ms / 1000));
}

const TIMELINE_COLUMNS = "grid-cols-[3.5rem_1fr_5.5rem] gap-x-4 md:gap-x-8";

function TimelineList({ timeline, imagePuzzle = false }: { timeline: TimelineEntry[]; imagePuzzle?: boolean }) {
  const visible = timeline.filter((entry) => entry.kind !== "away" || entry.durationMs >= MIN_VISIBLE_AWAY_MS);
  const { awayCount, awayMs } = summarizeTimeline(timeline);
  const hasGuess = visible.some((entry) => entry.kind === "guess");
  return <>
    {awayCount > 0 && <p className="mb-3 text-sm font-semibold text-white/75">
      Left tab {awayCount} {awayCount === 1 ? "time" : "times"}, {formatOffset(awayMs)} away
    </p>}
    {!hasGuess && !imagePuzzle && <p className="mb-3 text-sm text-white/55">No answers submitted.</p>}
    {visible.length > 0 && <div className="space-y-1">
      <div className={`grid ${TIMELINE_COLUMNS} px-3 pb-1 text-xs font-medium uppercase tracking-wide text-white/55`}>
        <span>Time</span>
        <span>Activity</span>
        <span className="text-center">Result</span>
      </div>
      <ol className="space-y-1">
        {visible.map((entry, index) => <li key={index} className={`grid ${TIMELINE_COLUMNS} rounded-md px-3 py-2 text-sm transition-colors hover:bg-black/5`}>
          <span className="tabular-nums text-white/55">{entry.offsetMs === null ? "--:--" : formatOffset(entry.offsetMs)}</span>
          <span className="min-w-0 break-words">
            {entry.kind === "typing" && "started typing"}
            {entry.kind === "copy" && <span className="text-[#f0a000]">{imagePuzzle ? "copied the prompt text" : "copied the riddle text"}</span>}
            {entry.kind === "paste" && <span className="text-[#f0a000]">{imagePuzzle ? "pasted into the note" : "pasted into the answer box"}</span>}
            {entry.kind === "image_added" && "added an image"}
            {entry.kind === "image_removed" && "removed an image"}
            {entry.kind === "submitted" && <span className="font-medium">submitted for review</span>}
            {entry.kind === "away" && <span className="text-[#f0a000]">
              left tab for {formatOffset(entry.durationMs)}{entry.returned ? "" : " (did not return)"}
            </span>}
            {entry.kind === "guess" && <>guessed <span className="font-medium">{entry.response}</span></>}
          </span>
          <span className={`text-center font-medium ${entry.kind === "guess" ? (entry.correct ? "text-[#00940a]" : "text-[#f00000]") : ""}`}>
            {entry.kind === "guess" ? (entry.correct ? "correct" : "wrong") : ""}
          </span>
        </li>)}
      </ol>
    </div>}
  </>;
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

const typeLabels: Record<string, string> = { riddle: "Riddle", character_puzzle: "Letter game", image_submission: "Image submission" };

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
  const personal = detail.schedule.mode === "personal";
  const groups = personal ? groupPlayersByPuzzle(detail.players) : [];
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const activeGroup = groups.find((group) => group.key === chosenKey);
  const shown = activeGroup ? activeGroup.players : detail.players;
  const played = shown.filter((player) => player.status !== "not_started" && player.status !== "not_assigned");
  const notPlayed = shown.filter((player) => player.status === "not_started");
  const notAssigned = detail.players.filter((player) => player.status === "not_assigned");
  return <>
    <RiddleHeader riddle={detail.schedule} deleting={deleting} onDelete={() => onDelete(detail.schedule)} />
    <SummaryTiles players={detail.players} />
    {!personal && <RulesBlock riddle={detail.schedule} />}
    {groups.length > 0 && <PuzzleGroupBar groups={groups} total={groups.reduce((sum, group) => sum + group.players.length, 0)} activeKey={activeGroup?.key ?? null} onSelect={setChosenKey} />}
    <h3 className={`${groups.length > 0 ? "mt-4" : "mt-8"} text-xl font-semibold`}>Played <span className="text-white/55">({played.length})</span></h3>
    {played.length === 0
      ? <p className="mt-3 rounded-md border border-dashed border-white/25 px-4 py-5 text-center text-sm text-white/55">Nobody has played this riddle yet.</p>
      : <PlayersTable players={played} maxAttempts={detail.schedule.maxAttempts} timeFormat={timeFormat} imagePuzzle={detail.schedule.type === "image_submission"} />}
    <h3 className="mt-8 text-xl font-semibold">Did not play <span className="text-white/55">({notPlayed.length})</span></h3>
    {notPlayed.length === 0
      ? <p className="mt-3 text-sm text-white/55">Every player has played.</p>
      : <ul className="mt-3 flex flex-wrap gap-2">{notPlayed.map((player) => <li key={player.userId} className="rounded-full border border-white/25 px-3 py-1 text-sm">{player.displayName}{player.puzzle && <span className="text-white/55"> · {typeLabels[player.puzzle.type] ?? "Puzzle"}</span>}</li>)}</ul>}
    {personal && !activeGroup && <>
      <h3 className="mt-8 text-xl font-semibold">No puzzle assigned <span className="text-white/55">({notAssigned.length})</span></h3>
      {notAssigned.length === 0
        ? <p className="mt-3 text-sm text-white/55">Every player has a puzzle.</p>
        : <ul className="mt-3 flex flex-wrap gap-2">{notAssigned.map((player) => <li key={player.userId} className="rounded-full border border-white/25 px-3 py-1 text-sm">{player.displayName}</li>)}</ul>}
    </>}
  </>;
}

function PuzzleGroupBar({ groups, total, activeKey, onSelect }: { groups: ReturnType<typeof groupPlayersByPuzzle>; total: number; activeKey: string | null; onSelect: (key: string | null) => void }) {
  const pill = (active: boolean) => `flex shrink-0 select-none items-center gap-2 rounded-xl border px-4 py-2 text-[15px] font-semibold transition focus-visible:outline-2 focus-visible:outline-white ${active ? "navy-surface relative isolate overflow-hidden border-transparent" : "border-white/25 bg-black/[0.04] hover:bg-white/10"}`;
  return <div role="tablist" aria-label="Puzzles" className="-mx-1 mt-8 flex gap-2 overflow-x-auto px-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
    <button type="button" role="tab" aria-selected={activeKey === null} onClick={() => onSelect(null)} className={pill(activeKey === null)}>All <span className="text-xs font-normal">{total} {total === 1 ? "player" : "players"}</span></button>
    {groups.map((group) => <button key={group.key} type="button" role="tab" aria-selected={group.key === activeKey} onClick={() => onSelect(group.key)} className={pill(group.key === activeKey)}>
      {group.name ?? `${typeLabels[group.type] ?? "Puzzle"} · ${group.answers.join(", ")}`}
      <span className="text-xs font-normal">{group.players.length} {group.players.length === 1 ? "player" : "players"}</span>
    </button>)}
  </div>;
}

function RiddleHeader({ riddle, deleting, onDelete }: { riddle: ScheduledRiddle; deleting: boolean; onDelete: () => void }) {
  return <div className="mt-4 rounded-md border border-white/25 bg-black/[0.04] p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {riddle.mode !== "personal" && <>
        <span className="rounded-full border border-white/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide">{typeLabels[riddle.type ?? ""] ?? "Puzzle"}</span>
        <span style={difficultyColor(riddle.difficulty) ? { borderColor: difficultyColor(riddle.difficulty), color: difficultyColor(riddle.difficulty) } : undefined} className="rounded-full border border-white/25 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white/70">{riddle.difficulty ?? "?"}</span>
        </>}
        <p className="ml-1 font-semibold tabular-nums">{riddle.activeDate} <span className="ml-1 text-sm font-normal uppercase tracking-wide text-white/55">{riddle.timing}</span></p>
      </div>
      <button type="button" disabled={deleting} onClick={onDelete} className="rounded-md border border-[#f00000] px-3 py-1.5 text-xs font-semibold text-[#f00000] transition hover:bg-[#f00000] hover:text-white disabled:opacity-50">Delete</button>
    </div>
    <p className="mt-3 whitespace-pre-wrap break-words text-lg">{riddle.mode === "personal" ? `${riddle.assignedCount} ${riddle.assignedCount === 1 ? "player has" : "players have"} an assigned puzzle.` : riddle.prompt ?? "No puzzle saved for this date."}</p>
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
      <span className="text-white/55">Time limit</span> {riddle.type === null ? "?" : formatTimeLimit(riddle.timeLimitSeconds)}
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
  pending_review: "Awaiting review",
  expired: "Expired",
  not_started: "",
  not_assigned: "",
};

function outcomeOf(player: ScheduledRiddlePlayer) {
  if (player.status !== "completed") return { label: outcomeLabels[player.status], tone: "zero" as const };
  if (player.outcome === "partial") return { label: "Partial", tone: "zero" as const };
  if (player.correct) return { label: "Solved", tone: "positive" as const };
  return { label: player.missed ? "DNF" : "Failed", tone: "negative" as const };
}

function Chevron({ open }: { open: boolean }) {
  return <svg
    aria-hidden
    viewBox="0 0 16 16"
    className={`h-4 w-4 shrink-0 text-white/55 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m6 3 5 5-5 5" />
  </svg>;
}

function PlayersTable({ players, maxAttempts, timeFormat, imagePuzzle = false }: { players: ScheduledRiddlePlayer[]; maxAttempts: number | null; timeFormat: Intl.DateTimeFormat; imagePuzzle?: boolean }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const th = "px-3 py-2.5 text-left";
  const optional = "hidden sm:table-cell";
  return <div className="mt-3 overflow-x-auto rounded-xl border border-white/25">
    <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
      <caption className="sr-only">Players who played this riddle. Select a row to show their answers and activity.</caption>
      <thead>
        <tr className="select-none border-b border-white/25 text-xs font-medium uppercase tracking-wide text-white/55">
          <th scope="col" className="w-10 px-4 py-2.5"><span className="sr-only">Details</span></th>
          <th scope="col" className={th}>Player</th>
          <th scope="col" className={th}>Result</th>
          <th scope="col" className={th}>Tries</th>
          <th scope="col" className={th}>Time</th>
          <th scope="col" className={`${th} ${optional}`}>Base</th>
          <th scope="col" className={`${th} ${optional}`}>Speed</th>
          <th scope="col" className={`${th} ${optional}`}>Penalty</th>
          <th scope="col" className={th}>Total</th>
        </tr>
      </thead>
      {players.map((player) => <PlayerRow
        key={player.userId}
        player={player}
        maxAttempts={maxAttempts}
        optional={optional}
        timeFormat={timeFormat}
        imagePuzzle={imagePuzzle}
        open={expanded.has(player.userId)}
        onToggle={() => setExpanded((current) => toggleMember(current, player.userId))}
      />)}
    </table>
  </div>;
}

function PlayerRow({ player, maxAttempts, optional, timeFormat, imagePuzzle, open, onToggle }: {
  player: ScheduledRiddlePlayer;
  imagePuzzle: boolean;
  maxAttempts: number | null;
  optional: string;
  timeFormat: Intl.DateTimeFormat;
  open: boolean;
  onToggle: () => void;
}) {
  const outcome = outcomeOf(player);
  const breakdown = player.breakdown;
  const total = player.points;
  const cell = "px-3 py-3 align-middle tabular-nums";
  const detailId = `player-detail-${player.userId}`;
  return <tbody className={`border-b border-white/15 last:border-b-0 transition-colors ${open ? "bg-black/[0.06]" : "hover:bg-black/[0.03]"}`}>
    <tr onClick={onToggle} className="cursor-pointer select-none">
      <td className="w-10 px-4 py-3 align-middle">
        <button
          type="button"
          aria-label={`Show details for ${player.displayName}`}
          aria-expanded={open}
          aria-controls={detailId}
          onClick={(event) => { event.stopPropagation(); onToggle(); }}
          className="flex items-center focus-visible:outline-2 focus-visible:outline-white"
        >
          <Chevron open={open} />
        </button>
      </td>
      <td className={`${cell} font-medium`}>{player.displayName}</td>
      <td className={`${cell} font-semibold ${toneClasses[outcome.tone]}`}>{outcome.label}</td>
      <td className={`${cell} text-white/65`}>{player.attempts}/{player.puzzle?.maxAttempts ?? maxAttempts ?? "?"}</td>
      <td className={`${cell} text-white/65`}>{player.timeTakenMs === null ? "-" : formatCountdown(Math.round(player.timeTakenMs / 1000))}</td>
      <td className={`${cell} text-white/65 ${optional}`}>{breakdown ? breakdown.basePoints : "-"}</td>
      <td className={`${cell} text-white/65 ${optional}`}>{breakdown ? formatPoints(breakdown.speedBonusPoints) : "-"}</td>
      <td className={`${cell} text-white/65 ${optional}`}>{breakdown ? formatPoints(-breakdown.penaltyPoints) : "-"}</td>
      <td className={`${cell} font-semibold ${total === null ? "" : toneClasses[toneOf(total)]}`}>{total === null ? "-" : formatPoints(total)}</td>
    </tr>
    <tr id={detailId} hidden={!open}>
      <td colSpan={9} className="px-4 pb-4 pt-1 md:px-12">
        {player.puzzle && <p className="mb-2 break-words text-sm text-white/75">
          <span className="font-semibold">{typeLabels[player.puzzle.type] ?? "Puzzle"} · {player.puzzle.difficulty}:</span> {player.puzzle.prompt}
          {player.puzzle.acceptedAnswers.length > 0 && <> (answers: {player.puzzle.acceptedAnswers.join(", ")})</>}
        </p>}
        {player.reviewComment && <p className="mb-2 break-words text-sm text-white/75">
          <span className="font-semibold">Reviewer comment:</span> {player.reviewComment}
        </p>}
        <p className="mb-3 text-xs text-white/55">
          {player.startedAt && `Started ${timeFormat.format(new Date(player.startedAt))}`}
          {player.submittedAt && ` · Finished ${timeFormat.format(new Date(player.submittedAt))}`}
        </p>
        <TimelineList timeline={player.timeline} imagePuzzle={imagePuzzle || player.puzzle?.type === "image_submission"} />
      </td>
    </tr>
  </tbody>;
}
