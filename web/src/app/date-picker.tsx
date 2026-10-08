"use client";

import { useEffect, useId, useRef, useState } from "react";
import { addMonths, formatUsDate, monthGrid, parseUsDate } from "@/lib/calendar";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const dayLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

function monthOf(iso: string): { year: number; month: number } {
  const [year, month] = iso.split("-").map(Number);
  return { year, month: month - 1 };
}

export function DatePicker({
  id,
  value,
  onChange,
  min,
  today,
  className,
}: {
  id: string;
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  today: string;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(formatUsDate(value));
  const [visible, setVisible] = useState(() => monthOf(value || today));
  const containerRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  function openCalendar() {
    setVisible(monthOf(value || today));
    setOpen(true);
  }

  function select(iso: string) {
    onChange(iso);
    setText(formatUsDate(iso));
    setOpen(false);
  }

  // Never closes the popup: a day click blurs the input first and must still land.
  function commitTyped() {
    const parsed = parseUsDate(text);
    if (parsed && (!min || parsed >= min)) {
      if (parsed !== value) onChange(parsed);
      setText(formatUsDate(parsed));
      setVisible(monthOf(parsed));
    } else {
      setText(formatUsDate(value));
    }
  }

  const previous = addMonths(visible.year, visible.month, -1);
  const next = addMonths(visible.year, visible.month, 1);
  const lastOfPrevious = new Date(Date.UTC(visible.year, visible.month, 0)).toISOString().slice(0, 10);
  const canGoBack = !min || lastOfPrevious >= min;

  return <div ref={containerRef} className="relative">
    <input
      id={id}
      type="text"
      inputMode="numeric"
      placeholder="mm/dd/yyyy"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onClick={openCalendar}
      onBlur={commitTyped}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitTyped();
        }
      }}
      className={`${className} pr-11`}
    />
    <button type="button" aria-label="Choose date" aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId} onClick={() => (open ? setOpen(false) : openCalendar())} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-white/60 hover:text-white">
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
    </button>
    {open && <div id={dialogId} role="dialog" aria-label="Choose date" className="absolute left-0 top-full z-40 mt-2 w-[18rem] rounded-md border border-white/30 bg-surface-solid p-3 font-normal shadow-2xl">
      <div className="flex items-center justify-between">
        <button type="button" aria-label="Previous month" disabled={!canGoBack} onClick={() => setVisible(previous)} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <span aria-live="polite" className="text-sm font-semibold">{monthLabel.format(Date.UTC(visible.year, visible.month, 1))}</span>
        <button type="button" aria-label="Next month" onClick={() => setVisible(next)} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-white/10">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m9 18 6-6-6-6" /></svg>
        </button>
      </div>
      <div className="mt-3 grid grid-cols-7 text-center text-xs text-white/55">
        {WEEKDAYS.map((weekday) => <span key={weekday} className="py-1">{weekday}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-sm">
        {monthGrid(visible.year, visible.month).flat().map((day) => {
          const disabled = Boolean(min && day.iso < min);
          const selected = day.iso === value;
          return <button
            key={day.iso}
            type="button"
            disabled={disabled}
            aria-label={dayLabel.format(Date.parse(`${day.iso}T00:00:00Z`))}
            aria-pressed={selected}
            onClick={() => select(day.iso)}
            className={`mx-auto flex h-9 w-9 items-center justify-center rounded-md tabular-nums transition ${
              selected ? "bg-white/20 font-semibold" : day.iso === today ? "ring-1 ring-white/40" : ""
            } ${disabled ? "cursor-not-allowed text-white/20" : `${day.inMonth ? "" : "text-white/45"} hover:bg-white/10`}`}
          >{day.day}</button>;
        })}
      </div>
    </div>}
  </div>;
}
