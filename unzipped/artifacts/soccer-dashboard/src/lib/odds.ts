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

export function findValueBets(
  market: { home_win?: number | null; draw?: number | null; away_win?: number | null },
  history: { home_win_pct: number; draw_pct: number; away_win_pct: number },
  threshold: number
): ValueBet[] {
  const candidates: ValueBet[] = [
    { outcome: "HOME", delta: history.home_win_pct - (market.home_win ?? 0), market: market.home_win ?? 0, history: history.home_win_pct },
    { outcome: "DRAW", delta: history.draw_pct - (market.draw ?? 0), market: market.draw ?? 0, history: history.draw_pct },
    { outcome: "AWAY", delta: history.away_win_pct - (market.away_win ?? 0), market: market.away_win ?? 0, history: history.away_win_pct },
  ];
  return candidates
    .filter((c) => c.delta >= threshold && c.market > 0)
    .sort((a, b) => b.delta - a.delta);
}
