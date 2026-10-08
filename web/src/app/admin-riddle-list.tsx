"use client";

import { useCallback, useEffect, useState } from "react";
import type { ScheduledRiddle } from "@/server/schedules/schedules";
import { AdminRiddleDetail } from "./admin-riddle-detail";

const timingStyles: Record<ScheduledRiddle["timing"], string> = {
  today: "border-emerald-300/70 text-emerald-200",
  upcoming: "border-sky-300/70 text-sky-200",
  past: "border-white/30 text-white/60",
};

export function AdminRiddleList({ refreshVersion, appTimezone }: { refreshVersion: number; appTimezone: string }) {
  const [riddles, setRiddles] = useState<ScheduledRiddle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduledRiddle | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/challenges", { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as { schedules?: ScheduledRiddle[]; error?: string };
    if (!response.ok || !body.schedules) throw new Error(body.error ?? "Could not load scheduled riddles.");
    setRiddles(body.schedules);
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void load().catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Could not load scheduled riddles.");
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, refreshVersion]);

  async function remove(riddle: ScheduledRiddle) {
    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/challenges/${riddle.id}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not delete this riddle.");
        return;
      }
      setPendingDelete(null);
      setOpenId(null);
      setNotice(`Deleted the riddle for ${riddle.activeDate}.`);
      await load();
    } catch {
      setError("Could not confirm the deletion. Refresh the list to check.");
    } finally {
      setDeleting(false);
    }
  }

  return <section aria-label="Scheduled riddles">
    <div aria-live="polite" className="space-y-2">
      {error && <p role="alert" className="rounded-md border border-red-300/60 bg-red-950/45 px-4 py-3 text-sm text-red-100">{error}</p>}
      {notice && <p className="rounded-md border border-emerald-300/60 bg-emerald-950/45 px-4 py-3 text-sm text-emerald-100">{notice}</p>}
    </div>
    {openId
      ? <AdminRiddleDetail scheduleId={openId} appTimezone={appTimezone} deleting={deleting} onBack={() => { setOpenId(null); setNotice(null); void load().catch(() => undefined); }} onDelete={setPendingDelete} />
      : riddles === null
        ? !error && <p className="mt-4 text-white/60">Loading scheduled riddles…</p>
        : riddles.length === 0
          ? <p className="mt-4 rounded-md border border-dashed border-white/25 px-4 py-6 text-center text-sm text-white/55">No riddles scheduled yet.</p>
          : <ul className="mt-4 space-y-2">{riddles.map((riddle) => <RiddleRow key={riddle.id} riddle={riddle} onOpen={() => { setNotice(null); setOpenId(riddle.id); }} />)}</ul>}
    {pendingDelete && <DeleteRiddleDialog riddle={pendingDelete} busy={deleting} onCancel={() => setPendingDelete(null)} onConfirm={() => void remove(pendingDelete)} />}
  </section>;
}

function riddleTypeLabel(type: string | null): string {
  if (type === "riddle") return "Riddle";
  if (type === "character_puzzle") return "Letter game";
  return "No puzzle";
}

function RiddleRow({ riddle, onOpen }: { riddle: ScheduledRiddle; onOpen: () => void }) {
  return <li>
    <button type="button" onClick={onOpen} className="flex w-full items-center justify-between gap-3 rounded-md border border-white/25 bg-black/[0.04] px-4 py-3.5 text-left transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white sm:px-5">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold tabular-nums">{riddle.activeDate}</span>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${timingStyles[riddle.timing]}`}>{riddle.timing}</span>
        <span className="text-sm text-white/65">{riddleTypeLabel(riddle.type)}</span>
      </span>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-white/55"><path d="m9 18 6-6-6-6" /></svg>
    </button>
  </li>;
}

function DeleteRiddleDialog({ riddle, busy, onCancel, onConfirm }: { riddle: ScheduledRiddle; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const played = riddle.startedCount > 0;
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4" role="presentation">
    <section role="alertdialog" aria-modal="true" aria-labelledby="delete-riddle-title" aria-describedby="delete-riddle-description" className="w-full max-w-md rounded-md border border-red-200/80 bg-surface-solid p-6 shadow-2xl">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-red-800">Permanent action</p>
      <h4 id="delete-riddle-title" className="mt-2 text-2xl font-semibold">Delete the riddle for {riddle.activeDate}?</h4>
      <p id="delete-riddle-description" className="mt-3 text-white">
        {played
          ? `This removes the riddle, ${riddle.startedCount} ${riddle.startedCount === 1 ? "player's game" : "players' games"}, and every point those games earned or deducted. Scores change as if it never existed. It cannot be undone.`
          : "This removes the riddle. Nobody has played it yet. It cannot be undone."}
      </p>
      <div className="mt-6 flex justify-end gap-3">
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-md border border-white/80 px-4 py-2 font-semibold hover:bg-white/10 disabled:opacity-50">Cancel</button>
        <button type="button" onClick={onConfirm} disabled={busy} className="rounded-md border border-[#c00000] bg-[#f00000] px-4 py-2 font-semibold text-on-fill transition hover:bg-[#d60000] disabled:opacity-50">{busy ? "Deleting…" : "Delete permanently"}</button>
      </div>
    </section>
  </div>;
}
