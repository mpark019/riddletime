"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LeaderboardEntry } from "@/server/points/points";
import { compareByName } from "@/lib/account-order";
import { pruneSelection } from "@/lib/point-selection";
import { FloatingQuestionMarks } from "./floating-question-marks";

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
    <section className="mx-auto flex w-[calc(100%-2rem)] max-w-[1280px] flex-col py-8 sm:py-12">
      {entries.length === 0 ? (
        <div className="rounded-md border border-white/80 bg-black/10 px-6 py-14 text-center">
          <p className="font-semibold">No players yet.</p>
          <p className="mt-1 text-sm text-white">Players will appear here once they join.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-y border-white/80 text-left sm:min-w-[640px]">
            <thead className="border-b border-white/25 text-xs font-semibold uppercase tracking-[0.12em] text-white">
              <tr>
                <th className="w-20 px-1 py-3 sm:px-2">Rank</th>
                <th className="px-3 py-3 sm:px-5">Player</th>
                <th className="hidden w-32 px-3 py-3 text-right sm:table-cell">Correct</th>
                <th className="w-24 px-1 py-3 text-right sm:w-32 sm:px-2">Points</th>
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
    <tr className="border-b border-white/25 last:border-0">
      <td className="px-1 py-5 text-lg font-semibold tabular-nums text-white sm:px-2 sm:text-xl">{entry.rank}</td>
      <td className="px-3 py-5 sm:px-5">
        <span className="min-w-0">
          <span className="block truncate text-xl font-semibold text-white sm:text-2xl">{entry.displayName}</span>
          {entry.name && <span className="block truncate text-sm text-white">{entry.name}</span>}
        </span>
      </td>
      <td className="hidden px-3 py-5 text-right text-lg tabular-nums text-white sm:table-cell">{number.format(entry.correctRiddles)} / {number.format(entry.incorrectRiddles)}</td>
      <td className="px-1 py-5 text-right text-xl font-semibold tabular-nums text-white sm:px-2 sm:text-2xl">{number.format(entry.totalPoints)}</td>
    </tr>
  );
}

export function PointsDesk({ players, canViewAudit, onChanged, refreshVersion = 0 }: { players: LeaderboardEntry[]; canViewAudit: boolean; onChanged: () => Promise<void>; refreshVersion?: number }) {
  const [tab, setTab] = useState<PointsDeskTab>("adjustment");

  return (
    <section className="mx-auto w-[calc(100%-2rem)] max-w-[1280px] py-6 max-sm:pb-2 max-sm:flex max-sm:min-h-0 max-sm:flex-1 max-sm:flex-col lg:py-10" aria-labelledby="points-desk-title">
      <div className="flex flex-col max-sm:min-h-0 max-sm:flex-1">
        <header className="flex items-center justify-between gap-3 pb-3 pt-2 lg:py-4">
          <h2 id="points-desk-title" className="text-[26px] font-semibold tracking-tight lg:text-[34px]">Points</h2>
          {canViewAudit && <div className="inline-flex overflow-hidden rounded-md border border-white/80" role="tablist" aria-label="Points sections">
            <TabButton active={tab === "adjustment"} onClick={() => setTab("adjustment")}>Adjustment</TabButton>
            <TabButton active={tab === "audit"} onClick={() => setTab("audit")}>Audit trail</TabButton>
          </div>}
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 w-full flex-1" hidden={tab !== "adjustment"}><AdjustmentForm players={players} onChanged={onChanged} /></div>
          {canViewAudit && tab === "audit" && <div className="w-full py-5"><AuditTrail onChanged={onChanged} refreshVersion={refreshVersion} /></div>}
        </div>
      </div>
    </section>
  );
}

function TabButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`h-9 px-3 text-sm font-semibold transition lg:h-11 lg:px-5 lg:text-base ${active ? "navy-surface flat-on-mobile relative isolate" : "text-white hover:bg-white/15"}`}>{active && <FloatingQuestionMarks contained compact start={4} />}{children === "Adjustment" ? <><span className="lg:hidden">Adjust</span><span className="hidden lg:inline">Adjustment</span></> : children}</button>;
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
  const [selection, setSelectedUserIds] = useState<string[]>([]);
  const selectedUserIds = pruneSelection(selection, players);
  const selectedIdSet = new Set(selectedUserIds);
  const [amount, setAmount] = useState(5);
  const [customAmount, setCustomAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [undoBusyKey, setUndoBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentAdjustments, setRecentAdjustments] = useState<RecentAdjustment[]>([]);
  const operationKey = useRef<string | null>(null);
  const effectiveAmount = customAmount === "" ? amount : Number(customAmount);
  const playersByName = useMemo(() => [...players].sort(compareByName), [players]);
  const matchingPlayers = playersByName.filter((player) => {
    const query = playerQuery.trim().toLocaleLowerCase();
    return !query || player.displayName.toLocaleLowerCase().includes(query) || player.name?.toLocaleLowerCase().includes(query);
  });

  function changeField(callback: () => void) {
    operationKey.current = null;
    callback();
  }

  const togglePlayer = useCallback((userId: string) => {
    operationKey.current = null;
    setSelectedUserIds((selected) => selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId]);
  }, []);

  function toggleAllPlayers() {
    changeField(() => setSelectedUserIds((current) => {
      const selected = pruneSelection(current, players);
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
    const selectedNames = playersByName.filter((player) => savedUserIds.includes(player.userId)).map((player) => player.displayName);
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

  const selectedNames = playersByName.filter((player) => selectedUserIds.includes(player.userId)).map((player) => player.displayName);
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
    <form noValidate onSubmit={(event) => event.preventDefault()} className="flex min-h-0 w-full flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-8">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:gap-5 lg:overflow-visible">
        <div className="flex justify-start">
          <div className="flex w-full gap-2 lg:w-auto lg:gap-3">
            <label className="flex h-11 min-w-0 flex-1 items-center rounded-md border border-white/25 bg-black/[0.04] px-3 focus-within:outline-2 focus-within:outline-white lg:w-60 lg:flex-none"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="mr-2 h-4 w-4 shrink-0 text-white lg:mr-3"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><input type="search" aria-label="Filter players" value={playerQuery} onChange={(event) => setPlayerQuery(event.target.value)} placeholder="Filter" className="min-w-0 flex-1 bg-transparent text-base text-white placeholder:text-white focus:outline-none lg:text-[15px]" /></label>
            <button type="button" onClick={toggleAllPlayers} aria-pressed={allPlayersSelected} className={`h-11 shrink-0 rounded-md border px-3 text-[15px] font-semibold lg:px-4 ${allPlayersSelected ? "navy-surface flat-on-mobile relative isolate overflow-hidden border-transparent" : "border-white text-white hover:bg-white/15"}`}>{allPlayersSelected && <FloatingQuestionMarks contained compact start={2} />}{allPlayersSelected ? "Clear all" : playerQuery.trim() ? <><span className="lg:hidden">Select shown</span><span className="hidden lg:inline">Select {matchingPlayers.length} shown</span></> : <><span className="lg:hidden">All ({players.length})</span><span className="hidden lg:inline">Select all ({players.length})</span></>}</button>
          </div>
        </div>
        <p className="truncate py-2 text-sm text-white lg:hidden" aria-live="polite">{mobileSelectionSummary || "\u00a0"}</p>
        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto overscroll-contain pb-4 lg:flex-none lg:gap-4 lg:overflow-visible lg:pb-0 xl:grid-cols-4">{matchingPlayers.map((player, index) => <PlayerButton key={player.userId} player={player} index={index} selected={selectedIdSet.has(player.userId)} onToggle={togglePlayer} />)}</div>
        {matchingPlayers.length === 0 && <p className="pb-4 text-[15px] text-white">No players match “{playerQuery}”.</p>}
      </section>
      <section className="app-header relative isolate flex min-h-0 shrink-0 flex-col gap-2 rounded-md border-t px-5 py-3 lg:gap-[22px] lg:self-start lg:px-6 lg:py-6"><FloatingQuestionMarks contained />
        <p className="hidden text-[15px] leading-snug text-white lg:block">{selectionSummary}</p>
        <fieldset><legend className="sr-only lg:not-sr-only lg:text-[15px] lg:font-semibold">Amount</legend><div className="grid grid-cols-[repeat(4,minmax(0,52px))_minmax(0,1fr)] gap-1.5 lg:mt-2 lg:gap-2">{[1, 5, 10, 25].map((value) => <button key={value} type="button" onClick={() => changeField(() => { setAmount(value); setCustomAmount(""); })} aria-pressed={customAmount === "" && amount === value} className={`h-11 min-w-0 rounded-md border px-2 font-semibold tabular-nums ${customAmount === "" && amount === value ? "border-white bg-white text-on-fill" : "border-white/25 text-white hover:bg-white/10"}`}>{value}</button>)}<input type="number" inputMode="numeric" min="1" step="1" aria-label="Custom amount" value={customAmount} onChange={(event) => changeField(() => setCustomAmount(event.target.value))} placeholder="Other" className={`number-field h-11 w-full min-w-0 rounded-md border bg-surface-solid px-2 font-semibold tabular-nums text-white placeholder:text-white transition focus:outline-2 focus:outline-white lg:px-3 ${customAmount === "" ? "border-white/25" : "rounded-md border-2 border-white"}`} /></div></fieldset>
        <label className="lg:hidden"><span className="sr-only">Reason (optional)</span><input value={reason} onChange={(event) => changeField(() => setReason(event.target.value))} aria-label="Reason (optional)" placeholder="Reason (optional)" className="h-11 w-full rounded-md border border-white/25 bg-surface-solid/70 px-3 text-base text-white placeholder:text-white transition focus:bg-surface-solid/90 focus:outline-2 focus:outline-white" /></label>
        <label className="hidden flex-col gap-2 text-[15px] font-semibold text-white lg:flex"><span>Reason <span className="font-normal text-white">(optional)</span></span><input value={reason} onChange={(event) => changeField(() => setReason(event.target.value))} placeholder="What was this for?" className="h-11 rounded-md border border-white/25 bg-white/10 px-3.5 text-[15px] font-normal text-white placeholder:text-white focus:outline-2 focus:outline-white" /></label>
        <div className="grid grid-cols-2 gap-2 lg:gap-3"><button type="button" onClick={() => void saveAdjustment(-1)} disabled={busy || !validAdjustment} className="flex h-14 min-w-0 flex-col items-center justify-center rounded-md border-2 border-[#c00000] bg-[#f00000] px-2 text-white transition enabled:hover:bg-[#d60000] disabled:cursor-not-allowed disabled:border-white/25 disabled:bg-white/10 disabled:text-white lg:h-[76px] lg:px-3"><span className="text-xl font-bold tabular-nums lg:text-2xl">− {Number.isInteger(effectiveAmount) && effectiveAmount > 0 ? number.format(effectiveAmount) : 0}</span><span className="max-w-full truncate text-xs font-medium lg:text-[13px]">{busy ? "Saving..." : actionHint ?? `from ${selectedTarget}`}</span></button><button type="button" onClick={() => void saveAdjustment(1)} disabled={busy || !validAdjustment} className="flex h-14 min-w-0 flex-col items-center justify-center rounded-md border-2 border-[#006f08] bg-[#00940a] px-2 text-white transition enabled:hover:bg-[#00800a] disabled:cursor-not-allowed disabled:border-white/25 disabled:bg-white/10 disabled:text-white lg:h-[76px] lg:px-3"><span className="text-xl font-bold tabular-nums lg:text-2xl">+ {Number.isInteger(effectiveAmount) && effectiveAmount > 0 ? number.format(effectiveAmount) : 0}</span><span className="max-w-full truncate text-xs font-medium lg:text-[13px]">{busy ? "Saving..." : actionHint ?? `to ${selectedTarget}`}</span></button></div>
        <div className="hidden min-h-0 flex-1 border-t border-white/25 pt-[18px] lg:block"><h4 className="text-[15px] font-semibold">Recent</h4>{recentAdjustments.length === 0 ? <p className="mt-2 text-sm text-white">No recent adjustments</p> : <div className="mt-3 flex flex-col gap-3">{recentAdjustments.map((entry, index) => <div key={entry.key} className={`flex min-h-10 items-center gap-3 ${entry.undone ? "opacity-60" : ""}`}><span className={`min-w-11 px-1.5 py-1 text-center text-sm font-bold tabular-nums ${entry.delta > 0 ? "bg-[#00940a] text-white ring-2 ring-[#006f08]" : "bg-[#f00000] text-white ring-2 ring-[#c00000]"}`}>{entry.delta > 0 ? "+" : "−"}{number.format(Math.abs(entry.delta))}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{entry.who}</span><span className="block truncate text-[13px] text-white">{entry.reason}</span></span>{index === 0 && !entry.undone ? <button type="button" onClick={() => void undoAdjustment(entry)} disabled={undoBusyKey !== null} className="h-9 rounded-md border border-white px-3 text-sm font-semibold disabled:opacity-50">{undoBusyKey === entry.key ? "Undoing..." : "Undo"}</button> : entry.undone ? <span className="text-[13px] text-white">Undone</span> : null}</div>)}</div>}</div>
      </section>
      {error && <p role="alert" className="border-t border-white bg-black/[0.06] px-5 py-3 text-sm text-white lg:col-span-2">{error}</p>}
    </form>
    </>
  );
}

const PlayerButton = memo(function PlayerButton({ player, index, selected, onToggle }: { player: LeaderboardEntry; index: number; selected: boolean; onToggle: (userId: string) => void }) {
  return <button type="button" aria-pressed={selected} onClick={() => onToggle(player.userId)} className={`flex h-[72px] items-center gap-2.5 rounded-md border px-3 text-left transition focus-visible:outline-2 focus-visible:outline-white lg:h-[72px] lg:gap-3 lg:px-4 ${selected ? "navy-surface flat-on-mobile relative isolate overflow-hidden border-transparent" : "border-white/25 text-white hover:bg-white/10"}`}>{selected && <FloatingQuestionMarks contained compact start={index * 3} />}<span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs font-bold lg:h-[22px] lg:w-[22px] ${selected ? "border-white bg-white text-black" : "border-white/25"}`} aria-hidden="true">{selected ? "✓" : ""}</span><span className="min-w-0 flex-1"><span className="block truncate text-base font-semibold lg:text-[17px]">{player.displayName}</span>{player.name && <span className="block truncate text-[13px] lg:text-sm">{player.name}</span>}</span><span className="shrink-0 text-sm font-semibold tabular-nums">{number.format(player.totalPoints)}</span></button>;
});

const AUDIT_PAGE_SIZE = 10;
const auditDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function AuditTrail({ onChanged, refreshVersion }: { onChanged: () => Promise<void>; refreshVersion: number }) {
  const [transactions, setTransactions] = useState<PointTransaction[]>([]);
  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] = useState<PointTransaction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(searchInput.trim());
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let current = true;
    const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE + 1), offset: String(page * AUDIT_PAGE_SIZE) });
    if (query) params.set("q", query);
    fetch(`/api/admin/point-transactions?${params}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<PointTransaction[]>;
      })
      .then((result) => {
        if (!current) return;
        if (result.length === 0 && page > 0) {
          setPage(page - 1);
          return;
        }
        setTransactions(result.slice(0, AUDIT_PAGE_SIZE));
        setHasNext(result.length > AUDIT_PAGE_SIZE);
        setError(null);
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
  }, [refreshVersion, page, query]);

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

  const emptyState = (message: string) => <p className="rounded-md border border-white/25 bg-black/[0.04] px-4 py-10 text-center text-sm">{message}</p>;

  return <div className="flex flex-col gap-4">
    <label className="flex h-11 w-full items-center rounded-md border border-white/25 bg-black/[0.04] px-3 focus-within:outline-2 focus-within:outline-white sm:max-w-xs"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="mr-2 h-4 w-4 shrink-0"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><input type="search" aria-label="Search audit trail by player" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search player" className="min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-white focus:outline-none" /></label>
    {error && <p role="alert" className="rounded-md border border-white bg-black/[0.06] px-4 py-3 text-sm">{error}</p>}
    {loading ? emptyState("Loading point history...") : transactions.length === 0 ? emptyState(query ? `No entries match “${query}”.` : "No point events yet.") : <ul className="flex flex-col gap-2">{transactions.map((transaction) => <AuditRow key={transaction.id} transaction={transaction} disabled={busyId !== null} onDelete={() => setPendingDeletion(transaction)} />)}</ul>}
    {(page > 0 || hasNext) && <nav className="flex items-center justify-between gap-3 pt-2" aria-label="Audit trail pages">
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="h-10 rounded-md border border-white px-4 text-sm font-semibold transition hover:bg-white/10 disabled:cursor-not-allowed disabled:border-white/25 disabled:hover:bg-transparent">Newer</button>
      <span className="text-sm font-medium tabular-nums">Page {page + 1}</span>
      <button type="button" disabled={!hasNext} onClick={() => setPage(page + 1)} className="h-10 rounded-md border border-white px-4 text-sm font-semibold transition hover:bg-white/10 disabled:cursor-not-allowed disabled:border-white/25 disabled:hover:bg-transparent">Older</button>
    </nav>}
    {pendingDeletion && <ConfirmationDialog transaction={pendingDeletion} busy={busyId === pendingDeletion.id} onCancel={() => setPendingDeletion(null)} onConfirm={removeTransaction} />}
  </div>;
}

function AuditRow({ transaction, disabled, onDelete }: { transaction: PointTransaction; disabled: boolean; onDelete: () => void }) {
  const positive = transaction.amount > 0;

  return <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-md border border-white/25 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_5rem_auto]">
    <div className="min-w-0">
      <p className="truncate font-semibold">{transaction.display_name ?? transaction.user_id}</p>
      <p className="text-xs">{auditDateFormat.format(new Date(transaction.created_at))}</p>
    </div>
    <span className={`col-start-2 row-start-1 justify-self-end rounded-md px-2.5 py-1 text-center text-sm font-semibold tabular-nums text-on-fill ring-2 sm:col-start-3 ${positive ? "bg-[#00940a] ring-[#006f08]" : "bg-[#f00000] ring-[#c00000]"}`}>{positive ? "+" : "−"}{number.format(Math.abs(transaction.amount))}</span>
    <p className="col-start-1 row-start-2 truncate text-sm sm:col-start-2 sm:row-start-1">{transaction.reason}</p>
    <button type="button" disabled={disabled} onClick={onDelete} className="col-start-2 row-start-2 justify-self-end rounded-md border border-white/25 px-3 py-1.5 text-xs font-semibold transition hover:bg-black/[0.06] disabled:opacity-50 sm:col-start-4 sm:row-start-1">Delete</button>
  </li>;
}

function ConfirmationDialog({ transaction, busy, onCancel, onConfirm }: { transaction: PointTransaction; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-5" role="presentation"><section role="alertdialog" aria-modal="true" aria-labelledby="delete-transaction-title" className="w-full max-w-md rounded-md border border-white bg-surface-solid p-6"><h4 id="delete-transaction-title" className="text-xl font-semibold">Delete this point event?</h4><p className="mt-2 text-sm leading-6 text-white">This removes the {transaction.amount > 0 ? "+" : ""}{number.format(transaction.amount)} entry for {transaction.display_name ?? "this player"}. It cannot be undone.</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onCancel} disabled={busy} className="rounded-md border border-white/80 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/15 disabled:opacity-50">Keep it</button><button type="button" onClick={onConfirm} disabled={busy} className="rounded-md border border-[#c00000] bg-[#f00000] px-4 py-2.5 text-sm font-semibold text-on-fill transition hover:bg-[#d60000] disabled:opacity-50">{busy ? "Deleting..." : "Delete event"}</button></div></section></div>;
}
