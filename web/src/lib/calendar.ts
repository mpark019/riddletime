export interface CalendarDay {
  iso: string;
  day: number;
  inMonth: boolean;
}

const DAY_MS = 86_400_000;

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Months are zero-based like Date; all math is in UTC so local DST never shifts a day.
export function monthGrid(year: number, month: number): CalendarDay[][] {
  const first = Date.UTC(year, month, 1);
  const last = Date.UTC(year, month + 1, 0);
  const start = first - new Date(first).getUTCDay() * DAY_MS;
  const end = last + (6 - new Date(last).getUTCDay()) * DAY_MS;
  const weeks: CalendarDay[][] = [];
  for (let time = start; time <= end; time += 7 * DAY_MS) {
    weeks.push(Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(time + offset * DAY_MS);
      return { iso: toIso(date), day: date.getUTCDate(), inMonth: date.getUTCMonth() === month };
    }));
  }
  return weeks;
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const date = new Date(Date.UTC(year, month + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}

export function formatUsDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : "";
}

export function parseUsDate(text: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return toIso(date);
}
