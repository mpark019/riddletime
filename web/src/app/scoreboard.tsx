"use client";

import { useEffect, useRef, useState } from "react";
import type { LeaderboardEntry } from "@/server/points/points";

type PointTransaction = {
  id: string;
  user_id: string;
  display_name: string | null;
  amount: number;
  kind: string;
  reason: string;
  created_at: string;
};

type PointsDeskTab = "adjustment" | "audit";

const number = new Intl.NumberFormat();

export function Scoreboard({ initialEntries }: { initialEntries: LeaderboardEntry[] }) {
  const entries = initialEntries;

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-8 sm:py-12">
      {entries.length === 0 ? (
        <div className="border border-white/80 bg-black/10 px-6 py-14 text-center">
          <p className="font-semibold">No players yet.</p>
          <p className="mt-1 text-sm text-white/70">Players will appear here once they join.</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-white/80 bg-black/10">
          <table className="w-full text-left sm:min-w-[640px]">
            <thead className="border-b border-white/50 text-xs font-semibold uppercase tracking-[0.12em] text-white/70">
              <tr>
                <th className="w-3/4 px-4 py-3 sm:w-auto sm:px-6">Player</th>
                <th className="w-1/4 px-4 py-3 text-right sm:w-auto">Points</th>
                <th className="hidden px-4 py-3 text-right sm:table-cell">Riddles correct</th>
                <th className="hidden px-4 py-3 text-right sm:table-cell sm:px-6">Riddles incorrect</th>
              </tr>
            </thead>
            <tbody>{entries.map((entry) => <LeaderboardRow key={entry.userId} entry={entry} />)}</tbody>
          </table>
        </div>
      )}

    </section>
  );
}

function LeaderboardRow({ entry }: { entry: LeaderboardEntry }) {
  return (
    <tr className="border-b border-white/50 last:border-0">
      <td className="px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="w-5 shrink-0 text-sm tabular-nums text-white/70" aria-label={`Rank ${entry.rank}`}>{entry.rank}</span>
          {entry.avatarUrl ? (
            // Avatar URLs are validated server-side and are public leaderboard data.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={entry.avatarUrl} alt="" className="h-10 w-10 shrink-0 rounded-full border border-white/80 object-cover" />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/80 text-sm font-semibold" aria-hidden="true">{entry.displayName.slice(0, 1).toUpperCase()}</span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-base font-medium text-white">{entry.displayName}</span>
            {entry.name && <span className="block truncate text-sm text-white/70">{entry.name}</span>}
          </span>
        </div>
      </td>
      <td className="px-4 py-4 text-right text-lg font-semibold tabular-nums text-white">{number.format(entry.totalPoints)}</td>
      <td className="hidden px-4 py-4 text-right text-lg tabular-nums text-white sm:table-cell">{number.format(entry.correctRiddles)}</td>
      <td className="hidden px-4 py-4 text-right text-lg tabular-nums text-white sm:table-cell sm:px-6">{number.format(entry.incorrectRiddles)}</td>
    </tr>
  );
}

export function PointsDesk({ players, onChanged, refreshVersion = 0 }: { players: LeaderboardEntry[]; onChanged: () => Promise<void>; refreshVersion?: number }) {
  const [tab, setTab] = useState<PointsDeskTab>("adjustment");
  const [auditRefreshVersion, setAuditRefreshVersion] = useState(0);

  async function handlePointsChanged() {
    setAuditRefreshVersion((version) => version + 1);
    await onChanged();
  }

  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8 sm:py-12" aria-labelledby="points-desk-title">
      <div className="border border-white/80 bg-black/10">
        <header className="border-b border-white/60 px-5 py-5 sm:px-7">
          <h2 id="points-desk-title" className="text-2xl font-semibold">Points</h2>
        </header>
        <div className="px-5 pt-5 sm:px-7">
          <div className="inline-flex border border-white/80" role="tablist" aria-label="Points sections">
            <TabButton active={tab === "adjustment"} onClick={() => setTab("adjustment")}>Adjustment</TabButton>
            <TabButton active={tab === "audit"} onClick={() => setTab("audit")}>Audit trail</TabButton>
          </div>
        </div>
        <div className="p-5 sm:p-7">
          <div hidden={tab !== "adjustment"}><AdjustmentForm players={players} onChanged={handlePointsChanged} /></div>
          <div hidden={tab !== "audit"}><AuditTrail onChanged={handlePointsChanged} refreshVersion={auditRefreshVersion + refreshVersion} /></div>
        </div>
      </div>
    </section>
  );
}

function TabButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`px-3 py-2 text-sm font-semibold transition ${active ? "bg-white text-[#4169e1]" : "text-white hover:bg-white/15"}`}>{children}</button>;
}

