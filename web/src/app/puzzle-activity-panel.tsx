"use client";

import { useEffect, useState } from "react";
import { Dropdown } from "./puzzle-dropdown";
import { formatMedianSeconds, formatSolveRate } from "@/lib/puzzle-bank";
import { rulesKey, type PlayOutcome, type PuzzleActivity, type PuzzleRules } from "@/server/puzzles/puzzle-activity";

const outcomeLabels: Record<PlayOutcome, { label: string; tone: string }> = {
  solved: { label: "Solved", tone: "text-[#00940a]" },
  failed: { label: "Failed", tone: "text-[#f00000]" },
  missed: { label: "Missed", tone: "text-[#f00000]" },
  in_progress: { label: "In progress", tone: "" },
  expired: { label: "Expired", tone: "text-white/60" },
  not_started: { label: "Not started", tone: "text-white/60" },
  did_not_play: { label: "Did not play", tone: "text-white/60" },
};

export function rulesLabel(rules: PuzzleRules): string {
  const tries = `${rules.maxAttempts} ${rules.maxAttempts === 1 ? "try" : "tries"}`;
  const time = rules.timeLimitSeconds === null ? "no time limit" : `${rules.timeLimitSeconds}s`;
  const penalty = rules.failurePenaltyPoints ? ` / -${rules.failurePenaltyPoints}` : "";
  const points = rules.basePoints === null ? "" : `, ${rules.basePoints} pts${penalty}`;
  const bonuses = rules.speedBonuses.map((tier) => `+${tier.points} under ${tier.underMs / 1000}s`).join(", ");
  return `${tries}, ${time}${points}${bonuses ? `, ${bonuses}` : ""}`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div><dt className="text-xs uppercase tracking-wide text-white/55">{label}</dt><dd className="text-lg font-semibold tabular-nums">{value}</dd></div>;
}

const th = "bg-black/[0.06] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide";
const td = "border-b border-white/15 px-3 py-2.5 align-middle";

interface StatValues {
  daysUsed: number;
  assigned: number;
  started: number;
  solved: number;
  solveRate: number | null;
  medianSolveSeconds: number | null;
  averageAttempts: number | null;
  missed: number;
}

export function PuzzleActivityPanel({ puzzleId, stats, used }: { puzzleId: string; stats: StatValues; used: boolean }) {
  const [activity, setActivity] = useState<PuzzleActivity | null>(null);
  const [failed, setFailed] = useState(false);
  const [ruleKey, setRuleKey] = useState("");

  useEffect(() => {
    if (!used) return;
    let active = true;
    void fetch(`/api/admin/puzzles/${puzzleId}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ puzzle: { activity?: PuzzleActivity } }> : Promise.reject(new Error("activity")))
      .then((body) => { if (active) setActivity(body.puzzle.activity ?? { ruleSets: [], plays: [] }); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [puzzleId, used]);

  const chosen = activity?.ruleSets.find((set) => rulesKey(set) === ruleKey) ?? null;
  const shown: StatValues = chosen ?? stats;
  const plays = activity ? (chosen ? activity.plays.filter((play) => rulesKey(play.rules) === ruleKey) : activity.plays) : [];

  return <>
    {activity && activity.ruleSets.length > 0 && <Dropdown className="mt-7 max-w-md" label="Rule set" value={ruleKey} onChange={setRuleKey}
      options={[
        ["", `All rule sets (${activity.plays.length} ${activity.plays.length === 1 ? "game" : "games"})`],
        ...activity.ruleSets.map((set): [string, string] => [rulesKey(set), `${rulesLabel(set)} (${set.assigned} ${set.assigned === 1 ? "game" : "games"})`]),
      ]} />}

    <h4 className="mt-7 text-base font-semibold">Statistics</h4>
    <dl className="mt-3 grid grid-cols-2 gap-4 rounded-xl border border-white/20 bg-black/[0.04] p-4 sm:grid-cols-4" aria-label="Puzzle statistics">
      <Stat label="Days used" value={shown.daysUsed} />
      <Stat label="Assigned" value={shown.assigned} />
      <Stat label="Started" value={shown.started} />
      <Stat label="Solved" value={shown.solved} />
      <Stat label="Solve rate" value={formatSolveRate(shown.solveRate)} />
      <Stat label="Median time" value={formatMedianSeconds(shown.medianSolveSeconds)} />
      <Stat label="Avg attempts" value={shown.averageAttempts === null ? "-" : shown.averageAttempts.toFixed(1)} />
      <Stat label="Missed games" value={shown.missed} />
    </dl>

    {used && failed && <p role="alert" className="mt-4 text-sm text-red-100">Could not load player history.</p>}
    {used && !failed && !activity && <p className="mt-4 text-sm text-white/60">Loading player history…</p>}
    {activity && <>
      <h4 className="mt-7 text-base font-semibold">Players</h4>
      <div className="mt-3 max-h-80 overflow-auto rounded-xl border border-white/20">
        <table className="w-full sm:min-w-[32rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Every player who was given this puzzle and how it went.</caption>
          <thead><tr>
            <th scope="col" className={`${th} sticky top-0 z-10`}>Player</th>
            <th scope="col" className={`${th} sticky top-0 z-10 hidden sm:table-cell`}>Date</th>
            <th scope="col" className={`${th} sticky top-0 z-10 text-right sm:text-left`}>Result</th>
            <th scope="col" className={`${th} sticky top-0 z-10 hidden text-right sm:table-cell`}>Tries</th>
            <th scope="col" className={`${th} sticky top-0 z-10 hidden text-right sm:table-cell`}>Time</th>
            <th scope="col" className={`${th} sticky top-0 z-10 hidden text-right sm:table-cell`}>Points</th>
          </tr></thead>
          <tbody>{plays.map((play) => {
            const outcome = outcomeLabels[play.outcome];
            return <tr key={`${play.date}-${play.playerId}`}>
              <td className={`${td} font-semibold`}>{play.playerName}</td>
              <td className={`${td} hidden tabular-nums sm:table-cell`}>{play.date}</td>
              <td className={`${td} text-right font-semibold sm:text-left ${outcome.tone}`} title={rulesLabel(play.rules)}>{outcome.label}</td>
              <td className={`${td} hidden text-right tabular-nums sm:table-cell`}>{play.attempts === null ? "-" : `${play.attempts}/${play.rules.maxAttempts}`}</td>
              <td className={`${td} hidden text-right tabular-nums sm:table-cell`}>{play.timeTakenMs === null ? "-" : formatMedianSeconds(play.timeTakenMs / 1000)}</td>
              <td className={`${td} hidden text-right tabular-nums sm:table-cell`}>{play.points === null ? "-" : `${play.points > 0 ? "+" : ""}${play.points}`}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </>}
  </>;
}
