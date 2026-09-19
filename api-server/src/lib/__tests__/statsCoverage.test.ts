import { describe, expect, it } from "vitest";
import { rollForwardCompetitionStats, type TeamStats } from "../statsService";
import { teamEvidenceQuality } from "../predictionDataQuality";

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
    competition_matches_played: 10,
    current_season_matches_played: 10,
    prior_season_matches_used: 0,
    recent_matches_used: 0,
    venue_matches_used: 0,
    strength_index: 1,
    strength_sample_size: 10,
    ...overrides,
  };
}

describe("early-season competition coverage", () => {
  it("uses only enough decayed prior-season matches to reach the minimum sample", () => {
    const current = stats({
      form: "WD",
      matches_played: 2,
      competition_matches_played: 2,
      current_season_matches_played: 2,
      goals_per_game: 2,
      conceded_per_game: 0.5,
      wins: 1,
      draws: 1,
      losses: 0,
      clean_sheets: 1,
    });
    const previous = stats({
      form: "LLWWW",
      matches_played: 38,
      competition_matches_played: 38,
      current_season_matches_played: 0,
      goals_per_game: 1,
      conceded_per_game: 1.5,
      wins: 18,
      draws: 8,
      losses: 12,
      clean_sheets: 10,
    });

    const rolled = rollForwardCompetitionStats(current, previous);

    expect(rolled).toMatchObject({
      matches_played: 5,
      competition_matches_played: 5,
      current_season_matches_played: 2,
      prior_season_matches_used: 3,
      data_source: "competition",
      form: "WWWWD",
    });
    expect(rolled?.goals_per_game).toBeGreaterThan(1);
    expect(rolled?.goals_per_game).toBeLessThan(2);
  });

  it("does not replace a complete current-season sample", () => {
    const current = stats({ matches_played: 5, competition_matches_played: 5 });
    expect(rollForwardCompetitionStats(current, stats())).toBe(current);
  });

  it("keeps prior-season evidence below equivalent current-season evidence", () => {
    const rolled = stats({
      matches_played: 5,
      competition_matches_played: 5,
      current_season_matches_played: 2,
      prior_season_matches_used: 3,
      strength_sample_size: 3.95,
    });
    const currentOnly = stats({
      matches_played: 5,
      competition_matches_played: 5,
      current_season_matches_played: 5,
      prior_season_matches_used: 0,
    });

    expect(teamEvidenceQuality(rolled)).toBeLessThan(teamEvidenceQuality(currentOnly));
  });
});
