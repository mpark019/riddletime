"use client";

import { useMemo, useState } from "react";
import { compareByName } from "@/lib/account-order";
import type { LeaderboardEntry } from "@/server/points/points";
import type { DateAssignment, DateRoster } from "@/server/schedules/schedules";

const typeLabels: Record<string, string> = { riddle: "Riddle", character_puzzle: "Letter game", image_submission: "Image submission" };
const statusLabels: Record<DateAssignment["status"], string> = {
  not_started: "Not started",
  in_progress: "In progress",
  pending_review: "Awaiting review",
  expired: "Expired",
  completed: "",
};
const number = new Intl.NumberFormat();

const puzzleLabel = (assignment: DateAssignment) => assignment.name
  ?? (assignment.type === "riddle" ? assignment.prompt : assignment.type === "image_submission" ? (assignment.prompt || "Image submission") : "Letter game");

function outcome(assignment: DateAssignment) {
  if (assignment.status !== "completed") return { label: statusLabels[assignment.status], tone: "" };
  if (assignment.partial) return { label: "Partial", tone: "text-[#b45f00]" };
  if (assignment.correct) return { label: "Solved", tone: "text-[#00940a]" };
  return { label: assignment.missed ? "DNF" : "Failed", tone: "text-[#f00000]" };
}

function Tile({ label, value }: { label: string; value: number }) {
  return <div>
    <p className="text-[11px] font-semibold uppercase tracking-wide text-white/55">{label}</p>
    <p className="mt-0.5 text-2xl font-bold tabular-nums">{value}</p>
  </div>;
}

export function summarizeRoster(players: LeaderboardEntry[], roster: DateRoster | null) {
  const assignments = roster?.mode === "personal" ? roster.assignments : [];
  const known = new Set(players.map((player) => player.userId));
  const mine = assignments.filter((entry) => entry.playerId && known.has(entry.playerId));
  const count = (status: DateAssignment["status"]) => mine.filter((entry) => entry.status === status).length;
  return {
    assigned: mine.length,
    notStarted: count("not_started"),
    inProgress: count("in_progress") + count("pending_review") + count("expired"),
    solved: mine.filter((entry) => entry.correct === true && !entry.partial).length,
    failed: mine.filter((entry) => entry.correct === false).length,
    noPuzzle: players.length - mine.length,
  };
}

export function DayStats({ players, roster }: { players: LeaderboardEntry[]; roster: DateRoster | null }) {
  const stats = summarizeRoster(players, roster);
  if (!roster || roster.mode === "shared") return <p className="text-sm text-white/60">{roster ? "One shared puzzle for everyone." : "Loading…"}</p>;
  return <div className="grid grid-cols-3 gap-x-6 gap-y-3 sm:grid-cols-6">
    <Tile label="Assigned" value={stats.assigned} />
    <Tile label="Not started" value={stats.notStarted} />
    <Tile label="In progress" value={stats.inProgress} />
    <Tile label="Solved" value={stats.solved} />
    <Tile label="Failed" value={stats.failed} />
    <Tile label="No puzzle" value={stats.noPuzzle} />
  </div>;
}

