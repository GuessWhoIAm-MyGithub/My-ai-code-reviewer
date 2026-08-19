// Dogfood test fixture — do not merge.
export function parseIntSafe(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
      return NaN;
    }
    return Number.isInteger(parsed) ? parsed : NaN;
  } catch {
    return NaN;
  }
}
