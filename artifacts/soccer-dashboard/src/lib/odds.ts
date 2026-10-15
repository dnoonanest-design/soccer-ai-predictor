// Familiar UK bookmaker fractions. Pinnacle supplies decimal prices, so use a
// compact set of common fractional quotes instead of displaying unusual ratios.
const BOOKMAKER_FRACTIONAL_ODDS: ReadonlyArray<readonly [number, number]> = [
  [1, 100], [1, 66], [1, 50], [1, 33], [1, 25], [1, 20], [1, 16], [1, 14],
  [1, 12], [1, 10], [1, 9], [1, 8], [1, 7], [1, 6], [1, 5], [2, 9], [1, 4],
  [2, 7], [3, 10], [1, 3], [2, 5], [4, 9], [1, 2], [4, 6], [4, 5], [5, 6],
  [10, 11], [1, 1], [11, 10], [6, 5], [5, 4], [11, 8], [6, 4], [13, 8],
  [7, 4], [15, 8], [2, 1], [9, 4], [5, 2], [11, 4], [3, 1], [10, 3], [7, 2],
  [4, 1], [9, 2], [5, 1], [11, 2], [6, 1], [13, 2], [7, 1], [15, 2], [8, 1],
  [9, 1], [10, 1], [12, 1], [14, 1], [16, 1], [20, 1], [25, 1], [33, 1],
  [50, 1], [66, 1], [100, 1],
];

export function decimalToFractional(decimal: number | null | undefined): string {
  if (decimal == null || !Number.isFinite(decimal) || decimal <= 1) return "-";

  const profit = decimal - 1;
  let bestNumerator = BOOKMAKER_FRACTIONAL_ODDS[0][0];
  let bestDenominator = BOOKMAKER_FRACTIONAL_ODDS[0][1];
  let bestError = Math.abs(profit - bestNumerator / bestDenominator);

  for (const [numerator, denominator] of BOOKMAKER_FRACTIONAL_ODDS.slice(1)) {
    const error = Math.abs(profit - numerator / denominator);
    if (error < bestError) {
      bestNumerator = numerator;
      bestDenominator = denominator;
      bestError = error;
    }
  }

  return String(bestNumerator) + "/" + String(bestDenominator);
}
export function formatOdds(decimal: number | null | undefined, format: "decimal" | "fractional"): string {
  if (decimal == null || !Number.isFinite(decimal) || decimal <= 1) return "—";
  return format === "fractional" ? decimalToFractional(decimal) : decimal.toFixed(2);
}

export type ValueBet = {
  outcome: "HOME" | "DRAW" | "AWAY";
  delta: number; // history - market (positive = history says more likely than priced)
  market: number;
  history: number;
};

export type ModelGap = Omit<ValueBet, "delta"> & {
  delta: number; // absolute model/market difference in percentage points
};

const COMPLETE_MARKET_MIN = 90;
const COMPLETE_MARKET_MAX = 110;
const MODEL_TOTAL_MIN = 98;
const MODEL_TOTAL_MAX = 102;
const MODEL_GAP_REVIEW_THRESHOLD = 25;

function isProbability(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0 && value <= 100;
}

function hasCompleteProbabilities(
  values: readonly [number | null | undefined, number | null | undefined, number | null | undefined],
  min: number,
  max: number,
): boolean {
  if (!values.every(isProbability)) return false;
  const total = (values as readonly [number, number, number]).reduce<number>((sum, value) => sum + value, 0);
  return total >= min && total <= max;
}

export function findValueBets(
  market: { home_win?: number | null; draw?: number | null; away_win?: number | null },
  history: { home_win_pct: number; draw_pct: number; away_win_pct: number },
  threshold: number
): ValueBet[] {
  const marketProbabilities = [market.home_win, market.draw, market.away_win] as const;
  const modelProbabilities = [history.home_win_pct, history.draw_pct, history.away_win_pct] as const;
  if (
    !hasCompleteProbabilities(marketProbabilities, COMPLETE_MARKET_MIN, COMPLETE_MARKET_MAX) ||
    !hasCompleteProbabilities(modelProbabilities, MODEL_TOTAL_MIN, MODEL_TOTAL_MAX)
  ) return [];

  const candidates: ValueBet[] = [
    { outcome: "HOME", delta: history.home_win_pct - (market.home_win ?? 0), market: market.home_win ?? 0, history: history.home_win_pct },
    { outcome: "DRAW", delta: history.draw_pct - (market.draw ?? 0), market: market.draw ?? 0, history: history.draw_pct },
    { outcome: "AWAY", delta: history.away_win_pct - (market.away_win ?? 0), market: market.away_win ?? 0, history: history.away_win_pct },
  ];
  return candidates
    .filter((c) => c.delta >= threshold && c.delta < MODEL_GAP_REVIEW_THRESHOLD && c.market > 0)
    .sort((a, b) => b.delta - a.delta);
}


export type ModelEdge = Omit<ValueBet, "history"> & {
  modelProbability: number;
};

/** Large probability gaps are surfaced for review, never promoted as edges. */
export function findModelGaps(
  market: { home_win?: number | null; draw?: number | null; away_win?: number | null },
  model: { home_win: number; draw: number; away_win: number },
  reviewThreshold = MODEL_GAP_REVIEW_THRESHOLD,
): ModelGap[] {
  if (
    !hasCompleteProbabilities([market.home_win, market.draw, market.away_win], COMPLETE_MARKET_MIN, COMPLETE_MARKET_MAX) ||
    !hasCompleteProbabilities([model.home_win, model.draw, model.away_win], MODEL_TOTAL_MIN, MODEL_TOTAL_MAX)
  ) return [];

  return [
    { outcome: "HOME" as const, market: market.home_win as number, history: model.home_win },
    { outcome: "DRAW" as const, market: market.draw as number, history: model.draw },
    { outcome: "AWAY" as const, market: market.away_win as number, history: model.away_win },
  ]
    .map(({ outcome, market: marketProbability, history }) => ({
      outcome,
      market: marketProbability,
      history,
      delta: Math.abs(history - marketProbability),
    }))
    .filter((gap) => gap.delta >= reviewThreshold)
    .sort((a, b) => b.delta - a.delta);
}

/** Compare prematch model probabilities with the market in percentage points. */
export function findModelEdges(
  market: { home_win?: number | null; draw?: number | null; away_win?: number | null },
  model: { home_win: number; draw: number; away_win: number },
  threshold: number,
): ModelEdge[] {
  return findValueBets(market, {
    home_win_pct: model.home_win,
    draw_pct: model.draw,
    away_win_pct: model.away_win,
  }, threshold).map(({ history, ...edge }) => ({
    ...edge,
    modelProbability: history,
  }));
}
