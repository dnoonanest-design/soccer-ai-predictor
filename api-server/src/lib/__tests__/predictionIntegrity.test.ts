import { describe, expect, it } from "vitest";
import {
  applyDataQualityPrior,
  blendH2H,
  lineupQualityFactor,
  type H2HRecord,
  type LineupPlayer,
} from "../enhancedStatsService";
import { competitionStrengthFactor } from "../statsService";

describe("prediction integrity guardrails", () => {
  it("shrinks incompatible data sources toward a conservative structural prior", () => {
    const result = applyDataQualityPrior(
      { home: 24, draw: 21, away: 55 },
      { data_source: "recent_all_comp", matches_played: 12, venue_matches_used: 2 },
      { data_source: "competition", matches_played: 6 },
    );
    expect(result.priorWeight).toBeGreaterThanOrEqual(0.25);
    expect(result.away).toBeLessThan(55);
    expect(result.home).toBeGreaterThan(24);
    expect(result.home + result.draw + result.away).toBeCloseTo(100, 8);
  });

  it("prevents a within-squad lineup score becoming a 20% team-strength boost", () => {
    const starters: LineupPlayer[] = [1, 2, 3].map((id) => ({
      id, name: `Starter ${id}`, number: id, position: "F", goals_per_game: 1, assists_per_game: 0,
    }));
    const squad = new Map<number, any>([
      [1, { appearances: 10, goals_per_game: 1, assists_per_game: 0 }],
      [2, { appearances: 10, goals_per_game: 1, assists_per_game: 0 }],
      [3, { appearances: 10, goals_per_game: 1, assists_per_game: 0 }],
      [4, { appearances: 10, goals_per_game: 0.1, assists_per_game: 0 }],
      [5, { appearances: 10, goals_per_game: 0.1, assists_per_game: 0 }],
    ]);
    expect(lineupQualityFactor(starters, squad)).toBe(1.06);
  });

  it("keeps one head-to-head meeting below a one-percent influence", () => {
    const h2h: H2HRecord = {
      matches: 1, home_wins: 1, draws: 0, away_wins: 0,
      home_win_rate: 1, draw_rate: 0, away_win_rate: 0,
    };
    const result = blendH2H(35, 27, 38, h2h);
    expect(result.home - 35).toBeLessThan(1);
    expect(result.home + result.draw + result.away).toBeCloseTo(100, 8);
  });

  it("normalizes strong- and weak-league schedules without team hardcoding", () => {
    const ligue1 = competitionStrengthFactor(61, "France", "Ligue 1");
    const untrackedLeague = competitionStrengthFactor(99999, "Slovakia", "Super Liga");
    expect(ligue1).toBeGreaterThan(untrackedLeague);
    expect(ligue1).toBeLessThanOrEqual(1.2);
    expect(untrackedLeague).toBeGreaterThanOrEqual(0.8);
  });
});
