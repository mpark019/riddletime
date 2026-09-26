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
    <section className="mx-auto w-full max-w-[1280px] lg:px-10 lg:py-10" aria-labelledby="points-desk-title">
      <div className="flex min-h-[calc(100svh-5rem)] flex-col bg-black/10 lg:min-h-[800px] lg:border lg:border-white/50">
        <header className="flex items-center justify-between gap-3 px-5 pb-3 pt-4 lg:border-b lg:border-white/50 lg:px-10 lg:py-6">
          <h2 id="points-desk-title" className="text-[26px] font-semibold tracking-tight lg:text-[34px]">Points</h2>
          <div className="inline-flex border border-white/80" role="tablist" aria-label="Points sections">
            <TabButton active={tab === "adjustment"} onClick={() => setTab("adjustment")}>Adjustment</TabButton>
            <TabButton active={tab === "audit"} onClick={() => setTab("audit")}>Audit trail</TabButton>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 w-full flex-1" hidden={tab !== "adjustment"}><AdjustmentForm players={players} onChanged={handlePointsChanged} /></div>
          <div className="w-full p-5 lg:p-10" hidden={tab !== "audit"}><AuditTrail onChanged={handlePointsChanged} refreshVersion={auditRefreshVersion + refreshVersion} /></div>
        </div>
      </div>
    </section>
  );
}

function TabButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`h-9 px-3 text-sm font-semibold transition lg:h-11 lg:px-5 lg:text-base ${active ? "bg-white text-[#2F4BBE]" : "text-white hover:bg-white/15"}`}>{children === "Adjustment" ? <><span className="lg:hidden">Adjust</span><span className="hidden lg:inline">Adjustment</span></> : children}</button>;
}

type RecentAdjustment = {
  key: string;
  userIds: string[];
  who: string;
  delta: number;
  reason: string;
  undoOperationKey: string;
  undone: boolean;
};

