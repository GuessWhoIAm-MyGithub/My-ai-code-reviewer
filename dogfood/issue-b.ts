// Dogfood test fixture — do not merge.
export function parseIntSafe(raw: string): number {
  return JSON.parse(raw) as number;
}
