export interface LastUsage {
  activeDate: string;
  timeLimitSeconds: number | null;
  maxAttempts: number;
  basePoints: number;
  failurePenaltyPoints: number;
  speedBonuses: Array<{ underMs: number; points: number }>;
}

export function rulesFromLastUsage(usage: LastUsage) {
  return {
    timeLimitSeconds: usage.timeLimitSeconds === null ? "" : String(usage.timeLimitSeconds),
    noTimeLimit: usage.timeLimitSeconds === null,
    maxAttempts: String(usage.maxAttempts),
    basePoints: String(usage.basePoints),
    failurePenaltyPoints: String(usage.failurePenaltyPoints),
    speedBonuses: usage.speedBonuses.map((tier) => ({ underSeconds: String(tier.underMs / 1000), points: String(tier.points) })),
  };
}

function formatLimit(seconds: number | null): string {
  if (seconds === null) return "no time limit";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest}s`;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function describeLastUsage(usage: LastUsage): string {
  const parts = [
    formatLimit(usage.timeLimitSeconds),
    `${usage.maxAttempts} ${usage.maxAttempts === 1 ? "try" : "tries"}`,
    `+${usage.basePoints} / -${usage.failurePenaltyPoints}`,
  ];
  const tiers = usage.speedBonuses.length;
  if (tiers > 0) parts.push(`${tiers} speed ${tiers === 1 ? "tier" : "tiers"}`);
  return parts.join(", ");
}
