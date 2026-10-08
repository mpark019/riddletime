"use client";

import { useState } from "react";
import { addMonths, monthGrid } from "@/lib/calendar";
import type { ScheduledRiddle } from "@/server/schedules/schedules";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const dayLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

function monthOf(iso: string): { year: number; month: number } {
  const [year, month] = iso.split("-").map(Number);
  return { year, month: month - 1 };
}

export function ScheduleCalendar({
  value,
  today,
  days,
  playerCount,
  onSelect,
}: {
  value: string;
  today: string;
  days: ScheduledRiddle[];
  playerCount: number;
  onSelect: (iso: string) => void;
}) {
  const [visible, setVisible] = useState(() => monthOf(value));
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    setVisible(monthOf(value));
  }

  const coverage = new Map(days.map((day) => [
    day.activeDate,
    day.mode === "shared" || day.assignedCount >= playerCount ? "full" : "partial",
  ] as const));
  const previous = addMonths(visible.year, visible.month, -1);
  const next = addMonths(visible.year, visible.month, 1);
  const arrow = "flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white";

  return <div>
    <div className="flex items-center justify-between">
      <button type="button" aria-label="Previous month" onClick={() => setVisible(previous)} className={arrow}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <span aria-live="polite" className="text-sm font-semibold">{monthLabel.format(Date.UTC(visible.year, visible.month, 1))}</span>
      <button type="button" aria-label="Next month" onClick={() => setVisible(next)} className={arrow}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>
    <div className="mt-2 grid grid-cols-7 text-center text-[11px] text-white/55">
      {WEEKDAYS.map((weekday) => <span key={weekday} className="py-1">{weekday}</span>)}
    </div>
    <div className="grid grid-cols-7 gap-y-0.5 text-center text-sm">
      {monthGrid(visible.year, visible.month).flat().map((day) => {
        const selected = day.iso === value;
        const state = coverage.get(day.iso);
        return <button
          key={day.iso}
          type="button"
          aria-label={`${dayLabel.format(Date.parse(`${day.iso}T00:00:00Z`))}${state ? (state === "full" ? ", puzzles assigned to everyone" : ", puzzles assigned to some players") : ", no puzzle"}`}
          aria-pressed={selected}
          onClick={() => onSelect(day.iso)}
          className={`mx-auto flex h-10 w-10 flex-col items-center justify-center rounded-lg tabular-nums transition focus-visible:outline-2 focus-visible:outline-white ${
            selected ? "bg-white/20 font-semibold" : day.iso === today ? "ring-1 ring-white/40" : ""
          } ${day.inMonth ? "" : "text-white/45"} hover:bg-white/10`}
        >
          <span>{day.day}</span>
          <span aria-hidden="true" className={`mt-0.5 h-1.5 w-1.5 rounded-full ${state === "full" ? "bg-current" : state === "partial" ? "border border-current" : ""}`} />
        </button>;
      })}
    </div>
    <p className="mt-2 flex items-center gap-4 text-xs text-white/55">
      <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />Everyone assigned</span>
      <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full border border-current" />Some players</span>
    </p>
  </div>;
}
