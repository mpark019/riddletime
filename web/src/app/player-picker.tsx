"use client";

import { useMemo, useState } from "react";
import { sortPlayers, type PlayerSort } from "@/lib/account-order";
import type { LeaderboardEntry } from "@/server/points/points";
import { PlayerButton, PlayerSortToggle } from "./scoreboard";

export function PlayerPicker({
  players,
  selected,
  summary,
  onChange,
}: {
  players: LeaderboardEntry[];
  selected: string[];
  summary?: string;
  onChange: (userIds: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PlayerSort>("name");
  const sorted = useMemo(() => sortPlayers(players, sort), [players, sort]);
  const needle = query.trim().toLocaleLowerCase();
  const matching = sorted.filter((player) => !needle
    || player.displayName.toLocaleLowerCase().includes(needle)
    || player.name?.toLocaleLowerCase().includes(needle));
  const selectedSet = new Set(selected);
  const allShownSelected = matching.length > 0 && matching.every((player) => selectedSet.has(player.userId));

  function toggle(userId: string) {
    onChange(selectedSet.has(userId) ? selected.filter((id) => id !== userId) : [...selected, userId]);
  }

  function toggleShown() {
    const shownIds = new Set(matching.map((player) => player.userId));
    onChange(allShownSelected
      ? selected.filter((id) => !shownIds.has(id))
      : Array.from(new Set([...selected, ...shownIds])));
  }

  return <div>
    <div className="flex gap-2">
      <label className="flex h-11 min-w-0 flex-1 items-center rounded-md border border-white/25 bg-black/[0.04] px-3 focus-within:outline-2 focus-within:outline-white sm:max-w-60">
        <span className="sr-only">Search players</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search players" className="w-full bg-transparent outline-none placeholder:text-white/45" />
      </label>
      <PlayerSortToggle sort={sort} onChange={setSort} />
      <button type="button" onClick={toggleShown} disabled={matching.length === 0} aria-pressed={allShownSelected} className="h-11 shrink-0 rounded-md border border-white px-3 text-[15px] font-semibold hover:bg-white/15 disabled:opacity-45">{allShownSelected ? "Clear shown" : query.trim() ? `Select ${matching.length} shown` : `Select all (${players.length})`}</button>
    </div>
    <p className="mt-2 text-sm text-white/65" aria-live="polite">{selected.length === 0 ? "Nobody selected yet." : `${selected.length} selected.`}{summary && ` ${summary}`}</p>
    <div className="mt-3 grid max-h-96 grid-cols-2 gap-2 overflow-y-auto overscroll-contain xl:grid-cols-3">
      {matching.map((player, index) => <PlayerButton key={player.userId} player={player} index={index} selected={selectedSet.has(player.userId)} onToggle={toggle} />)}
    </div>
    {matching.length === 0 && <p className="mt-3 text-sm text-white/65">No players match “{query}”.</p>}
  </div>;
}
