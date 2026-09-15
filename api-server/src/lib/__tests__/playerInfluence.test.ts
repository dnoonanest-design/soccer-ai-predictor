import { describe, expect, it } from "vitest";
import { activeParticipantsFromEvents, type LineupPlayer, type SquadPlayerStats } from "../enhancedStatsService";
import { getMatchPlayerInfluence, scorePlayerProfile } from "../playerInfluenceService";

function profile(overrides: Record<string, unknown> = {}) {
  return {
    playerId: 9,
    playerName: "Forward",
    position: "F",
    totalMatches: 30,
    totalMinutesPlayed: 2400,
    totalGoals: 16,
    totalAssists: 7,
    totalShots: 82,
    totalKeyPasses: 34,
    totalSuccessfulTackles: 12,
    totalYellowCards: 2,
    totalRedCards: 0,
    avgRating: 7.1,
    last5MatchesRating: 7.4,
    formScore: 0.6,
    growthRate: 0.35,
    confidenceScore: 0.8,
    consecutiveMatchesScored: 3,
    consecutiveMatchesWithoutGoal: 0,
    formTrend: "improving",
    ...overrides,
  } as any;
}

describe("participant-gated player influence", () => {
  it("shrinks a tiny player sample instead of treating it as star evidence", () => {
    const scored = scorePlayerProfile(profile({ totalMatches: 1, totalMinutesPlayed: 45, totalGoals: 2 }), {
      id: 9, name: "Forward", position: "F",
    });
    expect(scored.reliability).toBeLessThan(0.05);
    expect(Math.abs(scored.overall_score)).toBeLessThan(0.08);
    expect(scored.classification).not.toBe("star");
  });

  it("uses position when converting the same historical profile", () => {
    const forward = scorePlayerProfile(profile(), { id: 9, name: "Player", position: "F" });
    const goalkeeper = scorePlayerProfile(profile(), { id: 9, name: "Player", position: "G" });
    expect(forward.attack_score).toBeGreaterThan(goalkeeper.attack_score);
  });

  it("records established high performers as stars and penalises sustained negative runs", () => {
    const positive = scorePlayerProfile(profile(), { id: 9, name: "Player", position: "F" });
    const negative = scorePlayerProfile(profile({
      last5MatchesRating: 6.1,
      formScore: -0.6,
      growthRate: -0.5,
      confidenceScore: 0.25,
      consecutiveMatchesScored: 0,
      consecutiveMatchesWithoutGoal: 7,
    }), { id: 9, name: "Player", position: "F" });
    expect(positive.classification).toBe("star");
    expect(negative.form_score).toBeLessThan(positive.form_score);
    expect(negative.overall_score).toBeLessThan(positive.overall_score);
  });

  it("does not query or create player influence without both confirmed teams", async () => {
    await expect(getMatchPlayerInfluence([], [])).resolves.toBeNull();
  });

  it("removes the outgoing player and includes the incoming player only after the substitution", () => {
    const starters: LineupPlayer[] = [{ id: 1, name: "Starter", number: 9, position: "F", goals_per_game: 0.5, assists_per_game: 0.1 }];
    const squad = new Map<number, SquadPlayerStats>([[2, {
      id: 2, name: "Replacement", position: "F", appearances: 10, goals: 3, assists: 1,
      fouls_committed: 2, goals_per_game: 0.3, assists_per_game: 0.1, fouls_per_game: 0.2,
    }]]);
    const events = [{
      time: { elapsed: 60, extra: null }, team: { id: 10, name: "Home" },
      player: { id: 1, name: "Starter" }, assist: { id: 2, name: "Replacement" },
      type: "subst", detail: "Substitution 1",
    }];
    expect(activeParticipantsFromEvents(starters, events, 10, 59, squad).map((p) => p.id)).toEqual([1]);
    expect(activeParticipantsFromEvents(starters, events, 10, 60, squad).map((p) => p.id)).toEqual([2]);
  });

  it("ignores another team's substitutions", () => {
    const starters: LineupPlayer[] = [{ id: 1, name: "Starter", number: 9, position: "F", goals_per_game: 0, assists_per_game: 0 }];
    const events = [{
      time: { elapsed: 10, extra: null }, team: { id: 20, name: "Away" },
      player: { id: 1, name: "Starter" }, assist: { id: 2, name: "Other" },
      type: "subst", detail: "Substitution 1",
    }];
    expect(activeParticipantsFromEvents(starters, events, 10, 20, new Map()).map((p) => p.id)).toEqual([1]);
  });
});
