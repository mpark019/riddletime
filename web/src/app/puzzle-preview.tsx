"use client";

import { buildPuzzlePreview, type PreviewRules, type PuzzleForm } from "@/lib/puzzle-bank";
import { StaffRiddleSandbox } from "./riddle-game";

// Renders the real player screen with its controls disabled, so what you see is what players get.
export function PuzzlePreview({ form, rules }: { form: PuzzleForm; rules?: PreviewRules }) {
  const preview = buildPuzzlePreview(form, rules);
  return <section aria-label="Player preview">
    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
      Player view. Nothing is saved or scored{rules ? "" : "; time, tries and points are the defaults for this difficulty and can be changed when you schedule"}.
    </p>
    {preview
      ? <StaffRiddleSandbox preview={preview} />
      : <p className="rounded-md border border-dashed border-white/25 px-4 py-10 text-center text-sm text-white/55">
        {form.kind === "riddle" ? "Enter a riddle prompt, or pick one from storage." : "Enter an answer, or pick a puzzle from storage."}
      </p>}
  </section>;
}