function AdjustmentForm({ players, onChanged }: { players: LeaderboardEntry[]; onChanged: () => Promise<void> }) {
  const [userId, setUserId] = useState(players[0]?.userId ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationKey = useRef<string | null>(null);
  const selectedPlayer = players.find((player) => player.userId === userId);

  function changeField(callback: () => void) {
    operationKey.current = null;
    callback();
  }

  async function addAdjustment(event: React.FormEvent) {
    event.preventDefault();
    const parsedAmount = Number(amount);
    if (!userId || !Number.isInteger(parsedAmount) || parsedAmount === 0) {
      setError("Choose a player and enter a non-zero whole-number adjustment.");
      return;
    }
    setBusy(true);
    setError(null);
    operationKey.current ??= crypto.randomUUID();
    let saved = false;
    try {
      const response = await fetch("/api/admin/point-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, amount: parsedAmount, ...(reason.trim() && { reason }), operation_key: operationKey.current }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? "Could not save this adjustment. Change a field to start a new request.");
        return;
      }
      saved = true;
    } catch {
      setError("Could not save this adjustment. You can retry safely.");
    } finally {
      setBusy(false);
    }
    if (!saved) return;
    operationKey.current = null;
    setAmount("");
    setReason("");
    try {
      await onChanged();
    } catch {
      setError("Adjustment was saved, but the standings could not be refreshed.");
    }
  }

  return (
    <form noValidate onSubmit={addAdjustment} className="flex flex-col gap-5">
      <div><h3 className="text-lg font-semibold">Make an adjustment</h3></div>
      <label className="flex flex-col gap-2 text-sm font-semibold text-white">Player
        <div className="relative">
          <button type="button" onClick={() => setPickerOpen((open) => !open)} aria-expanded={pickerOpen} aria-haspopup="listbox" className="flex w-full items-center justify-between border border-white/80 bg-black/10 px-4 py-3 text-left font-medium text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"><span>{selectedPlayer?.displayName ?? "Choose a player"}</span><span aria-hidden="true">⌄</span></button>
          {pickerOpen && <div role="listbox" aria-label="Players" className="absolute z-10 mt-2 max-h-56 w-full overflow-y-auto border border-white bg-[#4169e1] p-1">{players.map((player) => <button key={player.userId} type="button" role="option" aria-selected={player.userId === userId} onClick={() => changeField(() => { setUserId(player.userId); setPickerOpen(false); })} className={`flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-medium transition ${player.userId === userId ? "bg-white text-[#4169e1]" : "text-white hover:bg-white/15"}`}><span>{player.displayName}</span>{player.userId === userId && <span aria-hidden="true">✓</span>}</button>)}</div>}
        </div>
      </label>
      <div className="grid gap-5 sm:grid-cols-[0.7fr_1.3fr]">
        <label className="flex flex-col gap-2 text-sm font-semibold text-white">Adjustment<input type="number" inputMode="numeric" step="1" value={amount} onChange={(event) => changeField(() => setAmount(event.target.value))} placeholder="-5, -25, +50, etc..." className="number-field border border-white/80 bg-black/10 px-4 py-3 font-medium tabular-nums text-white placeholder:text-white/50 focus:outline-2 focus:outline-white" /></label>
        <label className="flex flex-col gap-2 text-sm font-semibold text-white">Reason (optional)<input value={reason} onChange={(event) => changeField(() => setReason(event.target.value))} placeholder="wha happen" className="border border-white/80 bg-black/10 px-4 py-3 text-white placeholder:text-white/50 focus:outline-2 focus:outline-white" /></label>
      </div>
      {error && <p role="alert" className="border border-white bg-black/15 px-4 py-3 text-sm text-white">{error}</p>}
      <button type="submit" disabled={busy || players.length === 0} className="w-full border border-white bg-white px-4 py-3 font-semibold text-[#4169e1] transition hover:bg-transparent hover:text-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-fit">{busy ? "Saving adjustment..." : "Save adjustment"}</button>
    </form>
  );
}

function AuditTrail({ onChanged, refreshVersion }: { onChanged: () => Promise<void>; refreshVersion: number }) {
  const [transactions, setTransactions] = useState<PointTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] = useState<PointTransaction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    fetch("/api/admin/point-transactions", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<PointTransaction[]>;
      })
      .then((result) => {
        if (current) setTransactions(result);
      })
      .catch(() => {
        if (current) setError("Could not load the audit trail.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [refreshVersion]);

  async function removeTransaction() {
    if (!pendingDeletion) return;
    const transaction = pendingDeletion;
    setBusyId(transaction.id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/point-transactions/${transaction.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? "Could not delete this point transaction.");
        return;
      }
      setPendingDeletion(null);
      await onChanged();
    } catch {
      setError("Could not delete this point transaction.");
    } finally {
      setBusyId(null);
    }
  }

  return <div className="flex flex-col gap-4">
    <div><h3 className="text-lg font-semibold">Audit trail</h3></div>
    {error && <p role="alert" className="border border-white bg-black/15 px-4 py-3 text-sm text-white">{error}</p>}
    {loading ? <p className="border border-white/80 bg-black/10 px-4 py-6 text-sm text-white/75">Loading point history...</p> : transactions.length === 0 ? <p className="border border-white/80 bg-black/10 px-4 py-6 text-sm text-white/75">No point events yet.</p> : <ul className="border border-white/80">{transactions.map((transaction) => <li key={transaction.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/50 bg-black/10 px-4 py-3 last:border-0"><div className="min-w-32 flex-1"><p className="font-semibold text-white">{transaction.display_name ?? transaction.user_id}</p><p className="text-xs text-white/65">{new Date(transaction.created_at).toLocaleString()}</p></div><p className="max-w-full truncate text-sm text-white/80">{transaction.reason}</p><span className="border border-white/80 px-2.5 py-1 text-sm font-semibold tabular-nums text-white">{transaction.amount > 0 ? "+" : ""}{number.format(transaction.amount)}</span><button type="button" disabled={busyId !== null} onClick={() => setPendingDeletion(transaction)} className="text-xs font-semibold uppercase tracking-wide text-white underline-offset-4 hover:underline disabled:opacity-50">Delete</button></li>)}</ul>}
    {pendingDeletion && <ConfirmationDialog transaction={pendingDeletion} busy={busyId === pendingDeletion.id} onCancel={() => setPendingDeletion(null)} onConfirm={removeTransaction} />}
  </div>;
}

function ConfirmationDialog({ transaction, busy, onCancel, onConfirm }: { transaction: PointTransaction; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-5" role="presentation"><section role="alertdialog" aria-modal="true" aria-labelledby="delete-transaction-title" className="w-full max-w-md border border-white bg-[#4169e1] p-6"><h4 id="delete-transaction-title" className="text-xl font-semibold">Delete this point event?</h4><p className="mt-2 text-sm leading-6 text-white/80">This removes the {transaction.amount > 0 ? "+" : ""}{number.format(transaction.amount)} entry for {transaction.display_name ?? "this player"}. It cannot be undone.</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onCancel} disabled={busy} className="border border-white/80 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/15 disabled:opacity-50">Keep it</button><button type="button" onClick={onConfirm} disabled={busy} className="border border-white bg-white px-4 py-2.5 text-sm font-semibold text-[#4169e1] disabled:opacity-50">{busy ? "Deleting..." : "Delete event"}</button></div></section></div>;
}