export function AdminDayRoster({
  players,
  roster,
  loadError,
  removingId,
  onRemove,
}: {
  players: LeaderboardEntry[];
  roster: DateRoster | null;
  loadError: boolean;
  removingId: string | null;
  onRemove: (challengeId: string) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [pendingPlayed, setPendingPlayed] = useState<{ assignment: DateAssignment; name: string } | null>(null);
  const sorted = useMemo(() => [...players].sort(compareByName), [players]);
  const byPlayer = useMemo(
    () => new Map((roster?.assignments ?? []).flatMap((entry) => entry.playerId ? [[entry.playerId, entry] as const] : [])),
    [roster],
  );
  const sharedPuzzle = roster?.mode === "shared" ? roster.assignments[0] : undefined;

  if (loadError) return <p role="alert" className="rounded-md border border-red-300/60 bg-red-950/45 px-4 py-3 text-sm text-red-100">Could not load this day. Anyone who already has a puzzle will be skipped when you schedule.</p>;
  if (!roster) return <p className="text-sm text-white/60">Loading this day…</p>;
  if (sharedPuzzle) return <div className="rounded-md border border-white/25 px-4 py-4 text-sm">
    <p className="font-semibold">Everyone has the shared puzzle for this day.</p>
    <p className="mt-1 break-words text-white/70">{typeLabels[sharedPuzzle.type] ?? "Puzzle"} · {sharedPuzzle.difficulty}: {sharedPuzzle.prompt}</p>
    <p className="mt-1 text-white/55">Manage it from the All days tab. Personal puzzles cannot be added to this day.</p>
  </div>;

  const th = "sticky top-0 z-10 bg-surface-solid px-3 py-2.5 text-left text-sm font-semibold shadow-[inset_0_0_0_999px_rgba(0,0,0,0.06)]";
  const cell = "border-b border-white/15 group-last:border-0 group-hover:bg-white/[0.08] first:rounded-l-lg last:rounded-r-lg px-3 py-3 align-middle";

  function removeControl(assignment: DateAssignment, name: string) {
    if (assignment.status !== "not_started") {
      return <button type="button" aria-label={`Delete puzzle for ${name}`} disabled={removingId === assignment.challengeId} onClick={() => setPendingPlayed({ assignment, name })} className="rounded-md border border-[#f00000] px-2.5 py-1 text-xs font-semibold text-[#f00000] hover:bg-[#f00000] hover:text-white disabled:opacity-50">Delete</button>;
    }
    return confirmId === assignment.challengeId
      ? <span className="inline-flex gap-2">
        <button type="button" disabled={removingId === assignment.challengeId} onClick={() => { setConfirmId(null); onRemove(assignment.challengeId); }} className="rounded-md border border-[#c00000] bg-[#f00000] px-2.5 py-1 text-xs font-semibold text-on-fill disabled:opacity-50">Confirm</button>
        <button type="button" onClick={() => setConfirmId(null)} className="rounded-md border border-white/40 px-2.5 py-1 text-xs font-semibold hover:bg-white/10">Cancel</button>
      </span>
      : <button type="button" aria-label={`Delete puzzle for ${name}`} onClick={() => setConfirmId(assignment.challengeId)} className="rounded-md border border-[#f00000] px-2.5 py-1 text-xs font-semibold text-[#f00000] hover:bg-[#f00000] hover:text-white">Delete</button>;
  }

  function resultText(assignment: DateAssignment) {
    if (assignment.status !== "completed") return statusLabels[assignment.status];
    const points = assignment.points === null ? "" : ` (${assignment.points > 0 ? "+" : ""}${assignment.points})`;
    return `${outcome(assignment).label}${points}`;
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-white/25 p-2">
    <div className="max-h-96 min-h-0 flex-1 overflow-auto lg:max-h-none">
        <ul className="divide-y divide-white/25 sm:hidden">{sorted.map((player) => {
          const assignment = byPlayer.get(player.userId);
          return <li key={player.userId} className={`px-3 py-2 text-sm ${assignment ? "" : "text-white/55"}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-semibold">{player.displayName}{player.name && <span className="ml-2 text-xs font-normal text-white/60">{player.name}</span>}</span>
              <span className="shrink-0 tabular-nums">{number.format(player.totalPoints)}</span>
            </div>
            {assignment
              ? <div className="mt-1 flex items-center justify-between gap-3">
                <span className="min-w-0 text-[13px]">
                  <span className="block truncate font-semibold">{puzzleLabel(assignment)}</span>
                  <span className="block text-xs text-white/60">{typeLabels[assignment.type] ?? "Puzzle"} · {assignment.difficulty}</span>
                  <span className={`block ${outcome(assignment).tone}`}>{resultText(assignment)}</span>
                </span>
                {removeControl(assignment, player.displayName)}
              </div>
              : <p className="mt-1 text-[13px]">No riddle</p>}
          </li>;
        })}</ul>
        <table className="hidden w-full border-separate border-spacing-0 text-sm sm:table">
          <caption className="sr-only">Players and their puzzle for this day.</caption>
          <thead>
            <tr>
              <th scope="col" className={`${th} rounded-l-lg`}>Player</th>
              <th scope="col" className={th}>Puzzle</th>
              <th scope="col" className={th}>Status</th>
              <th scope="col" className={th}>Result</th>
              <th scope="col" className={`${th} text-right`}>Total</th>
              <th scope="col" className={`${th} rounded-r-lg`}><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>{sorted.map((player) => {
            const assignment = byPlayer.get(player.userId);
            if (!assignment) return <tr key={player.userId} className="group text-white/55">
              <td className={`${cell} font-semibold text-inherit`}>{player.displayName}{player.name && <span className="block text-xs font-normal">{player.name}</span>}</td>
              <td className={cell}>No riddle</td>
              <td className={cell}>-</td>
              <td className={cell} />
              <td className={`${cell} text-right tabular-nums`}>{number.format(player.totalPoints)}</td>
              <td className={cell} />
            </tr>;
            const result = outcome(assignment);
            return <tr key={player.userId} className="group">
              <td className={`${cell} font-semibold`}>{player.displayName}{player.name && <span className="block text-xs font-normal text-white/60">{player.name}</span>}</td>
              <td className={`${cell} max-w-xs`}>
                <span className="block truncate font-semibold" title={puzzleLabel(assignment)}>{puzzleLabel(assignment)}</span>
                <span className="block text-xs text-white/60">{typeLabels[assignment.type] ?? "Puzzle"} · {assignment.difficulty}</span>
              </td>
              <td className={`${cell} ${assignment.status === "completed" ? "text-white/55" : ""}`}>{assignment.status === "completed" ? "Finished" : statusLabels[assignment.status]}</td>
              <td className={`${cell} font-semibold ${result.tone}`}>{assignment.status === "completed" ? `${result.label}${assignment.points === null ? "" : ` (${assignment.points > 0 ? "+" : ""}${assignment.points})`}` : ""}</td>
              <td className={`${cell} text-right tabular-nums`}>{number.format(player.totalPoints)}</td>
              <td className={`${cell} text-right`}>{removeControl(assignment, player.displayName)}</td>
            </tr>;
          })}</tbody>
        </table>
    </div>
    </div>
    {pendingPlayed && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="delete-assignment-title" aria-describedby="delete-assignment-description" className="w-full max-w-md rounded-md border border-red-200/80 bg-surface-solid p-6 shadow-2xl">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-red-800">Permanent action</p>
        <h4 id="delete-assignment-title" className="mt-2 text-2xl font-semibold">Delete {pendingPlayed.name}&rsquo;s puzzle?</h4>
        <p id="delete-assignment-description" className="mt-3 text-white">
          This removes the puzzle and {pendingPlayed.name}&rsquo;s game{pendingPlayed.assignment.points === null ? "" : `, including the ${pendingPlayed.assignment.points > 0 ? "+" : ""}${pendingPlayed.assignment.points} points it earned or deducted`}. Their score changes as if it never existed. It cannot be undone.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={() => setPendingPlayed(null)} className="rounded-md border border-white/80 px-4 py-2 font-semibold hover:bg-white/10">Cancel</button>
          <button type="button" onClick={() => { const target = pendingPlayed.assignment.challengeId; setPendingPlayed(null); onRemove(target); }} className="rounded-md border border-[#c00000] bg-[#f00000] px-4 py-2 font-semibold text-on-fill transition hover:bg-[#d60000]">Delete permanently</button>
        </div>
      </section>
    </div>}
  </div>;
}
