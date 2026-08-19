// Dogfood test fixture — do not merge.
export function firstItem<T>(items: T[]): T {
  return items[items.length];
}

export function lastItem<T>(items: T[]): T {
  return items[items.length - 1];
}
