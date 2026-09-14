import { describe, expect, it } from "vitest";
import { applyDataQualityReliability, teamEvidenceQuality } from "../predictionDataQuality";
import type { TeamStats } from "../statsService";

function stats(overrides: Partial<TeamStats> = {}): TeamStats {
  return {
    team_id: 1,
    team: "Test",
    form: "WWDWL",
    goals_per_game: 1.5,
    conceded_per_game: 1,
    clean_sheets: 2,
    matches_played: 10,
    wins: 5,
    draws: 3,
    losses: 2,
    possession: null,
    shots_total: null,
    shots_on_target: null,
    corners: null,
    fouls: null,
    offsides: null,
    yellow_cards: null,
    red_cards: null,
    goalkeeper_saves: null,
    shots_off_target: null,
    blocked_shots: null,
    shots_inside_box: null,
    shots_outside_box: null,
    total_passes: null,
    accurate_passes: null,
    pass_accuracy: null,
    expected_goals_live: null,
    dangerous_attacks: null,
    data_source: "competition",
    competition_matches_played: 8,
    recent_matches_used: 10,
    venue_matches_used: 5,
    strength_index: 1,
    strength_sample_size: 8,
    ...overrides,
  };
}

describe("prediction data quality", () => {
  it("keeps strong evidence high quality", () => {
    expect(teamEvidenceQuality(stats())).toBeGreaterThanOrEqual(0.9);
  });

  it("shrinks sparse fallback predictions toward neutral", () => {
    const sparse = stats({
      matches_played: 1,
      data_source: "recent_all_comp",
      competition_matches_played: 0,
      recent_matches_used: 1,
      venue_matches_used: 0,
      strength_sample_size: 1,
    });
    const adjusted = applyDataQualityReliability(
      { home: 70, draw: 20, away: 10 },
      sparse,
      sparse,
      80,
    );
    expect(adjusted.dataTier).toBe("stats-low");
    expect(adjusted.probabilities.home).toBeLessThan(70);
    expect(adjusted.probabilities.away).toBeGreaterThan(10);
    expect(adjusted.confidence).toBeLessThan(80);
  });

  it("penalises a fixture when only one side has strong evidence", () => {
    const weak = stats({
      matches_played: 2,
      data_source: "recent_all_comp",
      competition_matches_played: 0,
      recent_matches_used: 2,
      venue_matches_used: 0,
      strength_sample_size: 2,
    });
    const adjusted = applyDataQualityReliability(
      { home: 60, draw: 25, away: 15 },
      stats(),
      weak,
      75,
    );
    expect(adjusted.score).toBeLessThan(0.8);
    expect(adjusted.probabilities.home).toBeLessThan(60);
  });
});
