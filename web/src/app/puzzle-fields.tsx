"use client";

import { DIFFICULTIES, difficultyColor, type Difficulty } from "@/lib/difficulty";
import { useRef, useState } from "react";
import { prepareImageForUpload } from "@/lib/image-resize";
import type { BankPuzzleKind } from "@/lib/puzzle-bank";
import { MAX_IMAGES } from "@/server/challenges/image-puzzle";
import { MAX_TARGET_LENGTH } from "@/server/challenges/character-puzzle";

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
  promptImagePath: string;
  promptImageUrl: string;
  hint: string;
  hintCost: string;
}

// Fire and forget: the server only removes a file that no puzzle uses.
export function discardPromptImage(path: string) {
  if (!path) return;
  void fetch("/api/admin/puzzles/prompt-image", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    keepalive: true,
  }).catch(() => undefined);
}

export const emptyFieldValues: PuzzleFieldValues = {
  prompt: "",
  acceptedAnswers: "",
  targetWord: "",
  promptImagePath: "",
  promptImageUrl: "",
  hint: "",
  hintCost: "",
};

function HintFields({ values, onChange }: { values: PuzzleFieldValues; onChange: (values: PuzzleFieldValues) => void }) {
  return <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_9rem]">
    <label className="block text-sm font-semibold">Hint (optional)
      <textarea maxLength={1_000} rows={2} value={values.hint} onChange={(event) => onChange({ ...values, hint: event.target.value })} placeholder="Think about a musical instrument" className={`${inputClass} resize-y`} />
      <span className="mt-1 block text-xs font-normal text-white/55">Players can reveal it during play. Leave blank for no hint.</span>
    </label>
    <label className="block text-sm font-semibold">Hint cost (points)
      <input type="number" inputMode="numeric" min={0} step={1} required={values.hint.trim() !== ""} disabled={values.hint.trim() === ""} value={values.hintCost}
        onChange={(event) => onChange({ ...values, hintCost: event.target.value })} placeholder="10" className={inputClass} />
      <span className="mt-1 block text-xs font-normal text-white/55">Taken off the result; a correct answer never goes below 0.</span>
    </label>
  </div>;
}

function PromptImageField({ values, onChange }: { values: PuzzleFieldValues; onChange: (values: PuzzleFieldValues) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("file", await prepareImageForUpload(file));
      const response = await fetch("/api/admin/puzzles/prompt-image", { method: "POST", body });
      const result = await response.json().catch(() => ({})) as { path?: string; url?: string | null; error?: string };
      if (!response.ok || !result.path) {
        setError(result.error ?? "Could not upload the image.");
        return;
      }
      discardPromptImage(values.promptImagePath);
      onChange({ ...values, promptImagePath: result.path, promptImageUrl: result.url ?? "" });
    } catch {
      setError("Could not upload the image.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return <div className="mt-5 text-sm font-semibold">
    <span id="prompt-image-label">Prompt image (optional)</span>
    {values.promptImageUrl && <img src={values.promptImageUrl} alt="Prompt" className="mt-2 max-h-56 rounded-md border border-white/25" />}
    {values.promptImagePath && !values.promptImageUrl && <p className="mt-2 text-xs font-normal text-white/55">Image attached.</p>}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-labelledby="prompt-image-label" disabled={busy}
        onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }}
        className="text-sm font-normal file:mr-3 file:rounded-md file:border file:border-white/50 file:bg-transparent file:px-3 file:py-1.5 file:font-semibold file:text-white" />
      {values.promptImagePath && <button type="button" onClick={() => { discardPromptImage(values.promptImagePath); onChange({ ...values, promptImagePath: "", promptImageUrl: "" }); }}
        className="rounded-md border border-white/50 px-3 py-1.5 text-sm font-semibold hover:bg-white/10">Remove image</button>}
      {busy && <span className="text-xs font-normal text-white/60">Uploading…</span>}
    </div>
    <span className="mt-1 block text-xs font-normal text-white/55">PNG, JPEG, WebP or GIF. Large photos are resized automatically. Players see it only after they start.</span>
    {error && <p role="alert" className="mt-2 text-xs font-normal text-red-200">{error}</p>}
  </div>;
}

export function PuzzleContentFields({ kind, values, onChange }: {
  kind: BankPuzzleKind;
  values: PuzzleFieldValues;
  onChange: (values: PuzzleFieldValues) => void;
}) {
  if (kind === "character_puzzle") {
    return <>
      <label className="mt-5 block text-sm font-semibold">Answer
      <span className="mt-1 flex gap-2">
        <input type="text" required maxLength={MAX_TARGET_LENGTH} autoComplete="off" spellCheck={false} value={values.targetWord}
          onChange={(event) => onChange({ ...values, targetWord: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })}
          placeholder="CRANE" className={`${inputClass} mt-0 font-mono uppercase tracking-widest`} />
      </span>
      <span className="mt-1 block text-xs font-normal text-white/55">Up to {MAX_TARGET_LENGTH} letters and digits, no spaces. Players see only the length.</span>
      </label>
      <HintFields values={values} onChange={onChange} />
    </>;
  }
  if (kind === "image_submission") {
    return <>
      <label className="mt-5 block text-sm font-semibold">Prompt text (optional if there is a prompt image)
        <textarea maxLength={10_000} rows={4} value={values.prompt} onChange={(event) => onChange({ ...values, prompt: event.target.value })} placeholder="Draw your favorite animal" className={`${inputClass} resize-y`} />
      </label>
      <PromptImageField values={values} onChange={onChange} />
      <p className="mt-5 text-xs font-normal text-white/55">Players can upload up to {MAX_IMAGES} images. An admin grades the submission by hand.</p>
    </>;
  }
  return <>
    <label className="mt-5 block text-sm font-semibold">Riddle prompt
      <textarea required maxLength={10_000} rows={5} value={values.prompt} onChange={(event) => onChange({ ...values, prompt: event.target.value })} placeholder="What has keys but no locks?" className={`${inputClass} resize-y`} />
    </label>
    <label className="mt-5 block text-sm font-semibold">Accepted answers
      <textarea required maxLength={25_050} rows={4} value={values.acceptedAnswers} onChange={(event) => onChange({ ...values, acceptedAnswers: event.target.value })} placeholder={"piano\na piano"} className={`${inputClass} resize-y`} />
      <span className="mt-1 block text-xs font-normal text-white/55">One answer per line, up to 50. Capitalization and punctuation are ignored during grading.</span>
    </label>
    <HintFields values={values} onChange={onChange} />
  </>;
}
