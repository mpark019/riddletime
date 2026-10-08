export function pruneSelection(selected: string[], players: { userId: string }[]): string[] {
  const known = new Set(players.map((player) => player.userId));
  return selected.every((id) => known.has(id)) ? selected : selected.filter((id) => known.has(id));
}
