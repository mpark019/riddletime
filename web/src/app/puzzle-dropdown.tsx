"use client";

import { useEffect, useRef, useState } from "react";

export function Dropdown({ label, value, options, onChange, className = "" }: {
  label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(0, options.findIndex(([optionValue]) => optionValue === value));
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function openList() {
    setHighlight(selectedIndex);
    setOpen(true);
  }

  function choose(index: number) {
    onChange(options[index][0]);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) return openList();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((current) => (current + step + options.length) % options.length);
    } else if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      choose(highlight);
    }
  }

  return <div ref={ref} className={`relative ${className}`} onKeyDown={onKeyDown}>
    <span className="block text-sm font-semibold">{label}</span>
    <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${options[selectedIndex][1]}`}
      onClick={() => (open ? setOpen(false) : openList())}
      className="mt-1 flex h-11 w-full items-center justify-between rounded-lg border border-white/40 bg-surface-solid px-3 text-left text-sm font-normal focus-visible:outline-2 focus-visible:outline-white">
      <span>{options[selectedIndex][1]}</span>
      <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 text-white/55" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 8 5 5 5-5" /></svg>
    </button>
    {open && <ul role="listbox" aria-label={label}
      className="absolute left-0 right-0 z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-white/25 bg-surface-solid p-1 shadow-lg">
      {options.map(([optionValue, text], index) => <li key={optionValue} role="option" aria-selected={optionValue === value}
        onMouseEnter={() => setHighlight(index)} onClick={() => choose(index)}
        className={`flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm ${index === highlight ? "bg-black/[0.07]" : ""}`}>
        <span>{text}</span>
        {optionValue === value && <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 10 4 4 8-8" /></svg>}
      </li>)}
    </ul>}
  </div>;
}
