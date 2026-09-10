import { describe, expect, it } from "vitest";
import {
  applyDataQualityPrior,
  blendH2H,
  lineupQualityFactor,
  type H2HRecord,
  type LineupPlayer,
} from "../enhancedStatsService";
import { competitionStrengthFactor } from "../statsService";
import {
  STRENGTH_MODEL_VERSION,
  blendCrossLeaguePrior,
  buildTeamStrengthProfile,
  ratingThreeWayProbability,
  type StrengthFixture,
} from "../crossLeagueStrength";

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

  function teamHistory(teamId: number, leagueId: number, country: string, results: Array<[number, number]>): StrengthFixture[] {
    return results.map(([forGoals, againstGoals], index) => ({
      date: `2026-08-${String(index + 1).padStart(2, "0")}T18:00:00Z`,
      leagueId,
      leagueName: leagueId === 61 ? "Ligue 1" : "Super Liga",
      country,
      homeTeamId: teamId,
      awayTeamId: 10_000 + index,
      homeGoals: forGoals,
      awayGoals: againstGoals,
    }));
  }

  it("uses league as a prior while allowing club performance to move the rating", () => {
    const strong = buildTeamStrengthProfile(teamHistory(1, 61, "France", [[3, 0], [2, 0], [4, 1], [2, 1], [3, 1], [1, 0]]), 1);
    const weak = buildTeamStrengthProfile(teamHistory(2, 9999, "Slovakia", [[3, 0], [2, 0], [4, 1], [2, 1], [3, 1], [1, 0]]), 2);
    expect(strong.leagueRating).toBeGreaterThan(weak.leagueRating);
    expect(strong.clubRating).toBeGreaterThan(weak.clubRating);
    expect(strong.clubRating).toBeGreaterThan(strong.leagueRating);
    expect(strong.version).toBe(STRENGTH_MODEL_VERSION);
  });

  it("does not mistake participation in a UEFA competition for domestic-league strength", () => {
    const fixtures: StrengthFixture[] = [
      ...teamHistory(2, 9999, "Slovakia", [[2, 0], [3, 1], [1, 0], [2, 1]]),
      { date: "2026-09-01T18:00:00Z", leagueId: 2, leagueName: "UEFA Champions League", country: "Europe", homeTeamId: 2, awayTeamId: 3, homeGoals: 1, awayGoals: 1 },
    ];
    const profile = buildTeamStrengthProfile(fixtures, 2);
    expect(profile.domesticLeagueId).toBe(9999);
    expect(profile.leagueRating).toBe(1340);
  });

  it("uses known opponent ratings instead of treating every schedule as league-average", () => {
    const fixtures = teamHistory(1, 61, "France", [[1, 0], [1, 0], [1, 0], [1, 0]]);
    fixtures.forEach((fixture) => { fixture.opponentRating = 1760; });
    const profile = buildTeamStrengthProfile(fixtures, 1);
    expect(profile.scheduleRating).toBe(1760);
    expect(profile.scheduleFactor).toBeGreaterThan(1);
  });

  it("excludes results at or after the prediction timestamp", () => {
    const fixtures = teamHistory(1, 61, "France", [[0, 3], [0, 2], [6, 0]]);
    const profile = buildTeamStrengthProfile(fixtures, 1, new Date("2026-08-03T18:00:00Z"));
    expect(profile.matchesUsed).toBe(2);
    expect(profile.clubRating).toBeLessThan(profile.leagueRating);
  });

  it("makes the stronger cross-league home club favourite in a PSG-Slovan regression scenario", () => {
    const psg = buildTeamStrengthProfile(teamHistory(1, 61, "France", [[3, 0], [2, 0], [4, 1], [2, 1], [3, 1], [1, 0], [4, 0], [2, 1]]), 1);
    const slovan = buildTeamStrengthProfile(teamHistory(2, 9999, "Slovakia", [[3, 0], [2, 0], [4, 1], [2, 1], [3, 1], [1, 0], [4, 0], [2, 1]]), 2);
    const adjusted = blendCrossLeaguePrior({ home: 24, draw: 21, away: 55 }, psg, slovan);
    expect(adjusted.ratingGap).toBeGreaterThanOrEqual(200);
    expect(adjusted.priorWeight).toBeGreaterThanOrEqual(0.65);
    expect(adjusted.home).toBeGreaterThan(adjusted.away);
    expect(adjusted.home + adjusted.draw + adjusted.away).toBeCloseTo(100, 8);
  });

  it("keeps ratings out when either club has insufficient history", () => {
    const sparse = buildTeamStrengthProfile(teamHistory(1, 61, "France", [[1, 0], [1, 1]]), 1);
    const full = buildTeamStrengthProfile(teamHistory(2, 9999, "Slovakia", [[1, 0], [1, 1], [2, 0], [0, 0]]), 2);
    expect(blendCrossLeaguePrior({ home: 30, draw: 30, away: 40 }, sparse, full).priorWeight).toBe(0);
  });

  it("produces normalized structural probabilities across large rating gaps", () => {
    const probabilities = ratingThreeWayProbability(1780, 1450);
    expect(probabilities.home).toBeGreaterThan(70);
    expect(probabilities.draw).toBeGreaterThanOrEqual(18);
    expect(probabilities.home + probabilities.draw + probabilities.away).toBeCloseTo(100, 8);
  });
});
