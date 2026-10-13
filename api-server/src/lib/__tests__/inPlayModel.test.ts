import { describe, expect, it } from "vitest";
import { DEFAULT_INPLAY_PARAMS, liveScoreAdjustedProbs } from "../enhancedStatsService";
import { fitInPlayParams, fitWithHoldout, liveLambdas, meanLogLoss, snapshotProbs, type InPlaySnapshot } from "../inPlayModelService";

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

// Snapshots whose outcomes are drawn from a "true" model in which the team
// behind pushes much harder than the hand-set 1.18.
function snapshots(n: number, truth = { ...DEFAULT_INPLAY_PARAMS, trailing: 1.5 }, seed = 3): InPlaySnapshot[] {
  const u = rng(seed);
  const out: InPlaySnapshot[] = [];
  for (let i = 0; i < n; i++) {
    const minute = 15 + Math.floor(u() * 70);
    const scoreHome = Math.floor(u() * 3), scoreAway = Math.floor(u() * 3);
    const s: InPlaySnapshot = {
      fixtureId: i + 1, at: i, minute, scoreHome, scoreAway,
      lambdaHome: 0.9 + u() * 1.2, lambdaAway: 0.7 + u() * 1.0, outcome: "draw",
    };
    const p = snapshotProbs(s, truth);
    const x = u();
    s.outcome = x < p.home ? "home" : x < p.home + p.draw ? "draw" : "away";
    out.push(s);
  }
  return out;
}

describe("in-play challenger", () => {
  it("default parameters reproduce the original live formula", () => {
    const stats = {
      home: { shots_on_target: 5, shots_total: 11, corners: 4, expected_goals_live: 1.2, red_cards: 1, possession: "58%" },
      away: { shots_on_target: 2, shots_total: 6, corners: 1, expected_goals_live: 0.4, red_cards: 0, possession: "42%" },
    };
    const a = liveScoreAdjustedProbs(0, 1, 62, 1.6, 1.1, stats);
    const b = liveScoreAdjustedProbs(0, 1, 62, 1.6, 1.1, stats, { ...DEFAULT_INPLAY_PARAMS });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.homeWin + a.draw + a.awayWin).toBeCloseTo(100, 6);
  });

  it("fits the trailing-team multiplier toward the truth and lowers log loss", async () => {
    const rows = snapshots(2000);
    const fitted = await fitInPlayParams(rows, DEFAULT_INPLAY_PARAMS, 10);
    expect(fitted.trailing).toBeGreaterThan(1.3);
    expect(meanLogLoss(rows, fitted)).toBeLessThan(meanLogLoss(rows, DEFAULT_INPLAY_PARAMS));
  }, 60_000);

  it("keeps the hand-set values when there are too few fixtures", async () => {
    const out = await fitWithHoldout(snapshots(50), 150);
    expect(out.params).toBe(null);
    expect(out.reason ?? "").toContain("needs 150");
  });

  it("keeps the hand-set values when they are already right", async () => {
    const out = await fitWithHoldout(snapshots(1500, { ...DEFAULT_INPLAY_PARAMS }, 9), 150);
    // Either rejected on the holdout, or any accepted fit stays close to the truth.
    if (out.params) expect(Math.abs(out.params.trailing - DEFAULT_INPLAY_PARAMS.trailing)).toBeLessThan(0.25);
    else expect(out.reason ?? "").toContain("did not beat");
  }, 60_000);

  it("rebuilds the live model's expected goals from a stored snapshot", () => {
    const l = liveLambdas({ home_xg: 1.5, away_xg: 1.0, live_player_performance: { home_factor: 1.1, away_factor: 0.9 }, home_sub_xg_delta: 0.05 });
    expect(l!.home).toBeCloseTo(1.7, 9);
    expect(l!.away).toBeCloseTo(0.9, 9);
    expect(liveLambdas({ home_xg: null, away_xg: 1 })).toBe(null);
  });
});
