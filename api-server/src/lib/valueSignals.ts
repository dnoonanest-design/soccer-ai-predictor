/**
 * Value flags: where an odds-free model disagrees with the bookmaker price.
 *
 * Until 26 Oct 2026 these came from the original formula, which is often far
 * from the market (e.g. 27% for a side the bookmakers price at 10%, flagged
 * as "+168% value" at odds of 10.0). Those gaps were the formula being wrong,
 * not value. Now:
 *   - only step 9 (the best odds-free model in testing, 0.579 Brier against
 *     0.637 for the formula) may raise a flag; without a step 9 forecast
 *     there are no flags;
 *   - a flag needs a believable gap: edge 5-25% and the model no more than
 *     12 probability points above the bookmaker's implied chance;
 *   - no long shots: bookmaker odds 6.0 or shorter.
 * Flags remain experimental: closing odds have been more accurate than any
 * model so far, so a gap is still more often model error than real value.
 */
import { valueEdge, valueBetMinEdgePct } from "./mathUtils";
import { forecastStrength } from "./strengthModel";

export const VALUE_RULES = {
  model: "step9-strength-ratings",
  minEdgePct: valueBetMinEdgePct(),
  maxEdgePct: 25,
  maxGapPoints: 12,
  maxOdds: 6,
} as const;

export type ValueSignal = {
  bookmaker_odds: number;
  fair_odds: number;
  edge_pct: number;
  is_value: boolean;
  /** Why a positive edge is not flagged. */
  excluded?: "long_shot" | "gap_too_large";
};

/** One outcome: the model's percentage against the bookmaker's decimal odds. */
export function valueSignal(modelPct: number, decimalOdds: number | null): ValueSignal | null {
  const base = valueEdge(modelPct, decimalOdds);
  if (!base) return null;
  const gapPoints = modelPct - 100 / base.bookmaker_odds;
  let excluded: ValueSignal["excluded"];
  if (base.edge_pct >= VALUE_RULES.minEdgePct) {
    if (base.bookmaker_odds > VALUE_RULES.maxOdds) excluded = "long_shot";
    else if (base.edge_pct > VALUE_RULES.maxEdgePct || gapPoints > VALUE_RULES.maxGapPoints) excluded = "gap_too_large";
  }
  return {
    bookmaker_odds: base.bookmaker_odds,
    fair_odds: base.fair_odds,
    edge_pct: base.edge_pct,
    is_value: base.edge_pct >= VALUE_RULES.minEdgePct && !excluded,
    ...(excluded ? { excluded } : {}),
  };
}

type MatchLike = {
  league_id?: number | null;
  home_team: { id: number };
  away_team: { id: number };
  odds?: { home_odds?: number | null; draw_odds?: number | null; away_odds?: number | null } | null;
};

/** Step 9's percentages for a fixture, or null when it cannot forecast it. */
export function valueModelPercent(match: MatchLike): { home: number; draw: number; away: number } | null {
  const f = forecastStrength(match.league_id ?? 0, match.home_team.id, match.away_team.id);
  if (!f) return null;
  const r = (v: number) => Math.round(v * 10_000) / 100;
  return { home: r(f.probs.home), draw: r(f.probs.draw), away: r(f.probs.away) };
}

/** Value flags for a fixture's three outcomes, or null without a step 9 forecast. */
export function valueSignalsFor(match: MatchLike) {
  const p = valueModelPercent(match);
  if (!p) return null;
  return {
    model: VALUE_RULES.model,
    model_probabilities: p,
    home: valueSignal(p.home, match.odds?.home_odds ?? null),
    draw: valueSignal(p.draw, match.odds?.draw_odds ?? null),
    away: valueSignal(p.away, match.odds?.away_odds ?? null),
  };
}
