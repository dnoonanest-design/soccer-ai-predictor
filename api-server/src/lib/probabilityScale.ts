function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Prediction rows exist in both legacy 0-1 and current 0-100 scales. */
export function toUnitProbability(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp01(parsed > 1 ? parsed / 100 : parsed);
}
