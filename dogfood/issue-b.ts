// Dogfood test fixture — do not merge.
export function parseIntSafe(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
      return NaN;
    }
    return Math.trunc(parsed);
  } catch {
    return NaN;
  }
}
