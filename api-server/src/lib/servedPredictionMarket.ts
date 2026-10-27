import { pool } from "@workspace/db";
import { goalMarketsForServedPrediction, marketForServedPrediction } from "./marketBlend";

type StoredFixture = {
  fixture_id: number;
  kickoff: string | null;
  model_version?: string | null;
  generated_at?: string | null;
  prediction: {
    home_win: number; draw: number; away_win: number; predicted_outcome: string;
    over_25: number | null; btts: number | null; pick_confidence: number | null;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

function outcome(h: number, d: number, a: number) {
  if (h >= d && h >= a) return "home";
  if (a >= h && a >= d) return "away";
  return "draw";
}

/** Odds were blended into predictions sealed from this moment (#63). */
const BLEND_LIVE_FROM = Date.parse("2026-10-26T09:30:00Z");

/**
 * Pure: was this stored prediction sealed from the app's own numbers alone?
 * True when it was sealed before odds blending went live, or before the first
 * bookmaker price for the fixture was stored.
 */
export function sealedWithoutOdds(generatedAt: string | null | undefined, firstOddsAt: number | null | undefined): boolean {
  const g = generatedAt ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(g)) return false;
  if (g < BLEND_LIVE_FROM) return true;
  return firstOddsAt == null || g < firstOddsAt;
}

/** First stored pre-match price per fixture (both odds sources). */
async function loadFirstOdds(ids: number[]): Promise<Map<number, number>> {
  const res = await pool.query(
    `SELECT fixture_id, MIN(t) t FROM (
       SELECT fixture_id, observed_at t FROM market_odds_snapshots WHERE fixture_id = ANY($1::int[]) AND observed_at < kickoff_at
       UNION ALL
       SELECT fixture_id, provider_updated_at AT TIME ZONE 'UTC' FROM apif_odds_snapshots
        WHERE fixture_id = ANY($1::int[]) AND phase = 'prematch' AND home_odds > 1 AND draw_odds > 1 AND away_odds > 1) x
      GROUP BY fixture_id`,
    [ids],
  );
  const out = new Map<number, number>();
  for (const r of res.rows as any[]) out.set(Number(r.fixture_id), new Date(r.t).getTime());
  return out;
}

/**
 * Stored predictions are sealed at checkpoints, so a match whose odds arrive
 * after its last checkpoint kept showing the app's numbers without them
 * (26 Oct: Copa del Rey cards). For matches not yet started that were sealed
 * without odds, apply the same 70/30 own/odds blend the live prediction uses,
 * from stored odds only. Predictions sealed with odds already include them and
 * are served as sealed, so odds are never counted twice. Other serving models
 * are left as sealed.
 */
export async function withLatestMarket<T extends StoredFixture>(fixtures: T[], now = Date.now(), firstOddsFor?: Map<number, number>): Promise<T[]> {
  const upcoming = fixtures.filter((f) => f.kickoff && Date.parse(f.kickoff) > now).map((f) => f.fixture_id);
  let first: Map<number, number>;
  try {
    first = firstOddsFor ?? (upcoming.length ? await loadFirstOdds(upcoming) : new Map());
  } catch {
    return fixtures;
  }
  return Promise.all(fixtures.map(async (f) => {
    try {
      if (!f.kickoff || !(Date.parse(f.kickoff) > now)) return f;
      if (f.model_version && /step9|strength/i.test(f.model_version)) return f;
      if (!sealedWithoutOdds(f.generated_at, first.get(f.fixture_id))) return f;
      const p = f.prediction;
      const applied = await marketForServedPrediction(f.fixture_id, "upcoming", f.kickoff, p, "legacy", now);
      const goals = await goalMarketsForServedPrediction(f.fixture_id, "upcoming", f.kickoff, { over_15: null, over_25: p.over_25, over_35: null, btts: p.btts }, now);
      if (!applied && !goals) return f;
      const next = { ...p };
      if (applied) {
        Object.assign(next, applied.probs);
        next.predicted_outcome = outcome(applied.probs.home_win, applied.probs.draw, applied.probs.away_win);
        next.pick_confidence = Math.max(applied.probs.home_win, applied.probs.draw, applied.probs.away_win);
        next.market_blend = applied.market_blend;
      }
      if (goals) {
        next.over_25 = goals.goals.over_25;
        next.btts = goals.goals.btts;
        next.goal_market_blend = goals.goal_market_blend;
      }
      next.model_only = { home_win: p.home_win, draw: p.draw, away_win: p.away_win, over_25: p.over_25, btts: p.btts };
      return { ...f, prediction: next };
    } catch {
      return f;
    }
  }));
}
