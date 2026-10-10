"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DIFFICULTIES, difficultyColor, isDifficulty, type Difficulty } from "@/lib/difficulty";
import {
  buildPuzzleRequest,
  MAX_NAME_LENGTH,
  formatMedianSeconds,
  formatSolveRate,
  randomTarget,
  type BankPuzzleKind,
  type PuzzleForm,
} from "@/lib/puzzle-bank";
import type { BankPuzzle } from "@/server/puzzles/puzzles";
import { PrimaryButton } from "./primary-button";
import { DifficultyPicker, PuzzleContentFields, inputClass, type PuzzleFieldValues } from "./puzzle-fields";
import { PuzzlePreview } from "./puzzle-preview";

type Drawer = "closed" | "view" | "form";
type Filter = { type: "" | BankPuzzleKind; status: "" | "active" | "retired"; used: "" | "true" | "false" };

const PAGE_SIZE = 20;
const emptyValues: PuzzleFieldValues = { prompt: "", acceptedAnswers: "", targetWord: "" };
const puzzleName = (puzzle: BankPuzzle) => puzzle.name ?? `${puzzle.acceptedAnswers[0] ?? "No answer"} | ${kindLabel(puzzle.type)}`;
const kindLabel = (type: BankPuzzleKind) => type === "riddle" ? "Riddle" : "Letter game";

async function readError(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return body.error ?? fallback;
}

function formFromPuzzle(puzzle: BankPuzzle): PuzzleForm {
  return {
    name: puzzle.name ?? "",
    kind: puzzle.type,
    difficulty: puzzle.difficulty,
    prompt: puzzle.type === "riddle" ? puzzle.prompt : "",
    acceptedAnswers: puzzle.type === "riddle" ? puzzle.acceptedAnswers.join("\n") : "",
    targetWord: puzzle.type === "character_puzzle" ? puzzle.acceptedAnswers[0] ?? "" : "",
  };
}

