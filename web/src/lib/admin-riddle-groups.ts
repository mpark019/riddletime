import type { ScheduledRiddlePlayer } from "@/server/schedules/schedules";

export interface PuzzleGroup {
  key: string;
  type: string;
  name: string | null;
  answers: string[];
  players: ScheduledRiddlePlayer[];
}

function normalizedAnswers(answers: readonly string[]): string[] {
  return answers.map((answer) => answer.trim().toLowerCase()).sort();
}

export function groupPlayersByPuzzle(players: readonly ScheduledRiddlePlayer[]): PuzzleGroup[] {
  const groups = new Map<string, PuzzleGroup>();
  for (const player of players) {
    const puzzle = player.puzzle;
    if (!puzzle) continue;
    const key = `${puzzle.type}|${normalizedAnswers(puzzle.acceptedAnswers).join("|")}`;
    const group = groups.get(key);
    if (group) group.players.push(player);
    else groups.set(key, { key, type: puzzle.type, name: puzzle.name, answers: puzzle.acceptedAnswers, players: [player] });
  }
  return [...groups.values()].sort((a, b) => b.players.length - a.players.length);
}
