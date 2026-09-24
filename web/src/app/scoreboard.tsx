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

const number = new Intl.NumberFormat();

export function Scoreboard({ initialEntries, isAdmin }: { initialEntries: LeaderboardEntry[]; isAdmin: boolean }) {
  const [entries, setEntries] = useState(initialEntries);

  async function refreshLeaderboard() {
    const response = await fetch("/api/leaderboard", { cache: "no-store" });
    if (response.ok) setEntries(await response.json());
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-10">
      <div>
        <h1 className="text-3xl">Scoreboard</h1>
        <p className="mt-1 text-sm text-white/70">Points only. Tied totals share a rank.</p>
      </div>
      <ol className="overflow-hidden rounded border border-white/20">
        {entries.length === 0 ? (
          <li className="px-5 py-6 text-white/70">No players yet.</li>
        ) : (
          entries.map((entry) => (
            <li key={entry.userId} className="flex items-center gap-4 border-b border-white/15 px-5 py-4 last:border-0">
              <span className="w-7 text-white/60">{entry.rank}</span>
              {entry.avatarUrl ? (
                // Avatar URLs are validated server-side and are public leaderboard data.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={entry.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" />
              ) : (
                <span className="h-9 w-9 rounded-full bg-white/15" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.displayName}</span>
              <span className="tabular-nums">{number.format(entry.totalPoints)}</span>
            </li>
          ))
        )}
      </ol>
      {isAdmin && <PointTransactionAdmin players={entries} onChanged={refreshLeaderboard} />}
    </section>
  );
}

function PointTransactionAdmin({ players, onChanged }: { players: LeaderboardEntry[]; onChanged: () => Promise<void> }) {
  const [transactions, setTransactions] = useState<PointTransaction[]>([]);
  const [userId, setUserId] = useState(players[0]?.userId ?? "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationKey = useRef<string | null>(null);

  async function loadTransactions(): Promise<PointTransaction[]> {
    const response = await fetch("/api/admin/point-transactions", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load point transactions.");
    return response.json();
  }

  async function refreshTransactions() {
    try {
      setTransactions(await loadTransactions());
      return true;
    } catch {
      setError("Could not load point transactions.");
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let current = true;
    loadTransactions()
      .then((result) => {
        if (current) setTransactions(result);
      })
      .catch(() => {
        if (current) setError("Could not load point transactions.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);

  async function addAdjustment(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    operationKey.current ??= crypto.randomUUID();
    let saved = false;
    try {
      const response = await fetch("/api/admin/point-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          amount: Number(amount),
          reason,
          operation_key: operationKey.current,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? "Could not create adjustment. Change a field to start a new request.");
        return;
      }
      saved = true;
    } catch {
      setError("Could not create adjustment. You can retry safely.");
    } finally {
      setBusy(false);
    }
    if (!saved) return;

    operationKey.current = null;
    setAmount("");
    setReason("");
    const [transactionsRefreshed, leaderboardRefreshed] = await Promise.all([
      refreshTransactions(),
      onChanged().then(() => true).catch(() => false),
    ]);
    if (!transactionsRefreshed || !leaderboardRefreshed) {
      setError("Adjustment was saved, but one or more views could not be refreshed.");
    }
  }

  async function removeTransaction(id: string) {
    if (!window.confirm("Delete this point transaction? This cannot be undone.")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/point-transactions/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? "Could not delete point transaction.");
        return;
      }
      const [transactionsRefreshed, leaderboardRefreshed] = await Promise.all([
        refreshTransactions(),
        onChanged().then(() => true).catch(() => false),
      ]);
      if (!transactionsRefreshed || !leaderboardRefreshed) {
        setError("Transaction was deleted, but one or more views could not be refreshed.");
      }
    } catch {
      setError("Could not delete point transaction.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-5 rounded border border-white/20 p-5">
      <div>
        <h2 className="text-xl">Point transactions</h2>
        <p className="mt-1 text-sm text-white/70">Corrections create a new signed entry; existing entries cannot be edited.</p>
      </div>
      <form onSubmit={addAdjustment} className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          Player
          <select value={userId} onChange={(event) => { operationKey.current = null; setUserId(event.target.value); }} required className="rounded border border-white/20 bg-transparent px-3 py-2">
            {players.map((player) => <option key={player.userId} value={player.userId} className="bg-blue-700">{player.displayName}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Adjustment
          <input type="number" step="1" required value={amount} onChange={(event) => { operationKey.current = null; setAmount(event.target.value); }} className="rounded border border-white/20 bg-transparent px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          Reason
          <input required value={reason} onChange={(event) => { operationKey.current = null; setReason(event.target.value); }} className="rounded border border-white/20 bg-transparent px-3 py-2" />
        </label>
        <button type="submit" disabled={busy || !userId} className="w-fit rounded bg-white px-4 py-2 text-black disabled:opacity-50">Add adjustment</button>
      </form>
      {error && <p className="text-sm text-red-200">{error}</p>}
      <div className="overflow-x-auto">
        {loading ? <p className="text-sm text-white/70">Loading transactions...</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-white/60"><tr><th className="pb-2">Player</th><th className="pb-2">Kind</th><th className="pb-2">Amount</th><th className="pb-2">Reason</th><th className="pb-2">Created</th><th className="pb-2" /></tr></thead>
            <tbody>{transactions.map((transaction) => (
              <tr key={transaction.id} className="border-t border-white/15">
                <td className="py-2 pr-3">{transaction.display_name ?? transaction.user_id}</td>
                <td className="py-2 pr-3">{transaction.kind}</td>
                <td className="py-2 pr-3 tabular-nums">{number.format(transaction.amount)}</td>
                <td className="py-2 pr-3">{transaction.reason}</td>
                <td className="py-2 pr-3 whitespace-nowrap">{new Date(transaction.created_at).toLocaleString()}</td>
                <td className="py-2 text-right"><button type="button" disabled={busy} onClick={() => removeTransaction(transaction.id)} className="text-red-200 disabled:opacity-50">Delete</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}
