import { describe, expect, it } from "vitest";
import {
  assessPredictionReliability,
  capHomeAdvantage,
  guardThreeWayProbabilities,
} from "../predictionReliabilityService";

describe("prediction reliability guard", () => {
  it("reduces confidence when competition history is fallback data", () => {
    const result = assessPredictionReliability({
      leagueId: 48,
      homeStats: { data_source: "recent_all_comp", recent_matches_used: 12, venue_matches_used: 5, data_quality_score: 68 },
      awayStats: { data_source: "blended", competition_matches_played: 2, recent_matches_used: 12, venue_matches_used: 6, data_quality_score: 80 },
      lineupConfirmed: false,
      isLive: false,
    });
    expect(result.mode).toBe("cup");
    expect(result.score).toBeLessThan(70);
    expect(result.probabilityShrink).toBeLessThan(0.9);
  });

  it("normalises cross-league strength without overpowering the model", () => {
    const result = assessPredictionReliability({
      leagueId: 2,
      homeStats: { data_source: "blended", domestic_strength_index: 1.12, data_quality_score: 82 },
      awayStats: { data_source: "blended", domestic_strength_index: 1.0, data_quality_score: 82 },
      lineupConfirmed: true,
    });
    expect(result.mode).toBe("cross-league");
    expect(result.homeStrengthFactor).toBeGreaterThan(1);
    expect(result.homeStrengthFactor).toBeLessThanOrEqual(1.1);
  });

  it("shrinks weak evidence toward a neutral three-way distribution", () => {
    const guarded = guardThreeWayProbabilities(60, 22, 18, 0.7);
    expect(guarded.home).toBeLessThan(60);
    expect(guarded.draw).toBeGreaterThan(22);
    expect(guarded.home + guarded.draw + guarded.away).toBeCloseTo(100, 1);
  });

  it("caps cup and UEFA home advantage", () => {
    expect(capHomeAdvantage(1.08, 48)).toBe(1.04);
    expect(capHomeAdvantage(1.08, 2)).toBe(1.035);
    expect(capHomeAdvantage(1.08, 39)).toBe(1.08);
  });
});
