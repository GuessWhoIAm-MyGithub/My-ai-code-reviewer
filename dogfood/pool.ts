// Dogfood fixture — do not merge.
export function lastValue(values: number[]): number {
  if (values.length === 0) throw new Error("values is empty");
  return values[values.length - 1];
}
