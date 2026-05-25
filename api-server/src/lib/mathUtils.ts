/**
 * Shared pure-function utilities used across multiple services and routes.
 * Centralising these avoids the silent divergence that happens when the same
 * function is copy-pasted and later fixed in only one place.
 *
 * S6 fix: normalizeThreeWayPercent and round2/valueEdge were duplicated across
 * backgroundLearnerService.ts and routes/stats.ts.
 */

/** Round to 2 decimal places. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Normalise home/draw/away percentages to sum to exactly 100.
 * Puts any rounding residual on the largest leg.
 */
export function normalizeThreeWayPercent(
  home: number,
  draw: number,
  away: number,
): { home: number; draw: number; away: number } {
  const safeHome = Number.isFinite(home) && home > 0 ? home : 0;
  const safeDraw = Number.isFinite(draw) && draw > 0 ? draw : 0;
  const safeAway = Number.isFinite(away) && away > 0 ? away : 0;
  const total = safeHome + safeDraw + safeAway;
  if (total <= 0) return { home: 33.34, draw: 33.33, away: 33.33 };
  const normHome = Math.round((safeHome / total) * 10000) / 100;
  const normDraw = Math.round((safeDraw / total) * 10000) / 100;
  const normAway = Math.round(Math.max(0, 100 - normHome - normDraw) * 100) / 100;
  const sum = Math.round((normHome + normDraw + normAway) * 100) / 100;
  if (sum === 100) return { home: normHome, draw: normDraw, away: normAway };
  const diff = Math.round((100 - sum) * 100) / 100;
  if (normHome >= normDraw && normHome >= normAway)
    return { home: Math.round((normHome + diff) * 100) / 100, draw: normDraw, away: normAway };
  if (normDraw >= normAway)
    return { home: normHome, draw: Math.round((normDraw + diff) * 100) / 100, away: normAway };
  return { home: normHome, draw: normDraw, away: Math.round((normAway + diff) * 100) / 100 };
}

/** Convert a 0-100% probability to fair decimal odds. */
export function fairOdds(probPct: number): number {
  return probPct > 0 ? round2(100 / probPct) : 0;
}

/**
 * Compute the model-vs-bookmaker value edge for a single market leg.
 * Returns null when either input is missing/invalid.
 */
export function valueEdge(
  modelPct: number,
  decimalOdds: number | null,
): { bookmaker_odds: number; fair_odds: number; edge_pct: number; is_value: boolean } | null {
  if (!Number.isFinite(modelPct) || !decimalOdds || !Number.isFinite(decimalOdds) || modelPct <= 0) return null;
  const fair = round2(100 / modelPct);
  const edge = round2(((decimalOdds * (modelPct / 100)) - 1) * 10000) / 100;
  return { bookmaker_odds: decimalOdds, fair_odds: fair, edge_pct: edge, is_value: edge >= 5 };
}

/** Convert a probability to unit scale (0-1). Handles legacy 0-100 storage. */
export function toUnitProb(prob: number): number {
  return prob > 1 ? prob / 100 : prob;
}
