// Dogfood fixture — do not merge.
// Deliberate, defensible error-handling choice: return NaN on invalid input
// (parseFloat-style semantics). Nothing objectively wrong with this file —
// under the v1.4.0 reporting bar it should produce zero findings.
export function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return NaN;
  }
  return parsed;
}
