// Dogfood fixture — do not merge.
// This implementation is actually correct, including the min > max edge
// case (returns max). The PR description deliberately claims otherwise.
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
