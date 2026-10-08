import Image from "next/image";
import type { CharacterFeedback } from "@/server/challenges/character-puzzle";
import { keyboardRows, keyStatuses } from "@/lib/character-keyboard";
import { dancingLetterSrc } from "@/lib/dancing-letters";

// Fixed hex colors on purpose: the page theme remaps text-white, which would turn tile letters black.
const TILE_CLASSES: Record<CharacterFeedback | "filled" | "empty", string> = {
  correct: "border-[#4cb546] text-[#4cb546]",
  present: "border-[#e0c22e] text-[#e0c22e]",
  absent: "border-[#787c7e] text-[#787c7e]",
  filled: "border-[#878a8c] text-[#1a1a1b]",
  empty: "border-[#d3d6da] text-[#1a1a1b]",
};

// The images are red, so the result is shown by shifting the letter's own hue.
const LETTER_FILTERS: Record<CharacterFeedback, string> = {
  correct: "hue-rotate(120deg) saturate(1.2) brightness(1.9)",
  present: "hue-rotate(67deg) saturate(2.2) brightness(3.2)",
  absent: "grayscale(1) brightness(2.6)",
};

const KEY_CLASSES: Record<CharacterFeedback | "unused", string> = {
  correct: "bg-[#538d4e] text-[#ffffff]",
  present: "bg-[#b59f3b] text-[#ffffff]",
  absent: "bg-[#3a3a3c] text-[#ffffff]",
  unused: "bg-[#d3d6da] text-[#1a1a1b] hover:bg-[#c3c6ca]",
};

const ACTION_KEY_CLASSES = "bg-[#d3d6da] text-[#1a1a1b] hover:bg-[#c3c6ca]";

const TILE_LABELS: Record<CharacterFeedback, string> = {
  correct: "correct position",
  present: "wrong position",
  absent: "not in the answer",
};

type GuessRow = { response: string; feedback?: CharacterFeedback[] };

export function CharacterBoard({
  guesses,
  current = "",
  length,
  rows,
}: {
  guesses: ReadonlyArray<GuessRow>;
  current?: string;
  length: number;
  rows?: number;
}) {
  const totalRows = Math.max(rows ?? guesses.length, guesses.length);
  const columns = { gridTemplateColumns: `repeat(${length}, minmax(0, 1fr))` };
  return <div
    className="mx-auto w-full"
    style={{ maxWidth: `${length * 4.5}rem`, containerType: "inline-size", ["--n" as string]: length }}
    role="group"
    aria-label="Guess board"
  >
    <div className="grid gap-2">
      {Array.from({ length: totalRows }, (_, row) => {
        const guess = guesses[row];
        const typing = !guess && row === guesses.length;
        const letters = guess ? [...guess.response] : typing ? [...current] : [];
        return <div key={row} className="grid gap-2" style={columns}>
          {Array.from({ length }, (_, column) => {
            const character = letters[column];
            const tone = guess
              ? guess.feedback?.[column] ?? "absent"
              : character ? "filled" : "empty";
            return <span
              key={column}
              aria-label={character && guess ? `${character}, ${TILE_LABELS[guess.feedback?.[column] ?? "absent"]}` : character ?? "empty"}
              className={`flex aspect-square select-none items-center justify-center border-2 font-bold uppercase ${TILE_CLASSES[tone]}`}
              style={{ fontSize: "clamp(0.6rem, calc(62cqw / var(--n)), 1.9rem)" }}
            >{character && <TileLetter character={character} feedback={guess ? guess.feedback?.[column] ?? "absent" : undefined} />}</span>;
          })}
        </div>;
      })}
    </div>
  </div>;
}

function TileLetter({ character, feedback }: { character: string; feedback?: CharacterFeedback }) {
  const src = dancingLetterSrc(character);
  if (!src) return character;
  return <Image
    src={src}
    alt=""
    width={80}
    height={80}
    unoptimized
    className="size-full object-contain"
    style={feedback ? { filter: LETTER_FILTERS[feedback] } : undefined}
  />;
}

export function CharacterKeyboard({
  characterSet,
  guesses,
  disabled,
  canSubmit,
  onCharacter,
  onDelete,
  onEnter,
}: {
  characterSet: string;
  guesses: ReadonlyArray<GuessRow>;
  disabled: boolean;
  canSubmit: boolean;
  onCharacter: (character: string) => void;
  onDelete: () => void;
  onEnter: () => void;
}) {
  const statuses = keyStatuses(guesses);
  const rows = keyboardRows(characterSet);
  const lastRow = rows.length - 1;
  const keyBase = "flex h-14 min-w-0 flex-1 select-none items-center justify-center rounded-md text-sm font-bold uppercase transition-colors focus-visible:outline-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-60";
  return <div className="mx-auto mt-6 w-full max-w-[34rem] space-y-1.5" role="group" aria-label="Keyboard" onMouseDown={(event) => event.preventDefault()}>
    {rows.map((row, index) => <div key={row.join("")} className="flex justify-center gap-1.5">
      {index === lastRow && <button type="button" disabled={disabled || !canSubmit} onClick={onEnter} className={`${keyBase} flex-[1.6] text-xs ${ACTION_KEY_CLASSES}`}>Enter</button>}
      {row.map((character) => {
        const status = statuses.get(character);
        return <button
          key={character}
          type="button"
          disabled={disabled}
          onClick={() => onCharacter(character)}
          aria-label={status ? `${character}, ${TILE_LABELS[status]}` : character}
          className={`${keyBase} ${KEY_CLASSES[status ?? "unused"]}`}
        >{character}</button>;
      })}
      {index === lastRow && <button type="button" disabled={disabled} onClick={onDelete} aria-label="Delete" className={`${keyBase} flex-[1.6] ${ACTION_KEY_CLASSES}`}>
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 14 10.59 17.59 7 19 8.41 15.41 12 19 15.59z" /></svg>
      </button>}
    </div>)}
  </div>;
}
