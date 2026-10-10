"use client";

import { DIFFICULTIES, difficultyColor, type Difficulty } from "@/lib/difficulty";
import type { BankPuzzleKind } from "@/lib/puzzle-bank";

export const inputClass = "mt-1 w-full rounded-md border border-white/40 bg-black/[0.04] px-3 py-2.5 text-white placeholder:text-white/45 focus:outline-2 focus:outline-white";

export function DifficultyPicker({ value, onChange, label }: { value: Difficulty; onChange: (value: Difficulty) => void; label: string }) {
  return <div className="text-sm font-semibold">
    <span id={`${label}-label`}>{label}</span>
    <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-labelledby={`${label}-label`}>
      {DIFFICULTIES.map((option) => {
        const color = difficultyColor(option);
        const active = value === option;
        return <button
          key={option}
          type="button"
          role="radio"
          aria-checked={active}
          onClick={() => onChange(option)}
          style={{ borderColor: color, color: active ? "#fff" : color, backgroundColor: active ? color : undefined }}
          className="flex min-w-0 items-center justify-center whitespace-nowrap rounded-md border-2 px-2 py-2.5 text-sm font-bold uppercase tracking-wide transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >{option}</button>;
      })}
    </div>
  </div>;
}

export interface PuzzleFieldValues {
  prompt: string;
  acceptedAnswers: string;
  targetWord: string;
}

export function PuzzleContentFields({ kind, values, onChange, onRandomTarget }: {
  kind: BankPuzzleKind;
  values: PuzzleFieldValues;
  onChange: (values: PuzzleFieldValues) => void;
  onRandomTarget?: () => void;
}) {
  if (kind === "character_puzzle") {
    return <label className="mt-5 block text-sm font-semibold">Answer
      <span className="mt-1 flex gap-2">
        <input type="text" required maxLength={50} autoComplete="off" spellCheck={false} value={values.targetWord}
          onChange={(event) => onChange({ ...values, targetWord: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })}
          placeholder="CRANE" className={`${inputClass} mt-0 font-mono uppercase tracking-widest`} />
        {onRandomTarget && <button type="button" onClick={onRandomTarget} className="shrink-0 rounded-md border border-white/60 px-3 text-sm font-semibold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white">Random</button>}
      </span>
      <span className="mt-1 block text-xs font-normal text-white/55">Up to 50 letters and digits, no spaces. Players see only the length.</span>
    </label>;
  }
  return <>
    <label className="mt-5 block text-sm font-semibold">Riddle prompt
      <textarea required maxLength={10_000} rows={5} value={values.prompt} onChange={(event) => onChange({ ...values, prompt: event.target.value })} placeholder="What has keys but no locks?" className={`${inputClass} resize-y`} />
    </label>
    <label className="mt-5 block text-sm font-semibold">Accepted answers
      <textarea required maxLength={25_050} rows={4} value={values.acceptedAnswers} onChange={(event) => onChange({ ...values, acceptedAnswers: event.target.value })} placeholder={"piano\na piano"} className={`${inputClass} resize-y`} />
      <span className="mt-1 block text-xs font-normal text-white/55">One answer per line, up to 50. Capitalization and punctuation are ignored during grading.</span>
    </label>
  </>;
}
