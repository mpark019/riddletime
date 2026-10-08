import type { ScheduledRiddlePlayer } from "@/server/schedules/schedules";

export interface PlayerSummary {
  total: number;
  played: number;
  solved: number;
  failed: number;
  inProgress: number;
  averageTimeMs: number | null;
  pointsGiven: number;
}

export function summarizePlayers(players: readonly ScheduledRiddlePlayer[]): PlayerSummary {
  const finished = players.filter((player) => player.status === "completed");
  const timed = finished.filter((player) => player.timeTakenMs !== null);
  const totalTimeMs = timed.reduce((sum, player) => sum + (player.timeTakenMs ?? 0), 0);
  return {
    total: players.length,
    played: players.filter((player) => player.status !== "not_started").length,
    solved: finished.filter((player) => player.correct === true).length,
    failed: finished.filter((player) => player.correct === false).length,
    inProgress: players.filter((player) => player.status === "in_progress" || player.status === "expired").length,
    averageTimeMs: timed.length > 0 ? Math.round(totalTimeMs / timed.length) : null,
    pointsGiven: players.reduce((sum, player) => sum + (player.points ?? 0), 0),
  };
}