export function AdminPuzzleBank() {
  const [puzzles, setPuzzles] = useState<BankPuzzle[] | null>(null);
  const [filter, setFilter] = useState<Filter>({ type: "", status: "", used: "" });
  const [search, setSearch] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState("");
  const [page, setPage] = useState(1);
  const [drawer, setDrawer] = useState<Drawer>("closed");
  const [selectedId, setSelectedId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BankPuzzleKind>("riddle");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [difficultyTouched, setDifficultyTouched] = useState(false);
  const [values, setValues] = useState<PuzzleFieldValues>(emptyValues);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (current: Filter) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(current)) if (value) query.set(key, value);
    const response = await fetch(`/api/admin/puzzles?${query}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as { puzzles?: BankPuzzle[]; error?: string };
    if (!response.ok || !body.puzzles) throw new Error(body.error ?? "Could not load the puzzle bank.");
    setPuzzles(body.puzzles);
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void load(filter).catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load the puzzle bank.");
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [filter, load]);

  useEffect(() => {
    if (drawer === "closed") return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer("closed"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const reload = () => load(filter).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not reload."));

  const selected = puzzles?.find((puzzle) => puzzle.id === selectedId) ?? null;
  const editing = editingId !== "" && selected?.id === editingId;
  const draftForm: PuzzleForm = { name, kind, difficulty, ...values };
  const needle = search.trim().toLowerCase();
  const matching = puzzles?.filter((puzzle) => (difficultyFilter === "" || puzzle.difficulty === difficultyFilter) && (needle === ""
    || (puzzle.name ?? "").toLowerCase().includes(needle)
    || puzzle.prompt.toLowerCase().includes(needle)
    || puzzle.acceptedAnswers.some((answer) => answer.toLowerCase().includes(needle)))) ?? null;
  const pageCount = Math.max(1, Math.ceil((matching?.length ?? 0) / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = matching?.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE) ?? null;

  function changeKind(next: BankPuzzleKind) {
    if (next === kind) return;
    setKind(next);
    setValues(emptyValues);
    setError(null);
  }

  function startAdd() {
    if (editingId) {
      setEditingId("");
      setName("");
      setValues(emptyValues);
      setDifficultyTouched(false);
    }
    setSelectedId("");
    setError(null);
    setNotice(null);
    setDrawer("form");
  }

  function openPuzzle(puzzle: BankPuzzle) {
    setSelectedId(puzzle.id);
    setEditingId("");
    setError(null);
    setNotice(null);
    setDrawer("view");
  }

  function startEdit(puzzle: BankPuzzle) {
    setSelectedId(puzzle.id);
    setEditingId(puzzle.id);
    setKind(puzzle.type);
    setDifficulty(isDifficulty(puzzle.difficulty) ? puzzle.difficulty : "medium");
    setDifficultyTouched(false);
    const form = formFromPuzzle(puzzle);
    setName(puzzle.name ?? "");
    setValues({ prompt: form.prompt, acceptedAnswers: form.acceptedAnswers, targetWord: form.targetWord });
    setError(null);
    setNotice(null);
    setDrawer("form");
  }

  function cancelForm() {
    if (editing && selected) {
      setEditingId("");
      setName("");
      setValues(emptyValues);
      setDifficultyTouched(false);
      setDrawer("view");
      return;
    }
    setDrawer("closed");
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    let built: ReturnType<typeof buildPuzzleRequest>;
    try {
      built = buildPuzzleRequest(draftForm);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Check the puzzle.");
      return;
    }
    setBusy(true);
    try {
      const response = editing
        ? await fetch(`/api/admin/puzzles/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          // A stored label outside the four presets is left alone unless a new one is picked.
          body: JSON.stringify(difficultyTouched ? { ...built, name: built.name ?? "" } : { name: built.name ?? "", puzzle: built.puzzle }),
        })
        : await fetch("/api/admin/puzzles", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(built),
        });
      if (!response.ok) {
        setError(await readError(response, "Could not save this puzzle."));
        return;
      }
      const { puzzle } = await response.json() as { puzzle: BankPuzzle };
      setPuzzles((list) => list === null ? list : editing ? list.map((item) => item.id === puzzle.id ? puzzle : item) : [puzzle, ...list]);
      setSelectedId(puzzle.id);
      setEditingId("");
      setName("");
      setValues(emptyValues);
      setDifficultyTouched(false);
      setDrawer(editing ? "view" : "closed");
      setNotice(editing ? "Puzzle updated." : "Saved to storage.");
      void reload();
    } catch {
      setError("Could not confirm the puzzle was saved. Reload to check.");
    } finally {
      setBusy(false);
    }
  }

  async function mutate(target: BankPuzzle, method: "PATCH" | "DELETE", body: unknown, success: string, clearSelection = false) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/puzzles/${target.id}`, {
        method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        setError(await readError(response, "Could not update this puzzle."));
        return;
      }
      if (clearSelection) {
        setSelectedId("");
        setDrawer("closed");
      }
      setNotice(success);
      await reload();
    } catch {
      setError("Could not confirm the change. Reload to check.");
    } finally {
      setBusy(false);
    }
  }

  const toggleStatus = (puzzle: BankPuzzle) => void mutate(puzzle, "PATCH",
    { status: puzzle.status === "active" ? "retired" : "active" },
    puzzle.status === "active" ? "Puzzle retired." : "Puzzle restored.");

  const drawerTitle = drawer === "form" ? (editing ? "Edit puzzle" : "Add a puzzle") : selected ? puzzleName(selected) : "Puzzle";

  return <section aria-label="Puzzle bank" className="space-y-4">
    <div aria-live="polite" className="space-y-2 empty:hidden">
      {error && drawer === "closed" && <p role="alert" className="rounded-md border border-red-300/60 bg-red-950/45 px-4 py-3 text-sm text-red-100">{error}</p>}
      {notice && <p className="rounded-md border border-emerald-300/60 bg-emerald-950/45 px-4 py-3 text-sm text-emerald-100">{notice}</p>}
    </div>

    <div className="flex items-stretch justify-between gap-2">
      <label className="min-w-0 w-full max-w-md text-sm font-semibold"><span className="sr-only">Search puzzles</span>
        <input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search names, prompts or answers"
          className="h-11 w-full rounded-md border border-white/40 bg-black/[0.04] px-3 text-white placeholder:text-white/45 focus:outline-2 focus:outline-white" />
      </label>
      <div className="flex shrink-0 items-stretch gap-2">
      <FilterMenu type={filter.type} status={filter.status} difficulty={difficultyFilter}
        onType={(type) => { setFilter({ ...filter, type }); setPage(1); }}
        onStatus={(status) => { setFilter({ ...filter, status }); setPage(1); }}
        onDifficulty={(next) => { setDifficultyFilter(next); setPage(1); }}
        onClear={() => { setFilter({ ...filter, type: "", status: "" }); setDifficultyFilter(""); setPage(1); }} />
      <PrimaryButton type="button" onClick={startAdd} className="h-11 px-5">+ Add puzzle</PrimaryButton>
      </div>
    </div>

    <PuzzleTable puzzles={visible} total={puzzles?.length ?? 0} matching={matching?.length ?? 0}
      page={currentPage} pageCount={pageCount} onPage={setPage} onOpen={openPuzzle} />

    {drawer !== "closed" && <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55" aria-hidden onClick={() => setDrawer("closed")} />
      <div className="relative w-full max-w-4xl overflow-hidden rounded-2xl bg-surface-solid shadow-2xl">
      <div role="dialog" aria-modal="true" aria-labelledby="puzzle-modal-title"
        className="max-h-[calc(100vh-2rem)] overflow-y-auto p-5 text-white [scrollbar-width:thin] sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <h3 id="puzzle-modal-title" className="break-words text-xl font-semibold">{drawerTitle}</h3>
          <button ref={closeRef} type="button" onClick={() => setDrawer("closed")} aria-label="Close"
            className="-mr-1 -mt-1 rounded-md px-2 py-1 text-2xl leading-none text-white/60 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white">×</button>
        </div>
        <div aria-live="polite" className="mt-3 space-y-2 empty:hidden">
          {error && <p role="alert" className="rounded-md border border-red-300/60 bg-red-950/45 px-4 py-3 text-sm text-red-100">{error}</p>}
          {notice && <p className="rounded-md border border-emerald-300/60 bg-emerald-950/45 px-4 py-3 text-sm text-emerald-100">{notice}</p>}
        </div>
        {drawer === "view" && selected && <>
          <PuzzleDetails key={selected.id} puzzle={selected} busy={busy}
            onEdit={() => startEdit(selected)}
            onToggleStatus={() => toggleStatus(selected)}
            onRename={(next) => void mutate(selected, "PATCH", { name: next }, next ? "Name saved." : "Name cleared.")}
            onDelete={() => void mutate(selected, "DELETE", undefined, "Puzzle deleted.", true)} />
          <h4 className="mt-7 text-base font-semibold">Player preview</h4>
          <div className="mt-3 rounded-xl border border-white/20 bg-black/[0.04] p-4"><PuzzlePreview form={formFromPuzzle(selected)} /></div>
        </>}
        {drawer === "form" && <>
          <form onSubmit={(event) => void save(event)} className="mt-4" aria-labelledby="puzzle-modal-title">
            <div className="inline-flex overflow-hidden rounded-full border border-white/30" role="radiogroup" aria-label="Puzzle type">
              {(["riddle", "character_puzzle"] as const).map((option) => <button key={option} type="button" role="radio" aria-checked={kind === option}
                disabled={editing} onClick={() => changeKind(option)}
                className={`px-3 py-1 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-white disabled:cursor-not-allowed ${kind === option ? "bg-white/20" : "hover:bg-white/10 disabled:opacity-45"}`}>{kindLabel(option)}</button>)}
            </div>
            <label className="mt-4 block text-sm font-semibold">Name <span className="font-normal text-white/60">(optional)</span>
              <input value={name} maxLength={MAX_NAME_LENGTH} onChange={(event) => setName(event.target.value)}
                placeholder="Shown in the bank and when scheduling" className={inputClass} />
            </label>
            <div className="mt-4">
              <DifficultyPicker label="Difficulty" value={difficulty} onChange={(value) => { setDifficulty(value); setDifficultyTouched(true); }} />
            </div>
            <PuzzleContentFields kind={kind} values={values}
              onChange={setValues}
              onRandomTarget={() => setValues({ ...values, targetWord: randomTarget(5) })} />
            <div className="mt-5 flex flex-wrap gap-2">
              <PrimaryButton type="submit" disabled={busy} className="px-5 py-2.5">{busy ? "Saving…" : editing ? "Save changes" : "Save to storage"}</PrimaryButton>
              <button type="button" onClick={cancelForm} className="rounded-md border border-white/60 px-4 py-2.5 font-semibold hover:bg-white/10">Cancel</button>
            </div>
          </form>
          <h4 className="mt-7 text-base font-semibold">Player preview</h4>
          <div className="mt-3 rounded-xl border border-white/20 bg-black/[0.04] p-4"><PuzzlePreview form={draftForm} /></div>
        </>}
      </div>
      </div>
    </div>}
  </section>;
}

function Dropdown({ label, value, options, onChange, className = "" }: {
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
      className="absolute left-0 right-0 z-10 mt-1 max-h-60 overflow-y-auto rounded-lg border border-white/25 bg-surface-solid p-1 shadow-lg">
      {options.map(([optionValue, text], index) => <li key={optionValue} role="option" aria-selected={optionValue === value}
        onMouseEnter={() => setHighlight(index)} onClick={() => choose(index)}
        className={`flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm ${index === highlight ? "bg-black/[0.07]" : ""}`}>
        <span>{text}</span>
        {optionValue === value && <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 10 4 4 8-8" /></svg>}
      </li>)}
    </ul>}
  </div>;
}

function FilterMenu({ type, status, difficulty, onType, onStatus, onDifficulty, onClear }: {
  type: Filter["type"]; status: Filter["status"]; difficulty: string;
  onType: (value: Filter["type"]) => void; onStatus: (value: Filter["status"]) => void;
  onDifficulty: (value: string) => void; onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const active = [type, status, difficulty].filter(Boolean).length;
  return <div ref={ref} className="relative">
    <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
      className="inline-flex h-11 items-center gap-2 rounded-md border border-white/40 bg-black/[0.04] px-4 text-sm font-semibold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white">
      <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M3 5h14M3 10h14M3 15h14" /><circle cx="7" cy="5" r="1.8" fill="var(--color-surface-solid)" /><circle cx="13" cy="10" r="1.8" fill="var(--color-surface-solid)" /><circle cx="6" cy="15" r="1.8" fill="var(--color-surface-solid)" />
      </svg>
      Filter{active > 0 && <span className="rounded-full bg-black px-1.5 text-xs text-[#ffffff]">{active}</span>}
    </button>
    {open && <div role="dialog" aria-label="Filter puzzles" className="absolute right-0 z-30 mt-2 w-64 rounded-lg border border-white/25 bg-surface-solid p-4 shadow-lg">
      <Dropdown label="Puzzle type" value={type} onChange={(next) => onType(next as Filter["type"])}
        options={[["", "All types"], ["riddle", "Riddles"], ["character_puzzle", "Letter games"]]} />
      <Dropdown className="mt-3" label="Status" value={status} onChange={(next) => onStatus(next as Filter["status"])}
        options={[["", "Any status"], ["active", "Active"], ["retired", "Retired"]]} />
      <Dropdown className="mt-3" label="Difficulty" value={difficulty} onChange={onDifficulty}
        options={[["", "Any difficulty"], ...DIFFICULTIES.map((value): [string, string] => [value, value[0].toUpperCase() + value.slice(1)])]} />
      {active > 0 && <button type="button" onClick={onClear} className="mt-4 text-sm font-semibold underline">Clear filters</button>}
    </div>}
  </div>;
}

const pill = "inline-block rounded-md px-2 py-0.5 text-xs font-semibold text-[#ffffff]";

function StatusPill({ status }: { status: BankPuzzle["status"] }) {
  return <span className={`${pill} ${status === "active" ? "bg-[#16a34a]" : "bg-[#c00000]"}`}>{status === "active" ? "Active" : "Retired"}</span>;
}

function PuzzleTable({ puzzles, total, matching, page, pageCount, onPage, onOpen }: {
  puzzles: BankPuzzle[] | null; total: number; matching: number; page: number; pageCount: number; onPage: (page: number) => void;
  onOpen: (puzzle: BankPuzzle) => void;
}) {
  if (puzzles === null) return <p className="text-sm text-white/60">Loading puzzles…</p>;
  if (puzzles.length === 0) {
    return <p className="rounded-xl border border-dashed border-white/25 px-4 py-10 text-center text-sm text-white/55">
      {total === 0 ? "No puzzles match these filters. Add one to get started." : "No puzzles match your search."}
    </p>;
  }
  const first = (page - 1) * PAGE_SIZE + 1;
  const th = "bg-black/[0.06] px-3 py-2.5 text-left text-sm font-semibold";
  return <div>
    <div className="overflow-x-auto rounded-xl border border-white/25 p-2">
      <table className="w-full min-w-[34rem] border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Stored puzzles. Select a row to preview it.</caption>
        <thead><tr>
          <th scope="col" className={`${th} w-1/2 rounded-l-lg`}>Puzzle</th>
          <th scope="col" className={`${th} hidden sm:table-cell`}>Type</th>
          <th scope="col" className={th}>Difficulty</th>
          <th scope="col" className={th}>Status</th>
          <th scope="col" className={`${th} text-right`}>Used</th>
          <th scope="col" className={`${th} hidden rounded-r-lg text-right sm:table-cell`}>Solve rate</th>
        </tr></thead>
        <tbody>
          {puzzles.map((puzzle) => <tr key={puzzle.id} onClick={() => onOpen(puzzle)}
            className="group cursor-pointer">
            <td className="border-b border-white/15 group-last:border-0 group-hover:bg-white/[0.08] first:rounded-l-lg last:rounded-r-lg max-w-0 px-3 py-4">
              <button type="button" onClick={(event) => { event.stopPropagation(); onOpen(puzzle); }}
                className="block w-full truncate text-left focus-visible:outline-2 focus-visible:outline-white">{puzzleName(puzzle)}</button>
            </td>
            <td className="border-b border-white/15 group-last:border-0 group-hover:bg-white/[0.08] first:rounded-l-lg last:rounded-r-lg hidden px-3 py-4 sm:table-cell">{kindLabel(puzzle.type)}</td>
            <td className="border-b border-white/15 group-last:border-0 group-hover:bg-white/[0.08] first:rounded-l-lg last:rounded-r-lg px-3 py-4 font-semibold capitalize" style={{ color: difficultyColor(puzzle.difficulty) }}>{puzzle.difficulty}</td>
            <td className="border-b border-white/15 group-last:border-0 group-hover:bg-white/[0.08] first:rounded-l-lg last:rounded-r-lg px-3 py-4"><StatusPill status={puzzle.status} /></td>
            <td className="border-b border-white/15 group-last:border-0 group-hover:bg-white/[0.08] first:rounded-l-lg last:rounded-r-lg px-3 py-4 text-right tabular-nums">{puzzle.timesUsed === 0 ? "-" : `${puzzle.timesUsed}×`}</td>
            <td className="border-b border-white/15 group-last:border-0 group-hover:bg-white/[0.08] first:rounded-l-lg last:rounded-r-lg hidden px-3 py-4 text-right tabular-nums sm:table-cell">{formatSolveRate(puzzle.stats.solveRate)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-white/65">
      <p>Showing {first}-{first + puzzles.length - 1} of {matching}</p>
      <div className="flex items-center gap-2">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}
          className="rounded-md border border-white/30 px-3 py-1.5 font-semibold hover:bg-white/10 disabled:opacity-40">Previous</button>
        <span>Page {page} of {pageCount}</span>
        <button type="button" disabled={page >= pageCount} onClick={() => onPage(page + 1)}
          className="rounded-md border border-white/30 px-3 py-1.5 font-semibold text-white hover:bg-white/10 disabled:opacity-40">Next</button>
      </div>
    </div>
  </div>;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div><dt className="text-xs uppercase tracking-wide text-white/55">{label}</dt><dd className="text-lg font-semibold tabular-nums">{value}</dd></div>;
}

function PuzzleDetails({ puzzle, busy, onEdit, onToggleStatus, onRename, onDelete }: {
  puzzle: BankPuzzle; busy: boolean; onEdit: () => void; onToggleStatus: () => void; onRename: (name: string) => void; onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [nameDraft, setNameDraft] = useState(puzzle.name ?? "");
  const renamed = nameDraft.trim() !== (puzzle.name ?? "");
  const unused = puzzle.timesUsed === 0;
  const { stats } = puzzle;
  const fill = "rounded-md bg-black px-3.5 py-2 text-sm font-semibold text-[#ffffff] hover:opacity-85 disabled:opacity-50";
  const label = "text-white/60";
  return <div className="mt-4">
    <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (renamed) onRename(nameDraft.trim()); }}>
      <label className="min-w-[12rem] flex-1 text-sm"><span className="sr-only">Name</span>
        <input value={nameDraft} maxLength={MAX_NAME_LENGTH} onChange={(event) => setNameDraft(event.target.value)} placeholder="No name set"
          className="h-10 w-full rounded-md border border-white/40 bg-black/[0.04] px-3 text-white placeholder:text-white/45 focus:outline-2 focus:outline-white" />
      </label>
      <button type="submit" disabled={busy || !renamed}
        className="h-10 rounded-md border border-white/60 px-3 text-sm font-semibold hover:bg-white/10 disabled:opacity-40">Save name</button>
    </form>
    <dl className="mt-4 space-y-1.5 text-sm">
      <div className="flex gap-2"><dt className={label}>Type:</dt><dd>{kindLabel(puzzle.type)}</dd></div>
      <div className="flex gap-2"><dt className={label}>Difficulty:</dt><dd className="font-semibold capitalize" style={{ color: difficultyColor(puzzle.difficulty) }}>{puzzle.difficulty}</dd></div>
      <div className="flex items-center gap-2"><dt className={label}>Status:</dt><dd><StatusPill status={puzzle.status} /></dd></div>
      <div className="flex gap-2"><dt className={label}>Accepted:</dt><dd className="break-words">{puzzle.acceptedAnswers.join(", ")}</dd></div>
    </dl>
    <div className="mt-4 flex flex-wrap gap-2">
      {unused && <button type="button" disabled={busy} onClick={onEdit} className={fill}>Edit</button>}
      <button type="button" disabled={busy} onClick={onToggleStatus} className={fill}>{puzzle.status === "active" ? "Retire" : "Restore"}</button>
      {unused && !confirmDelete && <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)} className="rounded-md bg-[#e00000] px-3.5 py-2 text-sm font-semibold text-[#ffffff] hover:opacity-85 disabled:opacity-50">Delete</button>}
      {unused && confirmDelete && <button type="button" disabled={busy} onClick={onDelete} className="rounded-md bg-[#a00000] px-3.5 py-2 text-sm font-semibold text-[#ffffff] disabled:opacity-50">Delete permanently</button>}
    </div>
    {!unused && <p className="mt-2 text-xs text-white/55">Scheduled puzzles can&apos;t be edited or deleted; retire one to stop it being picked.</p>}
    <h4 className="mt-7 text-base font-semibold">Statistics</h4>
    <dl className="mt-3 grid grid-cols-2 gap-4 rounded-xl border border-white/20 bg-black/[0.04] p-4 sm:grid-cols-4" aria-label="Puzzle statistics">
      <Stat label="Days used" value={stats.daysUsed} />
      <Stat label="Assigned" value={stats.assigned} />
      <Stat label="Started" value={stats.started} />
      <Stat label="Solved" value={stats.solved} />
      <Stat label="Solve rate" value={formatSolveRate(stats.solveRate)} />
      <Stat label="Median time" value={formatMedianSeconds(stats.medianSolveSeconds)} />
      <Stat label="Avg attempts" value={stats.averageAttempts === null ? "-" : stats.averageAttempts.toFixed(1)} />
      <Stat label="Missed games" value={stats.missed} />
    </dl>
  </div>;
}
