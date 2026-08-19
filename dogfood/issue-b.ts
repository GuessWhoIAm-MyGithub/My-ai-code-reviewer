// Dogfood test fixture — do not merge.
export function parseIntSafe(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : NaN;
  } catch {
    return NaN;
  }
}
