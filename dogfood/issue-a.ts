// Dogfood test fixture — do not merge.
export function firstItem<T>(items: T[]): T {
  if (items.length === 0) throw new Error("items is empty");
  return items[0];
}

export function lastItem<T>(items: T[]): T {
  if (items.length === 0) throw new Error("items is empty");
  return items[items.length - 1];
}
