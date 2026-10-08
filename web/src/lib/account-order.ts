type Nameable = { name: string | null; displayName: string | null };

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function compareByName(a: Nameable, b: Nameable): number {
  if (a.name && !b.name) return -1;
  if (!a.name && b.name) return 1;
  const byName = a.name && b.name ? collator.compare(a.name, b.name) : 0;
  return byName || collator.compare(a.displayName ?? "", b.displayName ?? "");
}
