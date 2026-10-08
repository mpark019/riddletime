"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildCharacterScheduleRequest, buildManualRiddleScheduleRequest } from "@/lib/admin-riddle-schedule";
import { DIFFICULTIES, difficultyColor, type Difficulty } from "@/lib/difficulty";
import { AdminRiddleList } from "./admin-riddle-list";
import { pruneSelection } from "@/lib/point-selection";
import { formatUsDate } from "@/lib/calendar";
import type { DateRoster } from "@/server/schedules/schedules";
import type { ScheduledRiddle } from "@/server/schedules/schedules";
import { AdminDayRoster, DayStats } from "./admin-day-roster";
import { ScheduleCalendar } from "./schedule-calendar";
import type { LeaderboardEntry } from "@/server/points/points";
import { FloatingQuestionMarks } from "./floating-question-marks";
import { PlayerPicker } from "./player-picker";
import { PrimaryButton } from "./primary-button";

interface SpeedBonusRow {
  id: number;
  underSeconds: string;
  points: string;
}

type PuzzleKind = "riddle" | "character_puzzle";

const MAX_SPEED_BONUSES = 20;
const card = "rounded-xl border border-white/25 bg-black/[0.04] p-4";
const cardTitle = "text-base font-semibold";
const inputClass = "mt-1 w-full rounded-md border border-white/40 bg-black/[0.04] px-3 py-2.5 text-white placeholder:text-white/45 focus:outline-2 focus:outline-white";

