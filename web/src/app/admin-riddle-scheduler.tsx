"use client";

import { useRef, useState } from "react";
import { buildCharacterScheduleRequest, buildManualRiddleScheduleRequest } from "@/lib/admin-riddle-schedule";
import { AdminRiddleList } from "./admin-riddle-list";
import { DatePicker } from "./date-picker";
import { FloatingQuestionMarks } from "./floating-question-marks";
import { PrimaryButton } from "./primary-button";

interface SpeedBonusRow {
  id: number;
  underSeconds: string;
  points: string;
}

type PuzzleKind = "riddle" | "character_puzzle";

const MAX_SPEED_BONUSES = 20;
const inputClass = "mt-1 w-full rounded-md border border-white/40 bg-black/[0.04] px-3 py-2.5 text-white placeholder:text-white/45 focus:outline-2 focus:outline-white";

export function AdminRiddleScheduler({ appTimezone, today }: { appTimezone: string; today: string }) {
  const [activeDate, setActiveDate] = useState(today);
  const [difficulty, setDifficulty] = useState("standard");
  const [prompt, setPrompt] = useState("");
  const [acceptedAnswers, setAcceptedAnswers] = useState("");
  const [timeLimitSeconds, setTimeLimitSeconds] = useState("120");
  const [maxAttempts, setMaxAttempts] = useState("1");
  const [puzzleKind, setPuzzleKind] = useState<PuzzleKind>("riddle");
  const [targetWord, setTargetWord] = useState("");
  const [basePoints, setBasePoints] = useState("100");
  const [failurePenaltyPoints, setFailurePenaltyPoints] = useState("20");
  const [speedBonuses, setSpeedBonuses] = useState<SpeedBonusRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [tab, setTab] = useState<"schedule" | "scheduled">("schedule");
  const nextSpeedBonusId = useRef(1);

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
        difficulty,
        timeLimitSeconds,
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
      const result = await response.json().catch(() => ({})) as { error?: string; active_date?: string };
      if (!response.ok) {
        setError(result.error ?? `Could not schedule this ${puzzleLabel}.`);
        return;
      }
      setPrompt("");
      setAcceptedAnswers("");
      setTargetWord("");
      setNotice(`${puzzleLabel[0].toUpperCase()}${puzzleLabel.slice(1)} scheduled for ${result.active_date ?? activeDate}.`);
    } catch {
      setError(`Could not confirm whether the ${puzzleLabel} was scheduled. Retry may report that the date is already in use.`);
    } finally {
      setBusy(false);
    }
  }

  const puzzleLabel = puzzleKind === "character_puzzle" ? "character puzzle" : "riddle";

  function openScheduled() {
    setTab("scheduled");
    setListVersion((version) => version + 1);
  }

  return <section className="mx-auto w-[calc(100%-2rem)] max-w-[1280px] py-6 lg:py-10" aria-labelledby="schedule-riddle-title">
    <header className="flex flex-col gap-2 pb-6 lg:pb-8">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/55">Admin</p>
      <div className="flex items-center justify-between gap-3">
        <h2 id="schedule-riddle-title" className="text-[26px] font-semibold tracking-tight lg:text-[34px]">{tab === "schedule" ? "Schedule a riddle" : "Scheduled riddles"}</h2>
        <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-white/80" role="tablist" aria-label="Riddle schedule sections">
          <TabButton active={tab === "schedule"} onClick={() => setTab("schedule")}>Schedule</TabButton>
          <TabButton active={tab === "scheduled"} onClick={openScheduled}>Scheduled</TabButton>
        </div>
      </div>
    </header>

    <form hidden={tab !== "schedule"} onSubmit={(event) => void submit(event)} className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)] lg:items-start">
      <div className="space-y-6">
        <section className="rounded-md border border-white/25 bg-black/[0.04] p-5 sm:p-6">
          <h3 className="text-xl font-semibold">Puzzle</h3>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <div className="text-sm font-semibold">
              <label htmlFor="schedule-play-date">Play date</label>
              <DatePicker id="schedule-play-date" value={activeDate} onChange={setActiveDate} min={today} today={today} className={inputClass} />
              <span className="mt-1 block text-xs font-normal text-white/55">{appTimezone}</span>
            </div>
            <label className="text-sm font-semibold">Difficulty name
              <input type="text" required maxLength={100} value={difficulty} onChange={(event) => setDifficulty(event.target.value)} className={inputClass} />
            </label>
          </div>
          <div className="mt-5 flex flex-wrap gap-2" aria-label="Schedule type">
            <span className="rounded-full border border-white/30 px-3 py-1 text-sm font-semibold">Shared</span>
            <div className="inline-flex overflow-hidden rounded-full border border-white/30" role="radiogroup" aria-label="Puzzle type">
              <PuzzleKindButton active={puzzleKind === "riddle"} onClick={() => selectPuzzleKind("riddle")}>Riddle</PuzzleKindButton>
              <PuzzleKindButton active={puzzleKind === "character_puzzle"} onClick={() => selectPuzzleKind("character_puzzle")}>Character puzzle</PuzzleKindButton>
            </div>
            <span className="rounded-full border border-white/30 px-3 py-1 text-sm font-semibold">Fixed difficulty</span>
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

        <section className="rounded-md border border-white/25 bg-black/[0.04] p-5 sm:p-6">
          <div className="flex items-center justify-between gap-4">
            <div><h3 className="text-xl font-semibold">Speed bonuses</h3><p className="mt-1 text-sm text-white/55">Optional tiers do not stack; the highest qualifying bonus wins.</p></div>
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

      <section className="app-header relative isolate overflow-hidden rounded-md p-5 sm:p-6 lg:sticky lg:top-28">
        <FloatingQuestionMarks contained compact start={12} />
        <h3 className="text-xl font-semibold">Rules and scoring</h3>
        <div className="mt-5 grid grid-cols-2 gap-4">
          <label className="text-sm font-semibold">Time limit
            <span className="sr-only"> in seconds</span>
            <input type="number" min="1" step="1" required value={timeLimitSeconds} onChange={(event) => setTimeLimitSeconds(event.target.value)} className={inputClass} />
            <span className="mt-1 block text-xs font-normal text-white/55">seconds</span>
          </label>
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
        <PrimaryButton type="submit" disabled={busy} className="mt-4 w-full px-5 py-3">{busy ? "Scheduling…" : `Schedule ${puzzleLabel}`}</PrimaryButton>
      </section>
    </form>

    <div hidden={tab !== "scheduled"}><AdminRiddleList refreshVersion={listVersion} appTimezone={appTimezone} /></div>
  </section>;
}

function TabButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`h-9 px-3 text-sm font-semibold transition lg:h-11 lg:px-5 lg:text-base ${active ? "navy-surface relative isolate" : "text-white hover:bg-white/15"}`}>{active && <FloatingQuestionMarks contained compact start={4} />}{children}</button>;
}

function PuzzleKindButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return <button type="button" role="radio" aria-checked={active} onClick={onClick} className={`px-3 py-1 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-white ${active ? "bg-white/20" : "hover:bg-white/10"}`}>{children}</button>;
}
