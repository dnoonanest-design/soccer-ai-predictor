import { goalMarketsForServedPrediction, marketForServedPrediction } from "./marketBlend";

type StoredFixture = {
  fixture_id: number;
  kickoff: string | null;
  model_version?: string | null;
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

/**
 * Stored predictions are sealed at checkpoints, so a match whose odds arrive
 * after its last checkpoint kept showing the formula alone (26 Oct: Copa del
 * Rey cards). For matches not yet started, apply the same bookmaker blend the
 * live prediction uses, from stored odds only. The original formula is served
 * at weight 0 (tested), so applying it to an already-blended number gives the
 * same result. Other serving models are left as sealed to avoid blending twice.
 */
export async function withLatestMarket<T extends StoredFixture>(fixtures: T[], now = Date.now()): Promise<T[]> {
  return Promise.all(fixtures.map(async (f) => {
    try {
      if (!f.kickoff || !(Date.parse(f.kickoff) > now)) return f;
      if (f.model_version && /step9|strength/i.test(f.model_version)) return f;
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