export function AdminRiddleScheduler({ appTimezone, today, players, onChanged }: { appTimezone: string; today: string; players: LeaderboardEntry[]; onChanged?: () => void }) {
  const [activeDate, setActiveDate] = useState(today);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [prompt, setPrompt] = useState("");
  const [acceptedAnswers, setAcceptedAnswers] = useState("");
  const [timeLimitSeconds, setTimeLimitSeconds] = useState("120");
  const [noTimeLimit, setNoTimeLimit] = useState(false);
  const [maxAttempts, setMaxAttempts] = useState("1");
  const [puzzleKind, setPuzzleKind] = useState<PuzzleKind>("riddle");
  const [selection, setSelection] = useState<string[]>([]);
  const [roster, setRoster] = useState<DateRoster | null>(null);
  const [rosterError, setRosterError] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [dayMessage, setDayMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [days, setDays] = useState<ScheduledRiddle[]>([]);
  const takenCount = roster?.mode === "shared" ? players.length : roster?.assignments.length ?? 0;
  const selectedPlayerIds = pruneSelection(selection, players);
  const isPastDate = activeDate < today;
  const [targetWord, setTargetWord] = useState("");
  const [basePoints, setBasePoints] = useState("100");
  const [failurePenaltyPoints, setFailurePenaltyPoints] = useState("20");
  const [speedBonuses, setSpeedBonuses] = useState<SpeedBonusRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [tab, setTab] = useState<"day" | "all">("day");
  const nextSpeedBonusId = useRef(1);

  const loadRoster = useCallback(async (date: string) => {
    const [rosterResponse, daysResponse] = await Promise.all([
      fetch(`/api/admin/assignments?date=${encodeURIComponent(date)}`, { cache: "no-store" }),
      fetch("/api/admin/challenges", { cache: "no-store" }),
    ]);
    const rosterBody = await rosterResponse.json().catch(() => null) as DateRoster | null;
    if (!rosterResponse.ok || !rosterBody?.assignments) throw new Error("Could not load this day");
    setRoster(rosterBody);
    setRosterError(false);
    const daysBody = await daysResponse.json().catch(() => null) as { schedules?: ScheduledRiddle[] } | null;
    if (daysResponse.ok && daysBody?.schedules) setDays(daysBody.schedules);
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setRoster(null);
      void loadRoster(activeDate).catch(() => {
        if (active) setRosterError(true);
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [activeDate, loadRoster]);

  async function removeAssignment(challengeId: string) {
    setRemovingId(challengeId);
    setDayMessage(null);
    try {
      const response = await fetch(`/api/admin/assignments/${challengeId}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({})) as { error?: string; removedResults?: number };
      if (!response.ok) {
        setDayMessage({ ok: false, text: result.error ?? "Could not delete this puzzle." });
        return;
      }
      setDayMessage({ ok: true, text: (result.removedResults ?? 0) > 0 ? "Puzzle and game deleted; points removed." : "Puzzle deleted." });
      await loadRoster(activeDate);
      if ((result.removedResults ?? 0) > 0) onChanged?.();
    } catch {
      setDayMessage({ ok: false, text: "Could not confirm the deletion. Reload the day to check." });
    } finally {
      setRemovingId(null);
    }
  }

  function selectPuzzleKind(kind: PuzzleKind) {
    if (kind === puzzleKind) return;
    setPuzzleKind(kind);
    setMaxAttempts(kind === "character_puzzle" ? "6" : "1");
    setTargetWord("");
    setError(null);
    setNotice(null);
  }

  function addSpeedBonus() {
    if (speedBonuses.length >= MAX_SPEED_BONUSES) return;
    const id = nextSpeedBonusId.current++;
    setSpeedBonuses((rows) => [...rows, { id, underSeconds: "30", points: "20" }]);
  }

  function updateSpeedBonus(id: number, field: "underSeconds" | "points", value: string) {
    setSpeedBonuses((rows) => rows.map((row) => row.id === id ? { ...row, [field]: value } : row));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    let body: ReturnType<typeof buildManualRiddleScheduleRequest | typeof buildCharacterScheduleRequest>;
    try {
      const rules = {
        activeDate,
        playerIds: selectedPlayerIds,
        difficulty,
        timeLimitSeconds: noTimeLimit ? null : timeLimitSeconds,
        maxAttempts,
        basePoints,
        failurePenaltyPoints,
        speedBonuses,
      };
      body = puzzleKind === "character_puzzle"
        ? buildCharacterScheduleRequest({ ...rules, targetWord })
        : buildManualRiddleScheduleRequest({ ...rules, prompt, acceptedAnswers });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Check the schedule values.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/admin/generate-challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; active_date?: string; assigned_count?: number; skipped_count?: number };
      if (!response.ok) {
        setError(result.error ?? `Could not schedule this ${puzzleLabel}.`);
        return;
      }
      setPrompt("");
      setAcceptedAnswers("");
      setTargetWord("");
      const skipped = result.skipped_count ?? 0;
      setNotice(`${puzzleLabel[0].toUpperCase()}${puzzleLabel.slice(1)} assigned to ${result.assigned_count ?? selectedPlayerIds.length} for ${result.active_date ?? activeDate}${skipped > 0 ? `; skipped ${skipped} who already had one` : ""}.`);
      setSelection([]);
      void loadRoster(activeDate).catch(() => setRosterError(true));
    } catch {
      setError(`Could not confirm whether the ${puzzleLabel} was scheduled. Retry may report that the date is already in use.`);
    } finally {
      setBusy(false);
    }
  }

  const puzzleLabel = puzzleKind === "character_puzzle" ? "letter game" : "riddle";

  function openAllDays() {
    setTab("all");
    setListVersion((version) => version + 1);
  }


  return <section className="mx-auto w-[calc(100%-2rem)] max-w-[1280px] py-5 lg:py-8" aria-labelledby="schedule-riddle-title">
    <header className="flex flex-col gap-2 pb-6 lg:pb-8">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/55">Admin</p>
      <div className="flex items-center justify-between gap-3">
        <h2 id="schedule-riddle-title" className="text-2xl font-semibold tracking-tight lg:text-[28px]">{tab === "day" ? "Schedule a riddle" : "All scheduled days"}</h2>
        <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-white/80" role="tablist" aria-label="Riddle schedule sections">
          <TabButton active={tab === "day"} onClick={() => setTab("day")}>Day</TabButton>
          <TabButton active={tab === "all"} onClick={openAllDays}>All days</TabButton>
        </div>
      </div>
    </header>

    <div hidden={tab !== "day"}>
    <div className="mb-4 grid gap-4 lg:grid-cols-3">
      <section className={card} aria-labelledby="schedule-day-title">
        <h3 id="schedule-day-title" className={`${cardTitle} mb-3`}>Calendar</h3>
        <ScheduleCalendar value={activeDate} today={today} days={days} playerCount={players.length} onSelect={setActiveDate} />
      </section>

      <section className={`${card} relative lg:col-span-2 lg:p-0`} aria-labelledby="schedule-progress-title">
        <div className="flex flex-col lg:absolute lg:inset-0 lg:p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="schedule-progress-title" className={cardTitle}>{formatUsDate(activeDate)}{activeDate === today && <span className="ml-2 text-xs font-bold uppercase text-blue-900">today</span>}</h3>
            <p className="text-xs text-white/55">{appTimezone}{isPastDate && " · past day, no new assignments"}{activeDate !== today && <> · <button type="button" onClick={() => setActiveDate(today)} className="font-semibold text-white underline">Back to today</button></>}</p>
          </div>
          <DayStats players={players} roster={roster} />
          <h4 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-white/55">Roster</h4>
          <AdminDayRoster players={players} roster={roster} loadError={rosterError} removingId={removingId} onRemove={(id) => void removeAssignment(id)} />
          {dayMessage && <p role={dayMessage.ok ? undefined : "alert"} className={`mt-2 rounded-lg border px-3 py-1.5 text-sm ${dayMessage.ok ? "border-emerald-300/60 bg-emerald-950/45 text-emerald-100" : "border-red-300/60 bg-red-950/45 text-red-100"}`}>{dayMessage.text}</p>}
        </div>
      </section>
    </div>

    <h3 className="mb-3 mt-8 text-lg font-semibold">Assign a puzzle</h3>
    <form onSubmit={(event) => void submit(event)} className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)] lg:items-start">
      <div className="space-y-4">
        <section className="rounded-xl border border-white/25 bg-black/[0.04] p-4">
          <h3 className={cardTitle}>Puzzle</h3>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <div className="text-sm font-semibold sm:col-span-2">
              <span id="schedule-difficulty-label">Difficulty</span>
              <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-labelledby="schedule-difficulty-label">
                {DIFFICULTIES.map((option) => <DifficultyButton key={option} option={option} active={difficulty === option} onClick={() => setDifficulty(option)} />)}
              </div>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2" aria-label="Schedule type">
            <div className="inline-flex overflow-hidden rounded-full border border-white/30" role="radiogroup" aria-label="Puzzle type">
              <PuzzleKindButton active={puzzleKind === "riddle"} onClick={() => selectPuzzleKind("riddle")}>Riddle</PuzzleKindButton>
              <PuzzleKindButton active={puzzleKind === "character_puzzle"} onClick={() => selectPuzzleKind("character_puzzle")}>Letter game</PuzzleKindButton>
            </div>
          </div>
          {puzzleKind === "riddle" ? <>
          <label className="mt-5 block text-sm font-semibold">Riddle prompt
              <textarea required maxLength={10_000} rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What has keys but no locks?" className={`${inputClass} resize-y`} />
            </label>
            <label className="mt-5 block text-sm font-semibold">Accepted answers
              <textarea required maxLength={25_050} rows={4} value={acceptedAnswers} onChange={(event) => setAcceptedAnswers(event.target.value)} placeholder={"piano\na piano"} className={`${inputClass} resize-y`} />
              <span className="mt-1 block text-xs font-normal text-white/55">One answer per line, up to 50. Capitalization and punctuation are ignored during grading.</span>
            </label>
          </> : <>
            <label className="mt-5 block text-sm font-semibold">Answer
              <input type="text" required maxLength={50} autoComplete="off" spellCheck={false} value={targetWord} onChange={(event) => setTargetWord(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="CRANE" className={`${inputClass} font-mono uppercase tracking-widest`} />
              <span className="mt-1 block text-xs font-normal text-white/55">Up to 50 letters and digits, no spaces. Players see only the length and are never shown the answer, even after they fail.</span>
            </label>
          </>}
        </section>

        <section className="rounded-xl border border-white/25 bg-black/[0.04] p-4">
          <h3 className={cardTitle}>Players</h3>
          <p className="mb-4 mt-1 text-sm text-white/55">Pick who gets this puzzle. Players who already have one on this date are skipped.</p>
          <PlayerPicker players={players} selected={selectedPlayerIds} summary={takenCount > 0 ? `${takenCount} already ${takenCount === 1 ? "has" : "have"} a puzzle on this date.` : undefined} onChange={setSelection} />
        </section>

        <section className="rounded-xl border border-white/25 bg-black/[0.04] p-4">
          <div className="flex items-center justify-between gap-4">
            <div><h3 className={cardTitle}>Speed bonuses</h3><p className="mt-1 text-sm text-white/55">Optional tiers do not stack; the highest qualifying bonus wins.</p></div>
            <button type="button" disabled={speedBonuses.length >= MAX_SPEED_BONUSES} onClick={addSpeedBonus} className="shrink-0 rounded-md border border-white/60 px-3 py-2 text-sm font-semibold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-45">Add tier</button>
          </div>
          {speedBonuses.length === 0
            ? <p className="mt-5 rounded-md border border-dashed border-white/25 px-4 py-6 text-center text-sm text-white/55">No speed bonus configured.</p>
            : <div className="mt-5 space-y-3">{speedBonuses.map((bonus, index) => <div key={bonus.id} className="grid grid-cols-[1fr_1fr_auto] items-end gap-3 rounded-md border border-white/20 p-3">
              <label className="text-sm font-semibold">Under seconds
                <input type="number" min="1" step="1" required value={bonus.underSeconds} onChange={(event) => updateSpeedBonus(bonus.id, "underSeconds", event.target.value)} className={inputClass} />
              </label>
              <label className="text-sm font-semibold">Bonus points
                <input type="number" min="0" step="1" required value={bonus.points} onChange={(event) => updateSpeedBonus(bonus.id, "points", event.target.value)} className={inputClass} />
              </label>
              <button type="button" aria-label={`Remove speed tier ${index + 1}`} onClick={() => setSpeedBonuses((rows) => rows.filter((row) => row.id !== bonus.id))} className="mb-1 flex h-10 w-10 items-center justify-center rounded-md border border-white/30 text-xl hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white">×</button>
            </div>)}</div>}
        </section>
      </div>

      <section className="app-header relative isolate overflow-hidden rounded-xl p-4 lg:sticky lg:top-28">
        <FloatingQuestionMarks contained compact start={12} />
        <h3 className={cardTitle}>Rules and scoring</h3>
        <div className="mt-5 grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-semibold">Time limit
              <span className="sr-only"> in seconds</span>
              <input type="number" min="1" step="1" required={!noTimeLimit} disabled={noTimeLimit} value={noTimeLimit ? "" : timeLimitSeconds} onChange={(event) => setTimeLimitSeconds(event.target.value)} className={`${inputClass} disabled:opacity-40`} />
            </label>
            <label className="mt-2 flex items-center gap-2 text-sm font-normal">
              <input type="checkbox" checked={noTimeLimit} onChange={(event) => setNoTimeLimit(event.target.checked)} className="h-4 w-4" />
              No time limit
            </label>
          </div>
          <label className="text-sm font-semibold">Maximum attempts
            <input type="number" min="1" step="1" required value={maxAttempts} onChange={(event) => setMaxAttempts(event.target.value)} className={inputClass} />
          </label>
          <label className="text-sm font-semibold">Base points
            <input type="number" min="0" step="1" required value={basePoints} onChange={(event) => setBasePoints(event.target.value)} className={inputClass} />
          </label>
          <label className="text-sm font-semibold">Failure penalty
            <input type="number" min="0" step="1" required value={failurePenaltyPoints} onChange={(event) => setFailurePenaltyPoints(event.target.value)} className={inputClass} />
          </label>
        </div>
        <p className="mt-5 text-sm leading-relaxed text-white/65">The failure penalty is deducted once only if the player runs out of attempts or time. Recoverable wrong guesses do not deduct points.</p>
        <div className="mt-5 min-h-12" aria-live="polite">
          {error && <p role="alert" className="rounded-md border border-red-300/60 bg-red-950/45 px-4 py-3 text-sm text-red-100">{error}</p>}
          {notice && <p className="rounded-md border border-emerald-300/60 bg-emerald-950/45 px-4 py-3 text-sm text-emerald-100">{notice}</p>}
        </div>
        <PrimaryButton type="submit" disabled={busy || isPastDate} className="mt-4 w-full px-5 py-3">{busy ? "Scheduling…" : isPastDate ? "Past days are view-only" : `Schedule ${puzzleLabel}${selectedPlayerIds.length > 0 ? ` for ${selectedPlayerIds.length}` : ""}`}</PrimaryButton>
      </section>
    </form>
    </div>

    <div hidden={tab !== "all"}><AdminRiddleList refreshVersion={listVersion} appTimezone={appTimezone} /></div>
  </section>;
}

function TabButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`h-9 px-3 text-sm font-semibold transition lg:h-11 lg:px-5 lg:text-base ${active ? "navy-surface flat-on-mobile relative isolate" : "text-white hover:bg-white/15"}`}>{active && <FloatingQuestionMarks contained compact start={4} />}{children}</button>;
}

function PuzzleKindButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return <button type="button" role="radio" aria-checked={active} onClick={onClick} className={`px-3 py-1 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-white ${active ? "bg-white/20" : "hover:bg-white/10"}`}>{children}</button>;
}

function DifficultyButton({ option, active, onClick }: { option: Difficulty; active: boolean; onClick: () => void }) {
  const color = difficultyColor(option);
  return <button
    type="button"
    role="radio"
    aria-checked={active}
    onClick={onClick}
    style={{ borderColor: color, color: active ? "#fff" : color, backgroundColor: active ? color : undefined }}
    className="flex min-w-0 items-center justify-center whitespace-nowrap rounded-md border-2 px-2 py-2.5 text-sm font-bold uppercase tracking-wide transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
  >{option}</button>;
}
