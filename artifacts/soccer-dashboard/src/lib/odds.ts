function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function decimalToFractional(decimal: number | null | undefined): string {
  if (decimal == null || decimal <= 1) return "-";
  const numerator = Math.round((decimal - 1) * 100);
  const denominator = 100;
  const divisor = gcd(numerator, denominator);
  return `${numerator / divisor}/${denominator / divisor}`;
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