function AdjustmentForm({ players, onChanged }: { players: LeaderboardEntry[]; onChanged: () => Promise<void> }) {
  const [playerQuery, setPlayerQuery] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [amount, setAmount] = useState(5);
  const [customAmount, setCustomAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [undoBusyKey, setUndoBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentAdjustments, setRecentAdjustments] = useState<RecentAdjustment[]>([]);
  const operationKey = useRef<string | null>(null);
  const effectiveAmount = customAmount === "" ? amount : Number(customAmount);
  const matchingPlayers = players.filter((player) => {
    const query = playerQuery.trim().toLocaleLowerCase();
    return !query || player.displayName.toLocaleLowerCase().includes(query) || player.name?.toLocaleLowerCase().includes(query);
  });

  function changeField(callback: () => void) {
    operationKey.current = null;
    callback();
  }

  function togglePlayer(userId: string) {
    changeField(() => setSelectedUserIds((selected) => selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId]));
  }

  function toggleAllPlayers() {
    changeField(() => setSelectedUserIds((selected) => {
      if (selected.length === players.length) return [];
      return Array.from(new Set([...selected, ...matchingPlayers.map((player) => player.userId)]));
    }));
  }

  async function saveAdjustment(direction: 1 | -1) {
    const parsedAmount = effectiveAmount;
    if (selectedUserIds.length === 0 || !Number.isInteger(parsedAmount) || parsedAmount <= 0) {
      setError("Select at least one player and enter a positive whole-number amount.");
      return;
    }
    setBusy(true);
    setError(null);
    operationKey.current ??= crypto.randomUUID();
    const savedUserIds = [...selectedUserIds];
    const savedReason = reason.trim();
    const savedOperationKey = operationKey.current;
    let saved = false;
    try {
      const response = await fetch("/api/admin/point-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedUserIds.length === players.length
          ? { scope: "all_players", amount: direction * parsedAmount, ...(savedReason && { reason: savedReason }), operation_key: operationKey.current }
          : selectedUserIds.length === 1
            ? { user_id: selectedUserIds[0], amount: direction * parsedAmount, ...(savedReason && { reason: savedReason }), operation_key: operationKey.current }
            : { user_ids: selectedUserIds, amount: direction * parsedAmount, ...(savedReason && { reason: savedReason }), operation_key: operationKey.current }),
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
    setReason("");
    const selectedNames = players.filter((player) => savedUserIds.includes(player.userId)).map((player) => player.displayName);
    const who = savedUserIds.length === players.length
      ? "everyone"
      : selectedNames.length <= 3
        ? selectedNames.join(", ")
        : `${selectedNames.length} players`;
    setRecentAdjustments((entries) => [{
      key: savedOperationKey,
      userIds: savedUserIds,
      who,
      delta: direction * parsedAmount,
      reason: savedReason || "Manual adjustment",
      undoOperationKey: crypto.randomUUID(),
      undone: false,
    }, ...entries].slice(0, 4));
    try {
      await onChanged();
    } catch {
      setError("Adjustment was saved, but the standings could not be refreshed.");
    }
  }

  async function undoAdjustment(adjustment: RecentAdjustment) {
    setUndoBusyKey(adjustment.key);
    setError(null);
    try {
      const response = await fetch("/api/admin/point-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(adjustment.userIds.length === 1
          ? { user_id: adjustment.userIds[0], amount: -adjustment.delta, reason: `Undo: ${adjustment.reason}`, operation_key: adjustment.undoOperationKey }
          : { user_ids: adjustment.userIds, amount: -adjustment.delta, reason: `Undo: ${adjustment.reason}`, operation_key: adjustment.undoOperationKey }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? "Could not undo this adjustment.");
        return;
      }
      setRecentAdjustments((entries) => entries.map((entry) => entry.key === adjustment.key ? { ...entry, undone: true } : entry));
      await onChanged();
    } catch {
      setError("Could not undo this adjustment. You can retry safely.");
    } finally {
      setUndoBusyKey(null);
    }
  }

  const selectedNames = players.filter((player) => selectedUserIds.includes(player.userId)).map((player) => player.displayName);
  const allPlayersSelected = players.length > 0 && selectedUserIds.length === players.length;
  const selectionSummary = selectedUserIds.length === 0
    ? "Nobody selected yet."
    : allPlayersSelected
      ? `Everyone (${players.length}) selected.`
      : selectedNames.length <= 4
        ? `Selected: ${selectedNames.join(", ")}.`
        : `Selected: ${selectedNames.slice(0, 4).join(", ")} + ${selectedNames.length - 4} more.`;
  const mobileSelectionSummary = selectedUserIds.length === 0
    ? ""
    : allPlayersSelected
      ? `Everyone (${players.length}) selected`
      : `${selectedUserIds.length} selected: ${selectedNames.join(", ")}`;
  const validAdjustment = selectedUserIds.length > 0 && Number.isInteger(effectiveAmount) && effectiveAmount > 0;
  const actionHint = selectedUserIds.length === 0 ? "select players first" : !Number.isInteger(effectiveAmount) || effectiveAmount <= 0 ? "enter an amount" : null;
  const selectedTarget = allPlayersSelected ? "everyone" : selectedNames.length === 1 ? selectedNames[0] : `${selectedNames.length} players`;

  return (
    <>
    <form noValidate onSubmit={(event) => event.preventDefault()} className="flex min-h-0 w-full flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-5 lg:gap-5 lg:overflow-visible lg:px-10 lg:py-7">
        <div className="flex justify-start">
          <div className="flex w-full gap-2 lg:w-auto lg:gap-3">
            <label className="flex h-11 min-w-0 flex-1 items-center border border-white/50 bg-black/10 px-3 focus-within:outline-2 focus-within:outline-white lg:w-60 lg:flex-none"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="mr-2 h-4 w-4 shrink-0 text-white/80 lg:mr-3"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><input type="search" aria-label="Filter players" value={playerQuery} onChange={(event) => setPlayerQuery(event.target.value)} placeholder="Filter" className="min-w-0 flex-1 bg-transparent text-base text-white placeholder:text-white/70 focus:outline-none lg:text-[15px]" /></label>
            <button type="button" onClick={toggleAllPlayers} aria-pressed={allPlayersSelected} className={`h-11 shrink-0 border px-3 text-[15px] font-semibold lg:px-4 ${allPlayersSelected ? "border-white bg-white text-[#2F4BBE]" : "border-white text-white hover:bg-white/15"}`}>{allPlayersSelected ? "Clear all" : playerQuery.trim() ? <><span className="lg:hidden">Select shown</span><span className="hidden lg:inline">Select {matchingPlayers.length} shown</span></> : <><span className="lg:hidden">All ({players.length})</span><span className="hidden lg:inline">Select all ({players.length})</span></>}</button>
          </div>
        </div>
        <p className="truncate py-2 text-sm text-white/80 lg:hidden" aria-live="polite">{mobileSelectionSummary || "\u00a0"}</p>
        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto pb-4 lg:flex-none lg:gap-3 lg:overflow-visible lg:pb-0 xl:grid-cols-4">{matchingPlayers.map((player) => { const selected = selectedUserIds.includes(player.userId); return <button key={player.userId} type="button" aria-pressed={selected} onClick={() => togglePlayer(player.userId)} className={`flex h-[60px] items-center gap-2.5 border px-3 text-left transition focus-visible:outline-2 focus-visible:outline-white lg:h-[72px] lg:gap-3 lg:px-4 ${selected ? "border-white bg-white text-[#2F4BBE]" : "border-white/50 text-white hover:bg-white/10"}`}><span className={`flex h-5 w-5 shrink-0 items-center justify-center border text-xs font-bold lg:h-[22px] lg:w-[22px] ${selected ? "border-[#3450C4] bg-[#3450C4] text-white" : "border-white/70"}`} aria-hidden="true">{selected ? "✓" : ""}</span><span className="min-w-0"><span className="block truncate text-base font-semibold lg:text-[17px]">{player.displayName}</span><span className={`block text-[13px] tabular-nums lg:text-sm ${selected ? "text-[#4A5FB8]" : "text-white/80"}`}>{number.format(player.totalPoints)} pts</span></span></button>; })}</div>
        {matchingPlayers.length === 0 && <p className="pb-4 text-[15px] text-white/80">No players match “{playerQuery}”.</p>}
      </section>
      <section className="flex min-h-0 shrink-0 flex-col gap-2 border-t border-white/50 bg-black/10 px-5 py-3 lg:min-h-[520px] lg:gap-[22px] lg:border-l lg:border-t-0 lg:bg-black/5 lg:px-8 lg:py-7">
        <p className="hidden text-[15px] leading-snug text-white/80 lg:block">{selectionSummary}</p>
        <fieldset><legend className="sr-only lg:not-sr-only lg:text-[15px] lg:font-semibold">Amount</legend><div className="grid grid-cols-[repeat(4,minmax(0,52px))_minmax(0,1fr)] gap-1.5 lg:mt-2 lg:gap-2">{[1, 5, 10, 25].map((value) => <button key={value} type="button" onClick={() => changeField(() => { setAmount(value); setCustomAmount(""); })} aria-pressed={customAmount === "" && amount === value} className={`h-11 min-w-0 border px-2 font-semibold tabular-nums ${customAmount === "" && amount === value ? "border-white bg-white text-[#2F4BBE]" : "border-white/50 text-white hover:bg-white/10"}`}>{value}</button>)}<input type="number" inputMode="numeric" min="1" step="1" aria-label="Custom amount" value={customAmount} onChange={(event) => changeField(() => setCustomAmount(event.target.value))} placeholder="Other" className={`number-field h-11 w-full min-w-0 border bg-[#435EC6] px-2 font-semibold tabular-nums text-white placeholder:text-white/70 focus:outline-2 focus:outline-white lg:bg-black/10 lg:px-3 ${customAmount === "" ? "border-white/50" : "border-2 border-white"}`} /></div></fieldset>
        <label className="lg:hidden"><span className="sr-only">Reason (optional)</span><input value={reason} onChange={(event) => changeField(() => setReason(event.target.value))} aria-label="Reason (optional)" placeholder="Reason (optional)" className="h-11 w-full border border-white/50 bg-[#435EC6] px-3 text-base text-white placeholder:text-white/70 focus:outline-2 focus:outline-white" /></label>
        <label className="hidden flex-col gap-2 text-[15px] font-semibold text-white lg:flex"><span>Reason <span className="font-normal text-white/80">(optional)</span></span><input value={reason} onChange={(event) => changeField(() => setReason(event.target.value))} placeholder="e.g. Solved the riddle" className="h-11 border border-white/50 bg-black/10 px-3.5 text-[15px] font-normal text-white placeholder:text-white/70 focus:outline-2 focus:outline-white" /></label>
        <div className="grid grid-cols-2 gap-2 lg:gap-3"><button type="button" onClick={() => void saveAdjustment(-1)} disabled={busy || !validAdjustment} className="flex h-14 min-w-0 flex-col items-center justify-center border border-white px-2 text-white disabled:cursor-not-allowed disabled:opacity-45 lg:h-[76px] lg:px-3"><span className="text-xl font-bold tabular-nums lg:text-2xl">− {Number.isInteger(effectiveAmount) && effectiveAmount > 0 ? number.format(effectiveAmount) : 0}</span><span className="max-w-full truncate text-xs font-medium lg:text-[13px]">{busy ? "Saving..." : actionHint ?? `from ${selectedTarget}`}</span></button><button type="button" onClick={() => void saveAdjustment(1)} disabled={busy || !validAdjustment} className="flex h-14 min-w-0 flex-col items-center justify-center border border-white bg-white px-2 text-[#2F4BBE] disabled:cursor-not-allowed disabled:opacity-45 lg:h-[76px] lg:px-3"><span className="text-xl font-bold tabular-nums lg:text-2xl">+ {Number.isInteger(effectiveAmount) && effectiveAmount > 0 ? number.format(effectiveAmount) : 0}</span><span className="max-w-full truncate text-xs font-medium lg:text-[13px]">{busy ? "Saving..." : actionHint ?? `to ${selectedTarget}`}</span></button></div>
        <div className="hidden min-h-0 flex-1 border-t border-white/50 pt-[18px] lg:block"><h4 className="text-[15px] font-semibold">Recent</h4>{recentAdjustments.length === 0 ? <p className="mt-2 text-sm text-white/80">Adjustments you make appear here, with undo.</p> : <div className="mt-3 flex flex-col gap-3">{recentAdjustments.map((entry, index) => <div key={entry.key} className={`flex min-h-10 items-center gap-3 ${entry.undone ? "opacity-60" : ""}`}><span className={`min-w-11 px-1.5 py-1 text-center text-sm font-bold tabular-nums ${entry.delta > 0 ? "bg-white text-[#2F4BBE]" : "bg-[#FFB27A] text-[#3A2206]"}`}>{entry.delta > 0 ? "+" : "−"}{number.format(Math.abs(entry.delta))}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{entry.who}</span><span className="block truncate text-[13px] text-white/80">{entry.reason}</span></span>{index === 0 && !entry.undone ? <button type="button" onClick={() => void undoAdjustment(entry)} disabled={undoBusyKey !== null} className="h-9 border border-white px-3 text-sm font-semibold disabled:opacity-50">{undoBusyKey === entry.key ? "Undoing..." : "Undo"}</button> : entry.undone ? <span className="text-[13px] text-white/80">Undone</span> : null}</div>)}</div>}</div>
      </section>
      {error && <p role="alert" className="border-t border-white bg-black/15 px-5 py-3 text-sm text-white lg:col-span-2">{error}</p>}
    </form>
    </>
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
